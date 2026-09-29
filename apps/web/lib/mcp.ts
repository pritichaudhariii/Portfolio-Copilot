import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:3001/mcp";

export class McpUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Could not reach the MCP server at ${MCP_SERVER_URL}. Start it with "npm run dev" (or "npm run start:mcp") and check MCP_SERVER_URL. ` +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "McpUnavailableError";
  }
}

/**
 * Opens a Streamable HTTP connection to the Portfolio MCP server, runs `fn`, and closes it.
 * The server runs in stateless mode, so a connection per request is cheap and avoids
 * holding sockets across serverless invocations.
 */
export async function withMcp<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "portfolio-copilot-web", version: "1.0.0" });
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  });

  try {
    await client.connect(transport);
  } catch (err) {
    throw new McpUnavailableError(err);
  }

  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Flattens an MCP tool result into a string for the model (and the UI). */
export function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource" && "text" in block.resource) return String(block.resource.text);
      return `[${block.type} content omitted]`;
    })
    .join("\n");
}

/** Calls a tool and parses its JSON text payload. Throws if the tool reported an error. */
export async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = textOf(result);
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as T;
}
