import { isSessionToken } from "../../../lib/utils/auth/jwt";

/**
 * Which proxied paths this route is willing to forward.
 *
 * The path decides WHICH service a request goes to — each branch of the proxy matches it against
 * a regex and picks a fixed, env-configured base URL — and `new URL()` then collapses any `.` or
 * `..` segments AFTER that choice was made. A caller that sends un-normalized segments (they
 * survive `curl --path-as-is`) can therefore have a path routed as one service's and resolved
 * against another path on that same origin.
 *
 * No branch lets a caller choose a HOST, so this was never a way to reach an arbitrary server,
 * and the internal surfaces behind it are service-authed while the only credentials forwarded
 * are the session cookie's JWT and, on the CLI's bearer doors alone, a caller's own bearer
 * (`upstreamAuthorization`) — it fails closed. It is refused anyway: a path that means one
 * thing to the router and another to the URL parser has no business being forwarded at all.
 */
export function isForwardablePath(path: string): boolean {
  if (!path.startsWith("v1/")) return false;
  // A relative segment, wherever it sits.
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") return false;
  }
  // An encoded separator: `new URL()` leaves these alone, so they reach the service as a literal
  // slash or backslash inside what the router read as a single segment.
  if (/%2f|%5c/i.test(path) || path.includes("\\")) return false;
  return true;
}

/**
 * A door, as method and path with `:name` for one segment: compiled once into an anchored regex,
 * so a segment never stretches across a `/`.
 */
