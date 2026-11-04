// Container lifecycle, as the core sees it: launch, kill, inspect — nothing else.
// The provisioner is infrastructure-level truth; heartbeats are application-level truth.
// The reaper reconciles the two, so an adapter only reports what its backend actually knows.
//
// Service containers ride `LaunchSpec` rather than a sibling port, and the argument is
// structural rather than aesthetic. A sibling implies a call sequence — launch the services,
// then launch the run — which KUBERNETES CANNOT EXPRESS: they are one Job manifest, created
// once, and containers cannot be added to a Pod afterwards. That adapter would have to buffer a
// `launchServices` call and replay it inside a later `launchRun`, i.e. pretend to implement a
// contract. (@ryph/mcp-gateway's ToolHost is a sibling port for the opposite reason: hosted
// servers outlive every run, have no runner inside, and are reconciled against a probe.)
//
// One OPTIONAL capability rides beside the three: `capacity`, warm room held for runs of each
// size class so a launch lands on a node that already exists (core/reserved_capacity.ts). Only a
// backend that has nodes to warm and something cheap to hold them with implements it, which today
// is kubernetes alone; the others leave it undefined and the API says the deployment cannot.
//
// And one optional FLAG, `supportsBrowser`: whether the adapter launches the browser sidecar a run
// may be given (core/browser.ts). Kubernetes and docker do; the core asks before granting one —
// and, where the adapter has one, asks `browserRefusal` too, for what only the run's own pod can
// say (kubernetes: a cluster without native sidecars, a size class with no disk left for it).

import type { LeaseStore } from "@ryph/service";
import type { ServiceSpec } from "../core/types.ts";
import type { RunSize } from "../core/run_sizes.ts";
import type { ServiceRoom } from "../core/services.ts";

export type { RunSize, ServiceRoom, ServiceSpec };

export interface LaunchSpec {
  runId: string;
  /**
   * The concrete agent-container image ref: the deployment's default image (RYPH_AGENT_IMAGE),
   * the same for every harness kind because every image carries every harness. Null when none is
   * configured — adapters that actually launch containers must refuse a null image; the manual
   * adapter just narrates it.
   */
  image: string | null;
  /**
   * The run's size class, resolved by the core (core/run_sizes.ts). Every adapter applies what
   * its backend can express and SAYS what it cannot, never refuses over it: a run one size off
   * is a slower run, while a refused one is no run at all. Null fields are unconstrained.
   */
  size: RunSize;
  /**
   * The agreed container contract, verbatim: the orchestrator's address, the run id, and a
   * single-use bootstrap bearer (plus a non-secret proxy address when configured). No durable
   * credential rides this env: the runner redeems bootstrap before fetching its work item,
   * retaining credentials only in memory and explicitly constructed child environments.
   */
  env: Record<string, string>;
  /**
   * The run's wall-clock backstop, in seconds from launch: its own limit plus the graces the
   * orchestrator's cancel needs to land first (core/run_limits.ts). The SIZE rule applies, not
   * the services rule — an adapter that cannot express a deadline says so and launches anyway,
   * because the reaper enforces the same limit and this is only what remains when it cannot.
   */
  deadlineSeconds?: number;
  /**
   * Containers to launch AS PART OF this run's container unit, reachable from it by name and
   * from nothing else. Resolved and policy-checked by the core before it gets here — `image` is
   * a digest-pinned ref this deployment allows, `security` is the catalogue's.
   *
   * Empty for every ordinary run. Adapters that cannot co-launch containers must REFUSE a
   * non-empty list rather than launch without it: a run whose database is simply absent does
   * not fail, it HANGS — that is the measured behaviour this feature exists
   * to remove, and reproducing it by silently dropping a service would be perverse.
   *
   * They live and die with the run. Taking them down is the adapter's job, not a port method:
   * `kill(handle)` must leave nothing behind.
   */
  services?: ServiceSpec[];
  /**
   * The browser sidecar (core/browser.ts): the platform's own container, never a repo's, which
   * is why it is its own field and not a `services` entry — no name to resolve it by, no
   * catalogue, and docker launches it differently (in the agent's network namespace, not on a
   * network of the run's own). It must share the agent's localhost, so a dev server the agent
   * starts is the page it opens, on every backend that launches it.
   *
   * Absent or null for every run the core did not grant one, and the core grants one only on a
   * provisioner that says it can (`supportsBrowser`, `browserRefusal`). A browser that does not
   * come up is not the launch's failure: the runner waits for it, gives up after a minute, and
   * the run goes on without one — a browser is a convenience, never the run's input. (One
   * exception the adapter cannot help: an image that will not pull, see kubernetes.ts.)
   */
  browser?: BrowserLaunch | null;
}

