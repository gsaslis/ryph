// The docker backend over the wire: every port the docker adapters implement in-process —
// `Provisioner`, the reconcile, `CheckLauncher`, `EnvironmentBuilder`, `ImagePrefetch` — as a
// client of @ryph/launcher, the one process that holds the docker socket. The binary reaches its
// embedded launcher through these over loopback, and a compose deployment its launcher service the
// same way: one client, one server, so the seam every deployment depends on is the one the binary
// exercises.
//
// The wire contract (wire.ts has the routes and the schemas; @ryph/launcher's README the server):
//   GET  /v1/info                        → LauncherInfo
//   POST /v1/runs/launch    {spec}       → long: {handle} | image_gone
//   POST /v1/runs/kill      {handle, graceful} → 204
//   POST /v1/runs/inspect   {handle}     → {state}
//   POST /v1/reconcile/list {}           → {listing}
//   POST /v1/reconcile/reclaim {listing, active} → {containers, networks} | 409 no_listing
//   POST /v1/checks/prepare {images, since} → ImagesAnswer
//   POST /v1/checks/launch  {spec}       → long: {} | image_gone
//   POST /v1/checks/poll    {name}       → CheckInspection
//   POST /v1/checks/logs    {name, container, maxBytes} → {log}
//   POST /v1/checks/discard {name}       → 204
//   GET  /v1/checks/list                 → {names}
//   POST /v1/builds/build   {spec}       → long: BuildResult
//   POST /v1/builds/adopt   {spec}       → long: AdoptResult
//   POST /v1/builds/discard {environmentId} → 204
//   POST /v1/builds/live-log {spec}      → {log}
//   POST /v1/builds/remove-images {spec} → {removed}
//   GET  /v1/prefetch/status             → {images}
//   POST /v1/prefetch/start {}           → 204
//
// Retryable and terminal (http.ts says how a failure is sorted), per method, by the port's shape.
// First, every call that changes something — `launch` (both), `kill`, check `discard`, `build`,
// `adopt`, build `discard` and `removeImages`, prefetch `start` — is asked again for up to 90 s
// while the launcher cannot be connected to at all (`untilReached`): that request never left, so
// repeating it repeats nothing, and a launcher being recreated is away for up to a minute. A
// failure after the request may have arrived (a timeout, a broken stream) is not asked again here:
// the launcher may have acted on it. Then:
// - THROWS, as the docker adapter does: `launch` (both), `kill`, check `discard` and `list`,
//   build `discard` and `removeImages`, prefetch `status` and `start`. What the core then does is
//   its own: a failed run launch errors the run and a failed check launch fails that attempt,
//   while a failed `kill` or `discard` is logged and met again by the next reaper or sweep pass;
//   the error says which kind it was.
// - NEVER THROWS, so "could not ask" becomes the port's own answer for it:
//   · `inspect` → "unknown" (the docker adapter's answer for a daemon that did not answer)
//   · check `poll` → `{kind:"unknown"}` when retryable (decide nothing), `unschedulable` when
//     terminal — a launcher that stopped serving checks (a 404 `not_served`) will refuse every
//     poll, so the suite is put back to launch again and errors once its attempts run out, rather
//     than waiting out its whole deadline on a question nobody will answer
//   · check `logs` → null, build `liveLog` → null
//   · check `prepare` → `pulling` when retryable (the suite waits, holding no slot and spending no
//     attempt — the launcher being away is not the image's failure), `failed` when terminal (a
//     launcher that refuses the request will refuse it on every attempt)
//   · `adopt` → `{kind:"unknown"}` (nothing is known, so nothing is decided)
//   · `build` → a failed build, saying the launcher was lost: the launcher aborts a build whose
//     request went away, so a build this side stopped hearing about is a build that stopped
//   · the reconcile → a warning and nothing removed, as the in-process reconcile does

import type { Provisioner } from "../../ports/provisioner.ts";
import type { CheckLauncher } from "../../ports/check_launcher.ts";
import type { BuildResult, EnvironmentBuilder } from "../../ports/environment_builder.ts";
import type { ImagePrefetch } from "../../ports/image_prefetch.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { secretFromEnv } from "@ryph/service";
import { runControlUrl } from "../provisioner/docker.ts";
import { LAUNCHER_OWNED_TOOL_SETTINGS, wireMismatch } from "@ryph/mcp-gateway/tool-host";
import { z } from "@zod/zod";
import {
  AdoptAnswer,
  BuildAnswer,
  CheckInspectionAnswer,
  ImagesAnswerSchema,
  InfoAnswer,
  InspectAnswer,
  LaunchAnswer,
  LAUNCHER_ROUTES as R,
  type LauncherInfo,
  laxWire,
  ListingAnswer,
  LogsAnswer,
  NamesAnswer,
  PrefetchAnswer,
  ReclaimedAnswer,
  RemovedAnswer,
} from "./wire.ts";
import {
  launcherCall,
  type LauncherConnection,
  LauncherError,
  launcherLongCall,
  outgoing,
  retryable,
  untilReached,
} from "./http.ts";

