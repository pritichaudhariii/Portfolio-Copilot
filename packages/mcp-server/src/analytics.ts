import type {
  AllocationSlice,
  AssetClass,
  Holding,
  HoldingView,
  PortfolioSummary,
  PricePoint,
  TargetAllocation
} from "./types.js";
import type { MarketDataProvider } from "./data-sources/market-data.js";
import type { PortfolioStore } from "./data-sources/portfolio-store.js";

export const ASSET_CLASSES: AssetClass[] = ["us_equity", "intl_equity", "bond", "real_estate", "crypto", "cash"];

export interface AnalyticsDeps {
  store: PortfolioStore;
  market: MarketDataProvider;
}

// ---- Holdings & summary -------------------------------------------------------

export function enrichHoldings({ store, market }: AnalyticsDeps, accountId?: string): HoldingView[] {
  const accounts = new Map(store.getAccounts().map((a) => [a.id, a]));
  const holdings = store.getHoldings(accountId);
  const total = holdings.reduce((sum, h) => sum + h.quantity * market.getQuote(h.symbol).price, 0);

  return holdings
    .map((h): HoldingView => {
      const security = market.requireSecurity(h.symbol);
      const quote = market.getQuote(h.symbol);
      const marketValue = h.quantity * quote.price;
      const unrealizedGain = marketValue - h.costBasis;
      return {
        accountId: h.accountId,
        accountName: accounts.get(h.accountId)?.name ?? h.accountId,
        symbol: h.symbol,
        name: security.name,
        type: security.type,
        assetClass: security.assetClass,
        sector: security.sector,
        region: security.region,
        quantity: h.quantity,
        costBasis: round2(h.costBasis),
        avgCost: h.quantity > 0 ? round2(h.costBasis / h.quantity) : 0,
        price: quote.price,
        marketValue: round2(marketValue),
        unrealizedGain: round2(unrealizedGain),
        unrealizedGainPct: h.costBasis > 0 ? round2((unrealizedGain / h.costBasis) * 100) : 0,
        dayChange: round2(h.quantity * quote.change),
        dayChangePct: quote.changePct,
        weight: total > 0 ? round2((marketValue / total) * 100) : 0
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);
}

export function summarizePortfolio(deps: AnalyticsDeps, accountId?: string): PortfolioSummary {
  const views = enrichHoldings(deps, accountId);
  const totalValue = sum(views.map((v) => v.marketValue));
  const totalCost = sum(views.map((v) => v.costBasis));
  const dayChange = sum(views.map((v) => v.dayChange));
  const previousValue = totalValue - dayChange;

  return {
    asOf: deps.market.asOfDate(),
    totalValue: round2(totalValue),
    totalCost: round2(totalCost),
    unrealizedGain: round2(totalValue - totalCost),
    unrealizedGainPct: totalCost > 0 ? round2(((totalValue - totalCost) / totalCost) * 100) : 0,
    dayChange: round2(dayChange),
    dayChangePct: previousValue > 0 ? round2((dayChange / previousValue) * 100) : 0,
    cashValue: round2(sum(views.filter((v) => v.assetClass === "cash").map((v) => v.marketValue))),
    positions: views.filter((v) => v.assetClass !== "cash").length,
    byAssetClass: groupBy(views, (v) => v.assetClass, totalValue),
    bySector: groupBy(views, (v) => v.sector, totalValue),
    byAccount: groupBy(views, (v) => v.accountName, totalValue),
    topHoldings: mergeAcrossAccounts(views)
      .slice(0, 5)
      .map((v) => ({
        symbol: v.symbol,
        name: v.name,
        marketValue: v.marketValue,
        weight: v.weight,
        unrealizedGainPct: v.unrealizedGainPct
      }))
  };
}

/** Collapses the same symbol held in several accounts into one row (weights add up). */
export function mergeAcrossAccounts(views: HoldingView[]): HoldingView[] {
  const merged = new Map<string, HoldingView>();
  for (const v of views) {
    const m = merged.get(v.symbol);
    if (!m) {
      merged.set(v.symbol, { ...v, accountId: "all", accountName: "All accounts" });
      continue;
    }
    m.quantity += v.quantity;
    m.costBasis = round2(m.costBasis + v.costBasis);
    m.marketValue = round2(m.marketValue + v.marketValue);
    m.unrealizedGain = round2(m.unrealizedGain + v.unrealizedGain);
    m.dayChange = round2(m.dayChange + v.dayChange);
    m.weight = round2(m.weight + v.weight);
    m.avgCost = m.quantity > 0 ? round2(m.costBasis / m.quantity) : 0;
    m.unrealizedGainPct = m.costBasis > 0 ? round2((m.unrealizedGain / m.costBasis) * 100) : 0;
  }
  return [...merged.values()].sort((a, b) => b.marketValue - a.marketValue);
}

// ---- Allocation drift & rebalancing --------------------------------------------

export interface DriftRow {
  assetClass: AssetClass;
  targetPct: number;
  currentPct: number;
  driftPct: number;
  currentValue: number;
  targetValue: number;
  /** Positive = buy this much (USD), negative = sell. */
  adjustmentUsd: number;
  needsRebalance: boolean;
}

export interface DriftAnalysis {
  asOf: string;
  totalValue: number;
  thresholdPct: number;
  needsRebalance: boolean;
  rows: DriftRow[];
  suggestedTrades: Array<{ action: "buy" | "sell"; assetClass: AssetClass; amountUsd: number; suggestedInstrument: string }>;
}

const DEFAULT_INSTRUMENT: Record<AssetClass, string> = {
  us_equity: "VTI",
  intl_equity: "VXUS",
  bond: "BND",
  real_estate: "VNQ",
  crypto: "IBIT",
  cash: "CASH"
};

export function analyzeDrift(deps: AnalyticsDeps, overrides: { thresholdPct?: number; target?: TargetAllocation } = {}): DriftAnalysis {
  const summary = summarizePortfolio(deps);
  const target = overrides.target ?? deps.store.getTargetAllocation();
  const thresholdPct = overrides.thresholdPct ?? target.rebalanceThresholdPct;
  const byClass = new Map(summary.byAssetClass.map((s) => [s.key as AssetClass, s]));

  const rows: DriftRow[] = ASSET_CLASSES.map((assetClass) => {
    const targetPct = target.targets[assetClass] ?? 0;
    const current = byClass.get(assetClass);
    const currentPct = current?.weight ?? 0;
    const currentValue = current?.value ?? 0;
    const targetValue = round2((summary.totalValue * targetPct) / 100);
    const driftPct = round2(currentPct - targetPct);
    return {
      assetClass,
      targetPct,
      currentPct,
      driftPct,
      currentValue,
      targetValue,
      adjustmentUsd: round2(targetValue - currentValue),
      needsRebalance: Math.abs(driftPct) >= thresholdPct
    };
  });

  const suggestedTrades = rows
    .filter((r) => r.needsRebalance && r.assetClass !== "cash")
    .map((r) => ({
      action: r.adjustmentUsd > 0 ? ("buy" as const) : ("sell" as const),
      assetClass: r.assetClass,
      amountUsd: Math.abs(r.adjustmentUsd),
      suggestedInstrument: DEFAULT_INSTRUMENT[r.assetClass]
    }))
    .sort((a, b) => b.amountUsd - a.amountUsd);

  return {
    asOf: summary.asOf,
    totalValue: summary.totalValue,
    thresholdPct,
    needsRebalance: rows.some((r) => r.needsRebalance),
    rows,
    suggestedTrades
  };
}

// ---- Performance history --------------------------------------------------------

/**
 * Portfolio value over the last `days` trading days, assuming today's quantities were
 * held throughout (a "what is this book worth over time" view, not time-weighted return).
 */
export function portfolioHistory(deps: AnalyticsDeps, days: number, accountId?: string): PricePoint[] {
  const holdings = deps.store.getHoldings(accountId);
  return combineHistories(deps.market, holdings, days);
}

function combineHistories(market: MarketDataProvider, holdings: Holding[], days: number): PricePoint[] {
  const series = holdings.map((h) => ({ quantity: h.quantity, points: market.getHistory(h.symbol, days) }));
  if (series.length === 0) return [];
  const dates = series[0].points.map((p) => p.date);
  return dates.map((date, i) => ({
    date,
    close: round2(sum(series.map((s) => s.quantity * s.points[i].close)))
  }));
}

// ---- Risk metrics ---------------------------------------------------------------

export interface RiskMetrics {
  asOf: string;
  lookbackDays: number;
  benchmark: string;
  riskFreeRatePct: number;
  portfolio: {
    annualizedReturnPct: number;
    annualizedVolatilityPct: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
    beta: number;
    correlationToBenchmark: number;
    periodReturnPct: number;
  };
  benchmarkStats: {
    annualizedReturnPct: number;
    annualizedVolatilityPct: number;
    periodReturnPct: number;
    maxDrawdownPct: number;
  };
  concentration: {
    largestPositionPct: number;
    largestPosition: string;
    top3Pct: number;
    herfindahlIndex: number;
    effectivePositions: number;
  };
  perHolding: Array<{ symbol: string; weightPct: number; annualizedVolatilityPct: number; beta: number; periodReturnPct: number }>;
}

export function computeRiskMetrics(
  deps: AnalyticsDeps,
  params: { benchmark?: string; lookbackDays?: number; riskFreeRatePct?: number; accountId?: string } = {}
): RiskMetrics {
  const benchmark = (params.benchmark ?? "SPY").toUpperCase();
  const lookbackDays = params.lookbackDays ?? 252;
  const riskFreeRatePct = params.riskFreeRatePct ?? 4.0;
  const rf = riskFreeRatePct / 100;

  const holdings = deps.store.getHoldings(params.accountId);
  const portfolio = combineHistories(deps.market, holdings, lookbackDays + 1);
  const bench = deps.market.getHistory(benchmark, lookbackDays + 1);

  const pReturns = dailyReturns(portfolio.map((p) => p.close));
  const bReturns = dailyReturns(bench.map((p) => p.close));

  const pVol = annualizedVol(pReturns);
  const bVol = annualizedVol(bReturns);
  const pRet = annualizedReturn(portfolio.map((p) => p.close));
  const bRet = annualizedReturn(bench.map((p) => p.close));

  const views = mergeAcrossAccounts(enrichHoldings(deps, params.accountId));
  const weights = views.map((v) => v.weight / 100);
  const sortedWeights = [...weights].sort((a, b) => b - a);
  const hhi = sum(weights.map((w) => w * w));
  const largest = views[0];

  const perHolding = views.map((v) => {
    const closes = deps.market.getHistory(v.symbol, lookbackDays + 1).map((p) => p.close);
    const r = dailyReturns(closes);
    return {
      symbol: v.symbol,
      weightPct: v.weight,
      annualizedVolatilityPct: round2(annualizedVol(r) * 100),
      beta: round2(beta(r, bReturns)),
      periodReturnPct: round2(periodReturn(closes) * 100)
    };
  });

  return {
    asOf: deps.market.asOfDate(),
    lookbackDays,
    benchmark,
    riskFreeRatePct,
    portfolio: {
      annualizedReturnPct: round2(pRet * 100),
      annualizedVolatilityPct: round2(pVol * 100),
      sharpeRatio: pVol > 0 ? round2((pRet - rf) / pVol) : 0,
      maxDrawdownPct: round2(maxDrawdown(portfolio.map((p) => p.close)) * 100),
      beta: round2(beta(pReturns, bReturns)),
      correlationToBenchmark: round2(correlation(pReturns, bReturns)),
      periodReturnPct: round2(periodReturn(portfolio.map((p) => p.close)) * 100)
    },
    benchmarkStats: {
      annualizedReturnPct: round2(bRet * 100),
      annualizedVolatilityPct: round2(bVol * 100),
      periodReturnPct: round2(periodReturn(bench.map((p) => p.close)) * 100),
      maxDrawdownPct: round2(maxDrawdown(bench.map((p) => p.close)) * 100)
    },
    concentration: {
      largestPositionPct: largest?.weight ?? 0,
      largestPosition: largest?.symbol ?? "",
      top3Pct: round2(sum(sortedWeights.slice(0, 3)) * 100),
      herfindahlIndex: round4(hhi),
      effectivePositions: hhi > 0 ? round2(1 / hhi) : 0
    },
    perHolding
  };
}

// ---- Math helpers ------------------------------------------------------------------

export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i - 1] > 0 ? closes[i] / closes[i - 1] - 1 : 0);
  }
  return out;
}

