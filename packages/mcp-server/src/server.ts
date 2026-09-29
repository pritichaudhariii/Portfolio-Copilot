import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASSET_CLASSES,
  analyzeDrift,
  computeRiskMetrics,
  enrichHoldings,
  mergeAcrossAccounts,
  portfolioHistory,
  summarizePortfolio,
  type AnalyticsDeps
} from "./analytics.js";
import { PortfolioError, PortfolioStore } from "./data-sources/portfolio-store.js";
import { SimulatedMarketDataProvider, UnknownSymbolError, type MarketDataProvider } from "./data-sources/market-data.js";
import { ResearchNotesSource } from "./data-sources/research-notes.js";
import type { Security } from "./types.js";
import fs from "node:fs";
import path from "node:path";
import { SEED_DIR } from "./paths.js";

export const SERVER_INFO = { name: "portfolio-copilot-mcp", version: "1.0.0" } as const;

export interface ServerDeps {
  store: PortfolioStore;
  market: MarketDataProvider;
  research: ResearchNotesSource;
}

/** Builds the default dependency set from the seed data and environment. */
export function createDefaultDeps(options: { inMemory?: boolean; now?: () => Date } = {}): ServerDeps {
  const securities = JSON.parse(fs.readFileSync(path.join(SEED_DIR, "securities.json"), "utf8")) as Security[];
  return {
    store: new PortfolioStore({ inMemory: options.inMemory }),
    market: new SimulatedMarketDataProvider(securities, { now: options.now }),
    research: new ResearchNotesSource()
  };
}

