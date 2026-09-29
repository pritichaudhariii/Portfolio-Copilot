import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock
} from "@anthropic-ai/sdk/resources/messages";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { textOf, withMcp } from "./mcp";
import type { AgentEvent, ChatMessage } from "./types";

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? 10);
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are Portfolio Copilot, an assistant that helps an investor understand and manage their own portfolio.

You have tools, served by a Model Context Protocol (MCP) server, that read the investor's accounts, holdings, transactions, watchlist and target allocation, fetch market data, run analytics (allocation drift, risk metrics, performance history) and search the firm's internal research notes.

How to work:
- Ground every number in a tool result. Never estimate prices, values or weights from memory; call the tool.
- Prefer the smallest set of tools that answers the question. get_portfolio_summary answers most "how am I doing" questions; get_holdings gives per-position detail; use list_accounts when you need an accountId.
- Tools marked as writes (record_transaction, update_watchlist, set_target_allocation, reset_demo_data) change the ledger. Only call them when the user has clearly asked for that change; if the request is ambiguous (which account? how many shares?), ask first. After a write, restate what changed.
- When you propose trades, give account, symbol, action, share count and dollar amount, and prefer using existing cash and tax-advantaged accounts before selling in a taxable account.
- Use the research notes to explain the house view on a holding, and say when a note is the source.
- Format money as $12,345.67 and percentages with one or two decimals. Use short markdown tables for lists of positions or trades; otherwise write in plain, direct prose. Do not repeat the raw tool output.
- Market data in this environment is simulated. Say so once if the user asks whether prices are live.
- This is educational analysis of the user's own data, not personalised financial advice; do not add repeated disclaimers.`;

export interface RunAgentOptions {
  messages: ChatMessage[];
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/**
 * The agent loop: stream a model response, execute any tool calls against the MCP server,
 * feed results back, and repeat until the model stops asking for tools.
 */
export async function runAgent({ messages, emit, signal }: RunAgentOptions): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    emit({ type: "error", message: "ANTHROPIC_API_KEY is not set. Add it to apps/web/.env.local (see .env.example) and restart." });
    emit({ type: "done", turns: 0 });
    return;
  }
  const anthropic = new Anthropic({ apiKey });

  await withMcp(async (mcp) => {
    const { tools: mcpTools } = await mcp.listTools();
    const tools: Tool[] = mcpTools.map((t, i) => ({
      name: t.name,
      description: t.description ?? t.title ?? t.name,
      input_schema: t.inputSchema as Tool.InputSchema,
      // Cache the (stable) tool definitions + system prompt across turns.
      ...(i === mcpTools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {})
    }));

    const history: MessageParam[] = toAnthropicMessages(messages);
    let turns = 0;

    while (turns < MAX_TURNS) {
      if (signal?.aborted) return;
      turns++;

      const stream = anthropic.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools,
          messages: history
        },
        { signal }
      );

      stream.on("text", (delta) => emit({ type: "text_delta", text: delta }));
      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          emit({ type: "tool_start", id: event.content_block.id, name: event.content_block.name, turn: turns });
        }
      });
      stream.on("contentBlock", (block) => {
        if (block.type === "tool_use") emit({ type: "tool_input", id: block.id, name: block.name, turn: turns, input: block.input });
      });

      const final = await stream.finalMessage();
      history.push({ role: "assistant", content: toContentParams(final.content) });
      emit({
        type: "turn_end",
        stopReason: final.stop_reason,
        usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens }
      });

      const toolUses = final.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;

      // Tool calls in one turn are independent; run them concurrently against the MCP server.
      const results = await Promise.all(
        toolUses.map(async (call): Promise<ToolResultBlockParam> => {
          const started = Date.now();
          let output: string;
          let isError = false;
          try {
            const result = (await mcp.callTool({
              name: call.name,
              arguments: (call.input ?? {}) as Record<string, unknown>
            })) as CallToolResult;
            output = textOf(result);
            isError = Boolean(result.isError);
          } catch (err) {
            output = `Tool call failed: ${err instanceof Error ? err.message : String(err)}`;
            isError = true;
          }
          emit({ type: "tool_result", id: call.id, name: call.name, turn: turns, output, isError, durationMs: Date.now() - started });
          return { type: "tool_result", tool_use_id: call.id, content: output, is_error: isError };
        })
      );
      history.push({ role: "user", content: results });
    }

    if (turns >= MAX_TURNS) {
      emit({ type: "text_delta", text: "\n\n_(Stopped after reaching the tool-call limit for a single request.)_" });
    }
    emit({ type: "done", turns });
  });
}

// ---- Message conversion -----------------------------------------------------------

/**
 * Rebuilds the Anthropic message history from the UI's message model, including past
 * tool calls and their results so the model keeps its context across requests.
 */
export function toAnthropicMessages(messages: ChatMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.parts
        .filter((p) => p.kind === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text) out.push({ role: "user", content: text });
      continue;
    }

    const content: ContentBlockParam[] = [];
    const results: ToolResultBlockParam[] = [];
    for (const part of m.parts) {
      if (part.kind === "text") {
        if (part.text.trim()) content.push({ type: "text", text: part.text });
      } else if (part.status === "done") {
        content.push({ type: "tool_use", id: part.id, name: part.name, input: part.input ?? {} });
        results.push({ type: "tool_result", tool_use_id: part.id, content: part.output ?? "", is_error: part.isError ?? false });
      }
    }
    if (content.length === 0) continue;
    out.push({ role: "assistant", content });
    if (results.length) out.push({ role: "user", content: results });
  }

  // The API requires alternating roles starting with a user message; merge adjacent same-role turns.
  const merged: MessageParam[] = [];
  for (const msg of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...asBlocks(prev.content), ...asBlocks(msg.content)];
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

function asBlocks(content: MessageParam["content"]): ContentBlockParam[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

/** Strips response-only fields so a returned message can be echoed back as a param. */
function toContentParams(blocks: ContentBlock[]): ContentBlockParam[] {
  const params: ContentBlockParam[] = [];
  for (const b of blocks) {
    if (b.type === "text") params.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") params.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
  }
  return params;
}
