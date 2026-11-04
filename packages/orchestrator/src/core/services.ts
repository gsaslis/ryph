// Service containers: what a repo may ask the platform to run beside its agent, and the rules
// that turn an ask into something safe to launch. Pure — the catalogue arrives as data, the
// policy as a value, and nothing here reads a file, an env var or a clock.
//
// The shape of the problem, which is why this file exists at all: a repo's `setup.yml` can run
// any shell it likes but it cannot start a database (the agent images ship no container runtime,
// on purpose), and the run's Pod is sealed the moment it is created. So the declaration must be
// resolved BEFORE launch, in the control plane, against a list the operator vouched for.
//
// Invariants:
// - the repo never names an image. `uses` names a CATALOGUE entry, and the catalogue supplies
//   the digest-pinned ref. The one exception is the operator's explicit escape hatch, and there
//   the declaration must carry its own hardening — see `resolveServices`
// - the repo never widens its confinement. `security` is the catalogue's, always; the field
//   does not exist in the declaration's vocabulary unless the escape hatch put it there
// - every refusal names the fix, and nothing is ever silently dropped. A run whose database is
//   simply absent fails a long way from the cause — which is the failure this feature exists
//   to remove, so reproducing it as a policy outcome would be perverse

import type { ConnectedRepo, ServiceSpec } from "./types.ts";
import { BROWSER_PORT, type BrowserConfig } from "./browser.ts";

/**
 * One service as the repo declared it: names and settings, nothing resolved. The parser
 * (helpers/services.ts) produces these; `resolveServices` turns them into `ServiceSpec`s.
 */
export interface ServiceDeclaration {
  /** An RFC 1035 label. THE HOSTNAME the run reaches it by, on every backend. */
  name: string;
  /** `<catalogue id>@<version>` — e.g. `postgres@18`. Absent only with `image`. */
  uses?: string;
  /** A raw image ref. Only legal when the operator set an allowlist; see `resolveServices`. */
  image?: string;
  /** Required alongside `image`: what that image's entrypoint genuinely needs, declared by
   * whoever took the escape hatch, because no catalogue reviewed it. */
  capabilities?: string[];
  command?: string[];
  env: Record<string, string>;
  /** What the run dials, and what the health gate waits on. Required and explicit: GitHub
   * Actions can infer it from the image's HEALTHCHECK, which we cannot read without pulling. */
  port: number;
  /**
   * `checks_only: true`: started only for the checks that name it, never beside a run. Present
   * only when true. A run reads the declaration through `forRuns`, which leaves these out, so a
   * repo whose only service is a test database starts its tasks on a deployment that runs no
   * service containers at all, and a run where they do run does not start one it never uses.
   */
  checksOnly?: true;
}

/**
 * The declarations a RUN starts: all but the checks-only ones. Empty means the run gets no
 * services, exactly as if the repo had no services.yml.
 */
export function forRuns(declarations: readonly ServiceDeclaration[]): ServiceDeclaration[] {
  return declarations.filter((d) => d.checksOnly !== true);
}

/**
 * A catalogue entry — what the platform knows about running one image safely. The fields that
 * matter are the ones a prefix allowlist cannot carry: the capability set the image's entrypoint
 * actually needs, reviewed once, here. `packages/mcp-gateway/src/core/catalogue.ts` encodes the
 * same knowledge for the same reason; this is its sibling, not its subclass.
 */
