// Size classes: the cpu, memory and disk a run gets, named by the operator and picked per repo or
// workspace by an admin.
//
// Resources used to be one deployment-wide knob that only Kubernetes read (`RYPH_K8S_RESOURCES`).
// A repo like heartwood needs more than a small web service, and the cost is the operator's, so the
// choice is a NAMED class — set on the repo page, not in the repo (which would let a repo spend
// the operator's money) and not on the agent (the same agent works on small and large repos).
//
// Invariants:
// - the classes are configuration, never rows: `RYPH_RUN_SIZES` defines them, and a repo or
//   workspace stores only a class NAME, validated against the configured names when it is set
// - a run always gets exactly one class, resolved once at start and handed to the provisioner
//   in `LaunchSpec.size`; each backend applies what it can and says what it cannot
// - a stored name the configuration no longer defines degrades to the default class rather than
//   refusing the run: an operator renaming a class must not lock every repo that used it out
// - quantities are Kubernetes' spelling (`4`, `500m`, `8Gi`), validated here, so a class that
//   boots is one every adapter can translate

/** One size class, as configured. A null field is "not constrained": the backend's own default. */
export interface RunSize {
  name: string;
  /** Cores, as a Kubernetes cpu quantity: `4`, `0.5`, `500m`. */
  cpu: string | null;
  /** Bytes, as a Kubernetes quantity: `8Gi`, `512Mi`. */
  memory: string | null;
  /** The container's own writable disk, as a Kubernetes quantity. */
  ephemeralStorage: string | null;
  /**
   * A separate volume mounted at `/ryph/work`, living and dying with the run — the answer to a
   * backend that caps ephemeral storage below what a warm Rust build needs (GKE Autopilot: 10Gi).
   * Null: the checkout lives on ephemeral storage like everything else.
   */
  workVolume: string | null;
}

/** The deployment's classes, in configured order, and which one a run gets when nobody chose. */
export interface RunSizes {
  classes: RunSize[];
  defaultName: string;
}

/** What `RYPH_RUN_SIZES` means when it is unset: one class, the size a run pod always had. */
export const DEFAULT_RUN_SIZES_SPEC = "standard:cpu=4,memory=8Gi,ephemeral-storage=10Gi";

/**
 * A class name. It rides URLs, forms and a column, so it is a slug; and it names Kubernetes
 * objects (`ryph-reserve-<class>`) and label values, so it ends in a letter or digit, never `-`.
 * At most 32 characters, which keeps `ryph-reserve-<class>` at 45, inside a DNS label's 63. The
 * one definition: schema.ts validates request bodies with it too.
 */
export const SIZE_CLASS_NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A Kubernetes cpu quantity: whole or fractional cores, or millicores. */
const CPU_QUANTITY = /^(?:[0-9]+(?:\.[0-9]+)?|[0-9]+m)$/;

/** A Kubernetes byte quantity, in the spellings an operator writes for memory and disk. */
const BYTE_QUANTITY = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/;

const BYTE_UNITS: Record<string, number> = {
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
};

/**
 * A Kubernetes byte quantity in whole bytes, rounded UP as the API server rounds a fraction of a
 * byte (`0.1Ki` is 103), so a sum of these is never less than the pods it stands for ask for.
 * Exact: the decimal is scaled as an integer, never through a float that could land a hair above
 * a whole number and round up a byte too many. Throws on anything else, naming it.
 */
export function quantityBytes(value: string): number {
  const match = value.match(BYTE_QUANTITY);
  if (match === null) throw new Error(`not a byte quantity: ${value}`);
  const [whole, fraction = ""] = match[1].split(".");
  const scale = 10n ** BigInt(fraction.length);
  const scaled = BigInt(whole + fraction) * BigInt(BYTE_UNITS[match[2] ?? ""]);
  return Number((scaled + scale - 1n) / scale);
}