export { type LauncherConnection, LauncherError, retryable } from "./http.ts";
export type { LauncherInfo } from "./wire.ts";

/** What a short call may take. `kill` waits out the runner's graceful stop (30 s by default). */
const INFO_MS = 10_000;
const KILL_MS = 90_000;
const READ_MS = 30_000;
const SWEEP_MS = 120_000;

/** An empty body's answer: a 204, which carries no JSON to parse. */
const Nothing = z.unknown();

/**
 * The reconcile over the wire, in the order `reclaimOrphans` requires: the launcher lists the
 * runtime FIRST, then this reads the active runs, then the launcher removes what it listed and the
 * read did not name — and only that, since a listing is the launcher's own and the caller names
 * nothing to remove. Never throws.
 */
export type LauncherReconcile = (
  listActiveRunIds: () => Promise<Iterable<string>>,
) => Promise<void>;

export interface LauncherClients {
  provisioner: Provisioner;
  reconcile: LauncherReconcile;
  checkLauncher: CheckLauncher;
  environmentBuilder: EnvironmentBuilder;
  imagePrefetch: ImagePrefetch;
  /** The launcher's own account of itself. Throws when it did not answer. */
  info(): Promise<LauncherInfo>;
}

const said = (err: unknown) => err instanceof Error ? err.message : String(err);

