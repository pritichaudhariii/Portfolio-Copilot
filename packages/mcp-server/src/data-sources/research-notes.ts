import fs from "node:fs";
import path from "node:path";
import type { ResearchNote, Sentiment } from "../types.js";
import { SEED_DIR } from "../paths.js";

/**
 * Internal data source #3: the firm's research notes.
 *
 * Read-only, loaded from JSON. A real deployment would point this at a document
 * store or a vector index; the search here is a simple keyword ranker so the agent
 * can ask "what do we think about NVDA?" and get grounded, citable context.
 */
export class ResearchNotesSource {
  private readonly notes: ResearchNote[];

  constructor(options: { file?: string; notes?: ResearchNote[] } = {}) {
    this.notes =
      options.notes ??
      (JSON.parse(fs.readFileSync(options.file ?? path.join(SEED_DIR, "research-notes.json"), "utf8")) as ResearchNote[]);
  }

  all(): ResearchNote[] {
    return structuredClone(this.notes);
  }

  forSymbol(symbol: string): ResearchNote[] {
    const s = symbol.toUpperCase();
    return structuredClone(this.notes.filter((n) => n.symbol === s).sort(byDateDesc));
  }

  search(params: { query?: string; symbol?: string; sentiment?: Sentiment; limit?: number } = {}): ResearchNote[] {
    const { query, symbol, sentiment, limit = 5 } = params;
    const terms = (query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((t) => t.length > 1);

    const scored = this.notes
      .filter((n) => !symbol || n.symbol === symbol.toUpperCase())
      .filter((n) => !sentiment || n.sentiment === sentiment)
      .map((n) => ({ note: n, score: terms.length ? score(n, terms) : 1 }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || (a.note.date < b.note.date ? 1 : -1));

    return structuredClone(scored.slice(0, limit).map((r) => r.note));
  }
}

function score(note: ResearchNote, terms: string[]): number {
  const title = note.title.toLowerCase();
  const summary = note.summary.toLowerCase();
  const tags = note.tags.join(" ").toLowerCase();
  const symbol = note.symbol.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (symbol === t) s += 5;
    if (tags.includes(t)) s += 3;
    if (title.includes(t)) s += 2;
    if (summary.includes(t)) s += 1;
  }
  return s;
}

function byDateDesc(a: ResearchNote, b: ResearchNote): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}
