// The files a compiled `ryph` reads as files rather than importing: the built UI, the schema
// migrations, the catalogues and skills, and the two workers. A `bun build --compile` binary
// carries modules, not directory trees, and every bundled module's `import.meta.url` is the
// binary's own, so `new URL("../../../skills", import.meta.url)` would point nowhere. So the
// build (scripts/compile.ts) packs those files into one archive embedded in the binary, and
// rewrites each workspace module's `import.meta.url` to where that module sits in the archive's
// tree, which mirrors the repository. At startup the archive is unpacked once into
// `~/.ryph/runtime/<id>` and every one of those URLs resolves there, from the same code that
// resolves them in a source checkout.
//
// What the binary runs from there is checked against the digests in its own archive at every
// boot, not just at unpacking: the workers, the UI's server and the confined sanitizer's modules
// are code, and whoever changed them would run it in the process holding the master key. A copy
// that does not match is unpacked again. The copy is read-only (files 0444, directories 0555),
// and the directory above it must be this user's own, not a link, and writable by nobody else.
//
// Runtime-neutral (node:* only), and imported by nothing in a source run: the build injects it.

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const MAGIC = "RYPHRES1";
const COMPLETE = ".complete";

/** One packed file: its repository-relative path (forward slashes), size and digest. */
export interface ResourceEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface ResourceHeader {
  /** The digest of every entry, so a binary with other contents unpacks into another directory. */
  id: string;
  files: ResourceEntry[];
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The archive: MAGIC, a big-endian u32 header length, the header as JSON, then every file's bytes
 * in header order, gzipped as one. The header stays uncompressed so a boot that finds the
 * directory already unpacked inflates nothing.
 */
export function packResources(files: { path: string; bytes: Uint8Array }[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    if (!safeRelative(file.path)) throw new Error(`not a relative path: ${file.path}`);
  }
  const entries = sorted.map((f) => ({
    path: f.path,
    size: f.bytes.length,
    sha256: sha256(f.bytes),
  }));
  const id = sha256(new TextEncoder().encode(JSON.stringify(entries))).slice(0, 16);
  const header = new TextEncoder().encode(JSON.stringify({ id, files: entries }));
  const body = gzipSync(Buffer.concat(sorted.map((f) => f.bytes)), { level: 9 });
  const out = new Uint8Array(MAGIC.length + 4 + header.length + body.length);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(MAGIC.length, header.length);
  out.set(header, MAGIC.length + 4);
  out.set(body, MAGIC.length + 4 + header.length);
  return out;
}

/** A path that stays inside the directory it is joined to. */
function safeRelative(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Read whole: the binary's embedded files open for reading only that way (Bun 1.4.2). */
function readArchive(archivePath: string): { header: ResourceHeader; body: Uint8Array } {
  const bytes = readFileSync(archivePath);
  if (new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new Error(`${archivePath} is not a ryph resource archive`);
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(MAGIC.length);
  const headerAt = MAGIC.length + 4;
  return {
    header: JSON.parse(
      new TextDecoder().decode(bytes.subarray(headerAt, headerAt + length)),
    ) as ResourceHeader,
    body: bytes.subarray(headerAt + length),
  };
}

/** Whether `dir` holds every file of `header` with its digest, unpacked to the end. */
function unpacked(dir: string, header: ResourceHeader): boolean {
  try {
    if (readFileSync(join(dir, COMPLETE), "utf8") !== header.id) return false;
    return header.files.every((f) => {
      const path = join(dir, f.path);
      return statSync(path).size === f.size && sha256(readFileSync(path)) === f.sha256;
    });
  } catch {
    return false;
  }
}

/** Makes `dir` and everything under it read-only: files 0444, directories 0555. */
function seal(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) chmodSync(path, 0o555);
    else if (entry.isFile()) chmodSync(path, 0o444);
  }
  chmodSync(dir, 0o555);
}

/** Removes `path` and everything under it, read-only directories (`seal`) included. */
export function removeTree(path: string): void {
  try {
    if (!lstatSync(path).isDirectory()) return rmSync(path, { force: true });
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true, recursive: true })) {
      if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o700);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
  rmSync(path, { recursive: true, force: true });
}

/** The runtime directory is one this binary may not unpack into; the message says the fix. */
export class RuntimeBaseError extends Error {}