export function launcherClients(conn: LauncherConnection, diag: Diagnostics): LauncherClients {
  const call = <T>(path: string, body: unknown, answer: z.ZodType<T>, timeoutMs = READ_MS) =>
    launcherCall(conn, path, body, answer, timeoutMs);

  const provisioner: Provisioner = {
    // The docker adapter launches the browser sidecar; the launcher runs that adapter.
    supportsBrowser: true,
    // Where that adapter put the run: a name this side derives from the run id alone, so the
    // address needs no call to the launcher, and nothing the run said.
    controlUrl: (run) => runControlUrl(run.id),
    async launch(spec) {
      const body = { spec: outgoing(laxWire.LaunchSpec, spec, "launch") };
      const answer = await untilReached(
        conn,
        () => launcherLongCall(conn, R.launch, body, LaunchAnswer),
      );
      return { handle: answer.handle };
    },
    async kill(handle, { graceful }) {
      await untilReached(conn, () => call(R.kill, { handle, graceful }, Nothing, KILL_MS));
    },
    async inspect(handle) {
      try {
        return (await call(R.inspect, { handle }, InspectAnswer)).state;
      } catch (err) {
        diag.warn("launcher.inspect_failed", { handle, err: said(err) });
        return "unknown";
      }
    },
  };

  const reconcile: LauncherReconcile = async (listActiveRunIds) => {
    try {
      const { listing } = await call(R.reconcileList, {}, ListingAnswer);
      // Only now: see the doc comment above, and `reclaimOrphans`.
      const active = [...await listActiveRunIds()];
      const reclaimed = await call(
        R.reconcileReclaim,
        { listing, active },
        ReclaimedAnswer,
        SWEEP_MS,
      );
      if (reclaimed.containers > 0 || reclaimed.networks > 0) {
        diag.debug("launcher.reclaimed", reclaimed);
      }
    } catch (err) {
      diag.warn("launcher.reclaim_failed", { err: said(err), retryable: retryable(err) });
    }
  };

  const checkLauncher: CheckLauncher = {
    kind: "docker",
    async prepare(images, since) {
      try {
        return await call(R.checksPrepare, { images: [...images], since }, ImagesAnswerSchema);
      } catch (err) {
        if (retryable(err)) {
          diag.warn("launcher.prepare_unanswered", { err: said(err) });
          return { kind: "pulling" };
        }
        return { kind: "failed", why: said(err) };
      }
    },
    async launch(spec) {
      const body = { spec: outgoing(laxWire.CheckSpec, spec, "check") };
      await untilReached(conn, () => launcherLongCall(conn, R.checksLaunch, body, Nothing));
    },
    async poll(name) {
      try {
        return await call(R.checksPoll, { name }, CheckInspectionAnswer);
      } catch (err) {
        // Terminal (see the header): asking again answers the same, so the suite is let go.
        if (!retryable(err)) return { kind: "unschedulable", why: said(err) };
        return { kind: "unknown", why: said(err) };
      }
    },
    async logs(name, container, maxBytes) {
      try {
        return (await call(R.checksLogs, { name, container, maxBytes }, LogsAnswer)).log;
      } catch (err) {
        diag.warn("launcher.check_logs_failed", { name, container, err: said(err) });
        return null;
      }
    },
    async discard(name) {
      await untilReached(conn, () => call(R.checksDiscard, { name }, Nothing, SWEEP_MS));
    },
    async list() {
      return (await call(R.checksList, undefined, NamesAnswer)).names;
    },
  };

  /** A build this side lost track of — cancelled here, or the launcher gone mid-build. */
  const lostBuild = (message: string): BuildResult => ({
    ok: false,
    kind: "failed",
    message,
    logTail: "",
    log: "",
  });

  const environmentBuilder: EnvironmentBuilder = {
    kind: "docker",
    async build(spec, { signal }) {
      try {
        const body = { spec: outgoing(laxWire.BuildSpec, spec, "build") };
        return await untilReached(
          conn,
          () => launcherLongCall(conn, R.build, body, BuildAnswer, signal),
          signal,
        );
      } catch (err) {
        // Cancelled: the closed connection is what stopped the launcher's build, so the answer
        // it would have given never comes. Said the way the docker adapter says it.
        if (signal.aborted) return lostBuild("the build was cancelled");
        if (err instanceof LauncherError && !err.retryable) throw err; // a bug: the port's own rule
        return lostBuild(`the docker launcher was lost during the build: ${said(err)}`);
      }
    },
    async adopt(spec, { signal }) {
      try {
        const body = { spec: outgoing(laxWire.AdoptSpec, spec, "adoption") };
        return await untilReached(
          conn,
          () => launcherLongCall(conn, R.adopt, body, AdoptAnswer, signal),
          signal,
        );
      } catch (err) {
        return { kind: "unknown", why: said(err) };
      }
    },
    async discard(environmentId) {
      await untilReached(conn, () => call(R.buildDiscard, { environmentId }, Nothing, SWEEP_MS));
    },
    async liveLog(spec) {
      try {
        return (await call(
          R.liveLog,
          { spec: outgoing(laxWire.LiveLogSpec, spec, "log request") },
          LogsAnswer,
        )).log;
      } catch {
        return null;
      }
    },
    async removeImages(spec) {
      const body = { spec: outgoing(laxWire.RemoveImagesSpec, spec, "image removal") };
      return (await untilReached(conn, () => call(R.removeImages, body, RemovedAnswer, SWEEP_MS)))
        .removed;
    },
  };

  const imagePrefetch: ImagePrefetch = {
    async status() {
      return (await call(R.prefetchStatus, undefined, PrefetchAnswer, INFO_MS)).images;
    },
    async start() {
      await untilReached(conn, () => call(R.prefetchStart, {}, Nothing, INFO_MS));
    },
  };

  return {
    provisioner,
    reconcile,
    checkLauncher,
    environmentBuilder,
    imagePrefetch,
    info: async () => checkedInfo(await call(R.info, undefined, z.unknown(), INFO_MS), conn.url),
  };
}

/**
 * The launcher's `/v1/info` answer, read only once its wire revision is this process's own: a
 * launcher of another version reads every request of ours as a bug and answers what we cannot
 * read, so a mismatch is said as one (`LauncherWireMismatch`, terminal), never as garbage.
 */
export function checkedInfo(raw: unknown, url: string): LauncherInfo {
  const said = typeof raw === "object" && raw !== null && "wire" in raw ? raw.wire : undefined;
  const mismatch = wireMismatch(said, url);
  if (mismatch !== null) throw new LauncherWireMismatch(mismatch);
  const parsed = InfoAnswer.safeParse(raw);
  if (!parsed.success) {
    throw new LauncherError(`the launcher answered ${R.info} with something else`, true);
  }
  return parsed.data;
}

/** A launcher of another wire revision: nothing it answers means what this process reads. */
export class LauncherWireMismatch extends LauncherError {
  constructor(message: string) {
    super(message, false);
  }
}

/**
 * The docker builder's own knobs: the launcher's where builds are docker builds, but read in
 * this process by the kubernetes and cloud-build builders, so refused only beside the docker one.
 */
