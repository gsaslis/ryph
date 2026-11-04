// The settings file — `~/.ryph/config.env`, written by `ryph setup` and safe to edit by hand.
//
// WHY A FILE AT ALL. Everything here was environment-only, which is exactly right for a container
// and wrong for a binary somebody downloads. A setting you have to re-export in every shell is
// not a setting, it is an argument — so `RYPH_PROVISIONER=docker ryph up` was the whole
// configuration story, and forgetting the prefix once gave you a deployment that started fine and
// then silently ran nothing.
//
// WHY ENV VARS AS THE VOCABULARY, rather than a config schema in JSON or TOML. The deployment
// already has one, and it is documented in three places — `ryph --help`, the host's README, and
// compose.yaml. A second vocabulary would need a mapping between the two, and a mapping between
// two config languages is a thing that drifts. `RYPH_PROVISIONER=docker` means the same thing
// in this file, in a shell, and in a compose service, because it IS the same thing.
//
// PRECEDENCE: the real environment wins, then this file, then the built-in default. A scripted or
// containerised launch is therefore never surprised by what is in somebody's home directory, and
// `RYPH_DB=… ryph up` still means what it says.
//
// ONLY `RYPH_*` KEYS ARE APPLIED. This file lives in a home directory and is meant to be edited
// by hand; it has no business setting PATH. Anything else in it is ignored, and `ryph config`
// says which lines were skipped rather than dropping them silently.

import { mkdir, readFile, stat } from "node:fs/promises";
import { writeSecretFile } from "@ryph/service";
import { dirname, join, resolve } from "@std/path";

/** Keys are validated against this before they are matched, written, or applied. */
const KEY = /^[A-Z][A-Z0-9_]*$/;

/**
 * Everything this deployment keeps on disk, in one directory: the database, the master key, and
 * this file. `RYPH_HOME` moves all three together, which is what makes a second instance (or a
 * test) a single variable rather than three that have to agree.
 *
 * Read from the real environment only, and ignored if it appears in the config file: the file's
 * own location depends on it, so a value inside it could not take effect without the file having
 * already been found somewhere else.
 *
 * Null when there is no home directory at all — a stripped environment, a container with no HOME.
 * Callers fall back to something relative rather than failing; somewhere to write beats nowhere.
 */
export function ryphHome(): string | null {
  const explicit = process.env.RYPH_HOME;
  if (explicit) return explicit;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home ? join(home, ".ryph") : null;
}

/**
 * Where the control plane's local files go when nothing says: `~/.ryph/files`, for both a run's
 * images (`attachments/…`) and environment build logs (`environments/…`) — one root, as in a
 * checkout, since their keys never collide — `~/.ryph/forge` for the in-process forge's repo
 * cache and patch bundles, which wipes its own staging directory on boot and so gets a root of
 * its own, `~/.ryph/radicle` for the in-process Radicle bridge's working files, and
 * `~/.ryph/env-cache` and `~/.ryph/tmp` for environment builds' layer cache and the GBs of clones
 * and image exports a build writes while it runs (a container's /tmp is often RAM). NOT under
 * `~/.ryph/data`: that directory is PGlite's, and a restore replaces it whole. Absolute, for
 * resolveDbUrl's reason. No home: the host's own `./data` default stands.
 */
export function defaultFileDirs(home: string | null = ryphHome()): Record<string, string> {
  if (home === null) return {};
  const files = resolve(join(home, "files"));
  return {
    RYPH_ATTACHMENT_DIR: files,
    RYPH_ENV_LOG_DIR: files,
    RYPH_FORGE_DATA: resolve(join(home, "forge")),
    // The in-process Radicle bridge's scratch repositories and clone mirrors — never inside
    // `~/.radicle`, which is the person's own (RYPH_RADICLE_URL=embedded).
    RYPH_RADICLE_DATA: resolve(join(home, "radicle")),
    RYPH_ENV_CACHE_DIR: resolve(join(home, "env-cache")),
    RYPH_ENV_TEMP_DIR: resolve(join(home, "tmp")),
  };
}

