/**
 * The stack manifest: the single source of truth every command is generic over.
 *
 * Invariants:
 * - All paths are absolute, resolved from this file's location; no command computes its own paths.
 * - Ports mirror the in-code defaults of each service (host 7411, forge 7412, vite 5173).
 * - A unit with `envFile` cannot boot properly without that file present: its script loads it
 *   with `--env-file`, which bun skips silently when the file is missing, so `up` checks it
 *   before launching.
 */

export interface Unit {
  name: string;
  /** Human-facing pane title shown on tmux pane borders. */
  title: string;
  /** Absolute package directory the unit's task runs in. */
  cwd: string;
  /** package.json script name; the launch command is always `bun run <task>` in `cwd`. */
  task: string;
  /** TCP readiness probe target on 127.0.0.1, when the unit serves a port. */
  port?: number;
  /** Absolute path of a .env file the unit's task requires to exist. */
  envFile?: string;
}

// decodeURIComponent, not raw .pathname: a checkout path with a space would otherwise keep its
// %20 escapes and every path derived from these two roots would miss on disk.
const dirOf = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname).replace(/\/$/, "");

const cliDir = dirOf("..");
export const repoRoot = dirOf("../../..");
export const logsDir = `${cliDir}/state/logs`;

const pkg = (name: string) => `${repoRoot}/packages/${name}`;

export const units: Unit[] = [
  {
    name: "host",
    title: "🛰️ host",
    cwd: pkg("host"),
    task: "up",
    port: 7411,
    envFile: `${pkg("host")}/.env`,
  },
  {
    name: "forge",
    title: "🔨 forge",
    cwd: pkg("forge"),
    task: "dev",
    port: 7412,
    envFile: `${pkg("forge")}/.env`,
  },
  { name: "app", title: "🎨 app", cwd: pkg("app"), task: "dev", port: 5173 },
];

/** Packages whose .env is scaffolded from .env.example by `init`. */
export const envPackages = [
  "host",
  "app",
  "auth",
  "model-proxy",
  "forge",
  "orchestrator",
  "automations",
].map(pkg);

/** Resolves unit names to manifest entries; no names selects the whole stack. */
export function selectUnits(names: string[]): Unit[] {
  if (names.length === 0) return units;
  return names.map((name) => {
    const unit = units.find((u) => u.name === name);
    if (!unit) {
      const known = units.map((u) => u.name).join(", ");
      throw new Error(`unknown unit "${name}" (known: ${known})`);
    }
    return unit;
  });
}
