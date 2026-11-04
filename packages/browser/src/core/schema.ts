// The tools' inputs, as zod schemas: every argument is parsed here before it reaches Chromium,
// and the same schemas are the JSON Schema `tools/list` answers (`jsonSchemaOf`), so the contract
// the model reads and the one this sidecar enforces cannot drift. Names and fields are a
// contract — the app presents these calls by them.

import { z } from "@zod/zod";
import { EVALUATE_MAX_TIMEOUT_MS } from "./evaluate.ts";

/** A ref from the latest snapshot: `e12`, or `f1e3` for an element inside a frame. */
const ref = z.string().trim().regex(/^(f\d+)?e\d+$/, "a ref looks like e12 (from the snapshot)")
  .describe("The element's ref from the latest snapshot, like e12");
const element = z.string().trim().min(1).max(300).describe(
  "A short human description of the element, like 'the Save button' — shown to people watching",
);

export const NavigateArgs = z.object({
  url: z.string().trim().min(1).max(8192).describe(
    "The address to open, like http://localhost:5173/settings. Without a scheme, http:// is assumed",
  ),
});

export const NoArgs = z.object({});

export const ClickArgs = z.object({
  ref,
  element,
  button: z.enum(["left", "right", "middle"]).optional().describe("Which button (default left)"),
  doubleClick: z.boolean().optional().describe("A double click instead of a single one"),
  modifiers: z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).max(5)
    .optional().describe("Keys held during the click"),
});

export const TypeArgs = z.object({
  ref,
  element,
  text: z.string().max(100_000).describe("The text to enter"),
  submit: z.boolean().optional().describe("Press Enter afterwards"),
  slowly: z.boolean().optional().describe(
    "Type one key at a time, appending to what is there, so key handlers fire per character. " +
      "By default the field's value is replaced in one go",
  ),
});

export const PressKeyArgs = z.object({
  key: z.string().trim().min(1).max(100).describe(
    "A key or chord in Playwright's names: Enter, Escape, ArrowDown, Tab, Control+a, Shift+Tab",
  ),
});

export const HoverArgs = z.object({ ref, element });

export const SelectOptionArgs = z.object({
  ref,
  element,
  values: z.array(z.string().max(1000)).min(1).max(100).describe(
    "The options to select, by value or by label",
  ),
});

export const ScrollArgs = z.object({
  deltaX: z.number().finite().min(-100_000).max(100_000).optional().describe(
    "Horizontal wheel distance in CSS pixels (positive scrolls right)",
  ),
  deltaY: z.number().finite().min(-100_000).max(100_000).optional().describe(
    "Vertical wheel distance in CSS pixels (positive scrolls down)",
  ),
});

export const WaitForArgs = z.object({
  text: z.string().min(1).max(1000).optional().describe("Wait until this text is visible"),
  textGone: z.string().min(1).max(1000).optional().describe("Wait until this text is gone"),
  seconds: z.number().finite().min(0).max(30).optional().describe("Wait this long (at most 30)"),
}).refine(
  (a) => [a.text, a.textGone, a.seconds].filter((v) => v !== undefined).length === 1,
  "give exactly one of text, textGone or seconds",
);

export const ScreenshotArgs = z.object({
  fullPage: z.boolean().optional().describe("The whole scrollable page, not just the viewport"),
  ref: ref.optional().describe("Only this element (a ref from the latest snapshot)"),
});

export const EvaluateArgs = z.object({
  function: z.string().trim().min(1).max(100_000).describe(
    "JavaScript function source, run in the page: `() => document.title`, or `(el) => el.value` " +
      "with a ref. Promises are awaited; the result is JSON (DOM nodes are described)",
  ),
  ref: ref.optional().describe(
    "Pass this element (a ref from the latest snapshot) as the argument",
  ),
  timeoutMs: z.number().int().min(1).max(EVALUATE_MAX_TIMEOUT_MS).optional().describe(
    "How long it may run before it is stopped (default 5000, at most 30000)",
  ),
});

export const AddInitScriptArgs = z.object({
  script: z.string().min(1).max(100_000).describe(
    "JavaScript run at the start of every LATER page load in this browser, before the page's own " +
      "scripts: stub fetch, freeze time, seed localStorage. Reload or navigate to apply it",
  ),
});

export const ConsoleMessagesArgs = z.object({
  level: z.enum(["debug", "log", "info", "warn", "error"]).optional().describe(
    "Only this level and above (default: everything)",
  ),
});

export const NetworkRequestsArgs = z.object({
  all: z.boolean().optional().describe(
    "Every request, images and scripts included. By default: documents, fetch/XHR and failures",
  ),
});

export const TabsArgs = z.object({
  action: z.enum(["list", "new", "select", "close"]),
  index: z.number().int().min(0).max(100).optional().describe(
    "The tab's position, from 0 (select and close; close defaults to the current tab)",
  ),
  url: z.string().trim().min(1).max(8192).optional().describe("For new: the address to open"),
});

export const ResizeArgs = z.object({
  width: z.number().int().min(200).max(3840).describe("Viewport width in CSS pixels"),
  height: z.number().int().min(200).max(2160).describe("Viewport height in CSS pixels"),
});

/** The schema as the JSON Schema `tools/list` carries. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
  delete out.$schema;
  return out;
}

/**
 * An address as the agent typed it, made navigable: no scheme means http:// (an agent writes
 * `localhost:5173` far more often than it means anything else). Only http(s) and about:blank are
 * opened; a `file:` URL would read this sidecar's own filesystem, and `chrome:` pages are the
 * browser's own controls, neither of which a run has business in.
 */
export function normaliseUrl(
  input: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (trimmed === "about:blank") return { ok: true, url: trimmed };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: `not an address: ${input}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `only http(s) addresses open here, not ${parsed.protocol}` };
  }
  return { ok: true, url: parsed.href };
}
