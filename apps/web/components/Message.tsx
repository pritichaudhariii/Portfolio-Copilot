"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, MessagePart, ToolPart } from "@/lib/types";
import { ToolCall } from "./ToolCall";

export function Message({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("\n");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-blue px-4 py-2.5 text-on-blue">{text}</div>
      </div>
    );
  }

  const groups = groupParts(message.parts);
  const hasContent = message.parts.length > 0;
  const lastIsTool = message.parts[message.parts.length - 1]?.kind === "tool";
  const finished = !streaming && hasContent;

  return (
    <div className="flex gap-3">
      <Avatar active={streaming} />
      <div className="min-w-0 flex-1">
        {!hasContent && streaming && <Working label="Reading the request" />}
        <div className="flex flex-col gap-3">
          {groups.map((group, gi) => {
            if (group.kind === "text") {
              const isLast = gi === groups.length - 1;
              return (
                <div key={gi} className={`chat-md ${streaming && isLast ? "caret" : ""}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{group.text}</ReactMarkdown>
                </div>
              );
            }
            return <Trace key={gi} calls={group.calls} />;
          })}
          {hasContent && streaming && lastIsTool && <Working label="Reading the results" />}
        </div>
        {finished && <Footer message={message} />}
      </div>
    </div>
  );
}

// ---- Trace rail ---------------------------------------------------------------------

type Group = { kind: "text"; text: string } | { kind: "trace"; calls: ToolPart[] };

/** Merges consecutive tool parts into one trace so they share a rail. */
function groupParts(parts: MessagePart[]): Group[] {
  const groups: Group[] = [];
  for (const part of parts) {
    const last = groups[groups.length - 1];
    if (part.kind === "text") {
      if (part.text.trim()) groups.push({ kind: "text", text: part.text });
    } else if (last && last.kind === "trace") {
      last.calls.push(part);
    } else {
      groups.push({ kind: "trace", calls: [part] });
    }
  }
  return groups;
}

function Trace({ calls }: { calls: ToolPart[] }) {
  const turns = new Map<number, ToolPart[]>();
  for (const c of calls) turns.set(c.turn, [...(turns.get(c.turn) ?? []), c]);

  return (
    <div className="relative pl-6" role="list" aria-label="Tool calls">
      <div className="absolute bottom-3 left-[9px] top-3 w-px bg-rule-strong" aria-hidden />
      <div className="flex flex-col gap-1.5">
        {[...turns.entries()].map(([turn, group]) => (
          <div key={turn} className="flex flex-col gap-1.5">
            {group.length > 1 && (
              <div className="relative -ml-6 pl-6 text-[11px] text-ink-faint">
                <span className="absolute left-[7px] top-[7px] h-[5px] w-[5px] rounded-full bg-rule-strong" aria-hidden />
                {group.length} calls in parallel
              </div>
            )}
            {group.map((call) => (
              <ToolCall key={call.id} part={call} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Chrome ---------------------------------------------------------------------------

function Avatar({ active }: { active: boolean }) {
  return (
    <div
      className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${
        active ? "border-blue bg-blue-soft text-blue" : "border-rule bg-sheet-2 text-ink-muted"
      }`}
      aria-hidden
    >
      PC
    </div>
  );
}

function Working({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-ink-faint" aria-live="polite">
      <span className="inline-flex gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint [animation-delay:300ms]" />
      </span>
      {label}
    </div>
  );
}

function Footer({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const tools = message.parts.filter((p): p is ToolPart => p.kind === "tool");
  const meta = message.meta;
  const elapsed = meta?.finishedAt && meta.startedAt ? (meta.finishedAt - meta.startedAt) / 1000 : null;
  const tokens = meta ? meta.inputTokens + meta.outputTokens : 0;

  const copy = async () => {
    const text = message.parts
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const bits: string[] = [];
  if (tools.length) bits.push(`${tools.length} tool call${tools.length === 1 ? "" : "s"}`);
  if (meta?.turns) bits.push(`${meta.turns} turn${meta.turns === 1 ? "" : "s"}`);
  if (elapsed !== null) bits.push(`${elapsed.toFixed(1)} s`);
  if (tokens) bits.push(`${tokens.toLocaleString()} tokens`);

  return (
    <div className="tnum mt-2.5 flex items-center gap-3 text-[12px] text-ink-faint">
      <span>{bits.join(" · ")}</span>
      <button type="button" onClick={copy} className="rounded px-1 text-ink-faint hover:bg-sheet-2 hover:text-ink">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
