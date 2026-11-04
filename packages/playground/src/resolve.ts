/**
 * Turning a request (`--preset ui --with history=30 --without automations`) into the ordered list
 * of fixtures to apply. Pure, so it is tested without a host.
 */

export interface FixtureInfo {
  name: string;
  summary: string;
  /** Fixtures this one builds on; requesting it brings them in. */
  needs: string[];
  /** `seed` writes once into the database; `live` runs on every start of the playground. */
  phase: "seed" | "live";
  /** The one number a fixture takes, `name=N` on the command line. */
  param?: { what: string; default: number };
}

export interface Resolved {
  name: string;
  param: number | null;
}

const UI_FIXTURES = [
  "owner",
  "team",
  "model",
  "repos",
  "workspace",
  "agents",
  "platform-notices",
  "chat",
  "automations",
  "memory",
  "tools",
  "gitlab",
  "live",
  "waiting",
];

export const PRESETS: Record<string, { summary: string; fixtures: string[] }> = {
  empty: {
    summary: "a fresh instance with no account yet (the sign-up flow)",
    fixtures: [],
  },
  minimal: {
    summary: "an owner, a model, the repos and the agents; no history",
    fixtures: ["owner", "model", "repos", "agents"],
  },
  ui: {
    summary:
      "a team, three representative finished runs, a platform-notice catalogue, live and waiting runs",
    fixtures: [...UI_FIXTURES, "history=3"],
  },
  full: {
    summary: "everything: a team, history in every state, live and waiting runs",
    fixtures: [...UI_FIXTURES, "history"],
  },
};

/** Parses `name` or `name=N`. */
export function parseItem(item: string): { name: string; param: number | null } {
  const [name, raw] = item.split("=", 2);
  if (raw === undefined) return { name: name.trim(), param: null };
  const param = Number(raw);
  if (!Number.isInteger(param) || param < 0) throw new Error(`${item}: expected a whole number`);
  return { name: name.trim(), param };
}

/**
 * The fixtures to apply, each after everything it needs, in the registry's order. `without`
 * wins over `with` and the preset, and refuses to remove something another fixture needs.
 */
export function resolve(
  registry: FixtureInfo[],
  preset: string,
  withItems: string[],
  without: string[],
): Resolved[] {
  const byName = new Map(registry.map((f) => [f.name, f]));
  const known = (name: string) => {
    if (!byName.has(name)) {
      throw new Error(`no fixture named ${name}; one of ${[...byName.keys()].join(", ")}`);
    }
    return name;
  };
  const base = PRESETS[preset];
  if (!base) {
    throw new Error(`no preset named ${preset}; one of ${Object.keys(PRESETS).join(", ")}`);
  }

  const params = new Map<string, number | null>();
  for (const item of base.fixtures) {
    const { name, param } = parseItem(item);
    params.set(known(name), param);
  }
  for (const item of withItems) {
    const { name, param } = parseItem(item);
    params.set(known(name), param);
  }
  const dropped = new Set(without.map(known));
  for (const name of dropped) params.delete(name);

  // Close over `needs`, refusing to bring back what was asked away.
  const wanted = new Set<string>();
  const visit = (name: string, chain: string[]) => {
    if (wanted.has(name)) return;
    if (chain.includes(name)) {
      throw new Error(`fixtures need each other: ${[...chain, name].join(" → ")}`);
    }
    if (dropped.has(name)) {
      throw new Error(`${chain.at(-1)} needs ${name}, which --without removes`);
    }
    for (const need of byName.get(name)!.needs) visit(known(need), [...chain, name]);
    wanted.add(name);
  };
  for (const name of params.keys()) visit(name, []);

  return registry
    .filter((f) => wanted.has(f.name))
    .map((f) => {
      const param = params.get(f.name) ?? null;
      if (param !== null && !f.param) throw new Error(`${f.name} takes no number`);
      return { name: f.name, param: param ?? f.param?.default ?? null };
    });
}

/** A stable description of a resolved set: a playground built for it can be reused for it. */
export function fingerprint(resolved: Resolved[], registry: FixtureInfo[]): string {
  const phase = new Map(registry.map((f) => [f.name, f.phase]));
  return resolved
    .filter((r) => phase.get(r.name) === "seed")
    .map((r) => (r.param === null ? r.name : `${r.name}=${r.param}`))
    .join(",");
}
