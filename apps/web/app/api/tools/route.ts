import { McpUnavailableError, MCP_SERVER_URL, withMcp } from "@/lib/mcp";
import { MODEL } from "@/lib/agent";
import type { PromptInfo, ToolInfo } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tools
 * The MCP server's advertised tools and prompts, for the UI's tool palette.
 */
export async function GET(): Promise<Response> {
  try {
    const data = await withMcp(async (mcp) => {
      const [{ tools }, { prompts }, { resources }] = await Promise.all([
        mcp.listTools(),
        mcp.listPrompts().catch(() => ({ prompts: [] })),
        mcp.listResources().catch(() => ({ resources: [] }))
      ]);
      const toolInfos: ToolInfo[] = tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        readOnly: t.annotations?.readOnlyHint !== false
      }));
      const promptInfos: PromptInfo[] = prompts.map((p) => ({ name: p.name, title: p.title, description: p.description }));
      return {
        server: mcp.getServerVersion(),
        serverUrl: MCP_SERVER_URL,
        model: MODEL,
        tools: toolInfos,
        prompts: promptInfos,
        resources: resources.map((r) => r.uri)
      };
    });
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const status = err instanceof McpUnavailableError ? 503 : 500;
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
