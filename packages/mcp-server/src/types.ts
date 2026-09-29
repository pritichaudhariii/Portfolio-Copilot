/**
 * Domain types shared across the MCP server's data sources, analytics and tools.
 */

export type AccountType = "taxable" | "roth_ira" | "traditional_401k";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: "USD";
  taxAdvantaged: boolean;
}

export type AssetClass =
  | "us_equity"
  | "intl_equity"
  | "bond"
  | "real_estate"
  | "crypto"
  | "cash";

export type SecurityType = "stock" | "etf" | "cash";

export interface Security {
  symbol: string;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
  sector: string;
  region: string;
  /** Simulated reference price (USD) used to anchor the price series. */
  basePrice: number;
  /** Simulated annualised volatility (e.g. 0.25 = 25%). */
  annualVolatility: number;
  /** Simulated annualised drift (expected log return). */
  annualDrift: number;
  /** Simulated sensitivity to the common market factor (SPY ≈ 1.0). */
  marketBeta: number;
  dividendYield: number;
  expenseRatio?: number;
}

export interface Holding {
  accountId: string;
  symbol: string;
  quantity: number;
  /** Total cost basis in USD for the whole position. */
  costBasis: number;
}

export type TransactionType = "buy" | "sell" | "dividend" | "deposit" | "withdrawal";

export interface Transaction {
  id: string;
  accountId: string;
  symbol: string;
  type: TransactionType;
  quantity: number;
  /** Price per share (or 1 for cash movements). */
  price: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  note?: string;
}

export interface TargetAllocation {
  /** Percent of total portfolio per asset class; should sum to 100. */
  targets: Record<AssetClass, number>;
  /** Drift (in percentage points) above which a rebalance is recommended. */
  rebalanceThresholdPct: number;
}

export interface WatchlistItem {
  symbol: string;
  addedOn: string;
  note?: string;
}

export interface PortfolioData {
  accounts: Account[];
  holdings: Holding[];
  transactions: Transaction[];
  targetAllocation: TargetAllocation;
  watchlist: WatchlistItem[];
}

export type Sentiment = "bullish" | "neutral" | "bearish";

export interface ResearchNote {
  id: string;
  symbol: string;
  date: string;
  author: string;
  title: string;
  summary: string;
  sentiment: Sentiment;
  tags: string[];
}

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  previousClose: number;
  change: number;
  changePct: number;
  asOf: string;
  currency: "USD";
}

export interface PricePoint {
  date: string;
  close: number;
}

export interface HoldingView {
  accountId: string;
  accountName: string;
  symbol: string;
  name: string;
  type: SecurityType;
  assetClass: AssetClass;
  sector: string;
  region: string;
  quantity: number;
  costBasis: number;
  avgCost: number;
  price: number;
  marketValue: number;
  unrealizedGain: number;
  unrealizedGainPct: number;
  dayChange: number;
  dayChangePct: number;
  /** Share of total portfolio value, in percent. */
  weight: number;
}

export interface AllocationSlice {
  key: string;
  value: number;
  weight: number;
}

export interface PortfolioSummary {
  asOf: string;
  totalValue: number;
  totalCost: number;
  unrealizedGain: number;
  unrealizedGainPct: number;
  dayChange: number;
  dayChangePct: number;
  cashValue: number;
  positions: number;
  byAssetClass: AllocationSlice[];
  bySector: AllocationSlice[];
  byAccount: AllocationSlice[];
  topHoldings: Array<Pick<HoldingView, "symbol" | "name" | "marketValue" | "weight" | "unrealizedGainPct">>;
}
