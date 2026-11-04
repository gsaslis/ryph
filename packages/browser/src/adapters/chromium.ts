// THE BROWSER: one Chromium (headless shell), one context, any number of tabs, driven through
// playwright-core and watched through a CDP screencast. Everything the tools do to a page happens
// here; everything they SAY about it is shaped by core/ (report.ts, framing.ts, evaluate.ts).
//
// Lazy. Nothing launches until the first tool call, so a run whose agent never opens the browser
// pays for a sleeping process and no Chromium. A browser that dies is reported on the live
// stream as `closed` and relaunched by the next call, with the init scripts the agent added
// re-applied — the agent's set-up survives, the open pages do not.
//
// A TAB THAT DIES IS REPLACED, NOT MOURNED. A renderer that crashes (an OOM, `Page.crash`) takes
// one tab with it, not the browser: the tab is swapped for a blank one in the same place, the
// screencast moves to it, and the next tool result says so. A renderer that HANGS (`while (true)
// {}` in a click handler) is worse, because it answers nothing — so every call into a page is
// bounded, a call that ended badly makes the next one probe the page first (one CDP round trip),
// and a page that does not answer the probe has its script terminated
// (`Runtime.terminateExecution`) and, if that does not wake it, is replaced like a crashed one.
//
// SANDBOX FIRST. Chromium's own sandbox (a user namespace for each renderer, a seccomp filter) is
// the line between a hostile page and this process. It works under gVisor, which is how runs are
// confined on Kubernetes, and fails under runc with "No usable sandbox" — which is docker. The
// orchestrator says which it is (`RYPH_BROWSER_SANDBOX`, core/config.ts): `required` launches
// sandboxed or not at all, `off` goes straight to `--no-sandbox`, and with nothing said the launch
// tries the sandbox, and on failure launches once more with `--no-sandbox`, says so in ONE log
// line, and never tries the sandbox again in this process' life.
//
// Egress goes through Playwright's `proxy` option: the run's egress proxy, with the per-run Basic
// credentials the runner handed over on /configure, and localhost always bypassed so the agent's
// own dev server is reached directly.

import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type ConsoleMessage,
  type Dialog,
  type JSHandle,
  type Locator,
  type Page,
  type Request,
} from "playwright-core";
import type { ProxyConfig, SandboxMode } from "../core/config.ts";
import {
  cutSerialised,
  EVALUATE_DEFAULT_TIMEOUT_MS,
  EVALUATE_RESULT_CAP,
  parseCut,
  wrapEvaluate,
} from "../core/evaluate.ts";
import { fence } from "@ryph/shared/markdown";
import { capText, kb, oneLine, untrusted } from "../core/framing.ts";
import {
  captureNote,
  imageSize,
  planCapture,
  type Region,
  SCREENSHOT_MAX_BYTES,
} from "../core/screenshot.ts";
import {
  clip,
  CONSOLE_TEXT_CAP,
  type ConsoleLevel,
  consoleLevel,
  FAILURE_CAP,
  type Frame,
  jpegSizeOfBase64,
  levelRank,
  type LiveHub,
  networkWanted,
  type Rect,
  SUMMARY_CAP,
  type Tab,
  URL_CAP,
} from "../core/live.ts";
import {
  type ConsoleEntry,
  DIALOG_TEXT_CAP,
  type DialogEntry,
  dialogLines,
  formatConsoleList,
  formatNetworkList,
  formatPageReport,
  formatTabList,
  type NetworkEntry,
  SNAPSHOT_TOOL_CAP,
} from "../core/report.ts";
import { floorAfter, shouldCollect } from "../core/heap.ts";
import { Throttle } from "../core/throttle.ts";
import { failure, refusal, text, type ToolResult } from "../core/tool_result.ts";

export interface Diag {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface ChromiumOptions {
  proxy: ProxyConfig | null;
  hub: LiveHub;
  diag: Diag;
  viewport?: { width: number; height: number };
  /** A Chromium other than Playwright's installed headless shell (tests, local debugging). */
  executablePath?: string;
  /** RYPH_BROWSER_SANDBOX (core/config.ts); `auto` when not given. */
  sandbox?: SandboxMode;
  /** HEAP_TIDY_MIN (core/heap.ts), for tests that cannot wait for 64 MiB of garbage. */
  heapTidyBytes?: number;
}

/**
 * The browser cannot be had in this run, for a reason that is the deployment's, not the page's:
 * the tools answer with it in the platform's own words.
 */
export class BrowserUnavailable extends Error {
  override name = "BrowserUnavailable";
}

/** `navigate` and history moves wait for `load`, at most this long. */
const NAVIGATION_TIMEOUT_MS = 30_000;
/** Every other Playwright action (click, fill, the element waits behind them). */
const ACTION_TIMEOUT_MS = 10_000;
/** How long an action's own fetches may take before the report is written anyway. */
const SETTLE_MS = 2_000;
/**
 * The calls Playwright gives no deadline of its own (a locator count, a key press, the wheel, a
 * viewport change, bringing a tab to front, a CDP command) get this one. Each answers in
 * milliseconds from a live page; one that takes seconds is talking to a stuck one.
 */
const QUICK_MS = 5_000;
/** How long a page has to answer the probe (a CDP `Runtime.evaluate` of `0`) to count as alive. */
const PROBE_MS = 2_000;
/** A PNG past this is re-taken as JPEG: a full page of photographs is megabytes as PNG. */
const PNG_MAX_BYTES = 1_500_000;
const RING = 1_000;
const MAX_INIT_SCRIPTS = 20;
/** The screencast's forward rate: one frame per 100 ms at most (core/throttle.ts). */
const FRAME_INTERVAL_MS = 100;

interface TabRecord {
  id: string;
  page: Page;
  title: string;
  cdp: CDPSession | null;
  /** Requests of the kinds an action waits on, still in flight. */
  inflight: Set<Request>;
  navigations: number;
  /** Its renderer died (`crash`); it is being, or has been, replaced. */
  crashed: boolean;
  /** The replacement under way, so a crash and a probe cannot each open a tab for it. */
  replacing: Promise<TabRecord> | null;
  /** The JS heap the last collection left on this document (core/heap.ts); 0 after a navigation. */
  heapFloor: number;
}

interface PendingFrame {
  data: string;
  tabId: string;
  viewport: { width: number; height: number };
}

class RefGone extends Error {}

export class ChromiumBrowser {
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #launching: Promise<BrowserContext> | null = null;
  readonly #sandboxMode: SandboxMode;
  /** Whether the next launch tries the sandbox: false after `auto` saw it fail once, and for `off`. */
  #sandbox: boolean;
  #tabs: TabRecord[] = [];
  #active: TabRecord | null = null;
  #nextTab = 1;
  #initScripts: string[] = [];
  #console: ConsoleEntry[] = [];
  #network: NetworkEntry[] = [];
  #consoleSeq = 0;
  #networkSeq = 0;
  #consoleCursor = 0;
  #errorCursor = 0;
  #networkCursor = 0;
  #dialogs: DialogEntry[] = [];
  #started = new WeakMap<Request, number>();
  #closing = false;
  /** A tab replacement in flight; `#page` waits for it rather than opening a tab of its own. */
  #replacing: Promise<unknown> | null = null;
  /**
   * Tab swaps under way. While one is, `tabs` is not published: between the dead tab leaving and
   * its replacement being activated the list has no active tab (and, before that, a tab too few),
   * and a viewer must never see that half-way state. The swap publishes once, when it is done.
   */
  #swapping = 0;
  /** Set when a call ended badly: the next call probes the page before using it. */
  #suspect = false;
  /** Platform-voice facts for the next tool result: a tab replaced, a stuck script stopped. */
  #notices: string[] = [];
  readonly #throttle: Throttle<PendingFrame>;
  readonly #viewport: { width: number; height: number };

