"use client";

import { useState } from "react";
import type { ToolPart } from "@/lib/types";
import { prettyJson, summarizeArgs } from "@/lib/format";

const WRITE_TOOLS = new Set(["record_transaction", "update_watchlist", "set_target_allocation", "reset_demo_data"]);

/**
 * One node on the trace rail: what was called, with what, how long it took,
 * and (on demand) exactly what the MCP server returned.
 */
export function ToolCall({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const isWrite = WRITE_TOOLS.has(part.name);
  const args = summarizeArgs(part.input);
  const rows = countRows(part.output);
  const failed = Boolean(part.isError);

  return (
    <div role="listitem" className="rise relative">
      <RailDot status={part.status} failed={failed} />
      <div className={`rounded-md border ${failed ? "border-loss/50" : open ? "border-rule-strong" : "border-rule"} bg-sheet-2 text-sm`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <span className="shrink-0 font-mono text-[13px] font-medium text-ink">{part.name || "…"}</span>
            {isWrite && <span className="shrink-0 rounded bg-amber-soft px-1.5 py-px text-[11px] font-medium text-amber">write</span>}
            {args && <span className="min-w-0 truncate text-ink-muted">{args}</span>}
          </span>
          <span className="tnum shrink-0 text-xs text-ink-faint">
            {part.status === "done" ? (
              <>
                {failed && <span className="mr-2 text-loss">failed</span>}
                {rows !== null && <span className="mr-2">{rows === 1 ? "1 row" : `${rows} rows`}</span>}
                {part.durationMs !== undefined && `${part.durationMs} ms`}
              </>
            ) : part.status === "running" ? (
              "running"
            ) : (
              "preparing"
            )}
          </span>
          <Chevron open={open} />
        </button>

        {open && (
          <div className="grid gap-3 border-t border-rule px-3 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Pane title="Input">{part.input === undefined ? "(none)" : JSON.stringify(part.input, null, 2)}</Pane>
            <Pane title={failed ? "Error" : "Result"} error={failed}>
              {part.status === "done" ? prettyJson(part.output) || "(empty)" : "Waiting for the server…"}
            </Pane>
          </div>
        )}
      </div>
    </div>
  );
}

function RailDot({ status, failed }: { status: ToolPart["status"]; failed: boolean }) {
  const color = failed ? "bg-loss" : status === "done" ? "bg-gain" : "bg-amber";
  return (
    <span
      className={`absolute left-[-19px] top-[13px] h-[9px] w-[9px] rounded-full ring-2 ring-sheet ${color} ${status !== "done" ? "animate-pulse" : ""}`}
      aria-hidden
    />
  );
}

function Pane({ title, children, error }: { title: string; children: string; error?: boolean }) {
  return (
    <div className="min-w-0">
      <div className={`mb-1 text-xs font-medium ${error ? "text-loss" : "text-ink-muted"}`}>{title}</div>
      <pre className="scroll-thin max-h-72 overflow-auto rounded border border-rule bg-sheet p-2.5 font-mono text-[12px] leading-relaxed text-ink">
        {children}
      </pre>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className={`shrink-0 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Row count when the result is a JSON array. */
function countRows(output?: string): number | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}
