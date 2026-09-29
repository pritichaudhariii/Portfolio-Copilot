import { NextRequest } from "next/server";
import { callJson, McpUnavailableError, withMcp } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGES: Record<string, number> = { "1m": 21, "3m": 63, "6m": 126, "1y": 252 };

/**
 * GET /api/portfolio?range=3m
 * Dashboard data, read straight from the MCP server (the same tools the agent uses).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const range = req.nextUrl.searchParams.get("range") ?? "3m";
  const days = RANGES[range] ?? RANGES["3m"];
  try {
    const data = await withMcp(async (mcp) => {
      const [summary, holdings, history, drift] = await Promise.all([
        callJson(mcp, "get_portfolio_summary"),
        callJson(mcp, "get_holdings", { mergeAccounts: true }),
        callJson(mcp, "get_portfolio_history", { days }),
        callJson(mcp, "analyze_allocation_drift")
      ]);
      return { range, summary, holdings, history, drift };
    });
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const status = err instanceof McpUnavailableError ? 503 : 500;
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