export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}

export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

export function annualizedVol(returns: number[]): number {
  return stdDev(returns) * Math.sqrt(252);
}

export function annualizedReturn(closes: number[]): number {
  if (closes.length < 2 || closes[0] <= 0) return 0;
  const years = (closes.length - 1) / 252;
  return Math.pow(closes[closes.length - 1] / closes[0], 1 / years) - 1;
}

export function periodReturn(closes: number[]): number {
  if (closes.length < 2 || closes[0] <= 0) return 0;
  return closes[closes.length - 1] / closes[0] - 1;
}

export function maxDrawdown(closes: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = peak > 0 ? c / peak - 1 : 0;
    if (dd < worst) worst = dd;
  }
  return worst;
}

export function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - 1);
}

export function beta(asset: number[], bench: number[]): number {
  const v = stdDev(bench) ** 2;
  return v > 0 ? covariance(asset, bench) / v : 0;
}

export function correlation(a: number[], b: number[]): number {
  const d = stdDev(a) * stdDev(b);
  return d > 0 ? covariance(a, b) / d : 0;
}

function groupBy(views: HoldingView[], key: (v: HoldingView) => string, total: number): AllocationSlice[] {
  const groups = new Map<string, number>();
  for (const v of views) groups.set(key(v), (groups.get(key(v)) ?? 0) + v.marketValue);
  return [...groups.entries()]
    .map(([k, value]) => ({ key: k, value: round2(value), weight: total > 0 ? round2((value / total) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