export const DOCKER_BUILDER_SETTINGS = [
  "RYPH_ENV_BUILDKIT_IMAGE",
  "RYPH_ENV_CACHE_DIR",
  "RYPH_ENV_TEMP_DIR",
  "RYPH_ENV_BUILD_PLATFORM",
  // Retention's stop (imageRemovalFromEnv): with the docker builder, what removes is the launcher.
  "RYPH_ENV_IMAGE_REMOVAL",
] as const;

/**
 * What a docker launcher elsewhere decides from its own environment, and a caller reaching it
 * (RYPH_LAUNCHER_URL) must not set: each would read as configured here and do nothing. One list
 * for both composition roots, the binary's and the standalone control plane's, so the two cannot
 * drift apart; its tool-side entries are @ryph/mcp-gateway's (LAUNCHER_OWNED_TOOL_SETTINGS), which
 * a gateway hosting through the launcher refuses the same way. RYPH_IMAGE_PREFETCH among them: the
 * launcher holds the images and fetches them, so whether it does is its own setting, and a caller
 * reports whatever the launcher says (`info.prefetch`). The docker builder's knobs
 * (`DOCKER_BUILDER_SETTINGS`) count only where the builder is docker.
 */
export const LAUNCHER_OWNED_SETTINGS = [
  "RYPH_DOCKER_NETWORK",
  "RYPH_DOCKER_RUN_NETWORK",
  "RYPH_DOCKER_GATE_IMAGE",
  "RYPH_DOCKER_GATE_ROUTES",
  "RYPH_DOCKER_GATE_TARGET",
  "RYPH_DOCKER_GATE_OWNER",
  // The tools network and the runtime: the gateway refuses these too, from the same list.
  ...LAUNCHER_OWNED_TOOL_SETTINGS,
  ...DOCKER_BUILDER_SETTINGS,
  "RYPH_ENV_TRUST_DEFAULT_BRANCH",
  "RYPH_IMAGE_PREFETCH",
  "RYPH_CHECKS_CPUS",
  "RYPH_CHECKS_MEMORY",
] as const;

/**
 * Why a caller of the docker launcher at `url` must not boot, or null: one of the launcher's own
 * settings set here (`LAUNCHER_OWNED_SETTINGS`), or checks or builds turned on here that the
 * launcher does not serve or refuses outright (`buildsRefused`) — refused at boot rather than
 * failing every suite or build later. And RYPH_ENV_EGRESS_PROXY_URL where the launcher confines
 * builds: it is this process's setting (every build spec carries the proxy it names), and a
 * confined build reaches only the run gate, so the address could never be dialled.
 */
export function launcherCallerRefusal(
  env: (name: string) => string | undefined,
  url: string,
  info: Pick<LauncherInfo, "checks" | "builds" | "buildsRefused" | "runNetwork"> | null,
  wants: {
    checks: boolean;
    builds: boolean;
    /** RYPH_ENV_BUILDER as this process resolved it; the docker builder's knobs are the
     * launcher's only beside it. Required, so no call can fall back to docker by omission. */
    builder: string;
  },
): string | null {
  const dockerBuilder = wants.builder === "docker";
  const owned = LAUNCHER_OWNED_SETTINGS.filter((name) =>
    env(name) !== undefined &&
    (dockerBuilder || !(DOCKER_BUILDER_SETTINGS as readonly string[]).includes(name))
  );
  if (owned.length > 0) {
    const one = owned.length === 1;
    return `RYPH_LAUNCHER_URL=${url} names a docker launcher elsewhere, whose own configuration ` +
      `${owned.join(", ")} ${one ? "is" : "are"} — set ${one ? "it" : "them"} on the launcher, ` +
      "not here";
  }
  if (info === null) return null;
  if (wants.checks && !info.checks) {
    return `RYPH_CHECKS=on, but the docker launcher at ${url} runs no check suites — set ` +
      "RYPH_CHECKS=on on the launcher too";
  }
  if (wants.builds && !info.builds) {
    return `RYPH_ENVIRONMENTS=on with the docker builder, but the docker launcher at ${url} runs ` +
      "no builds — set RYPH_ENVIRONMENTS=on on the launcher too";
  }
  if (wants.builds && info.buildsRefused !== null) {
    return `RYPH_ENVIRONMENTS=on with the docker builder, but the docker launcher at ${url} ` +
      `refuses every build: ${info.buildsRefused}. Or turn RYPH_ENVIRONMENTS off here`;
  }
  if (wants.builds && info.runNetwork != null && env("RYPH_ENV_EGRESS_PROXY_URL")?.trim()) {
    return `RYPH_ENV_EGRESS_PROXY_URL is unused: the docker launcher at ${url} confines builds to ` +
      `${info.runNetwork}, where a build reaches only the run gate, at RYPH_EGRESS_PROXY_URL. ` +
      "Unset it.";
  }
  return null;
}