function door(method: string, path: string): readonly [string, RegExp, string] {
  const pattern = path.split("/").map((segment) =>
    segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join("/");
  return [method, new RegExp(`^${pattern}$`), path];
}

/**
 * The doors a caller's own bearer may come through: the routes the `ryph` CLI calls with an API
 * token it exchanged — `ryph checks`, and the tools `ryph mcp` serves (packages/ryph/src/mcp, whose
 * tests hold every route a tool calls to this list). Method and path, exactly as the routes are.
 *
 * Every one is a user-surface route that verifies the bearer itself and decides from the token's
 * own `caps` claim (`refuseUnless`, or the service's capability gate), so an API token can do
 * through here only what its capabilities allow — and a token never holds more than its owner's
 * role. None reads the session cookie, the forwarded client headers or the proxy secret, and none
 * asks whether the caller is a session (only auth's account routes do, and the one auth route
 * here, `GET v1/auth/me`, answers a token as itself). Left out on purpose: people, invites,
 * instance settings, tokens, model keys and providers, the egress allowlist, reserved capacity,
 * image downloads, memory's embedding backfill, attachments and artifact documents, and every
 * runner, service and forge door.
 */
const BEARER_DOORS: ReadonlyArray<readonly [string, RegExp, string]> = [
  // `ryph checks`: asking for checks on your own commit, and following what you asked for.
  door("POST", "v1/check-delegations"),
  door("POST", "v1/check-delegations/bundle"),
  door("DELETE", "v1/check-delegations/:id"),
  door("GET", "v1/check-delegations/declaration"),
  door("GET", "v1/check-delegations/:id"),
  door("POST", "v1/check-suites"),
  door("POST", "v1/check-suites/bundle"),
  door("GET", "v1/check-suites/:id"),
  door("GET", "v1/check-suites/:id/log"),
  door("GET", "v1/check-requests/:id"),
  // The rest of checks: the suites list, a rerun, and fork approvals.
  door("GET", "v1/check-suites"),
  door("POST", "v1/check-suites/:id/rerun"),
  door("GET", "v1/checks/active"),
  door("GET", "v1/checks/repos"),
  door("GET", "v1/check-approvals/:id"),
  door("POST", "v1/check-approvals/:id/approve"),
  // Who the token speaks for.
  door("GET", "v1/auth/me"),
  // Tasks, and talking to their runs. A run's GET messages is the runner's inbox read, and stays
  // shut: only the POST is a person's.
  door("GET", "v1/tasks"),
  door("POST", "v1/tasks"),
  door("GET", "v1/tasks/:id"),
  door("POST", "v1/tasks/:id/cancel"),
  door("POST", "v1/tasks/:id/finish"),
  door("POST", "v1/runs/:id/messages"),
  door("GET", "v1/responses"),
  door("GET", "v1/responses/:id"),
  door("POST", "v1/responses/:id/close"),
  // A run's records: its transcript and subagents (the historian, by the run's grant or
  // tasks:read-all; never its ingest POSTs), its background commands and their live output, its
  // previews, its tool-call trail and its model bill (each by the run's grant, else the service's
  // own capability).
  door("GET", "v1/runs/:id/events"),
  door("GET", "v1/runs/:id/lanes"),
  door("GET", "v1/runs/:id/background"),
  door("GET", "v1/runs/:id/background/:job/log"),
  door("GET", "v1/runs/:id/live/commands/stream"),
  door("GET", "v1/runs/:id/previews"),
  door("POST", "v1/runs/:id/previews/:preview/open"),
  door("GET", "v1/mcp-usage/:id"),
  door("GET", "v1/model-usage/runs/:id"),
  // Patches.
  door("GET", "v1/patches"),
  door("GET", "v1/patches/:id"),
  door("GET", "v1/patches/:id/diff"),
  door("POST", "v1/patches/:id/approve"),
  door("POST", "v1/patches/:id/reject"),
  door("POST", "v1/patches/:id/retry"),
  // Agents.
  door("GET", "v1/agents"),
  door("POST", "v1/agents"),
  door("GET", "v1/agents/:id"),
  door("PATCH", "v1/agents/:id"),
  door("POST", "v1/agents/:id/archive"),
  // Repositories: connecting and configuring them, their command allowlists and environments.
  door("GET", "v1/connected-repos"),
  door("POST", "v1/connected-repos"),
  door("PATCH", "v1/connected-repos/:id"),
  door("POST", "v1/connected-repos/:id/archive"),
  door("GET", "v1/connected-repos/:id/radicle"),
  door("GET", "v1/connected-repos/:id/command-allowlist"),
  door("POST", "v1/connected-repos/:id/command-allowlist"),
  door("DELETE", "v1/connected-repos/:id/command-allowlist/:subject"),
  door("GET", "v1/connected-repos/:id/environment"),
  door("GET", "v1/connected-repos/:id/environment/definition"),
  door("POST", "v1/connected-repos/:id/environment/rebuild"),
  door("POST", "v1/connected-repos/:id/environment/setup"),
  door("GET", "v1/connected-repos/:id/services"),
  door("GET", "v1/forge-providers"),
  door("GET", "v1/installations"),
  door("POST", "v1/installations"),
  door("GET", "v1/installations/:id/repos"),
  door("GET", "v1/github/repos"),
  door("GET", "v1/radicle/identity"),
  // Workspaces.
  door("GET", "v1/workspaces"),
  door("POST", "v1/workspaces"),
  door("GET", "v1/workspaces/:id"),
  door("PATCH", "v1/workspaces/:id"),
  door("POST", "v1/workspaces/:id/archive"),
  door("POST", "v1/workspaces/:id/repos"),
  door("PATCH", "v1/workspaces/:id/repos/:repo"),
  door("DELETE", "v1/workspaces/:id/repos/:repo"),
  door("GET", "v1/workspaces/:id/environment"),
  door("GET", "v1/workspaces/:id/environment/definition"),
  door("POST", "v1/workspaces/:id/environment/rebuild"),
  door("POST", "v1/workspaces/:id/environment/setup"),
  // Environment builds.
  door("GET", "v1/environments"),
  door("GET", "v1/environments/:id"),
  door("GET", "v1/environments/:id/log"),
  // What the deployment offers a task (reads only: pulling images and the egress allowlist's
  // PUT are the instance's).
  door("GET", "v1/harnesses"),
  door("GET", "v1/images"),
  door("GET", "v1/run-sizes"),
  door("GET", "v1/limits"),
  door("GET", "v1/egress"),
  // Skills.
  door("GET", "v1/skills"),
  door("GET", "v1/skills/syncs"),
  door("GET", "v1/skills/catalogue/:name"),
  door("GET", "v1/skills/org/:name"),
  door("GET", "v1/skills/bundles/:digest"),
  door("PUT", "v1/skills/settings"),
  door("PUT", "v1/skills/org-repo"),
  door("DELETE", "v1/skills/org-repo"),
  door("POST", "v1/skills/org-repo/sync"),
  // Memory (the memory service's user surface; not its embedding backfill).
  door("GET", "v1/memories"),
  door("POST", "v1/memories"),
  door("GET", "v1/memories/:id"),
  door("PATCH", "v1/memories/:id"),
  door("POST", "v1/memories/:id/pin"),
  door("POST", "v1/memories/:id/unpin"),
  door("POST", "v1/memories/:id/retire"),
  door("GET", "v1/memory/subjects"),
  door("GET", "v1/memory/health"),
  door("POST", "v1/memory/brief-preview"),
  door("POST", "v1/memory/consolidate"),
  door("GET", "v1/memory/sources"),
  door("POST", "v1/memory/sources"),
  door("GET", "v1/memory/sources/:id"),
  door("POST", "v1/memory/sources/:id/withdraw"),
  door("POST", "v1/memory/sources/:id/move"),
  door("GET", "v1/memory-proposals"),
  door("POST", "v1/memory-proposals"),
  door("POST", "v1/memory-proposals/resolve"),
  door("POST", "v1/memory-proposals/:id/accept"),
  door("POST", "v1/memory-proposals/:id/reject"),
  // Chatrooms (the chat service) and their command policy (the control plane).
  door("GET", "v1/chatrooms"),
  door("POST", "v1/chatrooms"),
  door("GET", "v1/chatrooms/:id"),
  door("PATCH", "v1/chatrooms/:id"),
  door("POST", "v1/chatrooms/:id/archive"),
  door("GET", "v1/chatrooms/:id/channels"),
  door("GET", "v1/chatrooms/:id/groups"),
  door("GET", "v1/command-rooms/:id"),
  door("PUT", "v1/command-rooms/:id"),
  door("DELETE", "v1/command-rooms/:id"),
  // MCP servers (the gateway's control listener — archive is the control plane's, which fronts
  // it; never the gateway's internal or data-plane doors).
  door("GET", "v1/mcp-catalogue"),
  door("GET", "v1/mcp-servers"),
  door("POST", "v1/mcp-servers"),
  door("GET", "v1/mcp-servers/:id"),
  door("PATCH", "v1/mcp-servers/:id"),
  door("POST", "v1/mcp-servers/:id/archive"),
  door("POST", "v1/mcp-servers/:id/probe"),
  door("POST", "v1/mcp-servers/:id/restart"),
  door("GET", "v1/mcp-servers/:id/logs"),
  // Artifacts' records (their documents are the app's own routes, never forwarded).
  door("GET", "v1/artifacts"),
  door("GET", "v1/artifacts/:id"),
  door("DELETE", "v1/artifacts/:id"),
  // Automations (the automations service; its events door is the control plane's and 404s here).
  door("GET", "v1/automations"),
  door("POST", "v1/automations"),
  door("GET", "v1/automations/:id"),
  door("PATCH", "v1/automations/:id"),
  door("DELETE", "v1/automations/:id"),
  door("POST", "v1/automations/:id/enable"),
  door("POST", "v1/automations/:id/disable"),
  door("POST", "v1/automations/:id/rotate-secret"),
  door("GET", "v1/automations/:id/fires"),
];

/**
 * Paths a door's `:id` would match that are routes of their own, and not doors: the task list's
 * event stream reads as `GET v1/tasks/:id`, but no tool calls it, and a stream held open on a
 * bearer is not something an API token needs here.
 */
const NOT_BEARER_DOORS: ReadonlyArray<readonly [string, RegExp, string]> = [
  door("GET", "v1/tasks/stream"),
];

/** Every bearer door as written, method and path with `:name` segments, for the CLI's tests. */
export function bearerDoors(): Array<readonly [string, string]> {
  return BEARER_DOORS.map(([method, , path]) => [method, path] as const);
}

/** Whether the caller's own bearer goes upstream on this method and path. */
export function isBearerDoor(method: string, path: string): boolean {
  const matches = ([m, pattern]: readonly [string, RegExp, string]) =>
    m === method && pattern.test(path);
  return BEARER_DOORS.some(matches) && !NOT_BEARER_DOORS.some(matches);
}

/**
 * The `authorization` the proxy sends upstream: the session's access token from the httpOnly
 * cookie when there is one; else, on the bearer doors above only, the caller's own `Bearer`
 * header, verbatim; else none.
 *
 * The second is how a token holder outside the browser (the CLI, with a token it exchanged)
 * reaches the API on a deployment where only this app is public. It opens no CSRF door: a
 * browser never attaches an `Authorization` header by itself. It is an allowlist because the
 * services behind this proxy also serve doors for runner and service tokens (a run's
 * credentials, the git-key resolve), which are internal and must stay unreachable from the
 * internet: everywhere else a caller's bearer is dropped, and the request goes up anonymous.
 * The cookie wins when both are present: a signed-in browser is always its own session. Only a
 * session's token (`via: "session"`) is taken from the cookie: an API token's, put there by its
 * holder, would otherwise skip the doors.
 */
export function upstreamAuthorization(
  cookieToken: string | undefined,
  incoming: string | null,
  method: string,
  path: string,
): string | null {
  // The hook already keeps anything but a session's token out of `locals.accessToken`; checked
  // again here, where it decides what goes upstream. A cookie that is not a session's is refused
  // like any other bearer off the doors: the request goes up with none.
  if (cookieToken) return isSessionToken(cookieToken) ? `Bearer ${cookieToken}` : null;
  if (incoming === null || !/^Bearer [^\s]+$/.test(incoming)) return null;
  return isBearerDoor(method, path) ? incoming : null;
}

/**
 * The upstream response headers the browser gets. The content type always (JSON when the
 * upstream named none); cache-control so event streams reach the browser unbuffered and uncached,
 * and a run's image is revalidated on every view; the two a raw body relies on to stay inert (a check log
 * is text the head wrote, an image is bytes a person uploaded): `x-content-type-options: nosniff`
 * and `content-security-policy`; and `content-disposition`, which names an image `inline` under
 * a filename the control plane minted, so "save image" never takes one from the upload. Nothing
 * else crosses: cookies and the upstream's own framing are this server's to set.
 */
export function forwardedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers({
    "content-type": upstream.get("content-type") ?? "application/json",
  });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "x-content-type-options",
  "content-security-policy",
  "content-disposition",
];

