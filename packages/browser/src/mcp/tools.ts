// The browser's tools, as an MCP server lists and calls them. Names are bare (`navigate`,
// `click`); the runner registers this server under the slug `browser`, so the model sees
// `browser__navigate`. The names, inputs and their meaning are a
// contract — the app presents these calls by them.
//
// ONE CALL AT A TIME. There is one browser and one agent; two calls racing on the same page
// (a click while a navigation lands) would answer with each other's snapshots. Calls queue on a
// chain, in arrival order.
//
// …AND NO CALL HOLDS THE QUEUE FOREVER. Every call into the page is bounded in the adapter, but a
// queue is only as live as its slowest member, so each call also has an overall deadline: past
// it the call is answered with an error, the browser is told to wake or replace the stuck tab,
// and the queue moves on. The abandoned call is left to fail on its own — but the NEXT call still
// waits for it (for ABANDON_GRACE_MS at most): an abandoned call still running beside the next
// one would write its late report from the same console cursor and dialog list, and answer with
// the errors the next call caused. Bounded, so a call that never settles cannot wedge the queue
// a second time.
//
// The deadline is the CALL's, not Chromium's start: the first call launches the browser under a
// bound of its own (LAUNCH_DEADLINE_MS), and its deadline starts once Chromium is up.

import type { z } from "@zod/zod";
import { describeIssues } from "@ryph/shared/http";
import { BrowserUnavailable, type ChromiumBrowser } from "../adapters/chromium.ts";
import { EVALUATE_DEFAULT_TIMEOUT_MS } from "../core/evaluate.ts";
import {
  AddInitScriptArgs,
  ClickArgs,
  ConsoleMessagesArgs,
  EvaluateArgs,
  HoverArgs,
  jsonSchemaOf,
  NavigateArgs,
  NetworkRequestsArgs,
  NoArgs,
  normaliseUrl,
  PressKeyArgs,
  ResizeArgs,
  ScreenshotArgs,
  ScrollArgs,
  SelectOptionArgs,
  TabsArgs,
  TypeArgs,
  WaitForArgs,
} from "../core/schema.ts";
import { failure, refusal, type ToolResult, withNotices } from "../core/tool_result.ts";

/**
 * A call's overall deadline. Longer than the longest legitimate call (a 30 s navigation or
 * wait_for, plus its report), short enough that an agent learns of a stuck page in under a minute.
 */
export const CALL_DEADLINE_MS = 45_000;
/**
 * How long a call waits for Chromium to start before it answers with an error. Playwright gives
 * each launch attempt 60 s, and an `auto` sandbox that fails falls back to a second attempt, which
 * normally fails fast: 90 s covers a slow first start and a quick refusal.
 */
export const LAUNCH_DEADLINE_MS = 90_000;
/**
 * How long the next call waits for an abandoned one to settle. The deadline's recovery has
 * already woken or replaced the tab, so an abandoned call usually ends within its report's few
 * seconds; one that does not is waited for no longer than this.
 */
export const ABANDON_GRACE_MS = 15_000;
/** The tools that read what was recorded and never touch Chromium, so never launch it. */
const NO_LAUNCH = new Set(["console_messages", "network_requests"]);

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const REPORT = "Answers with the page's URL and title, console errors since the last call, any " +
  "dialog that came up, and a fresh snapshot with element refs (at most 12 KB; snapshot reads " +
  "more).";

function tool(
  name: string,
  schema: z.ZodType,
  description: string,
  annotations: Record<string, unknown>,
): ToolDefinition {
  return { name, description, inputSchema: jsonSchemaOf(schema), annotations };
}

const READ = { readOnlyHint: true };
const ACT = { readOnlyHint: false, destructiveHint: false };

/** `snapshot`, whose list of the tools that take refs names `screenshot` only when it is there. */
function snapshotTool(vision: boolean): ToolDefinition {
  const takers = vision
    ? "click, type, hover, select_option, screenshot and evaluate"
    : "click, type, hover, select_option and evaluate";
  return tool(
    "snapshot",
    NoArgs,
    "Read the current page as an accessibility tree: roles, names, text and states, each " +
      `interactive element with a ref like [ref=e12] that ${takers} take. Refs are only good ` +
      "until the next snapshot — every tool that changes the page answers with a fresh one. " +
      "Capped at 28 KB: it is the whole page, scrolled-away parts included, so read a part with " +
      "evaluate on a ref rather than scrolling.",
    { title: "Read the page", ...READ },
  );
}