/** Throws unless `base` is a directory (not a link) of this user's that nobody else can write. */
function assertOwnBase(base: string): void {
  const info = lstatSync(base);
  if (!info.isDirectory()) {
    throw new RuntimeBaseError(
      `${base} is not a directory (a link is refused); remove it, or set RYPH_HOME elsewhere`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new RuntimeBaseError(
      `${base} belongs to uid ${info.uid}, not this user (${uid}); set RYPH_HOME elsewhere`,
    );
  }
  if (uid !== undefined && (info.mode & 0o022) !== 0) {
    throw new RuntimeBaseError(
      `${base} is writable by others (mode ${(info.mode & 0o777).toString(8)}); ` +
        `run chmod g-w,o-w ${base}`,
    );
  }
}

/**
 * The subcommand that makes the binary the artifact sanitizer (@ryph/orchestrator's
 * ARTIFACT_SANITIZER_SUBCOMMAND; tests/resources_test.ts holds them equal). Named here because the
 * build's resources module decides how to find its files before anything else is loaded.
 */
export const SANITIZER_SUBCOMMAND = "__artifact-sanitizer";

/**
 * The runtime directory the binary reads its files from, for its boot. The CLI unpacks into
 * `runtimeBase(env)` (`unpackResources`). The artifact sanitizer runs with an empty environment, so
 * it must not derive a base of its own (that would be the account's, whatever RYPH_HOME or HOME
 * its parent ran under); its parent names the directory it unpacked, as the argument after the
 * subcommand, and the sanitizer only checks that copy (`openUnpacked`): it never unpacks or
 * prunes anything. A refused directory ends the process with one line and exit 1, not a stack
 * trace from module evaluation (a RYPH_HOME on a share under umask 002 comes out group-writable).
 */
export function resourcesRootOrExit(
  archivePath: string,
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): string {
  try {
    if (argv[0] === SANITIZER_SUBCOMMAND) return openUnpacked(archivePath, argv[1] ?? "");
    return unpackResources(archivePath, runtimeBase(env));
  } catch (err) {
    if (!(err instanceof RuntimeBaseError)) throw err;
    console.error(`ryph: ${err.message}`);
    process.exit(1);
  }
}

/**
 * The global the build's resources module sets to the runtime directory it resolved, which the
 * control plane passes to the sanitizer it starts as this binary (`resourcesRootOrExit`).
 */
export const RUNTIME_ROOT_GLOBAL = "ryph.runtimeRoot";

/**
 * `root`, a complete copy of this archive unpacked by another process, checked as a boot checks
 * its own: `<base>/<id>` for this archive's id, under a base of this user's, every file matching
 * its digest. Throws a RuntimeBaseError otherwise; it never writes.
 */
export function openUnpacked(archivePath: string, root: string): string {
  const { header } = readArchive(archivePath);
  if (root === "" || !root.startsWith("/") || basename(root) !== header.id) {
    throw new RuntimeBaseError(`not this build's runtime directory: ${JSON.stringify(root)}`);
  }
  assertOwnBase(dirname(root));
  if (!unpacked(root, header)) {
    throw new RuntimeBaseError(`${root} is not a complete copy of this build's files`);
  }
  return realpathSync(root);
}

/** Where live processes say which copy they use: `<base>/.in-use/<id>.<pid>.<token>`. */
const IN_USE = ".in-use";

/** The registrations this process made, by `<base>/<id>`, removed again at exit. */
const registered = new Map<string, string>();

/** Whether `pid` is a live process. Errs on alive: a kept directory is the cheap mistake. */
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/**
 * Says this process uses `<base>/<id>` until it exits, before it checks or unpacks the copy, so
 * another build's boot (`prune`) leaves the copy alone. A registration whose process has died is
 * removed by the next prune. A reused pid only keeps a directory longer, never removes one.
 */
function registerUse(base: string, id: string): void {
  const key = join(base, id);
  if (registered.has(key)) return;
  const dir = join(base, IN_USE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertOwnBase(dir);
  const path = join(dir, `${id}.${process.pid}.${crypto.randomUUID()}`);
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  if (registered.size === 0) {
    process.on("exit", () => {
      for (const file of registered.values()) rmSync(file, { force: true });
    });
  }
  registered.set(key, path);
}

/** The ids a live process has registered under `base`; dead processes' registrations go. */
function idsInUse(base: string): Set<string> {
  const ids = new Set<string>();
  const dir = join(base, IN_USE);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return ids;
  }
  for (const entry of entries) {
    const match = /^([0-9a-f]{16})\.(\d+)\.[0-9a-f-]+$/.exec(entry);
    if (match === null) continue;
    if (alive(Number(match[2]))) ids.add(match[1]);
    else rmSync(join(dir, entry), { force: true });
  }
  return ids;
}

/**
 * Removes what other builds left under `base`: their copies no live process has registered, and
 * staging or retired directories (`.<id>.<pid>.<token>`) whose process is gone. Never this
 * build's own copy, which another ryph starting beside this one may be unpacking right now.
 */
function prune(base: string, id: string): void {
  const inUse = idsInUse(base);
  for (const entry of readdirSync(base)) {
    const copy = /^([0-9a-f]{16})$/.exec(entry);
    if (copy !== null) {
      if (copy[1] !== id && !inUse.has(copy[1])) retire(base, copy[1]);
      continue;
    }
    const scratch = /^\.[0-9a-f]{16}\.(\d+)\./.exec(entry);
    if (scratch !== null && !alive(Number(scratch[1]))) removeTree(join(base, entry));
  }
}

/**
 * Removes another build's copy: renamed aside first, then the registrations read again, and put
 * back if a process registered it in between (it registers before it looks for the copy, so one
 * that registered later finds it missing and unpacks it again).
 */
function retire(base: string, other: string): void {
  const dir = join(base, other);
  const aside = join(base, `.${other}.${process.pid}.${crypto.randomUUID()}`);
  try {
    renameSync(dir, aside);
  } catch {
    return; // Gone already, or another boot is retiring it.
  }
  if (idsInUse(base).has(other)) {
    try {
      renameSync(aside, dir);
    } catch {
      // Unpacked again meanwhile; the copy set aside is surplus.
    }
  }
  removeTree(aside);
}

/**
 * The directory the archive at `archivePath` is unpacked in, under `base`: `<base>/<id>`, unpacked
 * now unless a complete copy is already there. Unpacked beside it first and renamed into place, so
 * a boot that dies halfway leaves no directory that reads as complete; every file is checked
 * against its digest on the way out. This process registers the copy as in use until it exits,
 * and every boot removes the copies of other builds that no live process uses.
 */
export function unpackResources(archivePath: string, base: string): string {
  const { header, body: packed } = readArchive(archivePath);
  const dir = join(base, header.id);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  assertOwnBase(base);
  registerUse(base, header.id);
  if (!unpacked(dir, header)) {
    const staging = join(base, `.${header.id}.${process.pid}.${crypto.randomUUID()}`);
    try {
      const body = gunzipSync(packed);
      let at = 0;
      for (const file of header.files) {
        if (!safeRelative(file.path)) throw new Error(`not a relative path: ${file.path}`);
        const bytes = body.subarray(at, at + file.size);
        at += file.size;
        if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
          throw new Error(`the binary's copy of ${file.path} is damaged`);
        }
        const target = join(staging, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { mode: 0o644 });
      }
      writeFileSync(join(staging, COMPLETE), header.id);
      seal(staging);
      removeTree(dir);
      try {
        renameSync(staging, dir);
      } catch (err) {
        // Another ryph starting at the same moment got there first.
        if (!unpacked(dir, header)) throw err;
      }
    } finally {
      removeTree(staging);
    }
  }
  prune(base, header.id);
  // Its real path: node, confining the artifact sanitizer to files in here, resolves every
  // directory above the module it runs (a symlinked HOME's included) unless named by real path.
  return realpathSync(dir);
}

/**
 * Where the runtime copies live: `$RYPH_HOME/runtime`, `~/.ryph/runtime`, or, with neither set,
 * the temp dir, never the account's home found some other way: a process started with a stripped
 * environment must not reach a home its parent did not run under. The temp dir is shared:
 * `unpackResources` refuses one there that another user made first.
 */
export function runtimeBase(env: Record<string, string | undefined> = process.env): string {
  if (env.RYPH_HOME) return join(env.RYPH_HOME, "runtime");
  const home = env.HOME ?? env.USERPROFILE;
  if (home) return join(home, ".ryph", "runtime");
  return join(tmpdir(), `ryph-runtime-${process.getuid?.() ?? "user"}`);
}

/** `rel` (a repository-relative path) as a file: URL inside `root`, refusing a path that leaves it. */
export function fileUrlIn(root: string, rel: string): string {
  const path = resolve(root, rel);
  const inside = relative(root, path);
  if (inside.startsWith("..") || inside.split(sep).includes("..")) {
    throw new Error(`${rel} is outside the unpacked resources`);
  }
  return pathToFileURL(path).href;
}
