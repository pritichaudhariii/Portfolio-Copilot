"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/use-theme";

export type ServerStatus =
  | { state: "connecting" }
  | { state: "error"; message: string }
  | {
      state: "connected";
      serverName: string;
      serverVersion: string;
      serverUrl: string;
      model: string;
      toolCount: number;
      resourceCount: number;
    };

interface HeaderProps {
  status: ServerStatus;
  mobilePane: "chat" | "portfolio";
  onMobilePane: (pane: "chat" | "portfolio") => void;
}

export function Header({ status, mobilePane, onMobilePane }: HeaderProps) {
  const [theme, toggleTheme] = useTheme();

  return (
    <header className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-3 px-4 py-3.5 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <Mark />
        <div className="hidden min-w-0 sm:block">
          <h1 className="whitespace-nowrap text-[17px] font-semibold leading-tight tracking-tight">Portfolio Copilot</h1>
          <p className="hidden truncate text-[13px] text-ink-muted sm:block">An agent over your ledger, served by MCP</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex rounded-md border border-rule bg-sheet p-0.5 text-sm lg:hidden" role="tablist" aria-label="Panel">
          {(["chat", "portfolio"] as const).map((pane) => (
            <button
              key={pane}
              role="tab"
              aria-selected={mobilePane === pane}
              onClick={() => onMobilePane(pane)}
              className={`rounded px-3 py-1 capitalize ${mobilePane === pane ? "bg-blue text-on-blue" : "text-ink-muted"}`}
            >
              {pane}
            </button>
          ))}
        </div>
        <StatusPill status={status} />
        <HowItWorks status={status} />
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
          className="grid h-8 w-8 place-items-center rounded-md border border-rule bg-sheet text-ink-muted hover:text-ink"
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}

/** Wordmark: a ledger rule with a rising tick. */
function Mark() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" role="img" aria-label="Portfolio Copilot" className="shrink-0 text-blue">
      <rect x="0.5" y="0.5" width="29" height="29" rx="7" fill="var(--blue-soft)" stroke="currentColor" strokeOpacity="0.35" />
      <path d="M7 19.5h16" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 17l4-4 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="22" cy="9" r="2" fill="currentColor" />
    </svg>
  );
}

function StatusPill({ status }: { status: ServerStatus }) {
  const base = "inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-[13px]";
  if (status.state === "connecting") {
    return (
      <span className={`${base} border-rule bg-sheet text-ink-muted`}>
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber" aria-hidden />
        <span className="hidden sm:inline">Connecting to MCP server</span>
        <span className="sr-only sm:hidden">Connecting to MCP server</span>
      </span>
    );
  }
  if (status.state === "error") {
    return (
      <span className={`${base} max-w-[300px] border-loss/40 bg-loss-soft text-loss`} title={status.message}>
        <span className="h-2 w-2 shrink-0 rounded-full bg-loss" aria-hidden />
        <span className="hidden truncate sm:inline">MCP server unreachable</span>
        <span className="sr-only sm:hidden">MCP server unreachable</span>
      </span>
    );
  }
  return (
    <span className={`${base} border-rule bg-sheet text-ink-muted`} title={`${status.serverUrl}\nmodel: ${status.model}`}>
      <span className="h-2 w-2 rounded-full bg-gain" aria-hidden />
      <span className="sr-only sm:hidden">Connected to MCP server</span>
      <span className="hidden font-mono text-[12.5px] text-ink sm:inline">
        {status.serverName} {status.serverVersion}
      </span>
      <span className="hidden md:inline">
        {status.toolCount} tools · {status.resourceCount} resources
      </span>
    </span>
  );
}

function HowItWorks({ status }: { status: ServerStatus }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const model = status.state === "connected" ? status.model : "the model";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="h-8 rounded-md border border-rule bg-sheet px-2.5 text-[13px] text-ink-muted hover:text-ink"
        title="How it works"
      >
        <span className="hidden md:inline">How it works</span>
        <span className="md:hidden" aria-hidden>
          ?
        </span>
        <span className="sr-only md:hidden">How it works</span>
      </button>
      {open && (
        <div className="panel rise absolute right-0 top-10 z-20 w-[340px] p-4 text-sm">
          <ol className="flex flex-col gap-3">
            <Step n="1" title="You ask">
              The browser posts the conversation to <code className="font-mono text-[12.5px]">/api/chat</code> and reads back a stream of events.
            </Step>
            <Step n="2" title="The agent fetches its tools">
              The runtime connects to the MCP server, lists its tools, and hands their JSON schemas to <span className="font-mono text-[12.5px]">{model}</span>.
            </Step>
            <Step n="3" title="Calls run against the server">
              When the model asks for a tool, the runtime calls it over MCP, streams the result into the trace, and feeds it back until the model is done.
            </Step>
            <Step n="4" title="The dashboard reads the same tools">
              No second data path: the panel on the right is <code className="font-mono text-[12.5px]">get_portfolio_summary</code>, <code className="font-mono text-[12.5px]">get_holdings</code> and friends, called directly.
            </Step>
          </ol>
          <p className="mt-3 border-t border-rule pt-3 text-xs text-ink-muted">Prices are simulated. Writes change the demo ledger and persist until reset.</p>
        </div>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="tnum mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-blue-soft text-[11px] font-medium text-blue">{n}</span>
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-ink-muted">{children}</div>
      </div>
    </li>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
