// `evaluate`, the part that is not Chromium: how the agent's function is wrapped before it is
// sent into the page, and how what comes back is shaped for a model.
//
// The agent hands us FUNCTION SOURCE (`() => document.title`, `(el) => el.value`). It is wrapped
// in an async function that calls it with the element (when a ref was given), AWAITS its result
// — a promise is what most interesting page state is behind — and serialises the value INSIDE
// the page, where a DOM node can still be described: `<button#save.primary> "Save"` is what an
// agent wants to read, and Playwright's own serialisation would hand it `{}` or a handle. The
// serialiser is bounded on every axis (depth, items, keys, string length, the JSON's own size)
// so that `() => document` or a ten-million-element array cannot become a ten-megabyte reply
// before the 20 KB cap gets to look at it.
//
// THE CAP IS NOT THE PAGE'S TO KEEP. The serialiser runs in the page's main world — it must,
// since the agent's function reads the app's own state (a store, a global), which an isolated
// world cannot see (measured: an isolated world shares the DOM but sees `window.__store` as
// undefined) — and so runs on builtins the page may have redefined: a page that replaces
// `JSON.stringify` or `String.prototype.slice` can make it answer fifty megabytes. So its answer
// stays in the page as a handle, and what crosses to the sidecar is pulled out by `cutSerialised`,
// which reads at most cap + 1 characters using only the language itself (typeof, a primitive
// string's length and index, `+`) — nothing a page can redefine — and hands back ONE primitive
// string, which the protocol carries by value without running any page code.
//
// The TIME bound lives in the adapter (a CDP `Runtime.terminateExecution` on timeout), because
// `while (true) {}` holds the renderer's main thread and no promise race inside the page could
// ever win against it.

/** What `evaluate` returns, at most. */
export const EVALUATE_RESULT_CAP = 20 * 1024;
export const EVALUATE_DEFAULT_TIMEOUT_MS = 5_000;
export const EVALUATE_MAX_TIMEOUT_MS = 30_000;

/** The serialiser's answer, as it comes back out of the page. */
export interface Serialised {
  /** JSON text of the value (or the words "undefined"), cut at `cap` + 1 characters. */
  text: string;
  /** Its length before that cut. */
  total: number;
}

/**
 * The serialiser, as it runs IN THE PAGE. Self-contained on purpose — it is sent as source
 * (`Function.prototype.toString`), so it may reference nothing outside its own body.
 */