/**
 * The launcher's account of itself, asked until it answers or `waitMs` runs out: a compose stack
 * starts the launcher and its callers together, and a caller that gave up at the first refused
 * connection would crash-loop through the launcher's own boot. Throws with the last reason.
 */
export async function awaitLauncherInfo(
  clients: Pick<LauncherClients, "info">,
  url: string,
  waitMs: number,
): Promise<LauncherInfo> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await clients.info();
    } catch (err) {
      if (err instanceof LauncherWireMismatch) throw new Error(err.message);
      if (Date.now() >= deadline) {
        throw new Error(`the docker launcher at ${url} did not answer: ${said(err)}`);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

/** A run-facing address as its caller is configured with it; null: not handed to runs. */
export interface RunAddress {
  setting: string;
  url: string | null;
}

/**
 * Where the addresses a caller hands runs fall short of the launcher's gate, when the launcher
 * confines runs (`info.gate` set): `elsewhere`, each one naming another host, which a confined
 * run cannot resolve at all; `unrouted`, each one naming the gate on a port it does not relay,
 * which a run dials and is refused. Both as `SETTING=value`, for a boot warning. The launcher
 * owns the gate and its routes and the caller owns the addresses, so neither can derive the other
 * and this is where they are compared.
 */
export function gateCoverage(
  info: Pick<LauncherInfo, "gate" | "routes">,
  addresses: readonly RunAddress[],
): { elsewhere: string[]; unrouted: string[] } {
  const elsewhere: string[] = [];
  const unrouted: string[] = [];
  if (info.gate === null) return { elsewhere, unrouted };
  for (const { setting, url: value } of addresses) {
    if (value === null) continue;
    const url = URL.parse(value);
    if (url === null || url.hostname !== info.gate) {
      elsewhere.push(`${setting}=${value}`);
      continue;
    }
    const port = Number(url.port || (/^(https|wss):$/.test(url.protocol) ? 443 : 80));
    if (!(info.routes ?? []).some((route) => route.listen === port)) {
      unrouted.push(`${setting}=${value}`);
    }
  }
  return { elsewhere, unrouted };
}

/**
 * One of the launcher's two tokens as a caller holds it: the variable itself, or the file
 * `<name>_FILE` names (@ryph/service's `secretFromEnv`, which the mcp-gateway reads its tools
 * token with too). The file is deploy/compose's way, where no one hands out secrets: the
 * launcher mints both into a volume on its first boot and the caller mounts that volume
 * read-only. Undefined when neither is set. Throws, naming the file, when it is set and cannot
 * be read or is empty.
 */
export function launcherTokenFromEnv(
  env: (name: string) => string | undefined,
  name: "RYPH_LAUNCHER_TOKEN" | "RYPH_LAUNCHER_TOOLS_TOKEN",
): string | undefined {
  return secretFromEnv(env, name);
}

/**
 * The boot warning for a launcher that answers while docker does not answer it (`engine: null`).
 * A caller boots anyway — it waits for the launcher to have started, not to be healthy, so its UI
 * and setup token come up — and says so loudly, with the usual cause and where the reason is.
 */
export function engineAbsentWarning(url: string): string {
  return `DOCKER IS NOT REACHABLE: the docker launcher at ${url} answers, but docker does not ` +
    "answer it, so every run, check and build fails until it does. On Docker Engine on Linux " +
    "this is almost always DOCKER_GID not being the docker socket's group (set it in .env to " +
    "`stat -c %g /var/run/docker.sock`, then `docker compose up -d`); the launcher's log says " +
    "why (`docker compose logs launcher`).";
}

/**
 * `launcherTokenFromEnv`, asked again for up to `waitMs` while its file cannot be read yet: in
 * deploy/compose the launcher mints the file on its first boot, and a caller that only waits for
 * the launcher to have STARTED (a socket the launcher may not open must not keep the caller, and
 * its setup token, down) can get there first. Throws the last reason past the wait.
 */
export async function awaitLauncherToken(
  env: (name: string) => string | undefined,
  name: "RYPH_LAUNCHER_TOKEN" | "RYPH_LAUNCHER_TOOLS_TOKEN",
  waitMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return launcherTokenFromEnv(env, name);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
