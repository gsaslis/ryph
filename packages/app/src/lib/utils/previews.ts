import type { ToolCall } from "$lib/api/tools";
import { ID_BODY } from "./ids";

/**
 * A preview on this machine: the local binary's `<id>.localhost:<port>`, or a compose or local
 * cluster previews service's `<id>.preview.localhost:<port>`.
 */
const LOCAL_PREVIEW = /^http:\/\/[a-f0-9]{32}\.(?:[a-z0-9-]+\.)*localhost:[0-9]+$/;
/** A preview the previews service serves: its own origin under the cell's preview domain. */
const HOSTED_PREVIEW = /^https:\/\/[a-f0-9]{32}\.[a-z0-9.-]+$/;

/** Never turn a server-supplied link into a navigation outside a preview's own origin. */
export function isPreviewUrl(url: string): boolean {
  return LOCAL_PREVIEW.test(url) || HOSTED_PREVIEW.test(url);
}

/** The local binary's own preview, `<id>.localhost:<port>`, which only this machine reaches. A
 * compose previews service's `<id>.preview.localhost` is opened by whoever can read the run. */
const MACHINE_PREVIEW = /^http:\/\/[a-f0-9]{32}\.localhost:[0-9]+$/;

export function isLocalPreviewUrl(url: string): boolean {
  return MACHINE_PREVIEW.test(url);
}

const PREVIEW_REPLY = /^Open preview: (\S+)\s*$/m;

export const RUN_ID = new RegExp(`^r-${ID_BODY}$`);
export const PREVIEW_ID = /^[a-f0-9]{32}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where the open action goes: the app's own route, which asks the control plane for a one-time
 * way in and sends the tab there. `task` is where a failure comes back to.
 */
export function previewHref(
  runId: string,
  previewId: string,
  { grant = null, taskId = null }: { grant?: string | null; taskId?: string | null } = {},
): string {
  const query = new URLSearchParams();
  if (grant) query.set("grant", grant);
  if (taskId) query.set("task", taskId);
  const search = query.toString() === "" ? "" : `?${query}`;
  return `/previews/${encodeURIComponent(runId)}/${encodeURIComponent(previewId)}${search}`;
}

/**
 * The open by preview id alone, `/previews/<previewId>?path=`: where the previews service sends a
 * page load that came without its cookie, and what the notice of a failed one tries again.
 */
export function previewOpenHref(previewId: string, path: string | null = null): string {
  const query = path ? `?${new URLSearchParams({ path })}` : "";
  return `/previews/${encodeURIComponent(previewId)}${query}`;
}

/** Where a failed open by preview id goes: a notice that can try that open again. A static
 * segment, so it never matches the open itself (32 hex) or the run page's (two segments). */
export const PREVIEW_UNAVAILABLE = "/previews/unavailable";

export function previewUnavailableHref(previewId: string, path: string | null = null): string {
  const query = new URLSearchParams({ id: previewId });
  if (path) query.set("path", path);
  return `${PREVIEW_UNAVAILABLE}?${query}`;
}

/** The task page a failed open returns to, or null when the id is not one. */
export function taskPath(taskId: string | null): string | null {
  return taskId !== null && TASK_ID.test(taskId) ? `/tasks/${taskId}` : null;
}

/**
 * The URL the open answer may send a tab to, or null. Only the preview's own origin, at its root
 * or its one-time entry path with nothing but the ticket on it.
 */
export function openablePreviewUrl(value: unknown, previewId: string): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
  if (!isPreviewUrl(url.origin)) return null;
  if (url.hostname.split(".")[0] !== previewId) return null;
  const params = [...url.searchParams.keys()];
  const root = url.pathname === "/" && url.search === "";
  // A hosted ticket is `<exp>.<nonce>.<mac>`; the local binary's has no dots.
  const enter = url.pathname === "/__ryph/enter" && params.length === 1 &&
    params[0] === "ticket" && /^[A-Za-z0-9._-]+$/.test(url.searchParams.get("ticket") ?? "");
  return root || enter ? url.href : null;
}

/** Recognise only the platform tool; never make an arbitrary tool's output a link. */
export function previewCallOf(
  call: ToolCall,
): { label: string; port: number; url: string | null } | null {
  if (call.view.kind !== "mcp" || call.view.server !== "ryph" || call.view.tool !== "expose_port") {
    return null;
  }
  const args = call.view.args as { port?: unknown; label?: unknown } | null;
  if (
    !args || typeof args.port !== "number" || !Number.isInteger(args.port) ||
    args.port < 1024 || args.port > 65535 || typeof args.label !== "string"
  ) return null;
  const reply = call.done && !call.isError ? call.view.output?.match(PREVIEW_REPLY)?.[1] : null;
  const url = reply != null && isPreviewUrl(reply) ? reply : null;
  return { label: args.label, port: args.port, url };
}
