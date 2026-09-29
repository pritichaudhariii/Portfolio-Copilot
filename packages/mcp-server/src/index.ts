#!/usr/bin/env node
/**
 * Portfolio Copilot MCP server entry point.
 *
 *   node dist/index.js --http     # Streamable HTTP on $PORT (default 3001), endpoint /mcp
 *   node dist/index.js --stdio    # stdio transport, for Claude Desktop / Claude Code / MCP Inspector
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { createDefaultDeps, createPortfolioServer, SERVER_INFO } from "./server.js";

const args = new Set(process.argv.slice(2));
const mode = args.has("--stdio") ? "stdio" : "http";

async function main(): Promise<void> {
  const deps = createDefaultDeps();

  if (mode === "stdio") {
    const server = createPortfolioServer(deps);
    await server.connect(new StdioServerTransport());
    // stdout is the wire; log to stderr only.
    console.error(`[${SERVER_INFO.name}] listening on stdio`);
    return;
  }

  const port = Number(process.env.PORT ?? 3001);
  const authToken = process.env.MCP_AUTH_TOKEN?.trim();

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/", (_req, res) => {
    res.json({ name: SERVER_INFO.name, version: SERVER_INFO.version, endpoint: "/mcp", transport: "streamable-http" });
  });
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", asOf: deps.market.asOfDate() });
  });

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!authToken) return next();
    const header = req.header("authorization") ?? "";
    if (header === `Bearer ${authToken}`) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };

  // Stateless Streamable HTTP: a fresh server + transport per request, shared data sources.
  app.post("/mcp", requireAuth, async (req, res) => {
    const server = createPortfolioServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] request failed", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed in stateless mode" }, id: null });
  };
  app.get("/mcp", requireAuth, methodNotAllowed);
  app.delete("/mcp", requireAuth, methodNotAllowed);

  app.listen(port, () => {
    console.log(`[${SERVER_INFO.name}] Streamable HTTP listening on http://localhost:${port}/mcp${authToken ? " (bearer auth on)" : ""}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