/** A run's reads from the historian — the paginated GET and the SSE tail of its transcript (or of
 * one subagent's), the listing of its subagents and its live feed, and the live streams of its browser and its background commands — which a standalone historian
 * serves; everything else is the orchestrator's. The runner's ingest POSTs go to the historian
 * directly, never through this proxy. */
const HISTORY_READ_PATH =
  /^v1\/runs\/[^/]+\/(events(\/stream)?|lanes(\/stream)?|live(\/commands)?\/stream)$/;

export function isHistoryReadPath(path: string): boolean {
  return HISTORY_READ_PATH.test(path);
}

/**
 * Paths only the app's own routes reach, never this proxy. An artifact version's document: served
 * raw from here it would be a page on this app's origin without the frame's guards. A repo's
 * installation settings: a redirect to GitHub, which a proxy would follow instead of passing on.
 */
const APP_ROUTE_PATHS = [
  /^v1\/artifacts\/[^/]+\/versions\/[^/]+\/content\/?$/,
  /^v1\/connected-repos\/[^/]+\/installation-settings\/?$/,
];

export function isAppRoutePath(path: string): boolean {
  return APP_ROUTE_PATHS.some((p) => p.test(path));
}

/**
 * A browser navigating here from another site: a link, a form, a popup or a frame some other
 * page opened. Nothing in this app navigates to /api, and a navigation carries the session's
 * cookies, so these are refused before anything is forwarded.
 */
export function isCrossSiteNavigation(headers: Headers): boolean {
  return headers.get("sec-fetch-site") === "cross-site" &&
    headers.get("sec-fetch-mode") === "navigate";
}
