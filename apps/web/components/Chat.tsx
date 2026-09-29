"use client";

import { useEffect, useRef, useState } from "react";
import type { UseAgentResult } from "@/lib/use-agent";
import type { PromptInfo, ToolInfo } from "@/lib/types";
import { Message } from "./Message";

interface ChatProps {
  agent: UseAgentResult;
  tools: ToolInfo[];
  prompts: PromptInfo[];
  serverState: "connecting" | "connected" | "error";
}

const STARTERS: Array<{ title: string; prompt: string; kind: "read" | "write" }> = [
  { title: "How am I doing?", kind: "read", prompt: "Give me a quick read on my portfolio: total value, how it's moved lately, and what's driving the gains and losses." },
  { title: "Am I off target?", kind: "read", prompt: "Compare my current allocation to my target and tell me where I've drifted. Propose trades to fix it, but don't record anything yet." },
  { title: "Where's my risk?", kind: "read", prompt: "Compute my risk metrics against SPY. What's my biggest concentration and how volatile is the portfolio compared to the benchmark?" },
  { title: "House view on NVDA", kind: "read", prompt: "What does our internal research say about NVDA, and how does that square with the size of my position?" },
  { title: "Dividends this year", kind: "read", prompt: "How much dividend income have I received since January 1 this year, by account?" },
  { title: "Buy 10 shares of BND", kind: "write", prompt: "Buy 10 shares of BND in my 401(k) at the current price." }
];

export function Chat({ agent, tools, prompts, serverState }: ChatProps) {
  const { messages, status, error, send, stop, reset } = agent;
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [pinned, setPinned] = useState(true);

  // Auto-scroll while the reader is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned && messages.length > 0) el.scrollTop = el.scrollHeight;
  }, [messages, pinned]);

  // Grow the composer with its content.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const submit = async (text: string) => {
    setDraft("");
    setPinned(true);
    await send(text);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(draft);
    }
  };

  const offline = serverState === "error";
  const disabled = status === "streaming" || offline;

  return (
    <div className="panel flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {messages.length === 0 ? (
          <EmptyState onPick={(p) => void submit(p)} tools={tools} prompts={prompts} disabled={disabled} />
        ) : (
          <ol className="flex flex-col gap-7">
            {messages.map((m, i) => (
              <li key={m.id} className="rise">
                <Message message={m} streaming={status === "streaming" && i === messages.length - 1} />
              </li>
            ))}
          </ol>
        )}
        {error && (
          <div role="alert" className="mt-4 rounded-md border border-loss/40 bg-loss-soft px-3 py-2 text-sm text-loss">
            {error}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(draft);
        }}
        className="border-t border-rule p-3 sm:p-4"
      >
        <div className="flex items-end gap-2 rounded-lg border border-rule-strong bg-sheet-2 pl-1 focus-within:border-blue focus-within:bg-sheet">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={offline ? "Start the MCP server to chat" : "Ask about the portfolio, or tell me what to do"}
            disabled={offline}
            aria-label="Message"
            className="min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] outline-none placeholder:text-ink-faint focus-visible:outline-none disabled:opacity-60"
          />
          {status === "streaming" ? (
            <button
              type="button"
              onClick={stop}
              className="m-1.5 inline-flex h-8 items-center gap-1.5 rounded-md border border-rule bg-sheet px-3 text-sm font-medium text-ink-muted hover:text-ink"
            >
              <span className="h-2 w-2 rounded-sm bg-current" aria-hidden />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={disabled || !draft.trim()}
              aria-label="Send"
              className="m-1.5 grid h-8 w-8 place-items-center rounded-md bg-blue text-on-blue hover:bg-blue-ink disabled:cursor-not-allowed disabled:opacity-35"
            >
              <SendIcon />
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-ink-faint">
          <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
          <span className="sm:hidden" />
          {messages.length > 0 && (
            <button type="button" onClick={reset} className="text-ink-muted underline-offset-2 hover:underline">
              New conversation
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function EmptyState({
  onPick,
  tools,
  prompts,
  disabled
}: {
  onPick: (prompt: string) => void;
  tools: ToolInfo[];
  prompts: PromptInfo[];
  disabled: boolean;
}) {
  const reads = tools.filter((t) => t.readOnly);
  const writes = tools.filter((t) => !t.readOnly);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-7 py-4">
      <div>
        <h2 className="text-[22px] font-semibold leading-tight tracking-tight">What do you want to know about the portfolio?</h2>
        <p className="mt-2 max-w-[58ch] text-ink-muted">
          Every answer is built from tool calls to the MCP server: the ledger, quotes, analytics and research notes. Each call is shown
          in the conversation, so you can open it and see exactly where a number came from.
        </p>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {STARTERS.map((s) => (
          <li key={s.title}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(s.prompt)}
              className="group flex h-full w-full flex-col rounded-lg border border-rule bg-sheet px-3.5 py-3 text-left transition-colors hover:border-blue hover:bg-blue-soft/50 disabled:opacity-50"
            >
              <span className="flex items-center gap-2 font-medium">
                {s.title}
                {s.kind === "write" && <span className="rounded bg-amber-soft px-1.5 py-px text-[11px] font-medium text-amber">write</span>}
              </span>
              <span className="mt-1 text-[13.5px] leading-snug text-ink-muted">{s.prompt}</span>
            </button>
          </li>
        ))}
      </ul>

      {tools.length > 0 && (
        <div className="border-t border-rule pt-5 text-sm">
          <p className="text-ink-muted">
            The agent can reach {reads.length} read tools and {writes.length} write tools
            {prompts.length > 0 && (
              <>
                , plus the server&apos;s prompts{" "}
                {prompts.map((p, i) => (
                  <span key={p.name}>
                    <code className="rounded border border-rule bg-sheet-2 px-1.5 py-0.5 font-mono text-[12.5px] text-ink">{p.name}</code>
                    {i < prompts.length - 1 ? " and " : ""}
                  </span>
                ))}
              </>
            )}
            . The same server works from Claude Desktop, Claude Code or the MCP Inspector.
          </p>
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <li
                key={t.name}
                title={t.description}
                className={`rounded-md border px-2 py-0.5 font-mono text-[12px] ${
                  t.readOnly ? "border-rule bg-sheet-2 text-ink-muted" : "border-amber/40 bg-amber-soft text-amber"
                }`}
              >
                {t.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}
