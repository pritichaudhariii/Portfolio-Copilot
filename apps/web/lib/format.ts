export const usd = (n: number, digits = 2): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export const pct = (n: number, digits = 1): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}%`;

export const signed = (n: number, digits = 2): string => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n), digits)}`;

export const ASSET_CLASS_LABEL: Record<string, string> = {
  us_equity: "US equity",
  intl_equity: "International equity",
  bond: "Bonds",
  real_estate: "Real estate",
  crypto: "Crypto",
  cash: "Cash"
};

export const label = (key: string): string => ASSET_CLASS_LABEL[key] ?? key.replace(/_/g, " ");

/** Compact one-line rendering of tool arguments: key: value, key: value. */
export function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : JSON.stringify(v);
      return `${k}: ${s.length > 60 ? s.slice(0, 57) + "…" : s}`;
    })
    .join("  ·  ");
}

/** Pretty-prints JSON text; returns the input untouched if it is not JSON. */
export function prettyJson(text: string | undefined): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
