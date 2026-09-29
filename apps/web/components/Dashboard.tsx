"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { label, pct, signed, usd } from "@/lib/format";
import { ValueChart } from "./ValueChart";

interface Slice {
  key: string;
  value: number;
  weight: number;
}

interface Summary {
  asOf: string;
  totalValue: number;
  totalCost: number;
  unrealizedGain: number;
  unrealizedGainPct: number;
  dayChange: number;
  dayChangePct: number;
  cashValue: number;
  positions: number;
  byAssetClass: Slice[];
  bySector: Slice[];
  byAccount: Slice[];
}

interface HoldingRow {
  symbol: string;
  name: string;
  assetClass: string;
  sector: string;
  quantity: number;
  price: number;
  marketValue: number;
  unrealizedGain: number;
  unrealizedGainPct: number;
  dayChangePct: number;
  weight: number;
}

interface History {
  startValue: number;
  endValue: number;
  periodReturnPct: number;
  points: Array<{ date: string; close: number }>;
}

interface Drift {
  needsRebalance: boolean;
  thresholdPct: number;
  rows: Array<{ assetClass: string; targetPct: number; currentPct: number; driftPct: number; needsRebalance: boolean }>;
}

interface PortfolioData {
  range: string;
  summary: Summary;
  holdings: HoldingRow[];
  history: History;
  drift: Drift;
}

type Range = "1m" | "3m" | "6m" | "1y";
const RANGE_LABEL: Record<Range, string> = { "1m": "1M", "3m": "3M", "6m": "6M", "1y": "1Y" };

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: PortfolioData; updatedAt: number };