/** Every tool, as listed to a model that can see images. */
export const TOOLS: ToolDefinition[] = [
  tool(
    "navigate",
    NavigateArgs,
    "Open an address in the current tab and wait for it to load (at most 30 s). A dev server " +
      `you started in your shell is reachable at http://localhost:<port>. ${REPORT}`,
    { title: "Open a page", ...ACT, openWorldHint: true },
  ),
  tool("back", NoArgs, `Go back in the current tab's history. ${REPORT}`, {
    title: "Back",
    ...ACT,
  }),
  tool("forward", NoArgs, `Go forward in the current tab's history. ${REPORT}`, {
    title: "Forward",
    ...ACT,
  }),
  tool("reload", NoArgs, `Reload the current tab. ${REPORT}`, { title: "Reload", ...ACT }),
  snapshotTool(true),
  tool(
    "click",
    ClickArgs,
    `Click an element, as a user would: it is scrolled into view and must be visible and enabled. ${REPORT}`,
    { title: "Click", ...ACT },
  ),
  tool(
    "type",
    TypeArgs,
    "Enter text into a field. Replaces the field's value unless `slowly`, which types key by " +
      `key after what is there. \`submit\` presses Enter afterwards. ${REPORT}`,
    { title: "Type", ...ACT },
  ),
  tool(
    "press_key",
    PressKeyArgs,
    `Press a key or chord on whatever has focus. ${REPORT}`,
    { title: "Press a key", ...ACT },
  ),
  tool("hover", HoverArgs, `Move the mouse over an element. ${REPORT}`, { title: "Hover", ...ACT }),
  tool(
    "select_option",
    SelectOptionArgs,
    `Choose options in a <select>, by value or label. ${REPORT}`,
    { title: "Select", ...ACT },
  ),
  tool(
    "scroll",
    ScrollArgs,
    `Turn the mouse wheel where the mouse is (over the last element acted on). ${REPORT}`,
    { title: "Scroll", ...ACT },
  ),
  tool(
    "wait_for",
    WaitForArgs,
    "Wait for text to appear, for text to go, or for a number of seconds (each at most 30 s). " +
      REPORT,
    { title: "Wait", ...READ },
  ),
  tool(
    "screenshot",
    ScreenshotArgs,
    "A picture of the viewport, the full page or one element, at most 2000 px on a side: a " +
      "larger one is scaled down to half size at most, then cropped. For reading the page, " +
      "snapshot is cheaper and gives refs; this is for how it LOOKS.",
    { title: "Screenshot", ...READ },
  ),
  tool(
    "evaluate",
    EvaluateArgs,
    "Run a JavaScript function in the page and get its result: to inspect state the snapshot " +
      "does not show (a store, localStorage, a computed style) or to set something up. Test the " +
      "app by clicking and typing like a user, not by calling its handlers from here. Promises " +
      "are awaited; the result comes back as JSON, DOM nodes described, at most 20 KB. Stopped " +
      "after timeoutMs (default 5000).",
    { title: "Run a script", ...ACT },
  ),
  tool(
    "add_init_script",
    AddInitScriptArgs,
    "Add a script that runs before the page's own scripts on every later page load in this " +
      "browser — to stub fetch, freeze time or seed storage before the app boots. Navigate or " +
      "reload to apply it. Answers with every init script held.",
    { title: "Add an init script", ...ACT },
  ),
  tool(
    "console_messages",
    ConsoleMessagesArgs,
    "The browser console since the last time you asked, every tab, uncaught exceptions " +
      "included. At most 200, newest kept.",
    { title: "Console", ...READ },
  ),
  tool(
    "network_requests",
    NetworkRequestsArgs,
    "The requests the pages made since the last time you asked: method, URL, status, " +
      "failures, timing. By default only documents, fetch/XHR and failures. At most 200, newest kept.",
    { title: "Network", ...READ },
  ),
  tool(
    "tabs",
    TabsArgs,
    "List, open, switch to or close tabs. Tools act on the current tab. A link that opens a new " +
      "tab adds it to the list without switching.",
    { title: "Tabs", ...ACT },
  ),
  tool(
    "resize",
    ResizeArgs,
    `Resize the current tab's viewport, to see a layout at another width. ${REPORT}`,
    { title: "Resize", ...ACT },
  ),
];

/**
 * What tools/list carries. A model that cannot see images (`/configure`'s `vision: false`) is not
 * offered `screenshot`, and no other description sends it to one: a picture it cannot read would
 * cost a call and tell it nothing.
 */