/**
 * The file dirs that are the docker launcher's own: a build's layer cache and temp space live
 * where the builder runs. An embedded launcher is this process, so they default here as the rest
 * do; a launcher elsewhere (RYPH_LAUNCHER_URL) keeps its own, and the host refuses to boot with
 * either set beside one (LAUNCHER_OWNED_SETTINGS), so they must not be defaulted then.
 */
const LAUNCHER_FILE_DIRS = new Set(["RYPH_ENV_CACHE_DIR", "RYPH_ENV_TEMP_DIR"]);

/**
 * `defaultFileDirs` written into `env` wherever a name is unset, as `up` does before the host
 * reads the environment — but the launcher's own dirs only while the launcher is embedded
 * (RYPH_LAUNCHER_URL unset or `embedded`).
 */
export function applyFileDirDefaults(
  env: Record<string, string | undefined>,
  home: string | null = ryphHome(),
): void {
  const launcher = env.RYPH_LAUNCHER_URL?.trim() || "embedded";
  for (const [name, dir] of Object.entries(defaultFileDirs(home))) {
    if (launcher !== "embedded" && LAUNCHER_FILE_DIRS.has(name)) continue;
    if (!env[name]) env[name] = dir;
  }
}

/**
 * `RYPH_ENVIRONMENTS` and `RYPH_CHECKS` when unset: on where runs launch on docker, which builds
 * with no registry and no further settings, and off elsewhere, where a build needs more.
 */
export function buildsDefault(provisioner: string | undefined): "on" | "off" {
  return provisioner === "docker" ? "on" : "off";
}

/**
 * `RYPH_CHECKS_CONCURRENCY` when unset under docker: two check pods at once, not the deployment
 * default of four. A laptop is one daemon shared with every run, and four pods of parallel test
 * checks starve each other into timeouts (each check container's `auto` cap is already half the
 * daemon). A suite's shared pod and each `pod: own` check take one, so a file needing more fails
 * here, and the repos view flags it. Unset elsewhere: the host's default holds.
 */
export function checksConcurrencyDefault(provisioner: string | undefined): string | undefined {
  return provisioner === "docker" ? "2" : undefined;
}

/**
 * The opt-in that lets `ryph up` boot on the `manual` provisioner. Developing ryph only: the
 * playground sets it, since its scripted runner plays every run by hand. Nothing `ryph setup` writes
 * ever names it.
 */
export const MANUAL_OPT_IN = "RYPH_ALLOW_MANUAL_PROVISIONER";

/**
 * Why `ryph up` must not boot on this environment's provisioner, or null when it may.
 *
 * `manual` launches nothing: every run is "launched" into a log line and then sits until the
 * reaper marks it lost. That is a tool for developing ryph, never a state an install should reach
 * by leaving the setting out or by a wizard turning the runner off, so unset is refused outright
 * and `manual` only boots with MANUAL_OPT_IN. Anything else is the host's to judge, which refuses
 * a provisioner it does not know.
 */
export function provisionerRefusal(env: Record<string, string | undefined>): string | null {
  const kind = env.RYPH_PROVISIONER?.trim();
  if (!kind) {
    return "no agent runner is configured (RYPH_PROVISIONER is unset), so no run could start. " +
      "Run `ryph setup` (`ryph setup --yes` with no terminal), or set RYPH_PROVISIONER=docker.";
  }
  if (kind === "manual" && env[MANUAL_OPT_IN]?.trim() !== "1") {
    return "RYPH_PROVISIONER=manual launches nothing, so every run would sit until it is " +
      "marked lost. Run `ryph setup` to run agents in docker, or set RYPH_PROVISIONER=docker. " +
      `(manual is for developing ryph: ${MANUAL_OPT_IN}=1 allows it.)`;
  }
  return null;
}

/**
 * Where local repositories may be added from when nothing says: the user's home directory, the
 * line between "what this deployment may read" and the rest of the disk that fits a laptop.
 * Not a file dir, so not in `defaultFileDirs`: nothing is written there, and it follows HOME
 * rather than RYPH_HOME, since moving ryph's own files somewhere else does not move your code.
 * Null when there is no home directory, and then no local repository can be added.
 */
