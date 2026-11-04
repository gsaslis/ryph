import { ApiError } from "$lib/api/call";
import { markWelcomeDone } from "$lib/utils/welcome";

/**
 * What an error page is told about a load that threw something other than SvelteKit's own
 * `error()` — the body of both sides' `handleError` hook.
 *
 * Nearly every load here is a control-plane read, and a read that fails throws an `ApiError` —
 * which SvelteKit does not know, so on its own it files every one of them as a 500 with the
 * message "Internal Error". A task that does not exist then looked exactly like the server
 * falling over. The control plane already said which it was; this passes its status and its
 * words through, so the error page can tell "no such task" from "try again in a moment".
 *
 * The page's own status stays what SvelteKit decided (a hook cannot change it), which is why the
 * boundary reads `page.error.status` first. Anything else keeps SvelteKit's own message: an
 * exception from our code has nothing in it a reader can act on.
 */
export function describeError(error: unknown, status: number, message: string): App.Error {
  const described = error instanceof ApiError
    ? { message: error.message, status: error.status }
    : { message, status };
  // A 4xx is an answer, not a fault — a mistyped task ID is not worth a stack trace in the log.
  // Installing the hook replaces SvelteKit's own logging, so the rest is logged here.
  if (described.status >= 500) console.error(error);
  return described;
}

/** What a failed page would have shown, and the way back from it. */
export type ErrorScope = {
  noun: string;
  back?: { href: string; label: string; onclick?: () => void };
};

/**
 * The pages that show ONE thing, by the route that shows it — so their error names that thing
 * ("Task not found") and offers its list, rather than saying "page". Keyed by route prefix: an
 * edit flow under a detail route fails for the same reason its detail page would.
 */
const SCOPES: [string, ErrorScope][] = [
  ["/(app)/tasks/[id]", { noun: "task", back: { href: "/tasks", label: "All tasks" } }],
  [
    "/(app)/memory/sources/[id]",
    { noun: "memory source", back: { href: "/memory/sources", label: "All sources" } },
  ],
  ["/(app)/memory/[id]", { noun: "memory", back: { href: "/memory", label: "All memories" } }],
  ["/(app)/repos/[id]", { noun: "repository", back: { href: "/repos", label: "All repos" } }],
  [
    "/(app)/workspaces/[id]",
    { noun: "workspace", back: { href: "/workspaces", label: "All workspaces" } },
  ],
  [
    "/(app)/triggers/[id]",
    { noun: "trigger", back: { href: "/triggers", label: "All triggers" } },
  ],
  ["/(flows)/triggers/[id]", {
    noun: "trigger",
    back: { href: "/triggers", label: "All triggers" },
  }],
  ["/(flows)/agents/[id]", { noun: "agent", back: { href: "/agents", label: "All agents" } }],
  ["/artifacts/[id]", { noun: "artifact", back: { href: "/artifacts", label: "All artifacts" } }],
  [
    "/(flows)/triggers/chat/[chatroomId]",
    { noun: "chat", back: { href: "/triggers", label: "All triggers" } },
  ],
];

/** The scope of the page at `routeId`: its own when it shows one thing, the whole app otherwise. */
export function scopeFor(routeId: string | null): ErrorScope {
  // The welcome flow failing must not strand anyone: until it is finished or skipped, the app
  // sends an admin straight back to it. So its way out skips it, as its own "Skip setup" does.
  if (routeId === "/(flows)/welcome") {
    return {
      noun: "page",
      back: { href: "/agents", label: "Skip setup", onclick: markWelcomeDone },
    };
  }
  const match = routeId === null
    ? undefined
    : SCOPES.find(([prefix]) => routeId.startsWith(prefix));
  return match?.[1] ?? { noun: "page", back: { href: "/", label: "Go home" } };
}