export interface ServiceCatalogueEntry {
  id: string;
  name: string;
  description: string;
  docs: string;
  /** version label → digest-pinned image ref. The label is what a repo writes after `@`. */
  versions: Record<string, string>;
  /** The port the image listens on out of the box — narration only; the repo states its own. */
  defaultPort: number;
  /**
   * Linux capabilities to ADD on top of `drop: ALL`. Empty is the goal and rarely reachable:
   * the official postgres and redis images both `exec gosu`, which needs SETUID/SETGID, and
   * initdb chowns its data dir. The alternative — leaving the runtime default — hands a
   * repo-chosen image CAP_NET_RAW in the run's network namespace, and every intra-cluster hop
   * in this deployment is plaintext HTTP carrying the run's tokens.
   */
  capabilities: string[];
  /**
   * Docker's spelling (`512m`), as @ryph/mcp-gateway's catalogue uses; the kubernetes adapter
   * converts. A FLOOR: what this image needs to come up, measured alongside its capability set.
   * A service gets the larger of this and the operator's `RYPH_SERVICE_MEMORY`, so tightening
   * the allowance cannot silently start an image under what it needs — see `largerMemory`.
   */
  memory: string;
  /** Env keys the repo may set. Anything else is refused, not dropped. */
  env: string[];
}

/**
 * Every capability a service container may be granted — by a catalogue entry, or by whoever
 * took the escape hatch — and nothing else. An ALLOWLIST, because the list of dangerous ones
 * does not end: NET_RAW reads the run's tokens off the wire, but NET_ADMIN rewrites the pod's
 * routes to the same effect, DAC_READ_SEARCH is a container escape, and `ALL` is all of them.
 *
 * The set is docker's own default, minus NET_RAW and MKNOD: nothing a stock `docker run` does
 * not already hand any image, and none of the capabilities that reach past the container's own
 * files and processes. Every measured catalogue entry fits inside it with room to spare.
 */
export const SERVICE_CAPABILITIES: ReadonlySet<string> = new Set([
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "NET_BIND_SERVICE",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
  "SYS_CHROOT",
]);

/** Why `capability` may not be granted to a service container, or null when it may. */
export function capabilityRefusal(capability: string): string | null {
  if (SERVICE_CAPABILITIES.has(capability)) return null;
  if (capability === "ALL") return "`ALL` is every capability, NET_RAW and SYS_ADMIN among them";
  return `${capability} is never granted to a service container — the set is docker's default ` +
    `minus NET_RAW and MKNOD: ${[...SERVICE_CAPABILITIES].join(", ")}`;
}

/** The operator's switches, resolved once by the composition root. */
export interface ServicePolicy {
  /** Off by default: this runs images of the repo's choosing on the operator's machines. */
  enabled: boolean;
  /**
   * Registry/repo prefixes a declaration may name an image from directly, bypassing the
   * catalogue. Empty — the default — means catalogue only. A prefix constrains who published
   * the bytes and not what they do (`docker.io/library/*` includes `alpine`), which is why
   * this is the escape hatch and not the main road.
   */
  imageAllowlist: string[];
  /** Services per run. */
  max: number;
  /** Per service, request and limit, in docker's spelling. */
  cpus: string;
  memory: string;
}

export const DEFAULT_SERVICE_POLICY: ServicePolicy = {
  enabled: false,
  imageAllowlist: [],
  max: 3,
  cpus: "1",
  memory: "1g",
};

/**
 * The most a run's services can add to its pod under this deployment's policy: `count` services,
 * each at the largest size one can be given. Reserved capacity holds this much on top of a
 * class's own shape (core/reserved_capacity.ts), because a slot shaped for a run without services
 * is too small to be evicted for a run with them.
 */
export interface ServiceRoom {
  /** `RYPH_SERVICE_MAX`, or 0 when services are off. */
  count: number;
  /** Per service, in docker's spelling, as `ServicePolicy`. */
  cpus: string;
  memory: string;
  /**
   * The browser sidecar's cpu and memory (core/browser.ts, Kubernetes quantities), which any run
   * of the class may add on top of its services; null when the deployment runs no browser.
   */
  browser: { cpus: string | null; memory: string | null } | null;
}

/**
 * The room for one deployment's policy and catalogue. A service gets `largerMemory` of its entry's
 * floor and the policy, so the largest any can get is the policy or the largest floor, whichever
 * is more. An image outside the catalogue has no floor and gets the policy's.
 */
