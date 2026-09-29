/**
 * Types shared between the agent runtime (server) and the chat UI (client).
 */

/** A message as the UI stores it. Assistant messages are a sequence of parts. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  /** Filled in for assistant messages as the run progresses. */
  meta?: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    startedAt: number;
    finishedAt?: number;
  };
}

export type MessagePart = TextPart | ToolPart;

export interface TextPart {
  kind: "text";
  text: string;
}

export interface ToolPart {
  kind: "tool";
  id: string;
  name: string;
  /** 1-based model turn within the run; calls in the same turn ran concurrently. */
  turn: number;
  input: unknown;
  status: "pending" | "running" | "done";
  output?: string;
  isError?: boolean;
  durationMs?: number;
}

/** Events streamed from POST /api/chat as newline-delimited JSON. */
export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; turn: number }
  | { type: "tool_input"; id: string; name: string; turn: number; input: unknown }
  | { type: "tool_result"; id: string; name: string; turn: number; output: string; isError: boolean; durationMs: number }
  | { type: "turn_end"; stopReason: string | null; usage: { inputTokens: number; outputTokens: number } }
  | { type: "done"; turns: number }
  | { type: "error"; message: string };

export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean;
}

export interface PromptInfo {
  name: string;
  title?: string;
  description?: string;
}