const assetClassEnum = z.enum(["us_equity", "intl_equity", "bond", "real_estate", "crypto", "cash"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").describe("ISO date, YYYY-MM-DD");
const symbolSchema = z.string().min(1).max(12).describe("Ticker symbol, e.g. AAPL or VTI");

/**
 * Creates a fully-configured MCP server instance. A new instance is cheap, so the HTTP
 * transport creates one per request (stateless mode) while sharing the same data sources.
 */
export function createPortfolioServer(deps: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Portfolio Copilot MCP server. Exposes an investor's accounts, holdings, transactions, " +
      "watchlist and target allocation, plus simulated market data, analytics (allocation drift, " +
      "risk metrics, performance history) and the firm's internal research notes. " +
      "All prices are simulated for demo purposes. Nothing returned is financial advice."
  });
  const analytics: AnalyticsDeps = { store: deps.store, market: deps.market };

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description: "List the investor's accounts (id, name, type, tax treatment). Call this first when you need an accountId.",
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => ok(deps.store.getAccounts())
  );

  server.registerTool(
    "get_holdings",
    {
      title: "Get holdings",
      description:
        "Current positions with live (simulated) prices, market value, cost basis, unrealized gain/loss, day change and portfolio weight. " +
        "Optionally filter to one account, or merge the same symbol across accounts.",
      inputSchema: {
        accountId: z.string().optional().describe("Restrict to one account (see list_accounts)"),
        mergeAccounts: z.boolean().optional().describe("Combine the same symbol held in several accounts into one row (default false)")
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ accountId, mergeAccounts }) =>
      guard(() => {
        const views = enrichHoldings(analytics, accountId);
        return mergeAccounts ? mergeAcrossAccounts(views) : views;
      })
  );

  server.registerTool(
    "get_portfolio_summary",
    {
      title: "Portfolio summary",
      description:
        "Top-level snapshot: total value, cost, unrealized P&L, day change, cash, and allocation breakdowns by asset class, sector and account, plus top holdings.",
      inputSchema: { accountId: z.string().optional().describe("Restrict to one account") },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ accountId }) => guard(() => summarizePortfolio(analytics, accountId))
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get quotes",
      description: "Latest price, previous close and day change for one or more symbols.",
      inputSchema: { symbols: z.array(symbolSchema).min(1).max(25).describe("Ticker symbols") },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ symbols }) => guard(() => deps.market.getQuotes(symbols))
  );

  server.registerTool(
    "get_price_history",
    {
      title: "Price history",
      description: "Daily closing prices for a symbol over the last N trading days (oldest first).",
      inputSchema: {
        symbol: symbolSchema,
        days: z.number().int().min(2).max(750).default(90).describe("Number of trading days (default 90)")
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ symbol, days }) =>
      guard(() => {
        const points = deps.market.getHistory(symbol, days);
        const first = points[0]?.close ?? 0;
        const last = points[points.length - 1]?.close ?? 0;
        return { symbol: symbol.toUpperCase(), days: points.length, periodReturnPct: first ? round2(((last - first) / first) * 100) : 0, points };
      })
  );

  server.registerTool(
    "get_portfolio_history",
    {
      title: "Portfolio value history",
      description:
        "Total portfolio (or single account) market value for each of the last N trading days, assuming today's positions were held throughout. Useful for 'how has my portfolio done over the last quarter' questions.",
      inputSchema: {
        days: z.number().int().min(2).max(750).default(90).describe("Number of trading days (default 90)"),
        accountId: z.string().optional().describe("Restrict to one account")
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ days, accountId }) =>
      guard(() => {
        const points = portfolioHistory(analytics, days, accountId);
        const first = points[0]?.close ?? 0;
        const last = points[points.length - 1]?.close ?? 0;
        return { days: points.length, startValue: first, endValue: last, periodReturnPct: first ? round2(((last - first) / first) * 100) : 0, points };
      })
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Get transactions",
      description: "Transaction ledger (buys, sells, dividends, deposits, withdrawals), newest first. Filter by account, symbol or date range.",
      inputSchema: {
        accountId: z.string().optional(),
        symbol: symbolSchema.optional(),
        from: dateSchema.optional().describe("Inclusive start date"),
        to: dateSchema.optional().describe("Inclusive end date"),
        limit: z.number().int().min(1).max(500).optional().describe("Max rows to return")
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (filter) => guard(() => deps.store.getTransactions(filter))
  );

  server.registerTool(
    "record_transaction",
    {
      title: "Record a transaction",
      description:
        "Record a buy, sell, dividend, deposit or withdrawal in an account. Buys debit cash and sells credit cash; " +
        "the call fails if the account lacks cash or shares. If price is omitted for a buy/sell the current quote is used. " +
        "This is a WRITE: confirm the user's intent before calling it.",
      inputSchema: {
        accountId: z.string().describe("Account id from list_accounts"),
        symbol: symbolSchema.describe("Ticker; use CASH for deposits/withdrawals"),
        type: z.enum(["buy", "sell", "dividend", "deposit", "withdrawal"]),
        quantity: z.number().positive().describe("Shares for buy/sell; dollar amount for deposit/withdrawal/dividend"),
        price: z.number().nonnegative().optional().describe("Price per share. Defaults to the current quote (1 for cash movements)"),
        date: dateSchema.optional().describe("Defaults to today"),
        note: z.string().max(200).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async (input) =>
      guard(() => {
        const isCashMove = input.type === "deposit" || input.type === "withdrawal" || input.type === "dividend";
        const price = input.price ?? (isCashMove ? 1 : deps.market.getQuote(input.symbol).price);
        const txn = deps.store.recordTransaction({ ...input, price });
        const holding = enrichHoldings(analytics, input.accountId).find((h) => h.symbol === txn.symbol);
        return { recorded: txn, position: holding ?? null };
      })
  );

  server.registerTool(
    "get_watchlist",
    {
      title: "Get watchlist",
      description: "Symbols the investor is watching, with their notes and current quotes.",
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () =>
      guard(() =>
        deps.store.getWatchlist().map((w) => {
          const security = deps.market.getSecurity(w.symbol);
          const quote = security ? deps.market.getQuote(w.symbol) : null;
          return { ...w, name: security?.name ?? null, quote };
        })
      )
  );

  server.registerTool(
    "update_watchlist",
    {
      title: "Update watchlist",
      description: "Add symbols (with an optional note) to the watchlist and/or remove symbols from it.",
      inputSchema: {
        add: z.array(z.object({ symbol: symbolSchema, note: z.string().max(200).optional() })).optional(),
        remove: z.array(symbolSchema).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async (changes) =>
      guard(() => {
        for (const item of changes.add ?? []) deps.market.requireSecurity(item.symbol);
        return deps.store.updateWatchlist(changes);
      })
  );

  server.registerTool(
    "get_target_allocation",
    {
      title: "Get target allocation",
      description: "The investor's target asset-class mix (percentages summing to 100) and rebalance threshold.",
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => ok(deps.store.getTargetAllocation())
  );

  server.registerTool(
    "set_target_allocation",
    {
      title: "Set target allocation",
      description: "Replace the target asset-class mix. Percentages must sum to 100. This is a WRITE: confirm with the user first.",
      inputSchema: {
        targets: z.record(assetClassEnum, z.number().min(0).max(100)).describe("Percent per asset class, e.g. {us_equity: 60, bond: 40}"),
        rebalanceThresholdPct: z.number().min(0.5).max(25).optional().describe("Drift threshold in percentage points (default keeps current)")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async ({ targets, rebalanceThresholdPct }) =>
      guard(() => {
        const current = deps.store.getTargetAllocation();
        const full = Object.fromEntries(ASSET_CLASSES.map((c) => [c, targets[c] ?? 0])) as Record<(typeof ASSET_CLASSES)[number], number>;
        return deps.store.setTargetAllocation({
          targets: full,
          rebalanceThresholdPct: rebalanceThresholdPct ?? current.rebalanceThresholdPct
        });
      })
  );

  server.registerTool(
    "analyze_allocation_drift",
    {
      title: "Analyze allocation drift",
      description:
        "Compare current asset-class weights to the target allocation, flag classes outside the threshold and suggest dollar-denominated rebalancing trades using default instruments.",
      inputSchema: { thresholdPct: z.number().min(0.5).max(25).optional().describe("Override the stored rebalance threshold") },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ thresholdPct }) => guard(() => analyzeDrift(analytics, { thresholdPct }))
  );

  server.registerTool(
    "compute_risk_metrics",
    {
      title: "Compute risk metrics",
      description:
        "Annualized volatility, Sharpe ratio, max drawdown, beta and correlation versus a benchmark (default SPY), concentration measures, and per-holding volatility/beta over a lookback window.",
      inputSchema: {
        benchmark: symbolSchema.optional().describe("Benchmark symbol (default SPY)"),
        lookbackDays: z.number().int().min(20).max(750).optional().describe("Trading days of history (default 252)"),
        riskFreeRatePct: z.number().min(0).max(20).optional().describe("Annual risk-free rate in percent (default 4)"),
        accountId: z.string().optional().describe("Restrict to one account")
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (params) => guard(() => computeRiskMetrics(analytics, params))
  );

  server.registerTool(
    "search_research_notes",
    {
      title: "Search research notes",
      description:
        "Search the firm's internal research notes by keyword, symbol and/or sentiment. Use this to ground opinions about a holding in the house view.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Free-text keywords"),
        symbol: symbolSchema.optional(),
        sentiment: z.enum(["bullish", "neutral", "bearish"]).optional(),
        limit: z.number().int().min(1).max(20).optional().describe("Max notes (default 5)")
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (params) => ok(deps.research.search(params))
  );

  server.registerTool(
    "list_securities",
    {
      title: "List securities",
      description: "The universe of symbols this server knows about, with asset class, sector, region and yield.",
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () =>
      ok(
        deps.market.listSecurities().map(({ basePrice: _b, annualVolatility: _v, annualDrift: _d, ...rest }) => rest)
      )
  );

  server.registerTool(
    "reset_demo_data",
    {
      title: "Reset demo data",
      description: "Restore the portfolio ledger, watchlist and targets to the seed dataset. Destructive; confirm with the user first.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async () =>
      guard(() => {
        deps.store.reset();
        return { reset: true, summary: summarizePortfolio(analytics) };
      })
  );

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  server.registerResource(
    "accounts",
    "portfolio://accounts",
    { title: "Accounts", description: "All investor accounts", mimeType: "application/json" },
    async (uri) => jsonResource(uri.href, deps.store.getAccounts())
  );

  server.registerResource(
    "holdings",
    "portfolio://holdings",
    { title: "Holdings", description: "Enriched positions across all accounts", mimeType: "application/json" },
    async (uri) => jsonResource(uri.href, enrichHoldings(analytics))
  );

  server.registerResource(
    "target-allocation",
    "portfolio://target-allocation",
    { title: "Target allocation", description: "Target asset-class mix", mimeType: "application/json" },
    async (uri) => jsonResource(uri.href, deps.store.getTargetAllocation())
  );

  server.registerResource(
    "watchlist",
    "portfolio://watchlist",
    { title: "Watchlist", description: "Symbols under consideration", mimeType: "application/json" },
    async (uri) => jsonResource(uri.href, deps.store.getWatchlist())
  );

  server.registerResource(
    "research-notes",
    new ResourceTemplate("research://notes/{symbol}", {
      list: async () => ({
        resources: [...new Set(deps.research.all().map((n) => n.symbol))].map((symbol) => ({
          uri: `research://notes/${symbol}`,
          name: `Research notes: ${symbol}`,
          mimeType: "application/json"
        }))
      })
    }),
    { title: "Research notes", description: "Internal research notes for a symbol", mimeType: "application/json" },
    async (uri, { symbol }) => jsonResource(uri.href, deps.research.forSymbol(String(symbol)))
  );

  // ---------------------------------------------------------------------------
  // Prompts
  // ---------------------------------------------------------------------------

  server.registerPrompt(
    "portfolio_review",
    {
      title: "Portfolio review",
      description: "A structured quarterly-style review of the whole portfolio."
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Give me a structured review of my portfolio. Start with get_portfolio_summary, then analyze_allocation_drift and compute_risk_metrics. " +
              "For the three largest positions, check search_research_notes for the house view. Finish with: (1) what is working, (2) the top three risks, " +
              "(3) concrete, prioritized next steps with dollar amounts. Be specific and cite the numbers you used."
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "rebalance_plan",
    {
      title: "Rebalance plan",
      description: "Propose trades to bring the portfolio back to its target allocation.",
      argsSchema: { thresholdPct: z.string().optional().describe("Drift threshold in percentage points") }
    },
    ({ thresholdPct }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Analyze allocation drift${thresholdPct ? ` with a ${thresholdPct}% threshold` : ""} and propose a rebalancing plan. ` +
              "Prefer making trades in tax-advantaged accounts and using existing cash before selling. List each proposed trade with account, symbol, action, " +
              "shares and dollar amount, then ask me to confirm before recording anything."
          }
        }
      ]
    })
  );

  return server;
}

// ---- Result helpers ----------------------------------------------------------------

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Runs a tool body, converting expected domain errors into MCP error results. */
function guard(fn: () => unknown): ToolResult {
  try {
    return ok(fn());
  } catch (err) {
    if (err instanceof PortfolioError || err instanceof UnknownSymbolError) return fail(err.message);
    throw err;
  }
}

function jsonResource(uri: string, data: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