export function serviceRoom(
  policy: ServicePolicy,
  catalogue: readonly ServiceCatalogueEntry[],
  browser: Pick<BrowserConfig, "cpus" | "memory"> | null = null,
): ServiceRoom {
  return {
    count: policy.enabled ? policy.max : 0,
    cpus: policy.cpus,
    memory: catalogue.reduce((most, entry) => largerMemory(entry.memory, most), policy.memory),
    browser: browser === null ? null : { cpus: browser.cpus, memory: browser.memory },
  };
}

/**
 * Names a service may not take, because something already answers to them where the run can
 * hear it.
 *
 * The first group is this project's own deployment topology: an agent container joins the
 * deployment's network to reach `control-plane` and `forge` BY NAME (compose.yaml sets
 * RYPH_PUBLIC_URL to exactly that), and under docker it joins the run's network beside it —
 * so a service aliased with one of these names makes the run's own control channel ambiguous.
 * The rest are names the resolver itself owns.
 *
 * This list cannot be complete, and the docs say so: it covers the names WE put on that
 * network, not whatever else an operator runs there. The addresses a deployment actually hands
 * its runs are checked on top of it, whatever the deployment calls them — `resolveServices`'s
 * `runnerAddresses` here, and the runner's own check for what only it is handed.
 */
export const RESERVED_SERVICE_NAMES: readonly string[] = [
  "control-plane",
  "forge",
  "historian",
  "memory",
  "model-proxy",
  "mcp-gateway",
  "app",
  "postgres",
  "objects",
  "localhost",
  "kubernetes",
  "host",
  "host.docker.internal",
  // The platform's browser sidecar (core/browser.ts) — not a service, but the one container the
  // platform itself puts beside a run, and the name the run's own tools and docs give it.
  "browser",
];

/**
 * The runner's own control listener (`RYPH_PORT`, `packages/runner/src/main.ts`). On
 * Kubernetes the sidecars share the pod's network namespace and start FIRST, so a service on
 * 8080 — wiremock, keycloak, jaeger's UI — wins the bind and `serve` fails with EADDRINUSE
 * before the runner has fetched its work item. The user would see an error naming a port and no
 * service, and file it as a platform bug. Under docker each service has its own namespace, so
 * there is no collision to have.
 *
 * ADVISORY, and worth being honest about: this constrains the DECLARATION, not the process.
 * `port` is metadata — what the startup probe dials and what the runner's health gate waits on
 * — while what the container actually binds is decided by the repo's `command`/`args`, which is
 * arbitrary argv into the image. `port: 5432` with `args: ["postgres", "-p", "8080"]` walks
 * straight past this check. The cost of that is a startup probe that never passes and a pod
 * stuck in `Init:` until the reaper's startup grace expires — a self-inflicted, loud failure,
 * confined to the run that declared it.
 *
 * So this is a good error message for the ordinary mistake, not a boundary. The boundary that
 * actually holds is the one in the cluster: `ryph-runs` is default-deny with no ingress rule
 * at all, so nothing outside the pod can reach a sidecar whatever port it chose.
 */
export const RUNNER_CONTROL_PORT = 8080;

/**
 * Which ref the declaration is read at: the run's own when it is a BRANCH of the connected
 * repo, and the connected repo's default branch otherwise.
 *
 * Today the distinction has no teeth — every run's ref is a branch of the connected repo by
 * construction (http/user_api.ts builds it against the repo's own URL after a live `write`
 * check; http/forge_api.ts uses `repo.defaultBranch`). It is here for the day a fork's PR head
 * can trigger a run, where `refs/pull/42/head` is fetched from the base repo but its CONTENT is
 * the fork's, so it must not choose what the platform launches.
 *
 * One function, so there is one place to change and one test that pins the intent. And note
 * what it is not: the ref is a fence around who may REQUEST, never around what may RUN. A
 * maintainer merging a bad declaration walks straight through it. The catalogue is the control.
 */