export function Dashboard({ refreshKey }: { refreshKey: number }) {
  const [range, setRange] = useState<Range>("3m");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/portfolio?range=${range}`);
      const body = (await res.json()) as PortfolioData & { error?: string };
      if (!res.ok || body.error) setState({ kind: "error", message: body.error ?? `HTTP ${res.status}` });
      else setState({ kind: "ready", data: body, updatedAt: Date.now() });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRefreshing(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <div className="panel scroll-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-5">
      {state.kind === "loading" && <Skeleton />}
      {state.kind === "error" && (
        <div className="rounded-md border border-loss/40 bg-loss-soft px-3 py-2 text-sm text-loss">
          <p className="font-medium">Portfolio unavailable</p>
          <p className="mt-1 break-words">{state.message}</p>
          <button type="button" onClick={() => void load()} className="mt-2 rounded border border-loss/40 px-2 py-0.5 text-xs hover:bg-sheet">
            Try again
          </button>
        </div>
      )}
      {state.kind === "ready" && (
        <Body data={state.data} range={range} onRange={setRange} refreshing={refreshing} onRefresh={() => void load()} updatedAt={state.updatedAt} />
      )}
    </div>
  );
}

function Body({
  data,
  range,
  onRange,
  refreshing,
  onRefresh,
  updatedAt
}: {
  data: PortfolioData;
  range: Range;
  onRange: (r: Range) => void;
  refreshing: boolean;
  onRefresh: () => void;
  updatedAt: number;
}) {
  const { summary, holdings, history, drift } = data;
  const dayUp = summary.dayChange >= 0;

  return (
    <>
      <section aria-label="Overview">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <span>Total value</span>
              <span className="text-ink-faint">·</span>
              <span>{summary.asOf}</span>
              <RefreshButton refreshing={refreshing} onRefresh={onRefresh} updatedAt={updatedAt} />
            </div>
            <div className="tnum mt-0.5 text-[32px] font-semibold leading-none tracking-tight">{usd(summary.totalValue, 0)}</div>
          </div>
          <div className={`tnum text-right ${dayUp ? "text-gain" : "text-loss"}`}>
            <div className="text-lg font-medium leading-tight">{signed(summary.dayChange, 0)}</div>
            <div className="text-sm">{pct(summary.dayChangePct, 2)} today</div>
          </div>
        </div>

        <div className="mt-3">
          <ValueChart points={history.points} />
          <div className="mt-1.5 flex items-center justify-between">
            <div className="flex rounded-md border border-rule bg-sheet-2 p-0.5" role="tablist" aria-label="Range">
              {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
                <button
                  key={r}
                  role="tab"
                  aria-selected={range === r}
                  onClick={() => onRange(r)}
                  className={`rounded px-2 py-0.5 text-xs ${range === r ? "bg-sheet text-ink shadow-sm" : "text-ink-muted hover:text-ink"}`}
                >
                  {RANGE_LABEL[r]}
                </button>
              ))}
            </div>
            <span className={`tnum text-xs ${history.periodReturnPct >= 0 ? "text-gain" : "text-loss"}`}>
              {pct(history.periodReturnPct, 1)} · {signed(history.endValue - history.startValue, 0)}
            </span>
          </div>
        </div>

        <dl className="tnum mt-4 grid grid-cols-3 gap-x-4 gap-y-3 border-t border-rule pt-3 text-sm">
          <Stat term="Unrealized gain" value={signed(summary.unrealizedGain, 0)} sub={pct(summary.unrealizedGainPct, 1)} tone={summary.unrealizedGain >= 0 ? "gain" : "loss"} />
          <Stat term="Cash" value={usd(summary.cashValue, 0)} sub={`${((summary.cashValue / summary.totalValue) * 100).toFixed(1)}% of total`} />
          <Stat term="Positions" value={String(summary.positions)} sub={`${summary.byAccount.length} accounts`} />
        </dl>
      </section>

      <Allocation summary={summary} drift={drift} />

      <Holdings rows={holdings} />
    </>
  );
}

// ---- Allocation ----------------------------------------------------------------------

type View = "class" | "sector" | "account";

function Allocation({ summary, drift }: { summary: Summary; drift: Drift }) {
  const [view, setView] = useState<View>("class");

  return (
    <section aria-label="Allocation" className="border-t border-rule pt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Allocation</h2>
        <div className="flex rounded-md border border-rule bg-sheet-2 p-0.5" role="tablist" aria-label="Allocation view">
          {(
            [
              ["class", "Asset class"],
              ["sector", "Sector"],
              ["account", "Account"]
            ] as Array<[View, string]>
          ).map(([v, name]) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`rounded px-2 py-0.5 text-xs ${view === v ? "bg-sheet text-ink shadow-sm" : "text-ink-muted hover:text-ink"}`}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {view === "class" ? (
        <>
          <p className={`mt-1 text-xs ${drift.needsRebalance ? "text-amber" : "text-ink-muted"}`}>
            {drift.needsRebalance
              ? `${drift.rows.filter((r) => r.needsRebalance).length} classes are more than ${drift.thresholdPct} pts from target`
              : `All classes within ${drift.thresholdPct} pts of target`}
          </p>
          <ul className="mt-2.5 flex flex-col gap-2.5">
            {drift.rows
              .filter((r) => r.targetPct > 0 || r.currentPct > 0)
              .map((r) => (
                <li key={r.assetClass} className="text-sm">
                  <div className="flex items-baseline justify-between">
                    <span>{label(r.assetClass)}</span>
                    <span className="tnum text-ink-muted">
                      <span className={r.needsRebalance ? "font-medium text-amber" : "text-ink"}>{r.currentPct.toFixed(1)}%</span>
                      <span className="mx-1 text-ink-faint">/</span>
                      <span title="target">{r.targetPct}%</span>
                    </span>
                  </div>
                  <TargetBar current={r.currentPct} target={r.targetPct} flagged={r.needsRebalance} />
                </li>
              ))}
          </ul>
        </>
      ) : (
        <ul className="mt-3 flex flex-col gap-2.5">
          {(view === "sector" ? summary.bySector : summary.byAccount).map((s) => (
            <li key={s.key} className="text-sm">
              <div className="flex items-baseline justify-between">
                <span>{s.key}</span>
                <span className="tnum text-ink-muted">
                  <span className="text-ink">{s.weight.toFixed(1)}%</span>
                  <span className="mx-1 text-ink-faint">·</span>
                  {usd(s.value, 0)}
                </span>
              </div>
              <div className="mt-1 h-2 w-full rounded-sm bg-sheet-2" aria-hidden>
                <div className="h-full rounded-sm bg-blue" style={{ width: `${Math.min(s.weight, 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Current weight as a bar, target as a tick, on a shared scale. */
function TargetBar({ current, target, flagged }: { current: number; target: number; flagged: boolean }) {
  const max = Math.max(current, target, 1) * 1.15;
  return (
    <div className="relative mt-1 h-2 w-full rounded-sm bg-sheet-2" aria-hidden>
      <div className={`h-full rounded-sm ${flagged ? "bg-amber" : "bg-blue"}`} style={{ width: `${(current / max) * 100}%` }} />
      <div className="absolute top-[-2px] h-3 w-0.5 rounded-sm bg-ink" style={{ left: `calc(${(target / max) * 100}% - 1px)` }} title={`target ${target}%`} />
    </div>
  );
}

// ---- Holdings ------------------------------------------------------------------------

type SortKey = "marketValue" | "weight" | "unrealizedGainPct" | "dayChangePct" | "symbol";

function Holdings({ rows }: { rows: HoldingRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "marketValue", dir: -1 });

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      if (sort.key === "symbol") return a.symbol.localeCompare(b.symbol) * sort.dir;
      // Cash has no P&L; keep it at the bottom for those columns.
      const av = a.assetClass === "cash" && sort.key !== "marketValue" && sort.key !== "weight" ? -Infinity : a[sort.key];
      const bv = b.assetClass === "cash" && sort.key !== "marketValue" && sort.key !== "weight" ? -Infinity : b[sort.key];
      return (av - bv) * sort.dir;
    });
    return out;
  }, [rows, sort]);

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "symbol" ? 1 : -1 }));

  const Th = ({ k, children, className = "" }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={`pb-1.5 font-medium ${className}`}>
      <button type="button" onClick={() => toggle(k)} className={`inline-flex items-center gap-1 hover:text-ink ${sort.key === k ? "text-ink" : ""}`}>
        {children}
        <span className="text-[9px]" aria-hidden>
          {sort.key === k ? (sort.dir === -1 ? "▼" : "▲") : ""}
        </span>
      </button>
    </th>
  );

  const maxValue = Math.max(...rows.map((r) => r.marketValue), 1);

  return (
    <section aria-label="Holdings" className="border-t border-rule pt-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Holdings</h2>
        <span className="text-xs text-ink-muted">merged across accounts</span>
      </div>
      <table className="tnum mt-2 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-muted">
            <Th k="symbol">Symbol</Th>
            <Th k="marketValue" className="text-right">
              Value
            </Th>
            <Th k="weight" className="text-right">
              Weight
            </Th>
            <Th k="unrealizedGainPct" className="text-right">
              Gain
            </Th>
            <Th k="dayChangePct" className="hidden text-right sm:table-cell">
              Today
            </Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((h) => {
            const cash = h.assetClass === "cash";
            return (
              <tr key={h.symbol} className="border-t border-rule">
                <td className="py-2 pr-2">
                  <div className="font-medium">{h.symbol}</div>
                  <div className="truncate text-xs text-ink-muted" title={h.name}>
                    {cash ? h.name : `${h.quantity.toLocaleString()} @ ${usd(h.price)}`}
                  </div>
                </td>
                <td className="py-2 text-right align-top">
                  {usd(h.marketValue, 0)}
                  <div className="ml-auto mt-1 h-1 w-14 rounded-sm bg-sheet-2" aria-hidden>
                    <div className="h-full rounded-sm bg-rule-strong" style={{ width: `${(h.marketValue / maxValue) * 100}%` }} />
                  </div>
                </td>
                <td className="py-2 text-right align-top text-ink-muted">{h.weight.toFixed(1)}%</td>
                <td className={`py-2 text-right align-top ${cash ? "text-ink-faint" : h.unrealizedGain >= 0 ? "text-gain" : "text-loss"}`}>
                  {cash ? "—" : pct(h.unrealizedGainPct, 1)}
                </td>
                <td className={`hidden py-2 text-right align-top sm:table-cell ${cash ? "text-ink-faint" : h.dayChangePct >= 0 ? "text-gain" : "text-loss"}`}>
                  {cash ? "—" : pct(h.dayChangePct, 2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---- Bits -------------------------------------------------------------------------------

function Stat({ term, value, sub, tone }: { term: string; value: string; sub: string; tone?: "gain" | "loss" }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{term}</dt>
      <dd className={`mt-0.5 font-medium ${tone === "gain" ? "text-gain" : tone === "loss" ? "text-loss" : ""}`}>{value}</dd>
      <dd className="text-xs text-ink-muted">{sub}</dd>
    </div>
  );
}

function RefreshButton({ refreshing, onRefresh, updatedAt }: { refreshing: boolean; onRefresh: () => void; updatedAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  const ago = seconds < 10 ? "just now" : seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      title="Re-read from the MCP server"
      className="inline-flex items-center gap-1 rounded px-1 text-xs text-ink-faint hover:bg-sheet-2 hover:text-ink disabled:opacity-60"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={refreshing ? "animate-spin" : ""} aria-hidden>
        <path d="M21 12a9 9 0 1 1-2.6-6.4" />
        <path d="M21 3v6h-6" />
      </svg>
      {refreshing ? "updating" : ago}
    </button>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse" aria-label="Loading portfolio">
      <div className="h-3 w-40 rounded bg-sheet-2" />
      <div className="mt-2 h-8 w-48 rounded bg-sheet-2" />
      <div className="mt-6 h-[120px] rounded bg-sheet-2" />
      <div className="mt-6 grid grid-cols-3 gap-4">
        <div className="h-10 rounded bg-sheet-2" />
        <div className="h-10 rounded bg-sheet-2" />
        <div className="h-10 rounded bg-sheet-2" />
      </div>
      <div className="mt-8 flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-5 rounded bg-sheet-2" />
        ))}
      </div>
    </div>
  );
}
