// The composition root: the bridge as its own process, beside a `radicle-node` in one pod,
// sharing one volume — or, through `startRadicle`, inside a host that mounts it (the `ryph`
// binary, in user mode). This file knows which adapter stands behind each port, reads the
// environment, owns the listening socket, and starts the event consumer.
//
// One credential (`RYPH_RADICLE_TOKEN`) guards the whole surface, because the whole surface
// writes with the node's Radicle key. There is no user tier and there will not be one: the
// forge is the only thing that should be able to reach this port at all. In a deployment the
// network policy is the real boundary; in the binary the listener is loopback-only and the
// token is minted per boot and never leaves the process.
//
// The service is OPTIONAL to a deployment. Nothing else fails without it; a bridge with no
// token starts, answers 503 on every route, and says why.

import { statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "@std/path";
import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import {
  type HttpServer,
  installDrain,
  makeHealth,
  refusePublicDevSecrets,
  serve,
} from "@ryph/service";
import { cliRadExec } from "./adapters/rad/cli.ts";
import { socketNodeControl } from "./adapters/node/socket.ts";
import { loggerDiagnostics } from "./adapters/diagnostics/logger.ts";
import { httpEventSink } from "./adapters/event_sink/http.ts";
import { memoryCursorStore } from "./adapters/cursor_store/memory.ts";
import { drizzleCursorStore } from "./adapters/cursor_store/drizzle.ts";
import { drizzleTrackedRepos } from "./adapters/tracked_repos/drizzle.ts";
import { makeRadicleDb, type RadicleDbHandle } from "./adapters/cursor_store/db/db.ts";
import type { CursorStore } from "./ports/cursor_store.ts";
import type { TrackedRepoStore } from "./ports/tracked_repos.ts";
import type { EventSink } from "./ports/event_sink.ts";
import type { RadExec } from "./ports/rad.ts";
import type { SelfIdentity } from "./core/service.ts";
import { EXPLORER_PLACEHOLDERS, isExplorerTemplate } from "./helpers/ids.ts";
import { agentHoldsKey, keyIsEncrypted, publicKeyBlob } from "./helpers/preflight.ts";
import { makeRouter } from "@ryph/shared/http";
import { type BridgeMode, setup } from "./setup.ts";

const env = (name: string): string | undefined => process.env[name] || undefined;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

const intEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** Like `intEnv`, but zero is a meaningful answer — "no pause", "no deadline". */
const msEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/**
 * What a host that mounts the bridge in its own process decides for it, rather than leaving it
 * to the environment — the shape of the forge's `ForgeStartOptions`. Anything left out is read
 * from the environment exactly as the standalone service reads it.
 */
export interface RadicleStartOptions {
  /** Absent: RYPH_RADICLE_MODE, and `deployment` when that is unset too. */
  mode?: BridgeMode;
  /** RAD_HOME. Absent: the environment's, else `/var/lib/radicle` (deployment) or
   * `~/.radicle` (user mode). */
  home?: string;
  /** Absent: RYPH_RADICLE_DATA. User mode has no default inside RAD_HOME — see below. */
  dataDir?: string;
  /** The shared bearer. Absent: RYPH_RADICLE_TOKEN. */
  token?: string;
  port?: number;
  /** The interface to bind. Absent: every interface, as a pod's service must. */
  hostname?: string;
  /** Where events are POSTed. Absent: RYPH_RADICLE_EVENTS_URL. */
  eventsUrl?: string;
  /** The cursor and tracked-repository tables on a connection the HOST owns — never closed
   * here. Absent: RYPH_RADICLE_DB, opened and closed by this bridge. */
  db?: RadicleDbHandle;
  /** Whether to serve `/healthz` and `/readyz`. A pod's probes need them; a host does not. */
  health?: boolean;
}

/** A bridge that is serving, and what the owner of the process needs to run and stop it. */
export interface RunningRadicle {
  server: HttpServer;
  /** The address the forge dials, from this process. */
  url: string;
  mode: BridgeMode;
  home: string;
  /** Who it signs as — null when `rad self` could not be read at boot. */
  identity: SelfIdentity | null;
  /** Whether the node's control socket answered at boot. */
  nodeRunning: boolean;
  /** User mode: disconnects every tracked repository not in `keep` — see the service's. */
  untrackExcept: (keep: ReadonlySet<string>, before: string) => Promise<string[]>;
  /** Starts the event consumer. Separate, so a host can light the mailroom it delivers to first. */
  start: () => void;
  /** Fails readiness, so a balancer stops routing here before the listener closes. */
  beginDrain: () => void;
  /** Stops the consumer and releases what this bridge opened itself. */
  close: () => Promise<void>;
}

export async function main(): Promise<void> {
  refusePublicDevSecrets("radicle");
  setupLoggerFromEnv();
  const radicle = await startRadicle({ health: true });
  radicle.start();
  installDrain({
    servers: [radicle.server],
    beginDrain: radicle.beginDrain,
    close: radicle.close,
    preStopMs: msEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs: msEnv("RYPH_DRAIN_DEADLINE_MS", 25_000),
    log: new Logger("radicle"),
  });
}

/** The bridge's mode from the environment, or a failed boot naming what it was given. */
export function modeFromEnv(raw: string | undefined): BridgeMode {
  if (raw === undefined || raw === "deployment") return "deployment";
  if (raw === "user") return "user";
  fail(`RYPH_RADICLE_MODE must be "deployment" or "user", got ${JSON.stringify(raw)}`);
}

/**
 * Where `rad` lives when nothing says. PATH first, in both modes: a deployment's image puts it
 * there. A user-mode bridge then falls back to `$RAD_HOME/bin`, which is where Radicle's
 * installer puts it and which a stripped PATH (a launchd job, a service manager) does not carry.
 */
export function defaultBinDir(
  mode: BridgeMode,
  home: string,
  path: string = process.env.PATH ?? "",
): string | null {
  if (mode !== "user") return null;
  const isFile = (file: string): boolean => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (path.split(":").some((dir) => dir !== "" && isFile(join(dir, "rad")))) return null;
  const dir = join(home, "bin");
  return isFile(join(dir, "rad")) ? dir : null;
}

/** Wires the bridge and starts listening. The caller starts the consumer and owns the drain. */
export async function startRadicle(opts: RadicleStartOptions = {}): Promise<RunningRadicle> {
  const mode = opts.mode ?? modeFromEnv(env("RYPH_RADICLE_MODE"));
  const user = mode === "user";
  const port = opts.port ?? intEnv("RYPH_RADICLE_PORT", 7470);
  const log = new Logger("radicle");
  const diag = loggerDiagnostics("radicle");

  // RAD_HOME. In a deployment, the volume this pod shares with the node — the bridge is the ONLY
  // writer besides the node itself. In user mode, a person's own profile, which their node and
  // their own `rad` write too: the bridge is one more client of it, as they are.
  const userHome = env("HOME");
  const home = opts.home ?? env("RAD_HOME") ??
    (user
      ? (userHome ? join(userHome, ".radicle") : fail("user mode needs RAD_HOME or HOME"))
      : "/var/lib/radicle");

  // The bridge's own files: scratch repositories and the git door's mirrors. A deployment keeps
  // them on its volume, under RAD_HOME. User mode never writes inside somebody's `~/.radicle` —
  // nothing in there is ryph's — so it has no default there, and refuses one.
  const dataSetting = opts.dataDir ?? env("RYPH_RADICLE_DATA");
  if (user && dataSetting === undefined) {
    fail("RYPH_RADICLE_DATA is required in user mode — the bridge never writes into RAD_HOME");
  }
  const dataDir = dataSetting ?? `${home}/ryph`;
  if (user) {
    if (!isAbsolute(dataDir)) fail(`RYPH_RADICLE_DATA must be an absolute path, got ${dataDir}`);
    const inside = resolve(dataDir) + "/";
    if (inside.startsWith(resolve(home) + "/")) {
      fail(
        `RYPH_RADICLE_DATA (${dataDir}) is inside RAD_HOME (${home}) — name a directory of its own`,
      );
    }
  }
  await mkdir(`${dataDir}/export`, { recursive: true });
  await mkdir(`${dataDir}/scratch`, { recursive: true });

  // An ssh-agent only in user mode: see `cliRadExec`.
  const agentSocket = user ? env("SSH_AUTH_SOCK") ?? null : null;
  const binDir = env("RYPH_RADICLE_BIN_DIR") ?? defaultBinDir(mode, home);
  const exec = cliRadExec({
    home,
    // Empty is a legitimate passphrase and means "the key is not encrypted"; unset would make
    // `rad` prompt, which in a container means hang. rad 1.10.3 treats empty as unset when it
    // picks a signer, so an encrypted key still reaches the agent in user mode.
    passphrase: process.env.RAD_PASSPHRASE ?? "",
    binDir,
    socket: env("RAD_SOCKET"),
    timeoutMs: msEnv("RYPH_RADICLE_EXEC_TIMEOUT_MS", 60_000),
    agentSocket,
    ...(user ? { gitProtocols: "file:rad" } : {}),
    diag,
  });
  const node = socketNodeControl({ socket: exec.socket, diag });
  if (user) await preflight(exec, home, binDir, agentSocket, log);

  const token = opts.token ?? env("RYPH_RADICLE_TOKEN") ?? null;
  if (token === null) {
    log.warn("RYPH_RADICLE_TOKEN unset — every route answers 503; no forge can reach this node");
  }

  // The cursor store is the consumer's memory. Without a database it is in-memory, which costs
  // one silent first-sight pass per restart — correct, just forgetful. The tracked set is not
  // forgetful-safe (see ports/tracked_repos.ts), so user mode will not run without a database.
  let cursors: CursorStore = memoryCursorStore();
  let tracked: TrackedRepoStore | undefined;
  let closeDb: () => Promise<void> = () => Promise.resolve();
  const dbUrl = opts.db === undefined ? env("RYPH_RADICLE_DB") : undefined;
  let handle: RadicleDbHandle | null = opts.db ?? null;
  if (handle === null && dbUrl !== undefined) {
    const opened = await makeRadicleDb(dbUrl);
    handle = opened;
    closeDb = () => opened.close();
  }
  if (handle !== null) {
    cursors = drizzleCursorStore(handle);
    if (user) tracked = drizzleTrackedRepos(handle);
    try {
      await cursors.listByRepo("rad:probe");
      if (tracked !== undefined) await tracked.get("rad:probe");
    } catch (err) {
      fail(
        `the radicle database ${handle.description} did not answer the startup probe ` +
          `(${err instanceof Error ? err.message : String(err)}) — ` +
          (opts.db !== undefined
            // Lent by a host, whose own schema step owns these tables.
            ? "if its radicle tables are missing, `ryph migrate` applies them (from a checkout, " +
              "`bun run db:push` at the repository root)"
            : "if it has no schema, run `bun run db:push` in packages/radicle. On Kubernetes " +
              "the pod's `migrate` init container applies it before this starts: read its log " +
              "(`kubectl logs <pod> -c migrate`). If the database did not answer at all, check " +
              "RYPH_RADICLE_DB and the NetworkPolicy to the database"),
      );
    }
  } else if (user) {
    fail(
      "user mode needs RYPH_RADICLE_DB — the repositories connected to ryph are kept there, and " +
        "a bridge that forgot them on restart would watch nothing",
    );
  } else {
    log.warn("RYPH_RADICLE_DB unset — event cursors live in memory and are lost on restart");
  }

  // A template naming none of `{rid}`, `{kind}` or `{id}` renders the SAME address for every
  // object — a bare `https://app.radicle.xyz` links the explorer's home page and calls it a
  // patch. That is worse than no link at all, so it is refused here, once, at startup, and the
  // bridge behaves as if the variable were unset.
  const explorerRaw = env("RYPH_RADICLE_EXPLORER_URL") ?? null;
  const explorerUrl = isExplorerTemplate(explorerRaw) ? explorerRaw : null;
  if (explorerRaw !== null && explorerUrl === null) {
    log.warn(
      `RYPH_RADICLE_EXPLORER_URL (${explorerRaw}) names none of ${
        EXPLORER_PLACEHOLDERS.join(", ")
      } — it would link the same page for every patch and issue, so it is ignored and no URLs ` +
        "are rendered",
    );
  }

  const eventsUrl = opts.eventsUrl ?? env("RYPH_RADICLE_EVENTS_URL");
  const sink: EventSink = eventsUrl !== undefined && token !== null
    ? httpEventSink({
      url: eventsUrl,
      token,
      diag,
      requestTimeoutMs: msEnv("RYPH_RADICLE_EVENTS_TIMEOUT_MS", 5_000),
    })
    : {
      deliver: () =>
        Promise.resolve(
          { kind: "failed", message: "no event sink is configured", terminal: true } as const,
        ),
    };
  if (eventsUrl === undefined) {
    log.warn("RYPH_RADICLE_EVENTS_URL unset — a comment on a seeded repo reaches no mailroom");
  }

  // The pull answers nobody, so it may be generous: a nothing-new fetch from a big seed was
  // measured at 32s on a live node.
  const pullIntervalMs = intEnv("RYPH_RADICLE_PULL_SECONDS", 60) * 1_000;

  const bridge = setup({
    mode,
    tracked,
    exec,
    node,
    cursors,
    sink,
    diag,
    token,
    explorerUrl,
    // The HTTP seed path's budget. It has to stay INSIDE the forge's and the orchestrator's
    // own deadlines — see the README's "The fetch timeout chain".
    fetchTimeoutMs: msEnv("RYPH_RADICLE_FETCH_TIMEOUT_MS", 20_000),
    reconcileIntervalMs: intEnv("RYPH_RADICLE_RECONCILE_SECONDS", 300) * 1_000,
    pullIntervalMs,
    pullTimeoutMs: msEnv("RYPH_RADICLE_PULL_TIMEOUT_MS", 45_000),
    config: {
      exportDir: `${dataDir}/export`,
      scratchDir: `${dataDir}/scratch`,
      maxBundleBytes: intEnv("RYPH_RADICLE_MAX_BUNDLE_BYTES", 500 * 1024 * 1024),
      maxUploadPackBytes: intEnv("RYPH_RADICLE_MAX_UPLOAD_PACK_BYTES", 10 * 1024 * 1024),
      fetchBeforeAdvertise: env("RYPH_RADICLE_FETCH_ON_CLONE") !== "off",
      // Short on purpose: best-effort freshness in front of callers with 10s deadlines, and it
      // holds the repo's lock, so a comment write queues behind it. See the README's "The git
      // fetch path".
      gitFetchTimeoutMs: msEnv("RYPH_RADICLE_GIT_FETCH_TIMEOUT_MS", 3_000),
      // One pull interval by default: inside it the pull has already asked, and a clone that
      // asked again would be paying the fetch above for nothing. See the README's "The git
      // fetch path".
      gitFetchFreshMs: msEnv("RYPH_RADICLE_GIT_FETCH_FRESH_MS", pullIntervalMs),
    },
  });

  // Readiness is one bounded read of the thing this service exists to serve — our own identity,
  // which needs the key and RAD_HOME and nothing else. Liveness asks nothing: a node outage
  // must route traffic away, never restart the pod into a crash loop.
  const health = makeHealth({ ready: () => bridge.service.identity(), log: diag });
  const router = makeRouter([...(opts.health ? health.routes : []), ...bridge.routes]);
  const hostname = opts.hostname;
  const server = await serve(
    { port, ...(hostname === undefined ? {} : { hostname }), onListen: () => {} },
    router,
  );
  const bound = server.addr;
  const url = `http://${hostname ?? "127.0.0.1"}:${bound.port}`;

  const self = await bridge.service.identity().catch(() => null);
  // Asked on its own rather than read off `self`: an identity that cannot be read says nothing
  // about whether the node is up, and the two get different fixes.
  const nodeRunning = await node.status().then(() => true, () => false);
  if (user && !nodeRunning) {
    // Not fatal: storage reads and pushes work without a node, and the consumer reconnects on
    // its own. But nothing is fetched or announced until it is up, which is worth one line.
    log.warn(
      `radicle-node is not running for ${home} — ryph reads and writes your storage, but ` +
        "nothing reaches the network and no event arrives until it is (`rad node start`)",
    );
  }
  log.info(`listening on ${hostname ?? ""}:${bound.port}`, {
    mode,
    home,
    did: self?.did ?? "unreadable",
    alias: self?.alias ?? null,
    node: nodeRunning ? "connected" : "unreachable",
    auth: token === null ? "dark" : "on",
    events: eventsUrl ?? "unset",
    cursors: handle === null ? "memory" : "database",
  });

  return {
    server,
    url,
    mode,
    home,
    identity: self,
    nodeRunning,
    untrackExcept: (keep, before) => bridge.service.untrackExcept(keep, before),
    start: () => bridge.consumer.start(),
    beginDrain: health.beginDrain,
    close: async () => {
      await bridge.consumer.stop();
      await cursors.close();
      await closeDb();
    },
  };
}

/**
 * The checks a person's own setup gets before a user-mode bridge starts, each failing with the
 * fix: `rad` installed, an identity in RAD_HOME, and a key `rad` can unlock without a terminal.
 * `git-remote-rad` and an agent that does not hold the key only warn — reads still work.
 */
async function preflight(
  exec: RadExec,
  home: string,
  binDir: string | null,
  agentSocket: string | null,
  log: Logger,
): Promise<void> {
  let version: Awaited<ReturnType<RadExec["rad"]>>;
  try {
    version = await exec.rad(["--version"], { timeoutMs: 10_000 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") {
      // Found, but not something this uid may execute.
      fail(
        `\`rad\` in ${binDir ?? "a directory on PATH"} cannot be executed by this user ` +
          `(${err instanceof Error ? err.message : err}) — check its permissions`,
      );
    }
    fail(
      `could not run \`rad\` (${err instanceof Error ? err.message : err}) — install Radicle ` +
        "(https://radicle.xyz) and put `rad` on PATH, or name its directory in " +
        `RYPH_RADICLE_BIN_DIR (looked on PATH and in ${join(home, "bin")})`,
    );
  }
  if (version.code !== 0) fail(`\`rad --version\` failed: ${version.stderr.trim()}`);
  const self = await exec.rad(["self", "--did"], { timeoutMs: 10_000 });
  if (self.code !== 0) {
    fail(
      `no Radicle identity in ${home} (${(self.stderr || self.stdout).trim().slice(0, 200)}) — ` +
        "create one with `rad auth`, or point RAD_HOME at the profile you use",
    );
  }

  const encrypted = await keyIsEncrypted(join(home, "keys", "radicle"));
  if (encrypted && !process.env.RAD_PASSPHRASE && agentSocket === null) {
    fail(
      `the Radicle key in ${home} is encrypted and nothing can unlock it: SSH_AUTH_SOCK is not ` +
        "set, so there is no ssh-agent to sign through. Start ryph from a shell where `rad auth` " +
        "has added the key to your agent, or set RAD_PASSPHRASE",
    );
  }
  if (encrypted && !process.env.RAD_PASSPHRASE && agentSocket !== null) {
    const pub = await readFile(join(home, "keys", "radicle.pub"), "utf8").catch(() => "");
    const blob = publicKeyBlob(pub);
    if (blob !== null && await agentHoldsKey(agentSocket, blob) === false) {
      log.warn(
        "your ssh-agent does not hold the Radicle key, so every write ryph makes will fail " +
          "until it does — run `rad auth` to add it",
      );
    }
  }

  // `git push rad://…` finds its helper on PATH, beside `rad` or not at all — see cliRadExec.
  const dirs = [...(binDir === null ? [] : [binDir]), ...(env("PATH") ?? "").split(":")];
  const found = dirs.some((dir) => {
    try {
      return dir !== "" && statSync(join(dir, "git-remote-rad")).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    log.warn(
      "git-remote-rad was not found beside rad or on PATH — ryph can read your repositories " +
        "but cannot open or update a patch until it is",
    );
  }
}

if (import.meta.main) {
  await main();
}