export function servicesRef(
  repo: ConnectedRepo,
  entry: { url: string; ref: string; forkHead?: boolean },
): string {
  if (entry.url !== repo.url) return repo.defaultBranch;
  // Said by the door, not inferred from the spelling: a fork pull request's head.
  if (entry.forkHead === true) return repo.defaultBranch;
  // A bare name and `refs/heads/*` are branches: putting one there needs write access, the same
  // gate the task itself passed. Anything else under `refs/` is not the repo's own branch.
  if (entry.ref.startsWith("refs/") && !entry.ref.startsWith("refs/heads/")) {
    return repo.defaultBranch;
  }
  return entry.ref;
}

/**
 * The declarations of every repo in a checkout, as one list — hostnames are shared across the
 * run, so a backend and a frontend that both declare `db` mean the same database. The same
 * name with a DIFFERENT declaration is refused, naming both repos: silently picking one is the
 * kind of half-run intent the setup contract refuses everywhere else. Pure; the caller has
 * read each repo's file already.
 */
export function unionDeclarations(
  perRepo: ReadonlyArray<{ repo: string; declarations: readonly ServiceDeclaration[] }>,
): { kind: "ok"; declarations: ServiceDeclaration[] } | { kind: "refused"; error: string } {
  const seen = new Map<string, { repo: string; declaration: ServiceDeclaration }>();
  const out: ServiceDeclaration[] = [];
  for (const { repo, declarations } of perRepo) {
    for (const declaration of declarations) {
      const prior = seen.get(declaration.name);
      if (prior === undefined) {
        seen.set(declaration.name, { repo, declaration });
        out.push(declaration);
        continue;
      }
      if (prior.repo === repo) continue; // one repo's own duplicate is resolveServices's to refuse
      if (!sameDeclaration(prior.declaration, declaration)) {
        return {
          kind: "refused",
          error: `services.${declaration.name}: ${prior.repo} and ${repo} both declare it, ` +
            `differently — one hostname is one service, so the two declarations must agree ` +
            `(or one repo must drop its own)`,
        };
      }
    }
  }
  return { kind: "ok", declarations: out };
}

function sameDeclaration(a: ServiceDeclaration, b: ServiceDeclaration): boolean {
  const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  return a.uses === b.uses && a.image === b.image && a.port === b.port &&
    same(a.command, b.command) && same(a.capabilities, b.capabilities) &&
    same(Object.entries(a.env).sort(), Object.entries(b.env).sort());
}

export type ServiceResolution =
  | { kind: "ok"; services: ServiceSpec[] }
  /** Every refusal is a 400 naming what to change — the repo's file, or the operator's switch. */
  | { kind: "refused"; error: string };

/**
 * Declarations + catalogue + operator policy → what the provisioner may launch.
 *
 * Refuses, never ignores. A declaration this deployment will not run means the task does not
 * start, with a message naming the switch or the entry: starting it anyway produces a run whose
 * database is silently absent, which is precisely the hang this feature exists to prevent, now
 * caused by us instead of by the platform's absence.
 */
