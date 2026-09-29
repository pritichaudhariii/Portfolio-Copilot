import type { PricePoint, Quote, Security } from "../types.js";

/**
 * Internal data source #2: market data.
 *
 * `MarketDataProvider` is the seam where a real vendor (Polygon, Alpaca, a broker API…)
 * would plug in. The shipped implementation is a deterministic simulation: every
 * symbol gets a reproducible daily price series so the demo is stable, works offline
 * and never rate-limits.
 */
export interface MarketDataProvider {
  listSecurities(): Security[];
  getSecurity(symbol: string): Security | undefined;
  requireSecurity(symbol: string): Security;
  getQuote(symbol: string): Quote;
  getQuotes(symbols: string[]): Quote[];
  /** Daily closes for the last `days` trading days, oldest first. */
  getHistory(symbol: string, days: number): PricePoint[];
  /** The current "as of" trading date (YYYY-MM-DD). */
  asOfDate(): string;
}

export class UnknownSymbolError extends Error {
  constructor(symbol: string, known: string[]) {
    super(`Unknown symbol "${symbol}". Known symbols: ${known.join(", ")}`);
    this.name = "UnknownSymbolError";
  }
}

const ANCHOR_DATE = "2026-09-01";
const TRADING_DAYS_PER_YEAR = 252;
const PRECOMPUTE_DAYS = 3 * 365;
/** Annualised volatility of the common market factor (roughly the S&P 500). */
const MARKET_VOL = 0.15;

export class SimulatedMarketDataProvider implements MarketDataProvider {
  private readonly securities = new Map<string, Security>();
  private readonly seriesCache = new Map<string, Map<string, number>>();
  private readonly now: () => Date;

  constructor(securities: Security[], options: { now?: () => Date } = {}) {
    for (const s of securities) this.securities.set(s.symbol.toUpperCase(), s);
    this.now = options.now ?? (() => new Date());
  }

  listSecurities(): Security[] {
    return [...this.securities.values()].map((s) => ({ ...s }));
  }

  getSecurity(symbol: string): Security | undefined {
    const s = this.securities.get(symbol.toUpperCase());
    return s ? { ...s } : undefined;
  }

  requireSecurity(symbol: string): Security {
    const s = this.getSecurity(symbol);
    if (!s) throw new UnknownSymbolError(symbol, [...this.securities.keys()]);
    return s;
  }

  asOfDate(): string {
    return lastTradingDayOnOrBefore(toISODate(this.now()));
  }

  getQuote(symbol: string): Quote {
    const security = this.requireSecurity(symbol);
    const asOf = this.asOfDate();
    if (security.type === "cash") {
      return { symbol: security.symbol, name: security.name, price: 1, previousClose: 1, change: 0, changePct: 0, asOf, currency: "USD" };
    }
    const series = this.series(security);
    const price = series.get(asOf)!;
    const previousClose = series.get(previousTradingDay(asOf))!;
    const change = round2(price - previousClose);
    return {
      symbol: security.symbol,
      name: security.name,
      price: round2(price),
      previousClose: round2(previousClose),
      change,
      changePct: round4((change / previousClose) * 100),
      asOf,
      currency: "USD"
    };
  }

  getQuotes(symbols: string[]): Quote[] {
    return symbols.map((s) => this.getQuote(s));
  }

  getHistory(symbol: string, days: number): PricePoint[] {
    const security = this.requireSecurity(symbol);
    const n = Math.max(2, Math.min(Math.floor(days), PRECOMPUTE_DAYS - 10));
    const dates: string[] = [];
    let d = this.asOfDate();
    for (let i = 0; i < n; i++) {
      dates.push(d);
      d = previousTradingDay(d);
    }
    dates.reverse();
    if (security.type === "cash") return dates.map((date) => ({ date, close: 1 }));
    const series = this.series(security);
    return dates.map((date) => ({ date, close: round2(series.get(date)!) }));
  }

  // ---- Simulation ---------------------------------------------------------

  /**
   * Builds (and caches) a price map for ±3 years around the anchor date.
   *
   * Returns follow a one-factor model: each symbol loads on a common market shock
   * (keyed by date only, so every symbol sees the same "market day") plus an
   * idiosyncratic shock keyed by (symbol, date). Both are deterministic, so the series is
   * identical across processes and across days: yesterday's close never changes.
   */
  private series(security: Security): Map<string, number> {
    const cached = this.seriesCache.get(security.symbol);
    if (cached) return cached;

    const map = new Map<string, number>();
    const sigma = security.annualVolatility;
    const systematic = security.marketBeta * MARKET_VOL;
    const idiosyncratic = Math.sqrt(Math.max(sigma * sigma - systematic * systematic, 0));
    const dailyDrift = security.annualDrift / TRADING_DAYS_PER_YEAR - (sigma * sigma) / (2 * TRADING_DAYS_PER_YEAR);
    const scale = 1 / Math.sqrt(TRADING_DAYS_PER_YEAR);
    const logReturn = (date: string) =>
      dailyDrift +
      scale * (systematic * gaussian(`MARKET|${date}`) + idiosyncratic * gaussian(`${security.symbol}|${date}`));

    const anchor = lastTradingDayOnOrBefore(ANCHOR_DATE);
    map.set(anchor, security.basePrice);

    // Forward from anchor
    let date = anchor;
    let price = security.basePrice;
    for (let i = 0; i < PRECOMPUTE_DAYS; i++) {
      date = nextTradingDay(date);
      price = price * Math.exp(logReturn(date));
      map.set(date, price);
    }
    // Backward from anchor
    date = anchor;
    price = security.basePrice;
    for (let i = 0; i < PRECOMPUTE_DAYS; i++) {
      const prev = previousTradingDay(date);
      price = price / Math.exp(logReturn(date));
      map.set(prev, price);
      date = prev;
    }

    this.seriesCache.set(security.symbol, map);
    return map;
  }
}

// ---- Date helpers (UTC, weekdays only) -------------------------------------

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fromISODate(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

export function lastTradingDayOnOrBefore(iso: string): string {
  const d = fromISODate(iso);
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() - 1);
  return toISODate(d);
}

export function previousTradingDay(iso: string): string {
  const d = fromISODate(iso);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (isWeekend(d));
  return toISODate(d);
}

export function nextTradingDay(iso: string): string {
  const d = fromISODate(iso);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (isWeekend(d));
  return toISODate(d);
}

// ---- Deterministic randomness -----------------------------------------------

/** cyrb53 string hash → 32-bit seed. */
function hash32(str: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) ^ (h1 >>> 0);
}

/** mulberry32 PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal draw that depends only on `key` (Box–Muller). */
function gaussian(key: string): number {
  const rng = mulberry32(hash32(key));
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