/** One browser sidecar, as the core resolved it from the deployment's configuration. */
export interface BrowserLaunch {
  /** RYPH_BROWSER_IMAGE. */
  image: string;
  /** The loopback port it listens on, which the runner dials (core/browser.ts's BROWSER_PORT). */
  port: number;
  /** On top of the run's size class, in Kubernetes quantities: `cpu` like `1` or `500m`,
   * `memory` like `1536Mi`. */
  resources: { cpu: string | null; memory: string | null };
}

export interface Provisioner {
  /** Starts a container for one run; the returned handle is opaque and backend-specific. Throws
   * `ImageGone` (ports/image_gone.ts) only where the backend itself says the run's image is gone
   * from its store for good (docker, a locally built environment image); a backend that cannot
   * tell at launch (kubernetes pulls later, in the pod) never does. */
  launch(spec: LaunchSpec): Promise<{ handle: string }>;
  /**
   * graceful=true delivers SIGTERM — the runner's graceful-cancel path, committed work ships.
   * graceful=false is the hard kill for a wedged container.
   */
  kill(handle: string, opts: { graceful: boolean }): Promise<void>;
  inspect(handle: string): Promise<"running" | "exited" | "unknown">;
  /**
   * Present only where the backend can hold warm room for runs (kubernetes). Absent everywhere
   * else, and absent is an answer the API passes on, never an error.
   */
  capacity?: CapacityReserver;
  /**
   * True where the adapter launches `LaunchSpec.browser` (kubernetes, docker). Absent is "cannot",
   * and the core then grants no run a browser, recording why on each run whose agent asked.
   */
  supportsBrowser?: boolean;
  /**
   * Why THIS run cannot hold the browser, or null when it can: `size` is its class and
   * `serviceCount` its service containers. Asked at start, once the core would otherwise grant
   * one; an answer makes the grant a `browser.unavailable` instead, so a browser the pod has no
   * room for never fails the launch. The reason completes "the agent has a browser, but …".
   * Absent: every run the adapter supports can hold one.
   */
  browserRefusal?(size: RunSize, serviceCount: number): Promise<string | null>;
  /**
   * Where the control plane POSTs a cancel to this run's runner (its inbound `POST /cancel`), or
   * null when nothing the control plane holds can dial into the run. Derived from what this
   * backend placed — the container it named for `runId`, the runner's fixed control port — and
   * never from anything the run says: the run is untrusted, and this is a request the control
   * plane makes with the run's control token on it. Absent is null: the heartbeat's answer and
   * the reaper's kill carry the cancel instead (docs/cancellation.md).
   */
  controlUrl?(run: { id: string; handle: string }): string | null;
}

/** How many placeholders to hold for one size class. Zero is "hold none". */
export interface Reservation {
  size: RunSize;
  slots: number;
}

/** What the backend holds for one class right now: placeholders that are up and holding room. */
export interface ReservationStatus {
  sizeClass: string;
  ready: number;
}

/**
 * Warm room for runs, held by placeholders that any real run or check evicts. See
 * core/reserved_capacity.ts for who drives it and why.
 */
export interface CapacityReserver {
  /**
   * Where the backend records who applies: one lease, taken and renewed by @ryph/service's
   * `makeLease` (core/reserved_capacity.ts drives it), so the old and the new configuration of a
   * rollout never take turns undoing each other.
   */
  readonly lease: LeaseStore;
  /** Who this process is in that lease. Unique per process, not per pod. */
  readonly identity: string;
  /**
   * Converges the backend on exactly these reservations: every configured class, 0 included.
   * Anything held for a class not listed, or listed at 0, is removed. Idempotent: each call
   * states the whole desired state rather than a step. Called only while this process holds the
   * lease, so two configurations in a rollout never take turns undoing each other.
   *
   * Each slot holds room for the largest pod a run or check of its class can ask for: the class
   * plus `services`, or as many of them as the class can fit (`servicesHeld`).
   *
   * `held` is the lease's own: asked before every write, and false from the holder's renew
   * deadline on, which is before any other process may take the lease over by its own clock. A
   * pass slow enough to outlive it stops and throws rather than write after the lease could have
   * passed on, so two configurations never write at once however many classes there are or
   * however slow the backend is.
   */
  apply(plan: {
    image: string;
    services: ServiceRoom;
    reservations: Reservation[];
    held: () => boolean;
  }): Promise<void>;
  /** What the backend holds now: one entry per class it holds anything for, never two. */
  status(): Promise<ReservationStatus[]>;
  /**
   * How many of `room`'s services one slot of this class holds room for: all of them, or fewer
   * when no run or check pod of the class can fit that many. Pure.
   */
  servicesHeld(size: RunSize, room: ServiceRoom): number;
}