function serialise(value: unknown, cap: number): { text: string; total: number } {
  // The DOM, in the few shapes used here. Declared rather than taken from lib.dom, which would
  // leak browser globals into the type check of every module of this program.
  interface DomNode {
    nodeType: number;
    nodeName: string;
    textContent: string | null;
    childNodes: { length: number };
    URL?: string;
  }
  interface DomElement extends DomNode {
    tagName: string;
    id: string;
    classList: Iterable<string>;
    innerText?: string;
    value?: unknown;
    getAttribute(name: string): string | null;
  }
  const g = globalThis as unknown as Record<string, unknown>;
  const isA = (o: object, name: string): boolean =>
    typeof g[name] === "function" && o instanceof (g[name] as new () => unknown);
  const MAX_DEPTH = 8;
  const MAX_ITEMS = 200;
  const MAX_KEYS = 200;
  const MAX_STRING = 4000;
  const seen = new WeakSet<object>();
  const squash = (s: string, max: number): string => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
  };
  const describeNode = (n: DomNode): string => {
    if (n.nodeType === 1) {
      const el = n as DomElement;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? "#" + el.id : "";
      const classes = Array.from(el.classList).slice(0, 3).map((c) => "." + c).join("");
      const attrs = ["name", "type", "role", "href", "aria-label"]
        .map((a) => {
          const v = el.getAttribute(a);
          return v === null ? "" : ` ${a}="${squash(v, 60)}"`;
        })
        .join("");
      const text = squash(el.innerText ?? el.textContent ?? "", 80);
      // A field's value is what an agent asks a node for; a button's `value` is noise.
      const field = tag === "input" || tag === "textarea" || tag === "select";
      const val = field && typeof el.value === "string" ? ` value="${squash(el.value, 60)}"` : "";
      return `<${tag}${id}${classes}${attrs}${val}>${text ? ` "${text}"` : ""}`;
    }
    if (n.nodeType === 3) return `#text "${squash(n.textContent ?? "", 80)}"`;
    if (n.nodeType === 8) return `<!-- ${squash(n.textContent ?? "", 80)} -->`;
    if (n.nodeType === 9) return `[document ${n.URL}]`;
    if (n.nodeType === 11) return `[fragment of ${n.childNodes.length} nodes]`;
    return `[${n.nodeName}]`;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null) return null;
    switch (typeof v) {
      case "string": {
        // A string that IS the result may fill the whole cap; one inside a structure may not
        // crowd out its siblings.
        const limit = depth === 0 ? cap : MAX_STRING;
        return v.length > limit ? v.slice(0, limit) + `… (${v.length} chars)` : v;
      }
      case "number":
        return Number.isFinite(v) ? v : String(v);
      case "boolean":
        return v;
      case "undefined":
        return "[undefined]";
      case "bigint":
        return `${v}n`;
      case "symbol":
        return `[${v.toString()}]`;
      case "function":
        return `[function ${(v as { name?: string }).name || "anonymous"}]`;
    }
    const o = v as object;
    if (isA(o, "Window")) return "[window]";
    if (isA(o, "Node")) return describeNode(o as DomNode);
    if (seen.has(o)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[…]";
    seen.add(o);
    try {
      if (o instanceof Date) return isNaN(o.getTime()) ? "[invalid date]" : o.toISOString();
      if (o instanceof Error) return `[${o.name}: ${o.message}]`;
      if (o instanceof RegExp) return o.toString();
      if (o instanceof Map) {
        const out: Record<string, unknown> = {};
        let n = 0;
        for (const [k, val] of o) {
          if (n++ >= MAX_KEYS) {
            out["…"] = `${o.size - MAX_KEYS} more entries`;
            break;
          }
          out[typeof k === "string" ? k : String(walk(k, depth + 1))] = walk(val, depth + 1);
        }
        return out;
      }
      const listLike = Array.isArray(o) || o instanceof Set ||
        isA(o, "NodeList") || isA(o, "HTMLCollection") ||
        ArrayBuffer.isView(o);
      if (listLike) {
        const items = Array.from(o as Iterable<unknown>);
        const out = items.slice(0, MAX_ITEMS).map((item) => walk(item, depth + 1));
        if (items.length > MAX_ITEMS) out.push(`… ${items.length - MAX_ITEMS} more items`);
        return out;
      }
      const out: Record<string, unknown> = {};
      const keys = Object.keys(o);
      for (const k of keys.slice(0, MAX_KEYS)) {
        try {
          out[k] = walk((o as Record<string, unknown>)[k], depth + 1);
        } catch (err) {
          out[k] = `[getter threw: ${String(err)}]`;
        }
      }
      if (keys.length > MAX_KEYS) out["…"] = `${keys.length - MAX_KEYS} more keys`;
      return out;
    } finally {
      seen.delete(o);
    }
  };
  const shaped = walk(value, 0);
  const text = value === undefined ? "undefined" : JSON.stringify(shaped, null, 2);
  return { text: text.length > cap ? text.slice(0, cap + 1) : text, total: text.length };
}

/**
 * The function source sent into the page: the agent's function, called with the element (or
 * nothing), awaited, and serialised. A source that is not a function expression fails the call
 * with a message that says so, rather than evaluating to the expression's value — the tool's
 * contract is a function, and a stray expression with side effects should not half-work.
 */
export function wrapEvaluate(source: string, cap = EVALUATE_RESULT_CAP): string {
  return `async (__ryphElement) => {
  const __ryphFn = (
${source}
  );
  if (typeof __ryphFn !== "function") {
    throw new TypeError("evaluate takes a function, like () => document.title or (el) => el.value");
  }
  const __ryphValue = await __ryphFn(__ryphElement);
  return (${serialise.toString()})(__ryphValue, ${cap});
}`;
}

/**
 * Runs IN THE PAGE, on the handle to the serialiser's answer: at most `cap` + 1 characters of its
 * text, prefixed with its full length, as one primitive string (`"51200:[…]"`); null when the
 * answer is not the shape the serialiser builds. Self-contained like the serialiser, and written
 * with language operations only — no method call, no global — because the page has had every
 * chance to redefine the builtins (see the note at the top).
 */
export function cutSerialised(answer: unknown, cap: number): string | null {
  if (answer === null || typeof answer !== "object") return null;
  // An own data property of the literal the serialiser returned: no getter of the page's runs.
  const text = (answer as { text?: unknown }).text;
  const claimed = (answer as { total?: unknown }).total;
  if (typeof text !== "string") return null;
  const total = typeof claimed === "number" && claimed >= text.length ? claimed : text.length;
  const n = text.length < cap + 1 ? text.length : cap + 1;
  let out = "";
  for (let i = 0; i < n; i++) out += text[i];
  return total + ":" + out;
}

/** What `cutSerialised` sent back, parsed; anything else is a broken page. */
export function parseCut(value: unknown, cap: number): Serialised | null {
  if (typeof value !== "string") return null;
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const total = Number(value.slice(0, colon));
  const text = value.slice(colon + 1);
  if (!Number.isFinite(total) || text.length > cap + 1) return null;
  return { text, total: Math.max(total, text.length) };
}

/** Exposed for the unit tests, which run the serialiser outside any page. */
export const serialiseForTest = serialise;