export function resolveServices(
  declarations: ServiceDeclaration[],
  catalogue: readonly ServiceCatalogueEntry[],
  policy: ServicePolicy,
  /**
   * The addresses a run is handed to reach the platform, keyed by the variable carrying each.
   * A service's name beats DNS on every backend that supports the feature, so a service named
   * after one of their hosts would answer in the platform's place.
   */
  runnerAddresses: Record<string, string | null> = {},
): ServiceResolution {
  if (declarations.length === 0) return { kind: "ok", services: [] };
  if (!policy.enabled) {
    return {
      kind: "refused",
      error: "this deployment does not run service containers (RYPH_SERVICES is off)",
    };
  }
  if (declarations.length > policy.max) {
    return {
      kind: "refused",
      error: `${declarations.length} services declared, and this deployment allows ` +
        `${policy.max} (RYPH_SERVICE_MAX)`,
    };
  }

  const byId = new Map(catalogue.map((e) => [e.id, e]));
  const services: ServiceSpec[] = [];
  const ports = new Map<number, string>();
  const names = new Set<string>();

  for (const decl of declarations) {
    const at = `services.${decl.name}`;
    if (names.has(decl.name)) return { kind: "refused", error: `${at}: declared twice` };
    names.add(decl.name);
    if (RESERVED_SERVICE_NAMES.includes(decl.name)) {
      return {
        kind: "refused",
        error: `${at}: "${decl.name}" already answers to something the run can reach — ` +
          `pick another name (the platform's own services and the resolver's own names are taken)`,
      };
    }
    const shadowed = shadowedAddress(decl.name, runnerAddresses);
    if (shadowed !== null) {
      return {
        kind: "refused",
        error: `${at}: "${decl.name}" is the host this deployment's runs reach ${shadowed} at — ` +
          "a service's name beats DNS, so it would answer in the platform's place and receive " +
          "the run's credentials. Pick another name",
      };
    }
    if (decl.port === RUNNER_CONTROL_PORT) {
      return {
        kind: "refused",
        error: `${at}.port: ${RUNNER_CONTROL_PORT} is the runner's own control port — ` +
          `services start first and would win the bind, failing the run before it starts`,
      };
    }
    // The browser sidecar's port, refused whether or not this run gets one: on Kubernetes it
    // shares the pod's localhost with every service, and a repo whose services only boot on
    // runs without a browser would break the day its agent is given one.
    if (decl.port === BROWSER_PORT) {
      return {
        kind: "refused",
        error: `${at}.port: ${BROWSER_PORT} is the platform browser's port — on Kubernetes ` +
          "services and the browser share one localhost, so pick another port",
      };
    }
    const clash = ports.get(decl.port);
    if (clash !== undefined) {
      return {
        kind: "refused",
        error: `${at}.port: ${decl.port} is already taken by "${clash}" — services share one ` +
          `address space, so every port must be distinct`,
      };
    }
    ports.set(decl.port, decl.name);

    const resolved = decl.image !== undefined
      ? resolveByImage(decl, policy, at)
      : resolveByCatalogue(decl, byId, at);
    if ("error" in resolved) return { kind: "refused", error: resolved.error };

    services.push({
      name: decl.name,
      image: resolved.image,
      ...(decl.command ? { command: [...decl.command] } : {}),
      env: { ...decl.env },
      port: decl.port,
      security: { capabilities: resolved.capabilities, allowPrivilegeEscalation: false },
      resources: { cpus: policy.cpus, memory: largerMemory(resolved.memory, policy.memory) },
    });
  }
  return { kind: "ok", services };
}

/**
 * `VARIABLE (address)` for the runner address whose host is `name`, or null.
 *
 * Only a single-label host can ever match, since a service name has no dots — and that is
 * precisely the exposed deployment: a runner dialling `http://orchestrator:7411` looks the bare
 * name up, and `hostAliases` or a network alias answers first; one dialling
 * `http://control-plane.ryph.svc:7411` does not.
 */
function shadowedAddress(name: string, addresses: Record<string, string | null>): string | null {
  for (const [variable, address] of Object.entries(addresses)) {
    if (address === null || !URL.canParse(address)) continue;
    if (new URL(address).hostname === name) return `${variable} (${address})`;
  }
  return null;
}

