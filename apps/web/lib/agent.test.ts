/**
 * Integration test for the agent loop.
 *
 * - Spawns the real MCP server (built output) on a random port.
 * - Stands up a scripted fake of the Anthropic Messages API (SSE) on another port.
 * - Runs `runAgent` and asserts that tool calls flow to the MCP server and results flow back.
 *
 * Run with: npm test -w @portfolio-copilot/web  (after building the MCP server)
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.resolve(here, "../../../packages/mcp-server/dist/index.js");

let mcp: ChildProcess;
let fakeApi: http.Server;
const apiRequests: Array<Record<string, unknown>> = [];

function sse(res: http.ServerResponse, events: Array<Record<string, unknown>>) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

const messageStart = (id: string) => ({
  type: "message_start",
  message: { id, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } }
});

async function waitFor(url: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

describe("agent loop", () => {
  before(async () => {
    assert.ok(fs.existsSync(MCP_ENTRY), `MCP server not built at ${MCP_ENTRY}; run "npm run build -w @portfolio-copilot/mcp-server" first`);

    const mcpPort = 3900 + Math.floor(Math.random() * 100);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-test-"));
    mcp = spawn(process.execPath, [MCP_ENTRY, "--http"], { env: { ...process.env, PORT: String(mcpPort), DATA_DIR: dataDir, MCP_AUTH_TOKEN: "" }, stdio: "ignore" });
    process.env.MCP_SERVER_URL = `http://localhost:${mcpPort}/mcp`;
    await waitFor(`http://localhost:${mcpPort}/health`);

    fakeApi = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const payload = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
        apiRequests.push(payload);
        const last = payload.messages[payload.messages.length - 1];
        const hasToolResult = Array.isArray(last.content) && (last.content as Array<{ type: string }>).some((b) => b.type === "tool_result");

        if (!hasToolResult) {
          // Turn 1: some text, then ask for a tool.
          sse(res, [
            messageStart("msg_1"),
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_portfolio_summary", input: {} } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } },
            { type: "message_stop" }
          ]);
          return;
        }

        // Turn 2: echo a number from the tool result to prove it round-tripped.
        const result = (last.content as Array<{ type: string; content: string }>).find((b) => b.type === "tool_result")!;
        const summary = JSON.parse(result.content) as { totalValue: number };
        sse(res, [
          messageStart("msg_2"),
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Your portfolio is worth $${summary.totalValue}.` } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
          { type: "message_stop" }
        ]);
      });
    });
    await new Promise<void>((resolve) => fakeApi.listen(0, resolve));
    const { port } = fakeApi.address() as { port: number };
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  after(async () => {
    mcp?.kill();
    await new Promise<void>((resolve) => fakeApi?.close(() => resolve()));
  });

  test("streams text, executes the tool on the MCP server, and feeds the result back", async () => {
    const { runAgent } = await import("./agent");
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    await runAgent({
      messages: [{ id: "u1", role: "user", parts: [{ kind: "text", text: "How am I doing?" }] }],
      emit: (e) => events.push(e)
    });

    const types = events.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t !== "text_delta"), ["tool_start", "tool_input", "turn_end", "tool_result", "turn_end", "done"]);

    const toolResult = events.find((e) => e.type === "tool_result") as unknown as { output: string; isError: boolean; name: string };
    assert.equal(toolResult.name, "get_portfolio_summary");
    assert.equal(toolResult.isError, false);
    assert.ok(JSON.parse(toolResult.output).totalValue > 0);

    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
    assert.match(text, /^Let me check\.Your portfolio is worth \$[\d.]+\.$/);

    // The second API request must carry the assistant's tool_use and our tool_result.
    assert.equal(apiRequests.length, 2);
    const second = apiRequests[1] as { messages: Array<{ role: string; content: Array<{ type: string }> }>; tools: Array<{ name: string }> };
    assert.equal(second.messages[1].role, "assistant");
    assert.ok(second.messages[1].content.some((b) => b.type === "tool_use"));
    assert.equal(second.messages[2].role, "user");
    assert.ok(second.messages[2].content.some((b) => b.type === "tool_result"));
    assert.ok(second.tools.length >= 15, "tool definitions come from the MCP server");
  });

  test("rebuilds history with prior tool calls for follow-up questions", async () => {
    const { toAnthropicMessages } = await import("./agent");
    const history = toAnthropicMessages([
      { id: "u1", role: "user", parts: [{ kind: "text", text: "How am I doing?" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { kind: "tool", id: "toolu_1", name: "get_portfolio_summary", turn: 1, input: {}, status: "done", output: "{\"totalValue\":1}", isError: false },
          { kind: "text", text: "Fine." }
        ]
      },
      { id: "u2", role: "user", parts: [{ kind: "text", text: "And risk?" }] }
    ]);
    assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "user"]);
    const assistant = history[1].content as Array<{ type: string }>;
    assert.deepEqual(assistant.map((b) => b.type), ["tool_use", "text"]);
    const user = history[2].content as Array<{ type: string }>;
    assert.deepEqual(user.map((b) => b.type), ["tool_result", "text"]);
  });
});
