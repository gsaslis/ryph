// `ryph config` — what a launch from here would actually resolve to, and which of the three
// layers decided each value.
//
// The layers are the point. Once there is a settings file, "why is it doing that" has three
// possible answers — the environment, the file, the built-in default — and a `cat` of the file
// only answers one of them. A variable exported in a shell profile two years ago outranks
// everything in `~/.ryph/config.env` and leaves no trace in it.
//
// Decisions live here as a pure function over the two maps, so what the command prints is tested
// the same way the status block is.

import { buildsDefault, checksConcurrencyDefault } from "./config_file.ts";
import { redact } from "./setup.ts";

export type Source = "environment" | "settings file" | "default" | "stored" | "unset";

export interface SettingRow {
  key: string;
  value: string;
  source: Source;
}

/**
 * The knobs worth listing when nothing has set them — the ones whose default is itself a
 * decision. Everything else appears only once it has a value, which keeps this a report of the
 * deployment rather than a second copy of `--help`.
 */
const KNOWN: {
  key: string;
  fallback: (
    defaults: Defaults,
    provisioner: string | undefined,
    /** Whether the docker launcher is this process (RYPH_LAUNCHER_URL unset or `embedded`). */
    embeddedLauncher: boolean,
  ) => string;
}[] = [
  { key: "RYPH_DB", fallback: (d) => d.dbUrl },
  { key: "RYPH_APP_PORT", fallback: (d) => String(d.appPort) },
  { key: "RYPH_PORT", fallback: (d) => String(d.apiPort) },
  { key: "RYPH_LOG_LEVEL", fallback: () => "warn" },
  // No default: `up` refuses to start without one, so unset is reported as unset.
  { key: "RYPH_PROVISIONER", fallback: () => "" },
  // Listed unset because its default is the loudest of them all: `proxy` means this deployment
  // claims a boundary, and whether that claim is backed by anything depends on settings that sit
  // in the "extra" rows below. Reporting it only once someone has typed it would hide the claim.
  { key: "RYPH_EGRESS", fallback: () => "proxy" },
  // Listed for the same reason: its default is the home directory, the line around everything
  // local repositories may be added from, and a boundary nobody typed is still a boundary.
  { key: "RYPH_LOCAL_REPO_ROOT", fallback: (d) => d.localRepoRoot ?? "" },
  // On by default under docker only, so the provisioner decides them as much as anything typed.
  { key: "RYPH_ENVIRONMENTS", fallback: (_, provisioner) => buildsDefault(provisioner) },
  { key: "RYPH_CHECKS", fallback: (_, provisioner) => buildsDefault(provisioner) },
  // What keeps local suites from starving each other and the runs beside them.
  {
    key: "RYPH_CHECKS_CONCURRENCY",
    fallback: (_, provisioner) => checksConcurrencyDefault(provisioner) ?? "4",
  },
  { key: "RYPH_CHECKS_CPUS", fallback: (_, p, embedded) => ownLauncherOnly(p, embedded, "auto") },
  { key: "RYPH_CHECKS_MEMORY", fallback: (_, p, embedded) => ownLauncherOnly(p, embedded, "auto") },
];

/** A default only the docker launcher has: unset under any other provisioner, and unset here when
 * the launcher is elsewhere, which keeps its own (and the host refuses it set here). */
const ownLauncherOnly = (provisioner: string | undefined, embedded: boolean, value: string) =>
  provisioner === "docker" && embedded ? value : "";

export interface Defaults {
  dbUrl: string;
  appPort: number;
  apiPort: number;
  /** The root `up` would hand the in-process forge; null when it would hand it none. */
  localRepoRoot: string | null;
}

export interface SettingsInput {
  env: Map<string, string>;
  file: Map<string, string>;
  defaults: Defaults;
  /** Where a stored master key was found, when one was — it is in neither map. */
  storedKeyPath: string | null;
  /** The directory the other two layers live in; null when there is no home at all. */
  home: string | null;
}

export function describeSettings(input: SettingsInput): SettingRow[] {
  const rows: SettingRow[] = [];
  const seen = new Set<string>();

  const row = (key: string, fallback: string): SettingRow => {
    seen.add(key);
    const fromEnv = input.env.get(key);
    if (fromEnv) return { key, value: fromEnv, source: "environment" };
    const fromFile = input.file.get(key);
    if (fromFile) return { key, value: fromFile, source: "settings file" };
    return fallback === ""
      ? { key, value: "—", source: "unset" }
      : { key, value: fallback, source: "default" };
  };

  // First, because it decides where the other two layers even live.
  seen.add("RYPH_HOME");
  rows.push(
    input.home === null ? { key: "RYPH_HOME", value: "—", source: "unset" } : {
      key: "RYPH_HOME",
      value: input.home,
      source: input.env.has("RYPH_HOME") ? "environment" : "default",
    },
  );
  const provisioner = input.env.get("RYPH_PROVISIONER") || input.file.get("RYPH_PROVISIONER") ||
    undefined;
  const launcher = input.env.get("RYPH_LAUNCHER_URL")?.trim() ||
    input.file.get("RYPH_LAUNCHER_URL")?.trim() || "embedded";
  for (const { key, fallback } of KNOWN) {
    rows.push(row(key, fallback(input.defaults, provisioner, launcher === "embedded")));
  }

  // The master key is the one setting whose usual home is neither map: `ryph up` reads it out
  // of ~/.ryph/secrets.key. Reporting it as "unset" because it is not an env var would be the
  // exact lie this command exists to prevent.
  seen.add("RYPH_SECRETS_KEY");
  const keyFromEnv = input.env.get("RYPH_SECRETS_KEY") ?? input.file.get("RYPH_SECRETS_KEY");
  rows.push(
    keyFromEnv
      ? {
        key: "RYPH_SECRETS_KEY",
        value: redact("RYPH_SECRETS_KEY", keyFromEnv),
        source: input.env.has("RYPH_SECRETS_KEY") ? "environment" : "settings file",
      }
      : input.storedKeyPath !== null
      ? { key: "RYPH_SECRETS_KEY", value: input.storedKeyPath, source: "stored" }
      : { key: "RYPH_SECRETS_KEY", value: "—", source: "unset" },
  );

  // Everything else that has a value, from either layer: image mappings, a forge, a git
  // credential, and any knob the host takes that this file has never heard of.
  const extra = [...new Set([...input.file.keys(), ...input.env.keys()])]
    .filter((key) => key.startsWith("RYPH_") && !seen.has(key) && key !== "RYPH_HOME")
    .sort();
  for (const key of extra) {
    const found = row(key, "");
    rows.push({ ...found, value: redact(key, found.value) });
  }

  return rows;
}

export function printSettings(
  say: (text?: string) => void,
  rows: SettingRow[],
  configPath: string | null,
): void {
  // Rows arrive already redacted — `describeSettings` is the only place that decides what a
  // secret looks like, so a caller that prints rows some other way cannot leak one.
  const width = Math.max(...rows.map((r) => r.key.length));
  // Capped: one long database path should not push the source column off the right of a terminal
  // for every other row. A value past the cap loses its alignment and nothing else.
  const valueWidth = Math.min(44, Math.max(...rows.map((r) => r.value.length)));
  say();
  for (const r of rows) {
    say(`  ${r.key.padEnd(width)}  ${r.value.padEnd(valueWidth)}  ${r.source}`);
  }
  say();
  say(
    configPath === null
      ? "  No home directory, so there is no settings file — the environment is all of it."
      : `  Settings file: ${configPath}   (\`ryph setup\` asks the questions again)`,
  );
  say();
}
