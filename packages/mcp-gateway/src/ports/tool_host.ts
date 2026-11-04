// Where hosted servers run, as the core sees it. The orchestrator's Provisioner's sibling rather
// than a generalisation of it: a Provisioner launches one fixed contract per run and is reaped
// against heartbeats, while a tool container is long-lived, has no runner inside, and is
// reconciled against a probe. The two share a shell command and nothing else, so coupling their
// lifecycles through one port would make both worse.
//
// Invariants every adapter holds (and pins in its argv test):
// - a vendor's container joins the TOOLS network and no other, and that network CONFINES it: on
//   Kubernetes the ryph-tools namespace's NetworkPolicies (the guard in, the public internet out,
//   nothing private); on docker an `--internal` network with gateway mode `isolated`, which the
//   launcher makes and refuses to host on when it cannot (packages/launcher/src/tools.ts). What a
//   vendor reaches there is the guard, which dials it, and the egress relay, its one way out —
//   never the run network, the deployment's services, the docker host or the LAN. (OrbStack's
//   networks do not isolate, measured, which is what the caller token in core/hosting.ts is for.)
// - the GUARD is the one container on two networks: the tools network, and an ordinary one
//   (`edge` under docker) where whoever dials it reaches it. Its image is the deployment's own,
//   never the caller's: a launcher refuses a guard of any other image
// - only the tool guard is ever published, and only with an explicit 127.0.0.1 bind: a bare
//   publish is reachable from the run network through the host (measured on docker)
// - non-root, read-only root filesystem, no mounts, no capabilities, a memory cap, no restart
//   policy — the gateway supervises, so a crash is a status and not a silent loop. (The
//   kubernetes adapter cannot hold the last of these: a Deployment restarts its pod whatever it
//   is told. Its header says what survives — the row still reads unreachable.)
// - a vendor container's name is `ryph-tool-<launch key>` (core/tool_guard.ts `toolNameProblem`)
//   and an adapter refuses to launch one under any other: the name is the address the guard
//   routes that key to, so nothing launched from other inputs may ever hold it. A launch replaces
//   whatever holds the name — the same inputs, by construction

export interface ToolLaunchSpec {
  /** `ryph-tool-<launch key>` (`toolContainerName`), or the guard's own name. */
  name: string;
  /** Digest-pinned for anything a catalogue or an operator named; the guard is our own build. */
  image: string;
  /** The argv after the image's entrypoint: catalogue args, or the guard's none. */
  command: string[];
  /** Settings only — never a credential. `inspect` on a tool container shows nothing to steal. */
  env: Record<string, string>;
  /**
   * Env whose VALUES must never reach a command line: the guard's token, a caller token. An
   * adapter passes these by NAME (`-e NAME`, which both backends read from the launching
   * process's own environment) and sets the values on that process instead — `/proc/<pid>/cmdline`
   * is world-readable on Linux, so `-e NAME=<token>` hands the guard's token to any local user,
   * or any sibling container with host PID access, for the length of the exec.
   *
   * `inspect` on the container still shows them; the container holds them either way. What this
   * closes is the window on the HOST, where the gateway's own guard token is the prize.
   */
  secretEnv?: Record<string, string>;
  /** The port the server listens on inside the container. */
  port: number;
  /** Memory cap, docker's spelling (`512m`). */
  memory: string;
  /** CPU cap, in CPUs (`1`). Absent: the backend's default. */
  cpus?: string;
  /** Publish `port` on the host's loopback. The guard, and nothing else (an adapter refuses it on
   * any other launch). 0 picks a free port. */
  publish?: { hostPort: number };
  /**
   * `shared`: one long-lived container per server, supervised and reconciled at boot — the only
   * value implemented. `run`: one container per run, minted at the run's boot and reaped with
   * it, for `shared: false` catalogue entries. Declared now so the per-run work does not have to
   * reshape the port.
   */
  lifetime: "shared" | "run";
}

export interface ToolLaunch {
  /** What stop/inspect/logs take. The container's name, so it survives a gateway restart. */
  handle: string;
  /**
   * `host:port`. For a vendor's launch, where the GUARD reaches it on the tools network — the
   * container's name under docker, its Service name under kubernetes. For the guard, where THIS
   * PROCESS reaches it: its name, or its loopback port when published.
   */
  address: string;
}

export type ToolContainerState = "running" | "exited" | "unknown";

export interface ToolHost {
  /** Which backend this is, for logs and the catalogue's reason line. */
  readonly kind: string;
  /**
   * Whether THIS PROCESS can dial the guard by its container address. True under kubernetes
   * (Service names, in-cluster) and under docker when this process is a container on the guard's
   * ordinary network (`edge`), so the guard is published on neither. False for a process on the
   * docker host: Docker Desktop puts containers behind a VM the host cannot route into, so the
   * guard is published — on loopback, and only the guard.
   */
  readonly reachesGuard: boolean;
  /** The guard's container name on this backend. Unset is the shared `GUARD_NAME`. */
  readonly guardName?: string;
  /**
   * The guard's image as this backend runs it, when the backend decides it (the docker launcher,
   * RYPH_TOOL_GUARD_IMAGE there): the one image a guard launch may name. Unset: the gateway's own
   * configuration names it.
   */
  readonly guardImage?: string;
  /**
   * Where a vendor's container reaches the internet: the egress relay's origin on the tools
   * network (`http://<relay>:7460`), which the gateway hands every vendor launch as its proxy
   * with a claim of its own (core/tool_egress.ts). Null: the backend confines and offers no way
   * out (the launcher's RYPH_TOOL_EGRESS_TARGET=off). Unset: the backend's own network policy is
   * the way out (kubernetes), and no proxy is handed.
   */
  readonly egressProxy?: string | null;
  /**
   * The tools network is ready to launch into. Idempotent; called at gateway boot. The docker
   * backend MAKES it — internal, its gateway isolated, the egress relay beside it — because a
   * docker network is the launcher's to make, and refuses where the engine cannot confine; the
   * kubernetes adapter only checks, because there the network is a namespace an operator declared
   * and this process is deliberately not allowed to make one.
   */
  ensureNetwork(): Promise<void>;
  /** Starts a long-lived container on the tools network, replacing any holding the same name. */
  launch(spec: ToolLaunchSpec): Promise<ToolLaunch>;
  /** Stops and removes. Idempotent: an already-gone container is the outcome wanted. */
  stop(handle: string): Promise<void>;
  /**
   * Every container on this backend that THIS PLATFORM launched, by name — tool containers and
   * the guard, running or not, found by the `ryph.tool` label. The one call that goes the other
   * way round: every other path walks rows and asks after a container it already knows the name
   * of, so a container whose row stopped accounting for it (an archive whose stop failed, a
   * process that died between the two writes) would otherwise be invisible for ever. Boot sweeps
   * what this returns against the live rows.
   */
  list(): Promise<string[]>;
  inspect(handle: string): Promise<ToolContainerState>;
  /**
   * Where the guard reaches a container that is already running — what a boot reconcile needs
   * for containers it did not launch this process. Null when it is not running. The address is
   * one only the backend knows.
   */
  address(handle: string, port: number): Promise<string | null>;
  /** The last `tail` lines of stdout and stderr. Never the env. */
  logs(handle: string, tail: number): Promise<string>;
}