/** A Kubernetes cpu quantity in cores (`500m` → 0.5). Throws on anything else, naming it. */
export function quantityCores(value: string): number {
  if (!CPU_QUANTITY.test(value)) throw new Error(`not a cpu quantity: ${value}`);
  return value.endsWith("m") ? Number(value.slice(0, -1)) / 1000 : Number(value);
}

/** The keys a class may set, and which field each lands in. */
const KEYS = {
  cpu: "cpu",
  memory: "memory",
  "ephemeral-storage": "ephemeralStorage",
  "work-volume": "workVolume",
} as const;

/**
 * Parses `name:key=value,key=value;name2:…`. Returns the classes, or the reason the spec is
 * wrong — in words that name the variable, because this is read at boot and the operator is the
 * only reader.
 */
export function parseRunSizes(
  spec: string,
  defaultName: string | undefined,
): { ok: true; sizes: RunSizes } | { ok: false; error: string } {
  const refuse = (error: string) => ({ ok: false as const, error: `RYPH_RUN_SIZES: ${error}` });
  const classes: RunSize[] = [];
  for (const entry of spec.split(";")) {
    if (entry.trim() === "") continue;
    const colon = entry.indexOf(":");
    const name = (colon === -1 ? entry : entry.slice(0, colon)).trim();
    if (!SIZE_CLASS_NAME.test(name)) {
      return refuse(
        "a class name is a lowercase slug of at most 32 characters that starts with a letter " +
          `and does not end in "-", got ${JSON.stringify(name)}`,
      );
    }
    if (classes.some((c) => c.name === name)) return refuse(`class "${name}" is defined twice`);
    const size: RunSize = {
      name,
      cpu: null,
      memory: null,
      ephemeralStorage: null,
      workVolume: null,
    };
    const body = colon === -1 ? "" : entry.slice(colon + 1);
    for (const pair of body.split(",")) {
      if (pair.trim() === "") continue;
      const [key, value, ...rest] = pair.split("=").map((s) => s.trim());
      if (!key || !value || rest.length > 0) {
        return refuse(
          `"${name}" wants comma-separated key=value pairs, got ${JSON.stringify(pair)}`,
        );
      }
      if (!(key in KEYS)) {
        return refuse(
          `"${name}" sets ${JSON.stringify(key)}, which is not one of ${
            Object.keys(KEYS).join(", ")
          }`,
        );
      }
      const field = KEYS[key as keyof typeof KEYS];
      if (size[field] !== null) return refuse(`"${name}" sets ${key} twice`);
      if (field === "cpu") {
        // Above zero: a zero quota is NO cap to docker and an unschedulable request to a kubelet,
        // so a class meant to constrain would silently do the opposite on one backend.
        if (!CPU_QUANTITY.test(value) || !(quantityCores(value) > 0)) {
          return refuse(
            `"${name}" wants cpu as cores or millicores (4, 0.5, 500m), got "${value}"`,
          );
        }
      } else if (!BYTE_QUANTITY.test(value) || !(quantityBytes(value) > 0)) {
        return refuse(`"${name}" wants ${key} as a quantity like 8Gi or 512Mi, got "${value}"`);
      }
      size[field] = value;
    }
    classes.push(size);
  }
  if (classes.length === 0) return refuse("defines no class");
  const chosen = defaultName ?? classes[0].name;
  if (!classes.some((c) => c.name === chosen)) {
    return {
      ok: false,
      error: `RYPH_RUN_SIZE_DEFAULT names "${chosen}", which RYPH_RUN_SIZES does not define ` +
        `(it defines ${classes.map((c) => c.name).join(", ")})`,
    };
  }
  return { ok: true, sizes: { classes, defaultName: chosen } };
}

/** The classes this package assumes when nothing is configured — tests and the unset case. */
export const DEFAULT_RUN_SIZES: RunSizes = (() => {
  const parsed = parseRunSizes(DEFAULT_RUN_SIZES_SPEC, undefined);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.sizes;
})();

