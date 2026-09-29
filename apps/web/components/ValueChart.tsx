"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usd } from "@/lib/format";

interface Point {
  date: string;
  close: number;
}

/**
 * Portfolio value over time. Pure SVG drawn at the container's pixel width: an area
 * under the line, a dashed baseline at the period's opening value, and a hover
 * crosshair with the date and value.
 */
export function ValueChart({ points, height = 120 }: { points: Point[]; height?: number }) {
  const id = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padX = 4;
  const padTop = 12;
  const padBottom = 6;

  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const values = points.map((p) => p.close);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const x = (i: number) => padX + (i / (points.length - 1)) * (width - padX * 2);
    const y = (v: number) => padTop + (1 - (v - min) / range) * (height - padTop - padBottom);
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join(" ");
    const area = `${line} L${x(points.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
    return { x, y, line, area, baseline: y(points[0].close) };
  }, [points, width, height]);

  if (!geometry) return <div ref={wrapRef} style={{ height }} />;

  const first = points[0].close;
  const last = points[points.length - 1].close;
  const color = last >= first ? "var(--gain)" : "var(--loss)";
  const active = hover ?? points.length - 1;
  const activePoint = points[active];
  const delta = activePoint.close - first;
  const labelLeft = (geometry.x(active) / width) * 100;

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = (e.clientX - rect.left - padX) / (rect.width - padX * 2);
    setHover(Math.round(Math.min(Math.max(ratio, 0), 1) * (points.length - 1)));
  };

  return (
    <div ref={wrapRef} className="relative cursor-crosshair" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <div
        className="tnum pointer-events-none absolute top-0 z-10 whitespace-nowrap text-xs"
        style={{ left: `${labelLeft}%`, transform: `translateX(${labelLeft > 70 ? "-100%" : labelLeft < 30 ? "0" : "-50%"})` }}
      >
        <span className="rounded border border-rule bg-sheet px-1.5 py-0.5 text-ink-muted">
          {activePoint.date} · <span className="text-ink">{usd(activePoint.close, 0)}</span>{" "}
          <span className={delta >= 0 ? "text-gain" : "text-loss"}>
            {delta >= 0 ? "+" : "−"}
            {usd(Math.abs(delta), 0)}
          </span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="mt-6 block"
        role="img"
        aria-label={`Portfolio value from ${points[0].date} to ${points[points.length - 1].date}`}
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geometry.area} fill={`url(#${id}-fill)`} />
        <line x1={padX} x2={width - padX} y1={geometry.baseline} y2={geometry.baseline} stroke="var(--rule-strong)" strokeDasharray="3 4" />
        <path d={geometry.line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
        {hover !== null && <line x1={geometry.x(active)} x2={geometry.x(active)} y1={padTop - 6} y2={height} stroke="var(--ink-faint)" strokeOpacity="0.7" />}
        <circle cx={geometry.x(active)} cy={geometry.y(activePoint.close)} r="3.5" fill={color} stroke="var(--sheet)" strokeWidth="2" />
      </svg>
    </div>
  );
}