export function toolsFor(opts: { vision: boolean }): ToolDefinition[] {
  if (opts.vision) return TOOLS;
  return TOOLS.filter((t) => t.name !== "screenshot").map((t) =>
    t.name === "snapshot" ? snapshotTool(false) : t
  );
}

/** What a call to `screenshot` answers when the model cannot see images. */
export const NO_VISION_REFUSAL = "screenshot is not available in this run: the model reading " +
  "these results cannot see images. snapshot reads the page as text, and evaluate can read a " +
  "computed style or an element's size and position.";

export interface ToolDiag {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

function parse<S extends z.ZodType>(
  schema: S,
  args: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; result: ToolResult } {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, result: refusal(`Invalid arguments: ${describeIssues(parsed.error)}`) };
}

/** Serialises calls (see the note at the top) and turns a broken one into a result the model reads. */
export class ToolRunner {
  /** What tools/list carries for this run (`toolsFor`). */
  readonly list: ToolDefinition[];
  readonly #names: Set<string>;
  #chain: Promise<unknown> = Promise.resolve();
  /** The call the last deadline gave up on, still running: the next call waits for it first. */
  #abandoned: Promise<unknown> | null = null;

  constructor(
    private readonly browser: ChromiumBrowser,
    private readonly diag: ToolDiag,
    private readonly deadlineMs = CALL_DEADLINE_MS,
    private readonly limits: { launchMs?: number; graceMs?: number; vision?: boolean } = {},
  ) {
    this.list = toolsFor({ vision: limits.vision ?? true });
    this.#names = new Set(TOOLS.map((t) => t.name));
  }

  /** Null for a name this server does not have; the caller answers -32601 for it. */
  call(name: string, args: unknown): Promise<ToolResult> | null {
    if (!this.#names.has(name)) return null;
    // Refused outright, without queueing or launching: unlisted, so a model only gets here by
    // guessing the name, and it should learn why rather than that the tool does not exist.
    if (name === "screenshot" && !this.list.some((t) => t.name === name)) {
      return Promise.resolve(refusal(NO_VISION_REFUSAL));
    }
    const run = this.#chain.then(() => this.#guarded(name, args));
    // The queue moves on when this call is answered AND whatever it abandoned has settled (or
    // had its grace): see the note at the top.
    const next = () => this.#settleAbandoned();
    this.#chain = run.then(next, next);
    return run;
  }

  async #settleAbandoned(): Promise<void> {
    const abandoned = this.#abandoned;
    if (abandoned === null) return;
    this.#abandoned = null;
    const graceMs = this.limits.graceMs ?? ABANDON_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"grace">((resolve) => {
      timer = setTimeout(() => resolve("grace"), graceMs);
    });
    try {
      const outcome = await Promise.race([abandoned.then(() => "settled", () => "settled"), grace]);
      if (outcome === "grace") this.diag.warn("browser.abandoned_still_running", { graceMs });
    } finally {
      clearTimeout(timer);
    }
  }