  constructor(private readonly opts: ChromiumOptions) {
    this.#sandboxMode = opts.sandbox ?? "auto";
    this.#sandbox = this.#sandboxMode !== "off";
    this.#viewport = opts.viewport ?? { width: 1280, height: 800 };
    this.#throttle = new Throttle(FRAME_INTERVAL_MS, (f) => this.#sendFrame(f));
  }

  get launched(): boolean {
    return this.#context !== null;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  async #ensure(): Promise<BrowserContext> {
    if (this.#context !== null) return this.#context;
    if (this.#launching === null) {
      this.#launching = this.#launch().finally(() => {
        this.#launching = null;
      });
    }
    return await this.#launching;
  }

  async #launch(): Promise<BrowserContext> {
    const hub = this.opts.hub;
    hub.setStatus("launching");
    const started = performance.now();
    const proxy = this.opts.proxy === null ? undefined : {
      server: this.opts.proxy.server,
      bypass: this.opts.proxy.bypass,
      ...(this.opts.proxy.username === undefined ? {} : { username: this.opts.proxy.username }),
      ...(this.opts.proxy.password === undefined ? {} : { password: this.opts.proxy.password }),
    };
    const base = {
      headless: true,
      ...(proxy === undefined ? {} : { proxy }),
      ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : {}),
      // A Chromium that cannot be started in this long will not be started at all.
      timeout: 60_000,
    };
    let browser: Browser;
    try {
      if (this.#sandbox) {
        try {
          browser = await chromium.launch({ ...base, chromiumSandbox: true });
        } catch (err) {
          if (this.#sandboxMode === "required") {
            // No fallback, ever: this deployment runs hostile pages only inside the sandbox.
            const reason = sandboxReason(err);
            this.opts.diag.warn("browser.sandbox_required_failed", { reason });
            throw new BrowserUnavailable(
              "The browser is unavailable: Chromium would not start with its sandbox, which this " +
                `deployment requires (RYPH_BROWSER_SANDBOX=required). Chromium said: ${
                  oneLine(reason, 300)
                }`,
            );
          }
          // ONE line, once per process: every later launch goes straight to --no-sandbox.
          this.#sandbox = false;
          this.opts.diag.warn("browser.sandbox_unavailable", {
            reason: sandboxReason(err),
            fallback: "--no-sandbox",
          });
          browser = await chromium.launch({ ...base, chromiumSandbox: false });
        }
      } else {
        browser = await chromium.launch({ ...base, chromiumSandbox: false });
      }
    } catch (err) {
      hub.setStatus("closed");
      throw err;
    }
    let context: BrowserContext;
    try {
      context = await browser.newContext({ viewport: this.#viewport });
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      for (const script of this.#initScripts) await context.addInitScript({ content: script });
      context.on("page", (page) => this.#adopt(page));
      this.#browser = browser;
      this.#context = context;
      const first = await context.newPage();
      // `page` fires for newPage too; adopt is idempotent, so whichever runs first wins.
      const rec = this.#adopt(first);
      await this.#activate(rec);
    } catch (err) {
      // Launched but not set up: the Chromium must not outlive the failure, or every retry
      // would leave one more behind.
      this.#browser = null;
      this.#context = null;
      this.#tabs = [];
      this.#active = null;
      await browser.close().catch(() => {});
      hub.setTabs([]);
      hub.setStatus("closed");
      throw err;
    }
    // Only now: a browser closed by the cleanup above is not one that was lost.
    browser.on("disconnected", () => this.#lost());
    hub.setStatus("active");
    this.opts.diag.info("browser.launched", {
      version: browser.version(),
      sandbox: this.#sandbox,
      proxy: this.opts.proxy === null ? "none" : "egress",
      ms: Math.round(performance.now() - started),
    });
    return context;
  }

  /** The browser went away under us: a crash, an OOM kill. The next call relaunches. */
  #lost(): void {
    this.#browser = null;
    this.#context = null;
    this.#tabs = [];
    this.#active = null;
    this.#throttle.reset();
    this.opts.hub.clearFrame();
    this.opts.hub.setTabs([]);
    this.opts.hub.setStatus("closed");
    if (!this.#closing) this.opts.diag.warn("browser.disconnected", {});
  }

  async close(): Promise<void> {
    this.#closing = true;
    const browser = this.#browser;
    if (browser !== null) await browser.close().catch(() => {});
    this.opts.hub.setStatus("closed");
  }

  /**
   * Launches Chromium if it is not up (or joins the launch under way). The tool runner calls
   * this BEFORE a call's deadline starts, under a bound of its own: a cold start in a slow
   * container is not a stuck page, and must not eat the call's 45 s.
   */
  async ensureLaunched(): Promise<void> {
    await this.#ensure();
  }

  /** The facts the next tool result opens with (a tab replaced, a script stopped), handed over once. */
  takeNotices(): string[] {
    return this.#notices.splice(0);
  }

  /** A call ended badly: before the next one uses the page, check that it still answers. */
  suspect(): void {
    this.#suspect = true;
  }

  /**
   * A call ran past the tool runner's deadline: wake the current tab now (stop its script), or
   * replace it, so the next call finds a page that answers. Bounded; never throws.
   */
  async recover(): Promise<void> {
    const rec = this.#active;
    if (rec === null || this.#context === null) return;
    await this.#unwedge(rec).catch((err) => {
      this.opts.diag.warn("browser.recover_failed", { err: String(err) });
    });
  }

  // ---- tabs and their events ---------------------------------------------------------------

  #adopt(page: Page): TabRecord {
    const known = this.#tabs.find((t) => t.page === page);
    if (known) return known;
    const rec: TabRecord = {
      id: `t${this.#nextTab++}`,
      page,
      title: "",
      cdp: null,
      inflight: new Set(),
      navigations: 0,
      crashed: false,
      replacing: null,
      heapFloor: 0,
    };
    this.#tabs.push(rec);
    page.on("crash", () => {
      rec.crashed = true;
      if (this.#closing) return;
      this.opts.diag.warn("browser.tab_crashed", { tab: rec.id });
      // At once, not on the next call: the person watching should not stare at a dead tab.
      void this.#replace(rec, "crashed").catch(() => {});
    });
    page.on("console", (m) => this.#onConsole(rec, m));
    page.on("pageerror", (err) => this.#onPageError(rec, err));
    page.on("dialog", (d) => this.#onDialog(d));
    page.on("request", (r) => this.#onRequest(rec, r));
    page.on("requestfinished", (r) => void this.#onRequestDone(rec, r, null));
    page.on(
      "requestfailed",
      (r) => void this.#onRequestDone(rec, r, r.failure()?.errorText ?? "failed"),
    );
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      rec.navigations++;
      rec.heapFloor = 0;
      this.#publishTabs();
    });
    page.on("domcontentloaded", () => void this.#refreshTitle(rec));
    page.on("load", () => void this.#refreshTitle(rec));
    page.on("close", () => void this.#onClose(rec));
    this.#publishTabs();
    return rec;
  }

  async #refreshTitle(rec: TabRecord): Promise<void> {
    rec.title = await withTimeout(rec.page.title(), 1_000).catch(() => rec.title) ?? rec.title;
    this.#publishTabs();
  }

  async #onClose(rec: TabRecord): Promise<void> {
    const index = this.#tabs.indexOf(rec);
    if (index === -1) return;
    this.#tabs.splice(index, 1);
    if (this.#active === rec) {
      this.#active = null;
      this.#throttle.reset();
      this.opts.hub.clearFrame();
      const next = this.#tabs[Math.min(index, this.#tabs.length - 1)];
      if (next) await this.#activate(next).catch(() => {});
    }
    this.#publishTabs();
  }

  #tabList(): Tab[] {
    return this.#tabs.map((t) => ({
      id: t.id,
      url: clip(t.page.url(), URL_CAP),
      title: clip(t.title, 500),
      active: t === this.#active,
    }));
  }

  #publishTabs(): void {
    if (this.#swapping > 0) return;
    this.opts.hub.setTabs(this.#tabList());
  }

  /** Makes a tab the one tools act on and the screencast shows. */
  async #activate(rec: TabRecord): Promise<void> {
    const previous = this.#active;
    if (previous === rec && rec.cdp !== null) return;
    if (previous !== null && previous !== rec && previous.cdp !== null) {
      await previous.cdp.send("Page.stopScreencast").catch(() => {});
    }
    this.#active = rec;
    this.#throttle.reset();
    this.opts.hub.clearFrame();
    await withTimeout(rec.page.bringToFront(), QUICK_MS, "Bringing the tab to front").catch(
      () => {},
    );
    const cdp = await this.#cdp(rec);
    await withTimeout(
      cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 800,
        // Every frame, not every Nth: a page that changes once and goes still paints ONE frame,
        // and skipping it would leave the viewer on the state before. The throttle drops the rest.
      }),
      QUICK_MS,
      "Starting the screencast",
    );
    this.#publishTabs();
  }

  async #cdp(rec: TabRecord): Promise<CDPSession> {
    if (rec.cdp !== null) return rec.cdp;
    const cdp = await withTimeout(
      this.#context!.newCDPSession(rec.page),
      QUICK_MS,
      "Attaching to the tab",
    );
    // Two racing callers may both have attached; the first one kept wins, the other detaches.
    if (rec.cdp !== null) {
      void cdp.detach().catch(() => {});
      return rec.cdp;
    }
    cdp.on("Page.screencastFrame", (f) => {
      // Ack EVERY frame, forwarded or not: an unacked screencast stops sending.
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      if (this.#active !== rec) return;
      this.#throttle.push({
        data: f.data,
        tabId: rec.id,
        viewport: {
          width: Math.round(f.metadata.deviceWidth),
          height: Math.round(f.metadata.deviceHeight),
        },
      });
    });
    rec.cdp = cdp;
    return cdp;
  }

  #sendFrame(f: PendingFrame): void {
    const size = jpegSizeOfBase64(f.data) ?? f.viewport;
    const frame: Frame = {
      mime: "image/jpeg",
      data: f.data,
      width: size.width,
      height: size.height,
      tabId: f.tabId,
      viewport: f.viewport,
    };
    this.opts.hub.setFrame(frame);
  }

  #onConsole(rec: TabRecord, m: ConsoleMessage): void {
    const loc = m.location();
    this.#pushConsole({
      tabId: rec.id,
      level: consoleLevel(m.type()),
      text: m.text(),
      ...(loc.url
        ? { source: { url: loc.url, ...(loc.lineNumber ? { line: loc.lineNumber } : {}) } }
        : {}),
    });
  }

  #onPageError(rec: TabRecord, err: Error): void {
    this.#pushConsole({
      tabId: rec.id,
      level: "error",
      text: err.stack && err.stack.includes(err.message)
        ? err.stack
        : `${err.name}: ${err.message}`,
      exception: true,
    });
  }

  #pushConsole(e: Omit<ConsoleEntry, "seq" | "at">): void {
    const entry: ConsoleEntry = {
      ...e,
      text: clip(e.text, CONSOLE_TEXT_CAP),
      seq: ++this.#consoleSeq,
      at: Date.now(),
    };
    if (entry.source) entry.source = { ...entry.source, url: clip(entry.source.url, URL_CAP) };
    ring(this.#console, entry);
    this.opts.hub.emit({ type: "console", ...withoutSeq(entry) });
  }

  #onDialog(d: Dialog): void {
    // Answered at once: a dialog blocks the page until answered, and nobody is there to answer
    // it. Dismissed — except "Leave site?" (`beforeunload`), which is ACCEPTED: dismissing it
    // keeps the page, and an agent that navigates away from a form it typed into would be
    // trapped there, every navigate failing. The next tool result says which happened.
    const leaving = d.type() === "beforeunload";
    this.#dialogs.push({
      type: d.type(),
      message: clip(d.message(), DIALOG_TEXT_CAP),
      answer: leaving ? "accepted" : "dismissed",
    });
    if (this.#dialogs.length > 20) this.#dialogs.shift();
    (leaving ? d.accept() : d.dismiss()).catch(() => {});
  }

  /** Dialogs not yet reported, as lines for a failure's fenced block (and then forgotten). */
  #dialogNotes(): string[] {
    const dialogs = this.#dialogs.splice(0);
    return dialogs.length === 0 ? [] : ["Dialogs:", ...dialogLines(dialogs)];
  }

  #onRequest(rec: TabRecord, r: Request): void {
    this.#started.set(r, Date.now());
    if (networkWanted(r.resourceType(), false)) rec.inflight.add(r);
  }

  async #onRequestDone(rec: TabRecord, r: Request, failureText: string | null): Promise<void> {
    rec.inflight.delete(r);
    const start = this.#started.get(r);
    let status: number | undefined;
    if (failureText === null) {
      status = (await r.response().catch(() => null))?.status();
    }
    const failed = failureText !== null || (status !== undefined && status >= 400);
    const entry: NetworkEntry = {
      seq: ++this.#networkSeq,
      at: Date.now(),
      tabId: rec.id,
      method: r.method(),
      url: clip(r.url(), URL_CAP),
      resourceType: r.resourceType(),
      ...(status === undefined ? {} : { status }),
      ...(failureText === null ? {} : { failure: clip(failureText, FAILURE_CAP) }),
      ...(start === undefined ? {} : { durationMs: Date.now() - start }),
    };
    ring(this.#network, entry);
    if (networkWanted(entry.resourceType, failed)) {
      this.opts.hub.emit({ type: "network", ...withoutSeq(entry) });
    }
  }

  // ---- helpers the tools share -------------------------------------------------------------

  /** The tab tools act on: alive, answering, and there. */
  async #page(): Promise<TabRecord> {
    await this.#ensure();
    if (this.#replacing !== null) await this.#replacing.catch(() => {});
    let rec = this.#active;
    if (rec === null) {
      // Every tab was closed: open a fresh one rather than fail the call.
      const page = await withTimeout(this.#context!.newPage(), QUICK_MS * 2, "Opening a tab");
      rec = this.#adopt(page);
      await this.#activate(rec);
    } else if (rec.crashed) {
      rec = await this.#replace(rec, "crashed");
    } else if (this.#suspect) {
      this.#suspect = false;
      rec = await this.#unwedge(rec);
    }
    return rec;
  }

  /**
   * Whether the tab's renderer runs JavaScript at all: a `Runtime.evaluate` of `0` over CDP,
   * which a live page answers in a millisecond. Only SILENCE is a no — an error is an answer
   * (a context torn down mid-navigation still means the renderer is there).
   */
  async #answers(rec: TabRecord): Promise<boolean> {
    try {
      const cdp = await this.#cdp(rec);
      await withTimeout(
        cdp.send("Runtime.evaluate", { expression: "0", returnByValue: true }),
        PROBE_MS,
        "The page",
      );
      return true;
    } catch (err) {
      return !isTimeout(err);
    }
  }

  /** A tab that answers: this one, after its script is stopped if it must be, or a new one. */
  async #unwedge(rec: TabRecord): Promise<TabRecord> {
    if (await this.#answers(rec)) return rec;
    // Silent: something holds the renderer's main thread. Stop it — only now, because a
    // terminate with nothing running would kill the NEXT script instead.
    this.opts.diag.warn("browser.tab_unresponsive", { tab: rec.id });
    const cdp = rec.cdp;
    if (cdp !== null) {
      await withTimeout(cdp.send("Runtime.terminateExecution"), QUICK_MS, "Terminating").catch(
        () => {},
      );
    }
    if (await this.#answers(rec)) {
      this.#notices.push(
        `A script in tab ${this.#tabs.indexOf(rec)} held the page so it could not answer; ` +
          "it was stopped, so the page may be left half-way through what that script was doing.",
      );
      return rec;
    }
    return await this.#replace(rec, "unresponsive");
  }

  /** Swaps a dead or stuck tab for a blank one in the same place; once per tab, however asked. */
  #replace(rec: TabRecord, why: "crashed" | "unresponsive"): Promise<TabRecord> {
    if (rec.replacing === null) {
      rec.replacing = this.#swap(rec, why);
      const done = rec.replacing.finally(() => {
        if (this.#replacing === done) this.#replacing = null;
      });
      this.#replacing = done;
      done.catch(() => {});
    }
    return rec.replacing;
  }

  async #swap(rec: TabRecord, why: "crashed" | "unresponsive"): Promise<TabRecord> {
    const context = this.#context;
    if (context === null) throw new Error("the browser is gone");
    const index = this.#tabs.indexOf(rec);
    const wasActive = this.#active === rec;
    let fresh: TabRecord;
    // Nothing published until the replacement is in place and active (see #swapping).
    this.#swapping++;
    try {
      // Out of the list first, so its close event finds nothing left to do.
      if (index !== -1) this.#tabs.splice(index, 1);
      if (wasActive) {
        this.#active = null;
        this.#throttle.reset();
        this.opts.hub.clearFrame();
      }
      const old = rec.cdp;
      rec.cdp = null;
      if (old !== null) void old.detach().catch(() => {});
      void withTimeout(rec.page.close({ runBeforeUnload: false }), QUICK_MS, "Closing the tab")
        .catch(() => {});
      const page = await withTimeout(context.newPage(), QUICK_MS * 2, "Opening a tab");
      fresh = this.#adopt(page);
      // Into the dead tab's place, so the indexes the agent holds still mean the same tabs.
      this.#tabs.splice(this.#tabs.indexOf(fresh), 1);
      this.#tabs.splice(index === -1 ? this.#tabs.length : index, 0, fresh);
      if (wasActive || this.#active === null) await this.#activate(fresh);
    } finally {
      this.#swapping--;
      this.#publishTabs();
    }
    const at = this.#tabs.indexOf(fresh);
    this.#notices.push(
      why === "crashed"
        ? `Tab ${at} crashed (its renderer process died) and was replaced with a blank tab; ` +
          "navigate to open the page again."
        : `Tab ${at} stopped answering and stopping its script did not wake it; it was closed ` +
          "and replaced with a blank tab. Navigate to open the page again.",
    );
    this.opts.diag.warn("browser.tab_replaced", { reason: why, tab: rec.id, by: fresh.id });
    return fresh;
  }

  async #locate(rec: TabRecord, ref: string): Promise<Locator> {
    const locator = rec.page.locator(`aria-ref=${ref}`);
    // A stuck page must surface as a stuck page, not as "the ref is gone".
    const count = await withTimeout(locator.count(), QUICK_MS, "Finding the element").catch(
      (err) => {
        if (isTimeout(err)) throw err;
        return 0;
      },
    );
    if (count === 0) {
      throw new RefGone(
        `Ref ${ref} is not on the page any more (refs are only good until the next snapshot). ` +
          "Take a snapshot and use a ref from it.",
      );
    }
    return locator;
  }

  /**
   * Where the element is in the viewport, for the live view's highlight. Measured AFTER it is
   * scrolled into view — Playwright scrolls it there before acting, and a box measured before
   * would put the ring where the element no longer is.
   */
  async #targetOf(locator: Locator, scroll = true): Promise<Rect | undefined> {
    if (scroll) await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    const box = await locator.boundingBox({ timeout: 1_000 }).catch(() => null);
    if (box === null) return undefined;
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  }

  #action(tool: string, summary: string, target?: Rect): void {
    this.opts.hub.emit({
      type: "action",
      at: Date.now(),
      tool,
      summary: oneLine(summary, SUMMARY_CAP),
      ...(target === undefined ? {} : { target }),
    });
  }

  /**
   * Lets an action's consequences land before the report is written: a navigation it started
   * reaches `load`, and the fetches it fired come back — each bounded, because a page that
   * polls forever must not hold the answer hostage.
   */
  async #settle(
    rec: TabRecord,
    navigationsBefore: number,
    inflightBefore: Set<Request>,
  ): Promise<void> {
    // One beat first: a navigation, a popup or a fetch an action causes is reported to us a
    // little after the action itself resolves, and without it the checks below see nothing yet.
    await sleep(100);
    if (rec.navigations !== navigationsBefore) {
      await rec.page.waitForLoadState("load", { timeout: SETTLE_MS * 5 }).catch(() => {});
    }
    const deadline = Date.now() + SETTLE_MS;
    while (Date.now() < deadline) {
      const fresh = [...rec.inflight].some((r) => !inflightBefore.has(r));
      if (!fresh) break;
      await sleep(50);
    }
  }

  /** A page-mutating tool's answer (core/report.ts): what it did, where the page is, a snapshot. */
  async #report(
    rec: TabRecord,
    did: string,
    notes: string[] = [],
    explicit = false,
  ): Promise<ToolResult> {
    // The active tab may have changed under the action (a popup, a tab the page closed).
    const current = this.#active ?? rec;
    const errors = this.#console.filter((e) => e.seq > this.#errorCursor && e.level === "error");
    this.#errorCursor = this.#consoleSeq;
    const dialogs = this.#dialogs.splice(0);
    let snapshot: string | null = null;
    try {
      snapshot = await current.page.ariaSnapshot({ mode: "ai", timeout: 5_000 });
    } catch (err) {
      if (isTimeout(err)) this.#suspect = true;
      notes.push(`No snapshot could be taken: ${oneLine(firstLine(err), 300)}`);
    }
    await this.#refreshTitle(current);
    await this.#tidy(current);
    return text(formatPageReport(did, {
      url: current.page.url(),
      title: current.title,
      tabs: this.#tabList(),
      consoleErrors: errors,
      dialogs,
      snapshot,
      notes,
    }, explicit ? { snapshotCap: SNAPSHOT_TOOL_CAP, explicit: true } : {}));
  }

  /** Collects the tab's JS heap when it has grown well past what is live (core/heap.ts). */
  async #tidy(rec: TabRecord): Promise<void> {
    try {
      const cdp = await this.#cdp(rec);
      const { usedSize } = await withTimeout(cdp.send("Runtime.getHeapUsage"), QUICK_MS);
      if (!shouldCollect(usedSize, rec.heapFloor, this.opts.heapTidyBytes)) return;
      let after: number | null = null;
      try {
        await withTimeout(cdp.send("HeapProfiler.collectGarbage"), QUICK_MS);
        after = (await withTimeout(cdp.send("Runtime.getHeapUsage"), QUICK_MS)).usedSize;
      } catch (err) {
        this.opts.diag.warn("browser.gc_timeout", { tab: rec.id, usedSize, err: String(err) });
      }
      rec.heapFloor = floorAfter(usedSize, after);
    } catch {
      // A page mid-navigation or gone: the next report tries again.
    }
  }

  /** Runs one ref-targeted action with its live event, settle and report. */
  async #onElement(
    tool: string,
    ref: string,
    summary: string,
    act: (locator: Locator) => Promise<void>,
  ): Promise<ToolResult> {
    const rec = await this.#page();
    let locator: Locator;
    try {
      locator = await this.#locate(rec, ref);
    } catch (err) {
      if (err instanceof RefGone) return refusal(err.message);
      throw err;
    }
    this.#action(tool, summary, await this.#targetOf(locator));
    const navs = rec.navigations;
    const inflight = new Set(rec.inflight);
    try {
      await act(locator);
    } catch (err) {
      return failure(`${summary} failed.`, err, this.#dialogNotes());
    }
    await this.#settle(rec, navs, inflight);
    return await this.#report(rec, `${summary}.`);
  }

  // ---- the tools ---------------------------------------------------------------------------

  async navigate(url: string): Promise<ToolResult> {
    const rec = await this.#page();
    this.#action("navigate", `Opened ${clip(url, 500)}`);
    const notes: string[] = [];
    try {
      await rec.page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    } catch (err) {
      if (!isTimeout(err)) {
        return failure(`Opening ${clip(url, 500)} failed.`, err, this.#dialogNotes());
      }
      notes.push("The page did not finish loading in 30 s; this is how it looks so far.");
    }
    return await this.#report(rec, `Opened ${clip(url, 500)}.`, notes);
  }

  async history(which: "back" | "forward" | "reload"): Promise<ToolResult> {
    const rec = await this.#page();
    const words =
      { back: "Went back", forward: "Went forward", reload: "Reloaded the page" }[which];
    this.#action(which, words);
    const notes: string[] = [];
    try {
      const options = { waitUntil: "load" as const, timeout: NAVIGATION_TIMEOUT_MS };
      const response = which === "back"
        ? await rec.page.goBack(options)
        : which === "forward"
        ? await rec.page.goForward(options)
        : await rec.page.reload(options);
      if (response === null && which !== "reload") {
        notes.push(`There was no page to go ${which === "back" ? "back" : "forward"} to.`);
      }
    } catch (err) {
      if (!isTimeout(err)) return failure(`${words}: failed.`, err, this.#dialogNotes());
      notes.push("The page did not finish loading in 30 s; this is how it looks so far.");
    }
    return await this.#report(rec, `${words}.`, notes);
  }

  async snapshot(): Promise<ToolResult> {
    const rec = await this.#page();
    this.#action("snapshot", "Read the page");
    return await this.#report(rec, "Snapshot of the current page.", [], true);
  }

  click(
    ref: string,
    element: string,
    opts: {
      button?: "left" | "right" | "middle";
      doubleClick?: boolean;
      modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
    },
  ): Promise<ToolResult> {
    const verb = opts.doubleClick
      ? "Double-clicked"
      : opts.button === "right"
      ? "Right-clicked"
      : "Clicked";
    const summary = `${verb} “${oneLine(element, 120)}”`;
    return this.#onElement("click", ref, summary, async (loc) => {
      const options = {
        ...(opts.button ? { button: opts.button } : {}),
        ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
      };
      if (opts.doubleClick) await loc.dblclick(options);
      else await loc.click(options);
    });
  }

  type(
    ref: string,
    element: string,
    value: string,
    opts: { submit?: boolean; slowly?: boolean },
  ): Promise<ToolResult> {
    const summary = `Typed into “${oneLine(element, 120)}”`;
    return this.#onElement("type", ref, summary, async (loc) => {
      if (opts.slowly) await loc.pressSequentially(value, { delay: 30 });
      else await loc.fill(value);
      if (opts.submit) await loc.press("Enter");
    });
  }

  hover(ref: string, element: string): Promise<ToolResult> {
    return this.#onElement("hover", ref, `Hovered over “${oneLine(element, 120)}”`, async (loc) => {
      await loc.hover();
    });
  }

  selectOption(ref: string, element: string, values: string[]): Promise<ToolResult> {
    const summary = `Selected ${values.map((v) => `“${oneLine(v, 60)}”`).join(", ")} in “${
      oneLine(element, 120)
    }”`;
    return this.#onElement("select_option", ref, summary, async (loc) => {
      await loc.selectOption(values);
    });
  }

  async pressKey(key: string): Promise<ToolResult> {
    const rec = await this.#page();
    const summary = `Pressed ${oneLine(key, 60)}`;
    this.#action("press_key", summary);
    const navs = rec.navigations;
    const inflight = new Set(rec.inflight);
    try {
      await withTimeout(rec.page.keyboard.press(key), ACTION_TIMEOUT_MS, "The key press");
    } catch (err) {
      return failure(`${summary}: failed.`, err, this.#dialogNotes());
    }
    await this.#settle(rec, navs, inflight);
    return await this.#report(rec, `${summary}.`);
  }

  async scroll(deltaX: number, deltaY: number): Promise<ToolResult> {
    const rec = await this.#page();
    const summary = `Scrolled by ${deltaX}, ${deltaY}`;
    this.#action("scroll", summary);
    try {
      await withTimeout(rec.page.mouse.wheel(deltaX, deltaY), ACTION_TIMEOUT_MS, "The scroll");
    } catch (err) {
      return failure(`${summary}: failed.`, err);
    }
    // The wheel event is dispatched, not awaited to completion: give smooth scrolling a beat.
    await sleep(300);
    return await this.#report(rec, `${summary}.`);
  }

  async waitFor(what: { text?: string; textGone?: string; seconds?: number }): Promise<ToolResult> {
    const rec = await this.#page();
    const notes: string[] = [];
    let summary: string;
    if (what.seconds !== undefined) {
      summary = `Waited ${what.seconds} s`;
      this.#action("wait_for", summary);
      await sleep(what.seconds * 1000);
    } else {
      const target = (what.text ?? what.textGone)!;
      const gone = what.text === undefined;
      summary = gone
        ? `Waited for “${oneLine(target, 80)}” to go`
        : `Waited for “${oneLine(target, 80)}”`;
      this.#action("wait_for", summary);
      try {
        await rec.page.getByText(target).first().waitFor({
          state: gone ? "hidden" : "visible",
          timeout: 30_000,
        });
      } catch (err) {
        if (!isTimeout(err)) return failure(`${summary}: failed.`, err);
        notes.push(
          gone ? "The text was still there after 30 s." : "The text did not appear within 30 s.",
        );
      }
    }
    return await this.#report(rec, `${summary}.`, notes);
  }

  async screenshot(opts: { fullPage?: boolean; ref?: string }): Promise<ToolResult> {
    const rec = await this.#page();
    let target: Locator | null = null;
    if (opts.ref !== undefined) {
      try {
        target = await this.#locate(rec, opts.ref);
      } catch (err) {
        if (err instanceof RefGone) return refusal(err.message);
        throw err;
      }
    }
    this.#action(
      "screenshot",
      "Took a screenshot",
      target ? await this.#targetOf(target) : undefined,
    );
    const what = target !== null ? "element" : opts.fullPage ? "page" : "viewport";
    // What would be captured, in document CSS px, and whether it fits an image (core/screenshot.ts).
    // Null when it cannot be measured: an element with no box, which Playwright's own screenshot
    // then explains.
    let region: Region | null;
    try {
      region = await this.#shotRegion(rec, target, opts.fullPage ?? false);
    } catch (err) {
      return failure("The screenshot failed.", err);
    }
    const plan = region === null ? null : planCapture(region);
    const note = region === null || plan === null ? null : captureNote(what, region, plan);
    const take = async (type: "png" | "jpeg", quality = 75): Promise<Uint8Array> => {
      if (plan === null || (plan.scale === 1 && !plan.cropped)) {
        const common = {
          type,
          scale: "css" as const,
          animations: "disabled" as const,
          ...(type === "jpeg" ? { quality } : {}),
        };
        if (target !== null) return await target.screenshot(common);
        return await rec.page.screenshot({ ...common, fullPage: opts.fullPage ?? false });
      }
      // Playwright scales nothing, so a region past the cap is captured over CDP, scaled there.
      // Playwright's `animations: "disabled"` is restated around it: finite animations finished,
      // infinite ones cancelled for the capture and played again after.
      const cdp = await this.#cdp(rec);
      const pausing = rec.page.evaluateHandle(PAUSE_ANIMATIONS);
      const paused = await withTimeout(pausing, ACTION_TIMEOUT_MS, "Pausing animations")
        .catch(() => {
          // Given up on, the pause may still run once the page frees (a script held it): the
          // infinite animations it cancels are played again then, never left stopped.
          pausing.then((late) => late.evaluate(RESUME_ANIMATIONS).finally(() => late.dispose()))
            .catch(() => {});
          return null;
        });
      try {
        const { data } = await withTimeout(
          cdp.send("Page.captureScreenshot", {
            format: type,
            ...(type === "jpeg" ? { quality } : {}),
            clip: { ...plan.clip, scale: plan.scale },
            captureBeyondViewport: true,
          }),
          ACTION_TIMEOUT_MS,
          "The screenshot",
        );
        return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      } finally {
        // Best-effort, like the pause: a page that navigated meanwhile has no animations of
        // ours left to play.
        if (paused !== null) {
          await withTimeout(
            paused.evaluate(RESUME_ANIMATIONS),
            ACTION_TIMEOUT_MS,
            "Resuming animations",
          ).catch(() => {});
          await paused.dispose().catch(() => {});
        }
      }
    };
    let bytes: Uint8Array;
    let mimeType = "image/png";
    try {
      bytes = await take("png");
      if (bytes.byteLength > PNG_MAX_BYTES) {
        bytes = await take("jpeg");
        mimeType = "image/jpeg";
      }
      if (bytes.byteLength > SCREENSHOT_MAX_BYTES) bytes = await take("jpeg", 50);
    } catch (err) {
      return failure("The screenshot failed.", err);
    }
    if (bytes.byteLength > SCREENSHOT_MAX_BYTES) {
      return refusal(
        `The screenshot came to ${kb(bytes.byteLength)}, over the ${
          kb(SCREENSHOT_MAX_BYTES)
        } an image may be. Take a smaller part: the viewport, or one element by its ref.`,
      );
    }
    const size = imageSize(bytes);
    const dims = size === null ? "" : `, ${size.width}x${size.height} px`;
    const label = what === "page" ? "the full page" : `the ${what}`;
    return {
      content: [
        { type: "image", data: base64(bytes), mimeType },
        {
          type: "text",
          text: [
            `Screenshot of ${label}${dims} (${kb(bytes.byteLength)}).`,
            ...(note ? [note] : []),
          ]
            .join("\n"),
        },
      ],
    };
  }

  /**
   * The region a screenshot covers, in document CSS px: the viewport where it is scrolled to, the
   * whole document, or the element's box. From CDP's layout metrics, which a page's own scripts
   * cannot answer for. Null for an element with no box (hidden, detached).
   */
  async #shotRegion(
    rec: TabRecord,
    target: Locator | null,
    fullPage: boolean,
  ): Promise<Region | null> {
    const cdp = await this.#cdp(rec);
    const metrics = await withTimeout(
      cdp.send("Page.getLayoutMetrics"),
      QUICK_MS,
      "Measuring the page",
    );
    const view = metrics.cssVisualViewport;
    if (target !== null) {
      const box = await target.boundingBox({ timeout: ACTION_TIMEOUT_MS });
      if (box === null) return null;
      return { x: box.x + view.pageX, y: box.y + view.pageY, width: box.width, height: box.height };
    }
    if (fullPage) {
      const { width, height } = metrics.cssContentSize;
      return { x: 0, y: 0, width, height };
    }
    return { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight };
  }

  async evaluate(
    source: string,
    ref: string | undefined,
    timeoutMs = EVALUATE_DEFAULT_TIMEOUT_MS,
  ): Promise<ToolResult> {
    const rec = await this.#page();
    let locator: Locator | null = null;
    if (ref !== undefined) {
      try {
        locator = await this.#locate(rec, ref);
      } catch (err) {
        if (err instanceof RefGone) return refusal(err.message);
        throw err;
      }
    }
    this.#action(
      "evaluate",
      "Ran a script in the page",
      // Not scrolled to: reading an element must not move the page under the agent.
      locator ? await this.#targetOf(locator, false) : undefined,
    );
    // Playwright sends a function as `String(fn)` and calls it in the page, but treats a STRING
    // as an expression (no element argument, nothing called). A function object whose source is
    // the wrapper gets the first behaviour for source we built: the page compiles it through the
    // DevTools protocol, so a page's CSP (`unsafe-eval` off) does not stand in the way.
    const wrapped = wrapEvaluate(source);
    const fn = Object.assign((_el?: unknown) => undefined as unknown, { toString: () => wrapped });
    // A HANDLE, not a value: what the serialiser built stays in the page until `cutSerialised`
    // has pulled the capped text out of it (core/evaluate.ts).
    const run: Promise<JSHandle> = locator !== null
      ? locator.evaluateHandle(fn, undefined, { timeout: timeoutMs })
      : rec.page.evaluateHandle(fn);
    // Watched from the outside: `while (true) {}` holds the renderer's main thread, so nothing
    // inside the page can stop it, and Playwright's evaluate has no deadline of its own. On
    // timeout V8 is told to terminate whatever it is running (CDP Runtime.terminateExecution),
    // which frees the page for the next call.
    const outcome = await raceTimeout(run, timeoutMs);
    if (outcome.kind === "timeout") {
      const cdp = await this.#cdp(rec).catch(() => null);
      await cdp?.send("Runtime.terminateExecution").catch(() => {});
      await withTimeout(run.catch(() => {}), 2_000).catch(() => {});
      void run.then((h) => h.dispose()).catch(() => {});
      return refusal(
        `The function was stopped after ${timeoutMs} ms without finishing. If it waits on ` +
          "something slow, raise timeoutMs (up to 30000); if it loops, it will not finish.",
      );
    }
    if (outcome.kind === "error") return failure("The function threw.", outcome.error);
    const handle = outcome.value;
    let cut: unknown;
    try {
      cut = await withTimeout(
        handle.evaluate(cutSerialised, EVALUATE_RESULT_CAP),
        QUICK_MS,
        "Reading the result",
      );
    } catch (err) {
      return failure("The result could not be read.", err);
    } finally {
      void handle.dispose().catch(() => {});
    }
    const result = parseCut(cut, EVALUATE_RESULT_CAP);
    if (result === null) return refusal("The page returned something that is not a result.");
    const capped = capText(result.text, EVALUATE_RESULT_CAP);
    const notes = capped.truncated || result.total > result.text.length
      ? [`The result was cut at ${kb(capped.text.length)} of ${kb(result.total)}.`]
      : [];
    return text(["Result:", ...notes, "", untrusted(capped.text)].join("\n"));
  }

  async addInitScript(script: string): Promise<ToolResult> {
    if (this.#initScripts.length >= MAX_INIT_SCRIPTS) {
      return refusal(`At most ${MAX_INIT_SCRIPTS} init scripts are held; none was added.`);
    }
    const context = await this.#ensure();
    this.#action("add_init_script", "Added a script to run before every page load");
    try {
      await withTimeout(context.addInitScript({ content: script }), QUICK_MS, "Adding the script");
    } catch (err) {
      return failure("The script could not be added.", err);
    }
    this.#initScripts.push(script);
    const list = this.#initScripts.map((s, i) =>
      `${i + 1}. ${clip(s.replace(/\s+/g, " ").trim(), 200)}`
    );
    return text(
      [
        `Added. It runs before the page's own scripts on every later page load in this browser ` +
        `(navigate or reload to apply it now). ${this.#initScripts.length} init script${
          this.#initScripts.length === 1 ? "" : "s"
        } held:`,
        "",
        fence(list.join("\n")),
      ].join("\n"),
    );
  }

  consoleMessages(minLevel: ConsoleLevel | undefined): ToolResult {
    const since = this.#console.filter((e) => e.seq > this.#consoleCursor);
    const dropped = droppedSince(this.#console, this.#consoleCursor);
    this.#consoleCursor = this.#consoleSeq;
    const floor = minLevel === undefined ? 0 : levelRank(minLevel);
    const shown = since.filter((e) => levelRank(e.level) >= floor);
    this.#action("console_messages", "Read the console");
    return text(formatConsoleList(shown, dropped));
  }

  networkRequests(all: boolean): ToolResult {
    const since = this.#network.filter((e) => e.seq > this.#networkCursor);
    const dropped = droppedSince(this.#network, this.#networkCursor);
    this.#networkCursor = this.#networkSeq;
    const shown = all
      ? since
      : since.filter((e) =>
        networkWanted(e.resourceType, e.failure !== undefined || (e.status ?? 0) >= 400)
      );
    this.#action("network_requests", "Read the network log");
    return text(formatNetworkList(shown, all, dropped));
  }

  async tabs(
    action: "list" | "new" | "select" | "close",
    index?: number,
    url?: string,
  ): Promise<ToolResult> {
    const rec = await this.#page();
    switch (action) {
      case "list":
        this.#action("tabs", "Listed the tabs");
        return text(formatTabList(this.#tabList()));
      case "new": {
        this.#action("tabs", url ? `Opened a new tab at ${clip(url, 500)}` : "Opened a new tab");
        const page = await withTimeout(this.#context!.newPage(), QUICK_MS * 2, "Opening a tab");
        const next = this.#adopt(page);
        await this.#activate(next);
        const notes: string[] = [];
        if (url !== undefined) {
          try {
            await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
          } catch (err) {
            if (!isTimeout(err)) return failure(`Opening ${clip(url, 500)} failed.`, err);
            notes.push("The page did not finish loading in 30 s; this is how it looks so far.");
          }
        }
        return await this.#report(next, "Opened a new tab.", notes);
      }
      case "select": {
        const target = index === undefined ? undefined : this.#tabs[index];
        if (target === undefined) {
          return refusal(`There is no tab ${index ?? "(no index given)"}; tabs list shows them.`);
        }
        this.#action("tabs", `Switched to tab ${index}`);
        await this.#activate(target);
        return await this.#report(target, `Switched to tab ${index}.`);
      }
      case "close": {
        const target = index === undefined ? rec : this.#tabs[index];
        if (target === undefined) return refusal(`There is no tab ${index}; tabs list shows them.`);
        this.#action("tabs", `Closed tab ${this.#tabs.indexOf(target)}`);
        await withTimeout(target.page.close(), QUICK_MS, "Closing the tab").catch(() => {});
        // The close handler moves the active tab; the report is of wherever that left us.
        await this.#onClose(target);
        const now = await this.#page();
        return await this.#report(now, "Closed the tab.");
      }
    }
  }

  async resize(width: number, height: number): Promise<ToolResult> {
    const rec = await this.#page();
    this.#action("resize", `Resized the viewport to ${width}×${height}`);
    try {
      await withTimeout(rec.page.setViewportSize({ width, height }), QUICK_MS, "Resizing");
    } catch (err) {
      return failure(`Resizing the viewport to ${width}×${height} failed.`, err);
    }
    return await this.#report(rec, `Resized the viewport to ${width}×${height}.`);
  }
}

// ---- small things ---------------------------------------------------------------------------

function ring<T>(buffer: T[], entry: T): void {
  buffer.push(entry);
  if (buffer.length > RING) buffer.splice(0, buffer.length - RING);
}

/** How many entries after `cursor` the ring evicted before anyone read them. */
function droppedSince(buffer: Array<{ seq: number }>, cursor: number): number {
  const oldest = buffer[0];
  return oldest === undefined ? 0 : Math.max(0, oldest.seq - cursor - 1);
}

function withoutSeq<T extends { seq: number }>(entry: T): Omit<T, "seq"> {
  const { seq: _seq, ...rest } = entry;
  return rest;
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n").find((l) => l.trim() !== "")?.trim() ?? message;
}

/**
 * Why the sandboxed launch failed, in one line. Playwright's error opens with a generic "browser
 * has been closed" and carries Chromium's own log below it, where the line that names the cause
 * ("No usable sandbox!") is; that one is preferred when it is there.
 */
function sandboxReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split("\n").find((l) =>
    /sandbox/i.test(l) && !/chromiumSandbox|--no-sandbox/.test(l)
  );
  return (line ?? firstLine(err)).replace(/^\s*(\[[^\]]*\]\s*)*/, "").trim().slice(0, 300);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What `withTimeout` rejects with; named like Playwright's own, so `isTimeout` knows both. */
class Stalled extends Error {
  override name = "TimeoutError";
}

/**
 * `p`, or a TimeoutError after `ms`. For the calls Playwright puts no deadline on: the promise
 * itself is left to settle on its own (its rejection handled), since nothing can cancel it.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, what = "The call"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Stalled(
                `${what} got no answer from the page in ${ms} ms; a script may be holding it.`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Raced<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | {
  kind: "timeout";
};

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(
        (value): Raced<T> => ({ kind: "value", value }),
        (error): Raced<T> => ({ kind: "error", error }),
      ),
      new Promise<Raced<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Playwright's `animations: "disabled"`, for the screenshot it cannot take (a scaled one, over
 * CDP): every finite animation finished, every infinite one cancelled, and those handed back to
 * be played again after the capture (RESUME_ANIMATIONS). Source text, as the page runs it.
 */
const PAUSE_ANIMATIONS = `(() => {
  const infinite = [];
  for (const animation of document.getAnimations()) {
    if (animation.effect && animation.effect.getComputedTiming().endTime === Infinity) {
      animation.cancel();
      infinite.push(animation);
    } else {
      animation.finish();
    }
  }
  return infinite;
})()`;

/** Plays again the infinite animations PAUSE_ANIMATIONS cancelled. */
const RESUME_ANIMATIONS = (list: Array<{ play(): void }>) => list.forEach((a) => a.play());
