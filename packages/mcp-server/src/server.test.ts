import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDefaultDeps, createPortfolioServer, type ServerDeps } from "./server.js";

const FIXED_NOW = () => new Date("2026-09-28T18:00:00Z");

async function connect(deps: ServerDeps): Promise<Client> {
  const server = createPortfolioServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function callJson<T = unknown>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(content.type, "text");
  if (result.isError) throw new Error(content.text);
  return JSON.parse(content.text ?? "null") as T;
}

describe("portfolio MCP server", () => {
  let client: Client;
  let deps: ServerDeps;

  before(async () => {
    deps = createDefaultDeps({ inMemory: true, now: FIXED_NOW });
    client = await connect(deps);
  });

  test("advertises the expected tools, resources and prompts", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of [
      "list_accounts", "get_holdings", "get_portfolio_summary", "get_quote", "get_price_history",
      "get_portfolio_history", "get_transactions", "record_transaction", "get_watchlist", "update_watchlist",
      "get_target_allocation", "set_target_allocation", "analyze_allocation_drift", "compute_risk_metrics",
      "search_research_notes", "list_securities", "reset_demo_data"
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "portfolio://holdings"));
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === "portfolio_review"));
  });

  test("summary totals match holdings", async () => {
    const holdings = await callJson<Array<{ marketValue: number; weight: number }>>(client, "get_holdings");
    const summary = await callJson<{ totalValue: number; byAssetClass: Array<{ weight: number }> }>(client, "get_portfolio_summary");
    const total = holdings.reduce((s, h) => s + h.marketValue, 0);
    assert.ok(Math.abs(total - summary.totalValue) < 0.05, `holdings sum ${total} vs summary ${summary.totalValue}`);
    const weights = summary.byAssetClass.reduce((s, a) => s + a.weight, 0);
    assert.ok(Math.abs(weights - 100) < 0.5, `asset class weights sum to ${weights}`);
  });

  test("quotes are deterministic and history is oldest-first", async () => {
    const [q1] = await callJson<Array<{ price: number; asOf: string }>>(client, "get_quote", { symbols: ["AAPL"] });
    const [q2] = await callJson<Array<{ price: number }>>(client, "get_quote", { symbols: ["AAPL"] });
    assert.equal(q1.price, q2.price);
    assert.equal(q1.asOf, "2026-09-28");
    const hist = await callJson<{ points: Array<{ date: string; close: number }> }>(client, "get_price_history", { symbol: "AAPL", days: 30 });
    assert.equal(hist.points.length, 30);
    assert.ok(hist.points[0].date < hist.points[29].date);
    assert.equal(hist.points[29].close, q1.price);
  });

  test("unknown symbols return an MCP error result, not a crash", async () => {
    const result = await client.callTool({ name: "get_quote", arguments: { symbols: ["ZZZZ"] } });
    assert.equal(result.isError, true);
  });

  test("record_transaction moves cash and shares, and rejects overdrafts", async () => {
    const before = await callJson<Array<{ symbol: string; quantity: number }>>(client, "get_holdings", { accountId: "acc_brokerage" });
    const cashBefore = before.find((h) => h.symbol === "CASH")!.quantity;

    const res = await callJson<{ recorded: { type: string }; position: { quantity: number } }>(client, "record_transaction", {
      accountId: "acc_brokerage", symbol: "AAPL", type: "buy", quantity: 2, price: 100
    });
    assert.equal(res.recorded.type, "buy");
    assert.equal(res.position.quantity, 42);

    const after = await callJson<Array<{ symbol: string; quantity: number }>>(client, "get_holdings", { accountId: "acc_brokerage" });
    assert.ok(Math.abs(after.find((h) => h.symbol === "CASH")!.quantity - (cashBefore - 200)) < 0.01);

    await assert.rejects(
      callJson(client, "record_transaction", { accountId: "acc_brokerage", symbol: "COST", type: "buy", quantity: 1000, price: 900 }),
      /Insufficient cash/
    );
    await assert.rejects(
      callJson(client, "record_transaction", { accountId: "acc_brokerage", symbol: "AAPL", type: "sell", quantity: 9999 }),
      /Cannot sell/
    );
  });

  test("drift analysis flags classes beyond the threshold", async () => {
    const drift = await callJson<{ rows: Array<{ assetClass: string; targetPct: number; currentPct: number }>; thresholdPct: number }>(
      client, "analyze_allocation_drift", { thresholdPct: 1 }
    );
    assert.equal(drift.thresholdPct, 1);
    assert.equal(drift.rows.length, 6);
    const targetSum = drift.rows.reduce((s, r) => s + r.targetPct, 0);
    assert.equal(targetSum, 100);
  });

  test("risk metrics are finite and sensible", async () => {
    const risk = await callJson<{ portfolio: { annualizedVolatilityPct: number; beta: number; maxDrawdownPct: number }; concentration: { effectivePositions: number } }>(
      client, "compute_risk_metrics", { lookbackDays: 120 }
    );
    assert.ok(risk.portfolio.annualizedVolatilityPct > 0 && risk.portfolio.annualizedVolatilityPct < 100);
    assert.ok(Number.isFinite(risk.portfolio.beta));
    assert.ok(risk.portfolio.maxDrawdownPct <= 0);
    assert.ok(risk.concentration.effectivePositions > 1);
  });

  test("research search ranks by relevance", async () => {
    const notes = await callJson<Array<{ symbol: string }>>(client, "search_research_notes", { query: "concentration semiconductors" });
    assert.equal(notes[0].symbol, "NVDA");
    const bySymbol = await callJson<Array<{ symbol: string }>>(client, "search_research_notes", { symbol: "BND" });
    assert.ok(bySymbol.every((n) => n.symbol === "BND"));
  });

  test("watchlist updates persist within the store", async () => {
    const list = await callJson<Array<{ symbol: string }>>(client, "update_watchlist", { add: [{ symbol: "msft", note: "test" }], remove: ["TSM"] });
    assert.ok(list.some((w) => w.symbol === "MSFT"));
    assert.ok(!list.some((w) => w.symbol === "TSM"));
  });

  test("resources and prompts resolve", async () => {
    const res = await client.readResource({ uri: "research://notes/NVDA" });
    const text = (res.contents[0] as { text: string }).text;
    assert.ok(JSON.parse(text).length >= 1);
    const prompt = await client.getPrompt({ name: "rebalance_plan", arguments: { thresholdPct: "3" } });
    assert.match((prompt.messages[0].content as { text: string }).text, /3% threshold/);
  });
});