function resolveByCatalogue(
  decl: ServiceDeclaration,
  byId: Map<string, ServiceCatalogueEntry>,
  at: string,
): { image: string; capabilities: string[]; memory: string | null } | { error: string } {
  const [id, version] = (decl.uses ?? "").split("@");
  const entry = byId.get(id);
  if (entry === undefined) {
    const known = [...byId.keys()].sort().join(", ") || "(none)";
    return { error: `${at}.uses: no catalogue entry "${id}" — this deployment offers: ${known}` };
  }
  const image = entry.versions[version ?? ""];
  if (image === undefined) {
    const known = Object.keys(entry.versions).sort().join(", ");
    return {
      error: `${at}.uses: ${entry.name} has no version "${version ?? ""}" — offered: ${known}`,
    };
  }
  for (const key of Object.keys(decl.env)) {
    if (!entry.env.includes(key)) {
      return {
        error: `${at}.env.${key}: ${entry.name} takes no such setting — ` +
          `it reads: ${entry.env.join(", ") || "(none)"}`,
      };
    }
  }
  if (decl.capabilities !== undefined) {
    // The whole point of the catalogue: a repo cannot widen its own confinement.
    return {
      error: `${at}.capabilities: only an operator-allowlisted \`image\` may declare these — ` +
        `a catalogue entry's confinement is the catalogue's`,
    };
  }
  return { image, capabilities: [...entry.capabilities], memory: entry.memory };
}

function resolveByImage(
  decl: ServiceDeclaration,
  policy: ServicePolicy,
  at: string,
): { image: string; capabilities: string[]; memory: string | null } | { error: string } {
  if (decl.uses !== undefined) {
    return { error: `${at}: name either \`uses\` (a catalogue entry) or \`image\`, not both` };
  }
  if (policy.imageAllowlist.length === 0) {
    return {
      error: `${at}.image: this deployment runs catalogue entries only — use \`uses\`, or ask ` +
        `the operator about RYPH_SERVICE_IMAGES`,
    };
  }
  const image = normalizeImage(decl.image!);
  if (!policy.imageAllowlist.some((prefix) => matchesPrefix(image, prefix))) {
    return {
      error: `${at}.image: ${image} is not under any prefix this deployment allows ` +
        `(RYPH_SERVICE_IMAGES)`,
    };
  }
  if (decl.capabilities === undefined) {
    // No catalogue reviewed this image, so somebody has to say what it needs. An omitted list
    // must not mean "the runtime default": that is the CAP_NET_RAW hole, silently.
    return {
      error: `${at}.capabilities: an \`image\` outside the catalogue must declare the ` +
        `capabilities its entrypoint needs (\`[]\` for none)`,
    };
  }
  // No entry, so no reviewed floor — whoever took the escape hatch owns sizing it, and the
  // operator's allowance is all there is.
  return { image, capabilities: [...decl.capabilities], memory: null };
}

/**
 * The larger of the catalogue entry's floor and the operator's allowance.
 *
 * The entry's `memory` is what the image needs to come up at all — it was measured with the
 * capability set beside it — so it is a floor and not a request: an operator who sets
 * `RYPH_SERVICE_MEMORY=256m` to rein in Redis must not thereby start MySQL under what MySQL
 * needs and have it OOM at entrypoint, naming nothing. The operator's real levers are which
 * entries exist and whether the feature is on at all.
 *
 * (Before this the field was simply never read, which the schema documented as "a floor" while
 * the resolver granted the policy's value to everything.)
 */
export function largerMemory(floor: string | null, allowance: string): string {
  if (floor === null) return allowance;
  return memoryMiB(floor) > memoryMiB(allowance) ? floor : allowance;
}

/** Docker's `512m` / `2g` as a number, for comparison only. */
function memoryMiB(memory: string): number {
  const match = memory.match(/^([1-9][0-9]{0,4})([mg])$/i);
  if (match === null) throw new Error(`not a memory size: ${memory}`);
  return Number(match[1]) * (match[2].toLowerCase() === "g" ? 1024 : 1);
}

/**
 * Docker's shorthand spelled out: `postgres:18` is `docker.io/library/postgres:18`. Comparing
 * before normalizing is how an allowlist gets walked past — and comparing UNANCHORED is the
 * other way, which `matchesPrefix` closes.
 */
export function normalizeImage(image: string): string {
  const [first] = image.split("/");
  const hasRegistry = image.includes("/") &&
    (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasRegistry) return image;
  return image.includes("/") ? `docker.io/${image}` : `docker.io/library/${image}`;
}

