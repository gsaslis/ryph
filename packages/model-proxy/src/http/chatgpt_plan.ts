// Signing a ChatGPT plan in: the management routes beside the provider-key CRUD, and the
// short-lived loopback listener OpenAI's browser redirect lands on.
//
// Invariants:
// - every route is ADMIN-gated, like registering any other key: a plan is spent by everyone on
//   the deployment, so adding one is a spending decision
// - these routes exist only on a local deployment (setup.ts); anywhere else `planOffRoutes`
//   answers them, with the reason
// - the listener is the ONLY way a sign-in finishes. There is no pasted-address route: OpenAI's
//   loopback redirect is how it keeps plan usage to apps on the person's own machine, and a
//   paste would carry it to a remote one
// - the listener exists only while a sign-in this process started is pending, on
//   127.0.0.1:1455 and nowhere else, and answers one path. Where it cannot bind (the port is
//   taken, or the process may not listen there) the sign-in is refused at the start
// - the page the listener answers with reflects nothing from the request: the query carries a
//   code, and the page says only whether it worked

import { type HttpServer, serve } from "@ryph/service";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import {
  CALLBACK_HOST,
  CALLBACK_PATH,
  CALLBACK_PORT,
  PLAN_LOCAL_ONLY,
  PLAN_LOCAL_ONLY_CODE,
} from "../core/chatgpt_plan.ts";
import type { PlanKeys } from "../core/plan_keys.ts";
import { StartPlanSignInSchema } from "../schema.ts";

/** A sign-in carries only an optional label and existing key id. */
export const MAX_PLAN_SIGN_IN_BODY_BYTES = 64 * 1024;

/** The plan routes' paths, shared by the live routes and their disabled stand-ins. */
export const PLAN_PATHS = {
  signIns: "/v1/chatgpt-plan/sign-ins",
  signIn: "/v1/chatgpt-plan/sign-ins/:id",
  models: "/v1/provider-keys/:id/chatgpt-plan/models",
} as const;

// ── the loopback listener ───────────────────────────────────────────────────────────────────

export interface CallbackListener {
  /** Opens (or keeps) the listener for one pending sign-in; false when it cannot listen. */
  open(signInId: string, expiresAtMs: number): Promise<boolean>;
  /** Drops every sign-in no longer pending, and closes the listener when none is left. */
  sweep(): Promise<void>;
  /** Closes the listener and forgets every sign-in. */
  close(): Promise<void>;
  /** The bound port while listening, else null — for tests that bind port 0. */
  port(): number | null;
}

export interface CallbackListenerDeps {
  hostname?: string;
  port?: number;
  /** Finishes the sign-in the query's state names; true when it did. */
  complete(query: URLSearchParams): Promise<boolean>;
  /** Whether a sign-in still waits for its callback. */
  pending(signInId: string): Promise<boolean>;
  now(): Date;
  diag: { debug(event: string, data?: Record<string, unknown>): void };
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  // The address carries the code; nothing on the page may send it anywhere.
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
};