export function defaultLocalRepoRoot(): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home ? resolve(home) : null;
}

/** Where the settings file lives, or null when there is no home to put it in. */
export function configPath(): string | null {
  const home = ryphHome();
  return home === null ? null : join(home, "config.env");
}

export interface ParsedConfig {
  values: Map<string, string>;
  /** Lines that looked like assignments but were not `RYPH_*`, named so `config` can say so. */
  ignored: string[];
}

/**
 * `KEY=value`, `#` comments, blank lines. Deliberately not a shell parser: no interpolation, no
 * line continuations, no `export`. A value is the rest of the line, trimmed, with one layer of
 * matching quotes removed — which is enough for a path with spaces and stops well short of
 * pretending the file is a script.
 */
export function parseConfig(text: string): ParsedConfig {
  const values = new Map<string, string>();
  const ignored: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    if (!key.startsWith("RYPH_") || key === "RYPH_HOME") {
      ignored.push(key);
      continue;
    }
    values.set(key, unquote(line.slice(eq + 1).trim()));
  }
  return { values, ignored };
}

function unquote(value: string): string {
  const quoted = (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted && value.length >= 2 ? value.slice(1, -1) : value;
}

/** The file's contents, or an empty result when there is no file (which is not an error). */
export async function readConfig(): Promise<ParsedConfig> {
  const path = configPath();
  if (path === null) return { values: new Map(), ignored: [] };
  try {
    return parseConfig(await readFile(path, "utf8"));
  } catch (err) {
    if (((err as NodeJS.ErrnoException)?.code === "ENOENT")) {
      return { values: new Map(), ignored: [] };
    }
    throw err;
  }
}

/**
 * Applies the file to this process's environment, without overriding anything already set.
 * Returns the keys it actually applied — the ones the file, and not the environment, decided.
 */
export async function loadConfigIntoEnv(): Promise<string[]> {
  const { values } = await readConfig();
  const applied: string[] = [];
  for (const [key, value] of values) {
    if (process.env[key]) continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

export async function configExists(): Promise<boolean> {
  const path = configPath();
  if (path === null) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const HEADER = `# ryph settings — written by \`ryph setup\`, and safe to edit by hand.
#
# These are the same RYPH_* variables \`ryph --help\` documents. A variable already set in the
# environment beats anything in here, so a scripted launch is never surprised by this file.
#
# Run \`ryph setup\` to go through the questions again, or \`ryph config\` to see what a launch
# from here would actually resolve to.
`;

/**
 * Writes settings into the file, in place: a key that is already there — commented out or not —
 * is replaced where it stands, so a value lands under the heading that explains it rather than
 * orphaned at the end. A key mapped to null is removed.
 *
 * In place, and not a regenerated file, because the whole design says this is yours to edit: a
 * `ryph setup` re-run that discarded the three lines and a comment you added by hand would make
 * the invitation a lie.
 *
 * Mode 0600 — it can carry a git token, and on a `postgres://` deployment the master key too.
 */
export async function updateConfig(updates: Map<string, string | null>): Promise<string> {
  const path = configPath();
  if (path === null) {
    throw new Error(
      "no home directory to write settings into — set RYPH_HOME, or configure with RYPH_* " +
        "environment variables",
    );
  }
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if (!((err as NodeJS.ErrnoException)?.code === "ENOENT")) throw err;
    existing = HEADER;
  }

  const lines = existing.split("\n");
  for (const [key, value] of updates) {
    if (!KEY.test(key) || !key.startsWith("RYPH_")) {
      throw new Error(`refusing to write ${JSON.stringify(key)} — settings are RYPH_* only`);
    }
    const at = lines.findIndex((line) => new RegExp(`^\\s*#?\\s*${key}=`).test(line));
    if (value === null) {
      if (at >= 0) lines.splice(at, 1);
      continue;
    }
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }

  // One trailing newline, however the file arrived.
  const text = `${lines.join("\n").replace(/\n+$/, "")}\n`;
  await mkdir(dirname(path), { recursive: true });
  // It can hold a GitHub token: owner-only from its first byte.
  await writeSecretFile(path, text);
  return path;
}