/**
 * A prefix matches only at a path boundary. Plain `startsWith` would let `evil/postgres-backdoor`
 * satisfy a rule for `evil/postgres`, and `docker.io/library/postgresql` satisfy one for
 * `docker.io/library/postgres`.
 *
 * A bare registry host — `ghcr.io`, `ghcr.io/*`, `localhost:5000` — is the root of that registry,
 * and has to be recognised before normalizing: `normalizeImage` reads a slash-less name the way
 * docker does, as a Docker Hub image, which turned `ghcr.io` into `docker.io/library/ghcr.io` and
 * matched nothing. A dot or `localhost` is what marks a host; `redis:7` stays an image.
 */
export function matchesPrefix(image: string, prefix: string): boolean {
  const root = prefix.replace(/\/\*$/, "");
  if (!root.includes("/") && (root.includes(".") || /^localhost(:[0-9]+)?$/.test(root))) {
    return image.startsWith(`${root}/`);
  }
  const normalized = normalizeImage(root);
  if (image === normalized) return true;
  return image.startsWith(`${normalized}/`) || image.startsWith(`${normalized}:`) ||
    image.startsWith(`${normalized}@`);
}

/**
 * The policy, from the deployment's environment. Pure: `env` and `fail` are handed in, so both
 * composition roots (`orchestrator/src/main.ts`, `host/src/main.ts`) read the same variables the
 * same way — the precedent `kubernetesOptionsFromEnv` sets, and the reason it is a function
 * rather than two blocks that drift.
 *
 * `RYPH_SERVICES` defaults OFF. Every other feature here defaults to whatever is safe; this
 * one defaults to absent, because turning it on means this deployment pulls and runs images
 * chosen from a repo's tree on the operator's own machines.
 */
export function servicePolicyFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): ServicePolicy {
  const raw = env("RYPH_SERVICES")?.trim().toLowerCase() ?? "off";
  if (raw !== "on" && raw !== "off") {
    fail(`RYPH_SERVICES must be "on" or "off", got ${JSON.stringify(raw)}`);
  }
  const positive = (name: string, fallback: number): number => {
    const value = env(name);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      fail(`${name} must be a whole number of at least 1, got ${JSON.stringify(value)}`);
    }
    return n;
  };
  const memory = env("RYPH_SERVICE_MEMORY") ?? DEFAULT_SERVICE_POLICY.memory;
  if (!/^[1-9][0-9]{0,4}[mg]$/.test(memory)) {
    // Docker's spelling, as the catalogue uses and the kubernetes adapter converts. Refused
    // rather than passed through: `1Gi` here would mean 1 GiB to a kubelet and nothing at all
    // to docker, so a deployment could be capped differently per backend without saying so.
    fail(`RYPH_SERVICE_MEMORY wants docker's spelling, e.g. 1g or 512m, got "${memory}"`);
  }
  const cpus = env("RYPH_SERVICE_CPU") ?? DEFAULT_SERVICE_POLICY.cpus;
  // Above zero and finite, not merely numeric: `0` is no cap at all to docker (a zero quota is
  // unrestricted) and a zero quantity to a kubelet, so a setting meant to constrain services
  // would silently remove the constraint.
  if (!/^[0-9]+(\.[0-9]+)?$/.test(cpus) || !(Number(cpus) > 0) || !Number.isFinite(Number(cpus))) {
    fail(`RYPH_SERVICE_CPU wants a number of cores above zero, e.g. 1 or 0.5, got "${cpus}"`);
  }
  const imageAllowlist = (env("RYPH_SERVICE_IMAGES") ?? "")
    .split(",").map((p) => p.trim()).filter((p) => p !== "");
  return {
    enabled: raw === "on",
    imageAllowlist,
    max: positive("RYPH_SERVICE_MAX", DEFAULT_SERVICE_POLICY.max),
    cpus,
    memory,
  };
}