/**
 * The classes, from the deployment's environment. Pure: `env` and `fail` are handed in, so both
 * composition roots read the same variables the same way — the `servicePolicyFromEnv` precedent.
 *
 * `RYPH_RUN_SIZE_DEFAULT` unset is the first class listed, which for the unset spec is `standard`.
 */
export function runSizesFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): RunSizes {
  const parsed = parseRunSizes(
    env("RYPH_RUN_SIZES") ??
      (env("RYPH_PROVISIONER") === "docker" ? "standard" : DEFAULT_RUN_SIZES_SPEC),
    env("RYPH_RUN_SIZE_DEFAULT")?.trim(),
  );
  if (!parsed.ok) fail(parsed.error);
  return parsed.sizes;
}

/** The configured class by name, or null when the configuration does not define it. */
export function findRunSize(sizes: RunSizes, name: string): RunSize | null {
  return sizes.classes.find((c) => c.name === name) ?? null;
}

/** The deployment's default class. Always defined: parsing refuses a default it does not list. */
export function defaultRunSize(sizes: RunSizes): RunSize {
  return findRunSize(sizes, sizes.defaultName)!;
}

/**
 * The class a run gets, from the class its subject names (a workspace's for a workspace run, a
 * connected repo's for a single-repo run, null otherwise).
 *
 * `stale` is set when the subject names a class the configuration no longer defines, so the
 * caller can say so; the run gets the default rather than a refusal (see the header).
 */
export function resolveRunSize(
  sizes: RunSizes,
  chosen: string | null,
): { size: RunSize; stale: string | null } {
  if (chosen === null) return { size: defaultRunSize(sizes), stale: null };
  const found = findRunSize(sizes, chosen);
  return found === null
    ? { size: defaultRunSize(sizes), stale: chosen }
    : { size: found, stale: null };
}

/** The class's fields in `RYPH_RUN_SIZES`' own spelling, for messages an operator reads. */
const SPELLING: Record<Exclude<keyof RunSize, "name">, string> = {
  cpu: "cpu",
  memory: "memory",
  ephemeralStorage: "ephemeral-storage",
  workVolume: "work-volume",
};

/**
 * The fields a class SETS that a backend does not apply, spelled as the operator wrote them —
 * what an adapter says once instead of refusing (see the port's `LaunchSpec.size`).
 */
export function unappliedSizeFields(
  size: RunSize,
  applied: ReadonlyArray<Exclude<keyof RunSize, "name">>,
): string[] {
  return (Object.keys(SPELLING) as Array<Exclude<keyof RunSize, "name">>)
    .filter((field) => size[field] !== null && !applied.includes(field))
    .map((field) => SPELLING[field]);
}

/** Memory in whole mebibytes, rounded up — the unit docker takes. */
export function memoryMebibytes(memory: string): number {
  return Math.ceil(quantityBytes(memory) / 2 ** 20);
}

/**
 * How a pod splits ephemeral storage, which the run provisioner, the check launcher and the
 * reserved-capacity placeholders must all agree on, kept here so none of them imports another.
 *
 * Each service sidecar asks for SERVICE_EPHEMERAL_STORAGE explicitly, because Autopilot injects
 * exactly this into a container that asks for none, and a quantity the admission webhook invents
 * is one nobody can take out of the runner's share. That is how the first sidecar run on GKE was
 * refused: the runner's 10Gi plus an injected 1Gi per service, against a pod cap of 10Gi. A
 * throwaway test database fits in it comfortably.
 */
export const SERVICE_EPHEMERAL_STORAGE = "1Gi";

/** The least ephemeral storage a run's runner keeps once services have taken theirs: the clone,
 * its dependencies and the harness's scratch files all land there. */
export const RUNNER_EPHEMERAL_FLOOR = "1Gi";

/** The least memory, and the least disk, one check gets once its class is split N ways. */
export const CHECK_FLOOR = "512Mi";
