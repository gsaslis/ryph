// The launcher's HTTP surface: the docker adapters' ports, one route each, behind two tokens.
//
// Invariants:
// - two scopes, two tokens, compared in constant time over their hashes. RYPH_LAUNCHER_TOKEN opens
//   the run side (runs, the reconcile, checks, builds, prefetch, info); RYPH_LAUNCHER_TOOLS_TOKEN
//   opens the tool-host routes and nothing else. Each is a 401 on the other's routes, the same 401
//   as no token at all, so a caller learns nothing about which token it holds
// - every request body is parsed with the STRICT schema (wire.ts in @ryph/orchestrator, and
//   adapters/tool_host/launcher.ts in @ryph/mcp-gateway): an unknown key is a 400, and so is any
//   field the launcher would not let reach an argv, a path or git's environment. What the request
//   cannot say — the networks, the runtime, the gate, mounts, privileges — the adapters were built
//   with at boot from the launcher's own configuration
// - a tool launch lands on the tools network, which confines it, except the guard's: the one
//   hosted container also on an ordinary network, so a launch under the guard's name runs this
//   launcher's guard image or is a 400, and only the guard is ever published (and only where its
//   caller is on the docker host). The egress relay is no handle a tool route takes
// - a spec is never logged, whole or in part, and never kept past its request: the bootstrap
//   bearer in a launch's env, a clone credential, a hosted server's secrets all ride one
// - the reconcile removes only what it listed itself: a listing is kept here under an id, and the
//   reclaim names the id and the caller's active runs, never an object
// - a run container is stopped or inspected only when it is this deployment's
//   (`runContainerOwnership`), so the run token reaches runs and not whatever else the daemon
//   holds: a stop goes ahead on "ours" or "absent" (nothing to stop), a 503 when docker could not
//   say, a 403 on anything else
// - a request body is at most `MAX_BODY_BYTES`, by its Content-Length and while it streams (a 413
//   past it), arrives within `BODY_READ_MS` (a 408 after), and at most `MAX_BODY_READS` are read at
//   once per scope, so the tools token, the narrower one, holds at most that many bodies in memory
//   at a time and cannot starve the run side's reads, by size, by trickling or by number. Past it
//   the tools scope is a 503; the run scope waits for a slot, up to `BODY_READ_MS`, since a burst
//   of launches is the control plane's ordinary load and a 503 would fail a run
// - `ImageGone` is the one failure with a name: `{error:"image_gone", message}`. Anything else an
//   adapter throws is `{error:"failed", message}` with docker's own words, a 500

import { bearerToken, tokenMatches } from "@ryph/sealed";
import { json, readCappedBytes } from "@ryph/shared/http";
import type { ServeHandler } from "@ryph/service";
import type { z } from "@zod/zod";
import {
  type CheckLauncher,
  type Diagnostics,
  dockerEngine,
  type DockerExec,
  type DockerOptions,
  type EnvironmentBuilder,
  gateName,
  IMAGE_GONE,
  ImageGone,
  type ImagePrefetch,
  ImageRefused,
  LAUNCHER_ROUTES as R,
  type LauncherInfo,
  listOrphanCandidates,
  noEnvironmentImageRef,
  type OrphanCandidates,
  type Provisioner,
  reclaimCandidates,
  runContainerOwnership,
  strictWire as W,
} from "@ryph/orchestrator/docker";
import {
  guardSpecProblem,
  LAUNCHER_WIRE_REVISION,
  strictToolWire as T,
  TOOL_ROUTES,
  type ToolHost,
  toolNameProblem,
} from "@ryph/mcp-gateway/tool-host";