  /** One call under the deadline, opening with whatever the browser has to say since the last. */
  async #guarded(name: string, args: unknown): Promise<ToolResult> {
    if (!NO_LAUNCH.has(name)) {
      const refused = await this.#launch(name);
      if (refused !== null) return withNotices(refused, this.browser.takeNotices());
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), this.deadlineMs);
    });
    let result: ToolResult;
    try {
      const call = this.#call(name, args);
      const outcome = await Promise.race([call, expired]);
      if (outcome === "expired") {
        this.#abandoned = call;
        this.diag.warn("browser.tool_deadline", { tool: name, ms: this.deadlineMs });
        await this.browser.recover();
        result = refusal(
          `${name} did not finish in ${seconds(this.deadlineMs)} and was abandoned; ` +
            "the page was checked and woken (or replaced) so the next call can go ahead.",
        );
      } else {
        result = outcome;
      }
    } finally {
      clearTimeout(timer);
    }
    // A call that ended badly may have left the page stuck: the next one checks it first.
    if (result.isError) this.browser.suspect();
    return withNotices(result, this.browser.takeNotices());
  }

  /**
   * Chromium up before the call's deadline starts, under its own bound. Null when it is up; the
   * answer otherwise. A launch past the bound keeps going: the next call joins it.
   */
  async #launch(name: string): Promise<ToolResult | null> {
    const launchMs = this.limits.launchMs ?? LAUNCH_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), launchMs);
    });
    try {
      const outcome = await Promise.race([this.browser.ensureLaunched(), expired]);
      if (outcome !== "expired") return null;
      this.diag.warn("browser.launch_deadline", { tool: name, ms: launchMs });
      return refusal(
        `The browser did not start within ${seconds(launchMs)}, so ${name} was not run. ` +
          "It is still starting; try again in a moment.",
      );
    } catch (err) {
      if (err instanceof BrowserUnavailable) return refusal(err.message);
      this.diag.warn("browser.tool_failed", { tool: name, err: String(err) });
      return failure(`${name} failed: the browser would not start.`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async #call(name: string, args: unknown): Promise<ToolResult> {
    const started = performance.now();
    try {
      const result = await this.#dispatch(name, args);
      this.diag.info("browser.tool", {
        tool: name,
        ms: Math.round(performance.now() - started),
        ...(result.isError ? { error: true } : {}),
      });
      return result;
    } catch (err) {
      // The deployment cannot give this run a browser: said in the platform's words.
      if (err instanceof BrowserUnavailable) return refusal(err.message);
      // A tool that threw past its own handling: Chromium would not launch, or the page went
      // away mid-call. The model reads what happened; the log keeps it too.
      this.diag.warn("browser.tool_failed", { tool: name, err: String(err) });
      return failure(`${name} failed.`, err);
    }
  }

  #dispatch(name: string, args: unknown): Promise<ToolResult> | ToolResult {
    const b = this.browser;
    switch (name) {
      case "navigate": {
        const p = parse(NavigateArgs, args);
        if (!p.ok) return p.result;
        const url = normaliseUrl(p.data.url);
        if (!url.ok) return refusal(url.error);
        return b.navigate(url.url);
      }
      case "back":
      case "forward":
      case "reload":
        return b.history(name);
      case "snapshot":
        return b.snapshot();
      case "click": {
        const p = parse(ClickArgs, args);
        if (!p.ok) return p.result;
        const { ref, element, ...opts } = p.data;
        return b.click(ref, element, opts);
      }
      case "type": {
        const p = parse(TypeArgs, args);
        if (!p.ok) return p.result;
        return b.type(p.data.ref, p.data.element, p.data.text, p.data);
      }
      case "press_key": {
        const p = parse(PressKeyArgs, args);
        if (!p.ok) return p.result;
        return b.pressKey(p.data.key);
      }
      case "hover": {
        const p = parse(HoverArgs, args);
        if (!p.ok) return p.result;
        return b.hover(p.data.ref, p.data.element);
      }
      case "select_option": {
        const p = parse(SelectOptionArgs, args);
        if (!p.ok) return p.result;
        return b.selectOption(p.data.ref, p.data.element, p.data.values);
      }
      case "scroll": {
        const p = parse(ScrollArgs, args);
        if (!p.ok) return p.result;
        return b.scroll(p.data.deltaX ?? 0, p.data.deltaY ?? 0);
      }
      case "wait_for": {
        const p = parse(WaitForArgs, args);
        if (!p.ok) return p.result;
        return b.waitFor(p.data);
      }
      case "screenshot": {
        const p = parse(ScreenshotArgs, args);
        if (!p.ok) return p.result;
        return b.screenshot(p.data);
      }
      case "evaluate": {
        const p = parse(EvaluateArgs, args);
        if (!p.ok) return p.result;
        return b.evaluate(
          p.data.function,
          p.data.ref,
          p.data.timeoutMs ?? EVALUATE_DEFAULT_TIMEOUT_MS,
        );
      }
      case "add_init_script": {
        const p = parse(AddInitScriptArgs, args);
        if (!p.ok) return p.result;
        return b.addInitScript(p.data.script);
      }
      case "console_messages": {
        const p = parse(ConsoleMessagesArgs, args);
        if (!p.ok) return p.result;
        return b.consoleMessages(p.data.level);
      }
      case "network_requests": {
        const p = parse(NetworkRequestsArgs, args);
        if (!p.ok) return p.result;
        return b.networkRequests(p.data.all ?? false);
      }
      case "tabs": {
        const p = parse(TabsArgs, args);
        if (!p.ok) return p.result;
        let url: string | undefined;
        if (p.data.url !== undefined) {
          const n = normaliseUrl(p.data.url);
          if (!n.ok) return refusal(n.error);
          url = n.url;
        }
        return b.tabs(p.data.action, p.data.index, url);
      }
      case "resize": {
        const p = parse(ResizeArgs, args);
        if (!p.ok) return p.result;
        return b.resize(p.data.width, p.data.height);
      }
      default:
        return refusal(`Unknown tool: ${name}`);
    }
  }
}
