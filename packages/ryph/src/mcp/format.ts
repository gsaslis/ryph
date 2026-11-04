// How tool results read: short, so a model's context is spent on what matters. A record is
// compact JSON with the null fields and pictures dropped and long strings cut, a list one line per item, and
// anything cut says how to get the rest.

/** Long strings and arrays are cut here unless a caller asks for more. */
export interface CompactOptions {
  maxString?: number;
  maxItems?: number;
  /** How to read a cut string whole, said in its marker (`pass full: true`). */
  more?: string;
}

/**
 * Keys whose values are pictures for a page, never read: an MCP catalogue entry's
 * `brand.logo` (inline SVG) and a skill's `icons` (stored) and `iconSmall`/`iconLarge`
 * (presentation), each base64 bytes. Exact names, so a field merely starting with "icon" stays.
 */
const PICTURE_KEYS: ReadonlySet<string> = new Set(["logo", "icons", "iconSmall", "iconLarge"]);

/** Nothing in it: an empty string or array, or an object of only those. */
const isEmpty = (v: unknown): boolean =>
  v === undefined || v === "" || (Array.isArray(v) && v.length === 0) ||
  (v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(isEmpty));

/**
 * The value with nulls dropped, strings longer than `maxString` cut, and arrays longer than
 * `maxItems` cut, each saying so. Empty strings and arrays below the top are kept, since an
 * empty list can be the answer (`allowedTools: []` allows nothing); objects left with nothing
 * are dropped. Pictures (the values under the picture keys above) are dropped too, and
 * a score broken into its terms is its total, to two decimals: both are for a page, and a model
 * reads neither. A
 * wholly empty answer (nothing, or an object of only empty fields) is null.
 */
export function compact(value: unknown, opts: CompactOptions = {}): unknown {
  const maxString = opts.maxString ?? 4000;
  const maxItems = opts.maxItems ?? 50;
  const more = opts.more ? `; ${opts.more}` : "";
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === "string") {
      return v.length > maxString
        ? `${v.slice(0, maxString)}…[+${v.length - maxString} chars${more}]`
        : v;
    }
    if (Array.isArray(v)) {
      const items = v.slice(0, maxItems).map(walk).filter((x) => x !== undefined);
      if (v.length > maxItems) items.push(`…[+${v.length - maxItems} more]`);
      return items;
    }
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (PICTURE_KEYS.has(k)) continue;
        if (k === "score" && x !== null && typeof x === "object" && "total" in x) {
          out[k] = roundScore((x as { total: unknown }).total);
          continue;
        }
        if (k === "score" && typeof x === "number") {
          out[k] = roundScore(x);
          continue;
        }
        const w = walk(x);
        if (w !== undefined) out[k] = w;
      }
      return Object.keys(out).length === 0 ? undefined : out;
    }
    return v;
  };
  const kept = walk(value);
  return isEmpty(kept) ? null : kept;
}

/** A ranking score to two decimals: 1.4999978366142144 reads as 1.5. */
function roundScore(v: unknown): unknown {
  return typeof v === "number" ? Math.round(v * 100) / 100 : v;
}

/** A page's place in a list: empty, it says nothing about the answer. */
const PAGING_KEYS: ReadonlySet<string> = new Set([
  "nextCursor",
  "cursor",
  "prevCursor",
  "hasMore",
]);

/** Words for a field kept proper-cased when a key is spelt out. */
const PROPER_WORDS: ReadonlySet<string> = new Set(["Dockerfile", "Dockerfiles"]);

/** A camelCase key as words: `ignoredDockerfiles` → "ignored Dockerfiles". */
function spelt(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ").map((w) =>
    PROPER_WORDS.has(w) || /^[A-Z0-9]+s?$/.test(w) ? w : w.toLowerCase()
  ).join(" ");
}

/**
 * A record as compact JSON. One with nothing left in it says so in words, naming the fields that
 * came back empty (`{"images": []}` → "No images.", `ignoredDockerfiles` → "No ignored
 * Dockerfiles."), never a bare `null`; a paging field (`nextCursor`) is never named.
 */
export function record(value: unknown, opts?: CompactOptions): string {
  const kept = compact(value, opts);
  if (kept !== null) return JSON.stringify(kept);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value).filter((k) => !PAGING_KEYS.has(k));
    if (keys.length > 0) return keys.map((k) => `No ${spelt(k)}.`).join(" ");
    return "Nothing.";
  }
  return "None.";
}

/** One line of at most `max` characters: whitespace runs folded, the cut marked. */
export function clip(text: string | null | undefined, max = 160): string {
  if (!text) return "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** At most `max` characters of a multi-line text, cut at the end and saying how much was. */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[+${text.length - max} chars]` : text;
}

/** The last `n` lines of a text. */
export function lastLines(text: string, n: number): { text: string; dropped: number } {
  const lines = text.replace(/\n$/, "").split("\n");
  const dropped = Math.max(0, lines.length - n);
  return { text: lines.slice(dropped).join("\n"), dropped };
}

/** How long ago an ISO time was, roughly: "5s", "3m", "2h", "4d". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** A duration in ms, roughly. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

/** Lines joined, the empty ones between sections kept, `undefined`/`false` dropped. */
export function lines(...parts: Array<string | false | null | undefined | string[]>): string {
  return parts.flat().filter((p): p is string => typeof p === "string").join("\n");
}