function page(status: number, text: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>ryph</title></head>` +
      `<body style="font-family:system-ui,sans-serif;margin:3rem">` +
      `<p>${text}</p></body></html>`,
    { status, headers: PAGE_HEADERS },
  );
}

export function makeCallbackListener(deps: CallbackListenerDeps): CallbackListener {
  const hostname = deps.hostname ?? CALLBACK_HOST;
  const wanted = deps.port ?? CALLBACK_PORT;
  /** Each pending sign-in this process opened the listener for, with its expiry timer. */
  const waiting = new Map<string, ReturnType<typeof setTimeout>>();
  let server: HttpServer | null = null;
  /** A listener still letting go of the port: a new one binds only after it has. */
  let closing: Promise<void> | null = null;
  /** A bind in flight, which every concurrent open shares: true once listening, false if not. */
  let binding: Promise<boolean> | null = null;

  const shutdown = async () => {
    // A listener still binding is closed once it is up, not left listening for nobody.
    if (binding !== null) await binding;
    const running = server;
    if (running === null) {
      if (closing !== null) await closing;
      return;
    }
    server = null;
    const done = running.shutdown().catch(() => {}).finally(() => {
      if (closing === done) closing = null;
    });
    closing = done;
    await done;
  };

  const forget = (signInId: string) => {
    const timer = waiting.get(signInId);
    if (timer !== undefined) clearTimeout(timer);
    waiting.delete(signInId);
  };

  const sweep = async () => {
    for (const id of [...waiting.keys()]) {
      if (!(await deps.pending(id).catch(() => false))) forget(id);
    }
    if (waiting.size === 0) await shutdown();
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      return new Response("not found", { status: 404 });
    }
    let ok = false;
    try {
      ok = await deps.complete(url.searchParams);
    } catch (err) {
      deps.diag.debug("chatgpt_plan.callback_failed", { err: String(err) });
    }
    // After the page is on its way: closing the listener mid-response would cut the page off.
    setTimeout(() => void sweep(), 0);
    return ok
      ? page(200, "Signed in to ChatGPT. You can close this tab and return to ryph.")
      : page(400, "The ChatGPT sign-in did not finish. Return to ryph to see why.");
  };

  return {
    async open(signInId, expiresAtMs) {
      // A sweep that just closed the listener may still hold the port; binding now would fail
      // as taken and refuse this sign-in for nothing.
      if (server === null && closing !== null) await closing;
      // Waiting before the bind, so a sweep that runs while it is in flight keeps the listener.
      forget(signInId);
      const delay = Math.max(0, expiresAtMs - deps.now().getTime());
      waiting.set(signInId, setTimeout(() => void sweep(), delay + 1_000));
      if (server === null) {
        // Two opens that both find no server share one bind rather than racing for the port.
        binding ??= serve({ hostname, port: wanted, onListen() {} }, handle).then(
          (bound) => {
            server = bound;
            return true;
          },
          (err) => {
            // Taken (another app's sign-in, a second ryph) or not permitted.
            deps.diag.debug("chatgpt_plan.listener_unavailable", {
              err: err instanceof Error
                ? (err as NodeJS.ErrnoException).code ?? err.name
                : String(err),
            });
            return false;
          },
        ).finally(() => {
          binding = null;
        });
        if (!(await binding)) {
          forget(signInId);
          return false;
        }
      }
      return true;
    },
    sweep,
    async close() {
      for (const id of [...waiting.keys()]) forget(id);
      await shutdown();
    },
    port() {
      return server?.addr.port ?? null;
    },
  };
}

// ── the routes ──────────────────────────────────────────────────────────────────────────────

export interface PlanRoutesDeps {
  plan: PlanKeys;
  listener: CallbackListener;
  /** The admin gate (`models:manage`), the same one registering a provider key takes. */
  authenticateManage(req: Request): Promise<Response | null>;
}

export function planRoutes(deps: PlanRoutesDeps): Route[] {
  const { plan, listener } = deps;

  const start = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const body = await parseBody(req, StartPlanSignInSchema, {
      maxBytes: MAX_PLAN_SIGN_IN_BODY_BYTES,
      emptyIs: {},
    });
    if (!body.ok) return body.res;
    const started = await plan.startSignIn(body.data);
    if (!started.ok) return json(started.status, { error: started.error });
    const { signIn } = started;
    // The sign-in row is left to expire: nothing can finish it without the listener.
    if (!(await listener.open(signIn.id, Date.parse(signIn.expiresAt)))) {
      return json(409, {
        error: `ryph could not listen on ${CALLBACK_HOST}:${CALLBACK_PORT} for the sign-in's ` +
          "return. Another app may be signing in to ChatGPT. Close it and try again",
      });
    }
    return json(201, {
      id: signIn.id,
      authorizeUrl: started.authorizeUrl,
      expiresAt: signIn.expiresAt,
    });
  };

  const status = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const current = await plan.signInStatus(params.id);
    if (current === null) return json(404, { error: "no such sign-in" });
    return json(200, current);
  };

  const models = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateManage(req);
    if (denied) return denied;
    const refreshed = await plan.refreshModels(params.id);
    return refreshed.ok
      ? json(200, { models: refreshed.models })
      : json(refreshed.status, { error: refreshed.error });
  };

  return [
    route("POST", PLAN_PATHS.signIns, start),
    route("GET", PLAN_PATHS.signIn, status),
    route("POST", PLAN_PATHS.models, models),
  ];
}

/** The plan routes off a local deployment: each answers why, so the app can say so. */
export function planOffRoutes(
  deps: { authenticate(req: Request): Promise<Response | null> },
): Route[] {
  const off = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    return json(403, { error: PLAN_LOCAL_ONLY, code: PLAN_LOCAL_ONLY_CODE });
  };
  return [
    route("POST", PLAN_PATHS.signIns, off),
    route("GET", PLAN_PATHS.signIn, off),
    route("POST", PLAN_PATHS.models, off),
  ];
}
