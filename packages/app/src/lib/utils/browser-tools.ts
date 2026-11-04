// The run's browser tools, said the way a person would say them. The sidecar's MCP server is
// mounted under the slug `browser`, so its tools reach the transcript as `browser__click` and so
// on.

/** The slug the runner mounts the browser sidecar's MCP server under. */
export const BROWSER_SERVER = "browser";

const PREFIX = `${BROWSER_SERVER}__`;

/** The browser tool behind a transcript tool name (`browser__click` → `click`); null for any other. */
export function browserToolOf(name: string): string | null {
  return name.startsWith(PREFIX) && name.length > PREFIX.length ? name.slice(PREFIX.length) : null;
}

/**
 * A live action's tool as the sidecar names it. The contract leaves open whether it carries the
 * slug, so both spellings are read as the bare name.
 */
export function bareBrowserTool(tool: string): string {
  return browserToolOf(tool) ?? tool;
}

/** How a call reads in a row: the phrase on its badge, and what it acted on beside it. */
export interface BrowserCallText {
  label: string;
  subject: string | null;
}

const MAX_QUOTED = 60;

/** A model-written description, quoted, and cut short when it runs on. */
function quoted(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const cut = flat.length > MAX_QUOTED ? `${flat.slice(0, MAX_QUOTED - 1)}…` : flat;
  return `“${cut}”`;
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The first line of a script, which is usually enough to tell one from another. */
function firstLine(source: string): string {
  return source.trim().split("\n")[0];
}

/**
 * What a browser call did, from its tool name and the arguments the model sent. Arguments are
 * whatever the model wrote, so every read is defensive and every tool has a phrase that needs none
 * of them.
 */
export function describeBrowserCall(tool: string, rawArgs: unknown): BrowserCallText {
  const args = typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {};
  const element = str(args, "element");
  const on = (verb: string) => (element === null ? verb : `${verb} ${quoted(element)}`);
  switch (tool) {
    case "navigate":
      return { label: "Opened a page", subject: str(args, "url") };
    case "back":
      return { label: "Went back", subject: null };
    case "forward":
      return { label: "Went forward", subject: null };
    case "reload":
      return { label: "Reloaded the page", subject: null };
    case "snapshot":
      return { label: "Read the page", subject: null };
    case "click":
      return { label: on(args.doubleClick === true ? "Double-clicked" : "Clicked"), subject: null };
    case "hover":
      return { label: on("Hovered over"), subject: null };
    case "type": {
      const text = str(args, "text");
      return {
        label: element === null ? "Typed" : `Typed into ${quoted(element)}`,
        subject: text === null ? null : text,
      };
    }
    case "press_key": {
      const key = str(args, "key");
      return { label: key === null ? "Pressed a key" : `Pressed ${key}`, subject: null };
    }
    case "select_option": {
      const values = Array.isArray(args.values)
        ? args.values.filter((v): v is string => typeof v === "string")
        : [];
      return {
        label: element === null ? "Picked an option" : `Picked in ${quoted(element)}`,
        subject: values.length === 0 ? null : values.join(", "),
      };
    }
    case "scroll": {
      const dy = num(args, "deltaY") ?? 0;
      const dx = num(args, "deltaX") ?? 0;
      const way = Math.abs(dy) >= Math.abs(dx)
        ? (dy < 0 ? "up" : dy > 0 ? "down" : null)
        : (dx < 0 ? "left" : "right");
      return { label: way === null ? "Scrolled" : `Scrolled ${way}`, subject: null };
    }
    case "wait_for": {
      const text = str(args, "text");
      const gone = str(args, "textGone");
      const seconds = num(args, "seconds");
      if (text !== null) return { label: `Waited for ${quoted(text)}`, subject: null };
      if (gone !== null) return { label: `Waited for ${quoted(gone)} to go`, subject: null };
      if (seconds !== null) {
        return {
          label: `Waited ${seconds} ${seconds === 1 ? "second" : "seconds"}`,
          subject: null,
        };
      }
      return { label: "Waited", subject: null };
    }
    case "screenshot":
      return {
        label: element !== null
          ? `Took a screenshot of ${quoted(element)}`
          : args.fullPage === true
          ? "Took a full-page screenshot"
          : "Took a screenshot",
        subject: null,
      };
    case "evaluate": {
      const source = str(args, "function");
      return { label: "Ran a script", subject: source === null ? null : firstLine(source) };
    }
    case "add_init_script": {
      const source = str(args, "script");
      return {
        label: "Added a script to every page",
        subject: source === null ? null : firstLine(source),
      };
    }
    case "console_messages":
      return { label: "Read the console", subject: null };
    case "network_requests":
      return { label: "Read the network log", subject: null };
    case "tabs": {
      const action = str(args, "action");
      const index = num(args, "index");
      switch (action) {
        case "new":
          return { label: "Opened a tab", subject: str(args, "url") };
        case "select":
          return {
            label: index === null ? "Switched tab" : `Switched to tab ${index + 1}`,
            subject: null,
          };
        case "close":
          return { label: "Closed a tab", subject: null };
        default:
          return { label: "Listed tabs", subject: null };
      }
    }
    case "resize": {
      const w = num(args, "width");
      const h = num(args, "height");
      return {
        label: w !== null && h !== null ? `Resized to ${w}×${h}` : "Resized the window",
        subject: null,
      };
    }
    default:
      return { label: `Used ${tool}`, subject: null };
  }
}

/**
 * Why a run started without the browser its agent has, from a `browser.unavailable` event's
 * detail. The control plane words three reasons (orchestrator `core/browser.ts`
 * `browserGrant`); each is said shortly here, and anything else is shown as it came.
 */
export function browserUnavailableReason(detail: string): string {
  if (detail.includes("RYPH_BROWSER_IMAGE")) return "This deployment doesn't run browsers.";
  if (detail.includes("provisioner")) return "This deployment's provisioner can't launch one.";
  if (detail.includes("MCP")) return "The agent's harness can't use one.";
  return detail;
}