export interface LauncherRoutesDeps {
  token: string;
  toolsToken: string;
  /** The options every docker adapter here was built with: the deployment's identity among them. */
  docker: DockerOptions;
  provisioner: Provisioner;
  /** Null where checks are off: their routes answer 404. */
  checks: CheckLauncher | null;
  builder: EnvironmentBuilder | null;
  /** Why `builder` refuses every build (`everyBuildRefused`), said in /v1/info; null: it builds. */
  buildsRefused: string | null;
  prefetch: ImagePrefetch | null;
  /** Null where hosting is off: the tool routes answer 404. */
  tools: { host: ToolHost; network: string; joined: boolean } | null;
  exec: DockerExec;
  diag: Diagnostics;
  /** Aborted as the launcher closes: every long call's work is told to stop. */
  closing: AbortSignal;
  beatMs: number;
  /** How long a request body may take to arrive; default `BODY_READ_MS`. */
  bodyReadMs?: number;
}

/** The largest request body read: a spec with its env and secrets is kilobytes. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** How long a request body may take to arrive: a sender that trickles holds nothing open past it. */
export const BODY_READ_MS = 30_000;
/** How many request bodies one scope may have being read at once; past it, the tools scope gets a
 * 503 and the run scope waits for a slot (at most `BODY_READ_MS`). */
export const MAX_BODY_READS = 8;
/** How long `/v1/info` waits on docker for the engine before answering `engine: null`. */
export const INFO_ENGINE_MS = 3_000;

/** How long a reconcile listing waits for its reclaim, and how many are kept at once. */
const LISTING_TTL_MS = 10 * 60_000;
const MAX_LISTINGS = 32;

type Scope = "run" | "tools";
type Handler = (req: Request) => Promise<Response>;

const noContent = () => new Response(null, { status: 204 });
const said = (err: unknown) => err instanceof Error ? err.message : String(err);

/** The body of a refusal or a failure: the one named failure, or docker's words. */
function failure(err: unknown): { status: number; body: { error: string; message: string } } {
  if (err instanceof ImageGone) {
    return { status: 409, body: { error: IMAGE_GONE, message: err.message } };
  }
  return { status: 500, body: { error: "failed", message: said(err) } };
}

