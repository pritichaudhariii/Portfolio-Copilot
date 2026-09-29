"use client";

import { useCallback, useRef, useState } from "react";
import type { AgentEvent, ChatMessage, MessagePart, ToolPart } from "./types";

export type AgentStatus = "idle" | "streaming";

export interface UseAgentResult {
  messages: ChatMessage[];
  status: AgentStatus;
  error: string | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
  /** Increments every time a run finishes; lets other panels refetch. */
  runCount: number;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/**
 * Client-side driver for POST /api/chat. Keeps the message list, applies streamed
 * events to the in-progress assistant message, and exposes send/stop/reset.
 */
export function useAgent(): UseAgentResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [runCount, setRunCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
  }, []);

  const reset = useCallback(() => {
    stop();
    setMessages([]);
    setError(null);
  }, [stop]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || status === "streaming") return;

      const userMessage: ChatMessage = { id: nextId("u"), role: "user", parts: [{ kind: "text", text: trimmed }] };
      const assistantId = nextId("a");
      const history = [...messages, userMessage];

      setMessages([
        ...history,
        { id: assistantId, role: "assistant", parts: [], meta: { turns: 0, inputTokens: 0, outputTokens: 0, startedAt: Date.now() } }
      ]);
      setStatus("streaming");
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (m: ChatMessage) => ChatMessage) => {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));
      };
      const update = (fn: (parts: MessagePart[]) => MessagePart[]) => patch((m) => ({ ...m, parts: fn(m.parts) }));

      const apply = (event: AgentEvent) => {
        switch (event.type) {
          case "text_delta":
            update((parts) => {
              const last = parts[parts.length - 1];
              if (last && last.kind === "text") {
                return [...parts.slice(0, -1), { kind: "text", text: last.text + event.text }];
              }
              return [...parts, { kind: "text", text: event.text }];
            });
            break;
          case "tool_start":
            update((parts) => [...parts, { kind: "tool", id: event.id, name: event.name, turn: event.turn, input: undefined, status: "pending" }]);
            break;
          case "tool_input":
            update((parts) => upsertTool(parts, event.id, (t) => ({ ...t, name: event.name, input: event.input, status: "running" })));
            break;
          case "tool_result":
            update((parts) =>
              upsertTool(parts, event.id, (t) => ({
                ...t,
                name: event.name,
                status: "done",
                output: event.output,
                isError: event.isError,
                durationMs: event.durationMs
              }))
            );
            break;
          case "turn_end":
            patch((m) => ({
              ...m,
              meta: {
                turns: (m.meta?.turns ?? 0) + 1,
                inputTokens: (m.meta?.inputTokens ?? 0) + event.usage.inputTokens,
                outputTokens: (m.meta?.outputTokens ?? 0) + event.usage.outputTokens,
                startedAt: m.meta?.startedAt ?? Date.now()
              }
            }));
            break;
          case "error":
            setError(event.message);
            break;
          case "done":
            break;
        }
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
          signal: controller.signal
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new Error(`Request failed (${res.status}) ${detail}`.trim());
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) apply(JSON.parse(line) as AgentEvent);
            newline = buffer.indexOf("\n");
          }
        }
        if (buffer.trim()) apply(JSON.parse(buffer) as AgentEvent);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        abortRef.current = null;
        setStatus("idle");
        setRunCount((n) => n + 1);
        setMessages((prev) =>
          prev
            // Drop an assistant message that never received content (e.g. stopped immediately).
            .filter((m) => m.id !== assistantId || m.parts.length > 0)
            .map((m) => (m.id === assistantId && m.meta ? { ...m, meta: { ...m.meta, finishedAt: Date.now() } } : m))
        );
      }
    },
    [messages, status]
  );

  return { messages, status, error, send, stop, reset, runCount };
}

function upsertTool(parts: MessagePart[], id: string, fn: (t: ToolPart) => ToolPart): MessagePart[] {
  const idx = parts.findIndex((p) => p.kind === "tool" && p.id === id);
  if (idx === -1) {
    return [...parts, fn({ kind: "tool", id, name: "", turn: 0, input: undefined, status: "pending" })];
  }
  return parts.map((p, i) => (i === idx && p.kind === "tool" ? fn(p) : p));
}
