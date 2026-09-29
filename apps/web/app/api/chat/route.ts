import { NextRequest } from "next/server";
import { runAgent } from "@/lib/agent";
import type { AgentEvent, ChatMessage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/chat
 * Body: { messages: ChatMessage[] }
 * Response: newline-delimited JSON stream of AgentEvent.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let body: { messages?: ChatMessage[] };
  try {
    body = (await req.json()) as { messages?: ChatMessage[] };
  } catch {
    return Response.json({ error: "Body must be JSON: { messages: ChatMessage[] }" }, { status: 400 });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return Response.json({ error: "The last message must be from the user." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: AgentEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        await runAgent({ messages, emit, signal: req.signal });
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
        emit({ type: "done", turns: 0 });
      } finally {
        closed = true;
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}