export function launcherRoutes(deps: LauncherRoutesDeps): ServeHandler {
  const { diag, exec, docker } = deps;
  const bodyReadMs = deps.bodyReadMs ?? BODY_READ_MS;
  const listings = new Map<string, { candidates: OrphanCandidates; at: number }>();
  /** Each request's scope, set by the dispatch below, and the body reads under way per scope. */
  const scopeOf = new WeakMap<Request, Scope>();
  const reading: Record<Scope, number> = { run: 0, tools: 0 };
  /** Run-scope requests waiting for a body-read slot, first come first served. */
  const waiting: Array<() => void> = [];
  const release = (scope: Scope) => {
    reading[scope]--;
    if (scope === "run") waiting.shift()?.();
  };
  /**
   * A body-read slot for `scope`, or false. The tools scope is refused outright past
   * `MAX_BODY_READS`. The run scope waits, at most `bodyReadMs`: its callers are the control
   * plane's launches and builds, and a 503 there is not a launcher that was never reached, so
   * the client would not ask again and the run would fail on a burst alone.
   */
  const acquire = async (scope: Scope): Promise<boolean> => {
    if (reading[scope] < MAX_BODY_READS) {
      reading[scope]++;
      return true;
    }
    if (scope === "tools") return false;
    return await new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        reading.run++;
        resolve(true);
      };
      const timer = setTimeout(() => {
        const at = waiting.indexOf(wake);
        if (at !== -1) waiting.splice(at, 1);
        resolve(false);
      }, bodyReadMs);
      waiting.push(wake);
    });
  };

  const parse = async <T>(req: Request, schema: z.ZodType<T>): Promise<T | Response> => {
    const scope = scopeOf.get(req) ?? "tools";
    if (!await acquire(scope)) {
      return json(503, {
        error: "busy",
        message: `${MAX_BODY_READS} request bodies are already being read for this token`,
      });
    }
    // A body that broke off mid-read is no body: the 400 below.
    const read = await readCappedBytes(req, MAX_BODY_BYTES, AbortSignal.timeout(bodyReadMs)).catch(
      () => ({
        ok: true as const,
        bytes: new Uint8Array(),
      }),
    ).finally(() => release(scope));
    if (!read.ok && read.reason === "too_large") {
      return json(413, {
        error: "too_large",
        message: `a request body is at most ${MAX_BODY_BYTES} bytes`,
      });
    }
    if (!read.ok) {
      return json(408, {
        error: "timeout",
        message: `a request body must arrive within ${bodyReadMs / 1000} s`,
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return json(400, { error: "bad_request", message: "the body is not JSON" });
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // Paths and messages only: an issue's input would echo the spec, secrets and all.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`);
    return json(400, { error: "bad_request", message: issues.join("; ") });
  };

  /** A short call: the adapter's answer as JSON, or its failure. */
  const answer = async (route: string, work: () => Promise<unknown>): Promise<Response> => {
    try {
      const result = await work();
      return result === undefined ? noContent() : json(200, result);
    } catch (err) {
      diag.warn("launcher.call_failed", { route, err: said(err) });
      const { status, body } = failure(err);
      return json(status, body);
    }
  };

  /**
   * A long call (wire.ts): beats while `work` runs, then its one result or failure. The work's
   * signal fires when the caller goes away — its closed connection aborts the request — or the
   * launcher closes, and a build stops on it.
   */
  const long = (
    req: Request,
    route: string,
    work: (signal: AbortSignal) => Promise<unknown>,
  ): Response => {
    const signal = AbortSignal.any([req.signal, deps.closing]);
    const encoder = new TextEncoder();
    let beat: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const send = (line: unknown) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            open = false; // the caller is gone; the work hears it on its signal
          }
        };
        send({ beat: 1 });
        beat = setInterval(() => send({ beat: 1 }), deps.beatMs);
        work(signal).then(
          (result) => send({ result: result ?? null }),
          (err) => {
            diag.warn("launcher.call_failed", { route, err: said(err) });
            send(failure(err).body);
          },
        ).finally(() => {
          clearInterval(beat);
          open = false;
          try {
            controller.close();
          } catch {
            // already closed by a caller that went away
          }
        });
      },
      cancel() {
        clearInterval(beat);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };

  const notARun = (handle: string) =>
    json(403, {
      error: "not_a_run",
      message: `${handle} is not a run container of this deployment`,
    });

  /** Null when `handle` may be stopped: it is this deployment's run, or there is nothing there. */
  const notOurs = async (handle: string): Promise<Response | null> => {
    const owner = await runContainerOwnership(handle, docker, exec);
    if (owner === "ours" || owner === "absent") return null;
    if (owner === "unknown") {
      return json(503, {
        error: "unknown_owner",
        message: `docker did not say whose container ${handle} is; ask again`,
      });
    }
    return notARun(handle);
  };

  const off = (what: string) =>
    json(404, { error: "not_served", message: `this launcher runs no ${what}` });

  /** The engine, or null when docker did not say within `INFO_ENGINE_MS`: every caller handles
   * null, and a boot that waits on /v1/info must not wait on a daemon that is slow to answer. */
  const engine = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        dockerEngine(exec).catch(() => null),
        new Promise<null>((r) => (timer = setTimeout(() => r(null), INFO_ENGINE_MS))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const info = async (): Promise<LauncherInfo> => ({
    wire: LAUNCHER_WIRE_REVISION,
    engine: await engine(),
    network: docker.network ?? null,
    runNetwork: docker.runNetwork ?? null,
    gate: docker.runNetwork === undefined ? null : gateName(docker),
    routes: docker.runNetwork === undefined ? null : (docker.gate?.routes ?? []),
    runtime: docker.runtime ?? null,
    checks: deps.checks !== null,
    builds: deps.builder !== null,
    buildsRefused: deps.builder === null ? null : deps.buildsRefused,
    prefetch: deps.prefetch !== null,
  });

  const routes = new Map<string, { scope: Scope; handle: Handler }>();
  const add = (method: "GET" | "POST", path: string, scope: Scope, handle: Handler) =>
    routes.set(`${method} ${path}`, { scope, handle });

  // ---- runs --------------------------------------------------------------------------------

  add("GET", R.info, "run", () => answer(R.info, info));

  add("POST", R.launch, "run", async (req) => {
    const body = await parse(req, W.Launch);
    if (body instanceof Response) return body;
    return long(req, R.launch, () => deps.provisioner.launch(body.spec));
  });

  add("POST", R.kill, "run", async (req) => {
    const body = await parse(req, W.Kill);
    if (body instanceof Response) return body;
    const refused = await notOurs(body.handle);
    if (refused !== null) return refused;
    return answer(R.kill, () => deps.provisioner.kill(body.handle, { graceful: body.graceful }));
  });

  add("POST", R.inspect, "run", async (req) => {
    const body = await parse(req, W.Inspect);
    if (body instanceof Response) return body;
    const owner = await runContainerOwnership(body.handle, docker, exec);
    // Absent is the answer itself, and an unknown owner an unknown state; anything else is not
    // this token's to look at.
    if (owner === "absent") return json(200, { state: "exited" });
    if (owner === "unknown") return json(200, { state: "unknown" });
    if (owner === "foreign") return notARun(body.handle);
    return answer(R.inspect, async () => ({ state: await deps.provisioner.inspect(body.handle) }));
  });

  // ---- the reconcile, in two halves ----------------------------------------------------------

  add("POST", R.reconcileList, "run", async (req) => {
    const body = await parse(req, W.Empty);
    if (body instanceof Response) return body;
    return answer(R.reconcileList, async () => {
      const candidates = await listOrphanCandidates(docker, exec);
      const now = Date.now();
      for (const [id, entry] of listings) {
        if (now - entry.at > LISTING_TTL_MS) listings.delete(id);
      }
      while (listings.size >= MAX_LISTINGS) listings.delete(listings.keys().next().value!);
      const listing = crypto.randomUUID();
      listings.set(listing, { candidates, at: now });
      return { listing };
    });
  });

  add("POST", R.reconcileReclaim, "run", async (req) => {
    const body = await parse(req, W.Reclaim);
    if (body instanceof Response) return body;
    const entry = listings.get(body.listing);
    listings.delete(body.listing);
    if (entry === undefined) {
      // Expired, already reclaimed, or never ours: nothing is removed on a listing not in hand.
      // A 409, not a 404 (which says "no such route", for good): listing again answers it.
      return json(409, { error: "no_listing", message: "no such listing; list again" });
    }
    return answer(
      R.reconcileReclaim,
      () => reclaimCandidates(entry.candidates, body.active, diag, exec),
    );
  });

  // ---- checks --------------------------------------------------------------------------------

  add("POST", R.checksPrepare, "run", async (req) => {
    const body = await parse(req, W.ChecksPrepare);
    if (body instanceof Response) return body;
    const checks = deps.checks;
    if (checks === null) return off("checks");
    return answer(
      R.checksPrepare,
      () => checks.prepare?.(body.images, body.since) ?? Promise.resolve({ kind: "ready" }),
    );
  });

  add("POST", R.checksLaunch, "run", async (req) => {
    const body = await parse(req, W.ChecksLaunch);
    if (body instanceof Response) return body;
    const checks = deps.checks;
    if (checks === null) return off("checks");
    return long(req, R.checksLaunch, () => checks.launch(body.spec));
  });

  add("POST", R.checksPoll, "run", async (req) => {
    const body = await parse(req, W.ChecksName);
    if (body instanceof Response) return body;
    const checks = deps.checks;
    if (checks === null) return off("checks");
    return answer(R.checksPoll, () => checks.poll(body.name));
  });

  add("POST", R.checksLogs, "run", async (req) => {
    const body = await parse(req, W.ChecksLogs);
    if (body instanceof Response) return body;
    const checks = deps.checks;
    if (checks === null) return off("checks");
    return answer(R.checksLogs, async () => ({
      log: await checks.logs(body.name, body.container, body.maxBytes),
    }));
  });

  add("POST", R.checksDiscard, "run", async (req) => {
    const body = await parse(req, W.ChecksName);
    if (body instanceof Response) return body;
    const checks = deps.checks;
    if (checks === null) return off("checks");
    return answer(R.checksDiscard, () => checks.discard(body.name));
  });

  add("GET", R.checksList, "run", () => {
    const checks = deps.checks;
    if (checks === null) return Promise.resolve(off("checks"));
    return answer(R.checksList, async () => ({ names: await checks.list() }));
  });

  // ---- builds --------------------------------------------------------------------------------

  add("POST", R.build, "run", async (req) => {
    const body = await parse(req, W.Build);
    if (body instanceof Response) return body;
    const builder = deps.builder;
    if (builder === null) return off("environment builds");
    return long(req, R.build, (signal) => builder.build(body.spec, { signal }));
  });

  add("POST", R.adopt, "run", async (req) => {
    const body = await parse(req, W.Adopt);
    if (body instanceof Response) return body;
    const builder = deps.builder;
    if (builder === null) return off("environment builds");
    return long(req, R.adopt, (signal) => builder.adopt(body.spec, { signal }));
  });

  add("POST", R.buildDiscard, "run", async (req) => {
    const body = await parse(req, W.BuildDiscard);
    if (body instanceof Response) return body;
    const builder = deps.builder;
    if (builder === null) return off("environment builds");
    return answer(R.buildDiscard, () => builder.discard(body.environmentId));
  });

  add("POST", R.liveLog, "run", async (req) => {
    const body = await parse(req, W.LiveLog);
    if (body instanceof Response) return body;
    const builder = deps.builder;
    if (builder === null) return off("environment builds");
    return answer(R.liveLog, async () => ({ log: await builder.liveLog(body.spec) }));
  });

  add("POST", R.removeImages, "run", async (req) => {
    const body = await parse(req, W.RemoveImages);
    if (body instanceof Response) return body;
    const builder = deps.builder;
    if (builder === null) return off("environment builds");
    // A builder without removal (RYPH_ENV_IMAGE_REMOVAL=off here) removed nothing: `false`, so
    // the caller leaves the row unstamped for when removal is on again, never stamps it done.
    return answer(R.removeImages, async () => ({
      removed: (await builder.removeImages?.(body.spec)) ?? false,
    }));
  });

  // ---- prefetch: off is an empty list, not a refusal ------------------------------------------

  add(
    "GET",
    R.prefetchStatus,
    "run",
    () => answer(R.prefetchStatus, async () => ({ images: (await deps.prefetch?.status()) ?? [] })),
  );

  add("POST", R.prefetchStart, "run", async (req) => {
    const body = await parse(req, W.Empty);
    if (body instanceof Response) return body;
    return answer(R.prefetchStart, async () => void (await deps.prefetch?.start()));
  });

  // ---- the tool host, on the other token -----------------------------------------------------

  const tools = <T>(
    route: string,
    schema: z.ZodType<T> | null,
    work: (host: ToolHost, body: T) => Promise<unknown>,
  ): Handler =>
  async (req) => {
    const t = deps.tools;
    if (t === null) return off("hosted MCP servers");
    let body = undefined as T;
    if (schema !== null) {
      const parsed = await parse(req, schema);
      if (parsed instanceof Response) return parsed;
      body = parsed;
    }
    return answer(route, () => work(t.host, body));
  };

  add(
    "GET",
    TOOL_ROUTES.info,
    "tools",
    tools(TOOL_ROUTES.info, null, (host) =>
      Promise.resolve({
        wire: LAUNCHER_WIRE_REVISION,
        reachesGuard: host.reachesGuard,
        guardName: host.guardName!,
        guardImage: host.guardImage!,
        network: deps.tools!.network,
        egressProxy: host.egressProxy ?? null,
      })),
  );
  add(
    "POST",
    TOOL_ROUTES.network,
    "tools",
    tools(TOOL_ROUTES.network, T.Empty, (host) => host.ensureNetwork()),
  );
  add("POST", TOOL_ROUTES.launch, "tools", async (req) => {
    const t = deps.tools;
    if (t === null) return off("hosted MCP servers");
    const body = await parse(req, T.Launch);
    if (body instanceof Response) return body;
    const guard = body.spec.name === t.host.guardName;
    // The guard is the one hosted container on an ordinary network as well as the tools network,
    // so what runs under its name is this launcher's image and never the caller's: a caller that
    // could name it could put any image of its choosing beside the deployment's services.
    if (guard && body.spec.image !== t.host.guardImage) {
      return json(400, {
        error: "bad_request",
        message:
          `the tool guard runs this launcher's guard image (${t.host.guardImage}), and no other`,
      });
    }
    // Only the guard is ever published, and only where its caller is on the docker host: a joined
    // launcher's gateway dials it by name, and a port on the docker host would only put it where
    // runs reach it.
    if (body.spec.publish !== undefined && (!guard || t.joined)) {
      return json(400, {
        error: "bad_request",
        message: guard
          ? "this launcher's gateway dials the guard by name, and the guard publishes nothing"
          : "only the tool guard is ever published",
      });
    }
    // An image is not all that runs: the guard's is node, and NODE_OPTIONS or a command of the
    // caller's would run the caller's code in the one dual-homed container, under docker's default
    // runtime. So the shape is fixed as well — hosting's own, and nothing else (`guardSpecProblem`).
    // A vendor container runs under its launch key's name and no other (the adapter refuses it
    // too, as a 500): said here as the caller's mistake it is.
    const problem = guard ? guardSpecProblem(body.spec) : toolNameProblem(body.spec.name);
    if (problem !== null) return json(400, { error: "bad_request", message: problem });
    // The guard's image is this launcher's own reference, launched as configured.
    if (guard) return answer(TOOL_ROUTES.launch, () => t.host.launch(body.spec));
    // A hosted server runs a vendor's image from a registry. A locally built environment image —
    // this deployment's or, on a shared daemon, another's — holds a repository's code and is
    // nothing a tools-token holder may start. Judged on the image docker resolves the reference
    // to, never its spelling (`noEnvironmentImageRef`), and launched by the id judged, so a retag
    // meanwhile swaps nothing; a reference no local image answers is pulled by `docker run`.
    let image: string;
    try {
      image = await noEnvironmentImageRef(body.spec.image, (args) => exec(args));
    } catch (err) {
      if (!(err instanceof ImageRefused)) {
        diag.warn("launcher.call_failed", { route: TOOL_ROUTES.launch, err: said(err) });
        return json(500, { error: "failed", message: said(err) });
      }
      return json(400, {
        error: "bad_request",
        message: `${said(err)}; not a hosted server's image`,
      });
    }
    return answer(TOOL_ROUTES.launch, () => t.host.launch({ ...body.spec, image }));
  });
  add(
    "POST",
    TOOL_ROUTES.stop,
    "tools",
    tools(TOOL_ROUTES.stop, T.Handle, (host, b) => host.stop(b.handle)),
  );
  add(
    "GET",
    TOOL_ROUTES.list,
    "tools",
    tools(TOOL_ROUTES.list, null, async (host) => ({
      names: await host.list(),
    })),
  );
  add(
    "POST",
    TOOL_ROUTES.inspect,
    "tools",
    tools(TOOL_ROUTES.inspect, T.Handle, async (h, b) => ({
      state: await h.inspect(b.handle),
    })),
  );
  add(
    "POST",
    TOOL_ROUTES.address,
    "tools",
    tools(TOOL_ROUTES.address, T.Address, async (h, b) => ({
      address: await h.address(b.handle, b.port),
    })),
  );
  add(
    "POST",
    TOOL_ROUTES.logs,
    "tools",
    tools(TOOL_ROUTES.logs, T.Logs, async (h, b) => ({
      logs: await h.logs(b.handle, b.tail),
    })),
  );

  return async (req) => {
    const route = routes.get(`${req.method} ${new URL(req.url).pathname}`);
    if (route === undefined) return json(404, { error: "not_found", message: "no such route" });
    const presented = bearerToken(req);
    const expected = route.scope === "run" ? deps.token : deps.toolsToken;
    if (presented === null || !await tokenMatches(presented, expected)) {
      return json(401, { error: "unauthorized", message: "unauthorized" });
    }
    scopeOf.set(req, route.scope);
    return await route.handle(req);
  };
}
