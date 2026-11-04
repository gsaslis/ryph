// The fixtures every hermetic test shares: a throwaway RAD_HOME with a real key in it, a real
// repository initialized with the real `rad`, and the offline plumbing that moves refs between
// two such homes without a network.
//
// Three rules, and the first one is not negotiable:
//
// 1. NEVER TOUCH THE DEVELOPER'S ~/.radicle. Every home here is a fresh temp directory, every
//    command carries RAD_HOME explicitly, and RAD_SOCKET is /dev/null unless a test deliberately
//    points it at a fake node. `rad` will happily sign with your real key if you let it.
// 2. REAL BINARIES OR NOTHING. These tests spawn the actual `rad` that ships to production;
//    a mock of the CLI would test our idea of it, which is exactly the thing that has been
//    wrong every time. CI without the binaries SKIPS with a message rather than failing.
// 3. OFFLINE. heartwood's own goldens run fully offline with RAD_SOCKET=/dev/null, and so do
//    these: two peers exchange refs by `git fetch` between their storage repositories, which is
//    byte-for-byte what a node fetch would have written.

import { statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";
import { cliRadExec } from "../src/adapters/rad/cli.ts";
import type { RadExec } from "../src/ports/rad.ts";

/** Where `rad`, `radicle-node` and `git-remote-rad` live, or null if they are not installed. */
export function radBinDir(): string | null {
  const configured = process.env.RYPH_RADICLE_BIN_DIR;
  if (configured && existsSync(`${configured}/rad`)) return configured;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir !== "" && existsSync(`${dir}/rad`)) return dir;
  }
  const home = process.env.HOME;
  if (home && existsSync(`${home}/.radicle/bin/rad`)) return `${home}/.radicle/bin`;
  return null;
}

function existsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const BIN_DIR = radBinDir();

/**
 * Whether a test that needs the real CLI can run. Used with `test.skipIf` so the suite SKIPS,
 * loudly, on a machine (or a CI job) with no Radicle installed rather than failing something
 * nobody broke.
 */
export const RAD_MISSING = BIN_DIR === null;
export const RAD_SKIP_REASON =
  "the `rad` binary is not on PATH or RYPH_RADICLE_BIN_DIR — install radicle to run this";

if (RAD_MISSING) {
  console.error(`\n  SKIPPING the Radicle integration tests: ${RAD_SKIP_REASON}\n`);
}

export interface Peer {
  alias: string;
  home: string;
  exec: RadExec;
  did: string;
  nid: string;
  /** Deletes the home. Registered on the test's `t` by `makePeer`. */
  dispose(): Promise<void>;
}

const decoder = new TextDecoder();

/** A raw command run, for the few setup steps that predate having a `RadExec`. */
async function run(
  bin: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await command(bin, {
    args,
    cwd,
    clearEnv: true,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: `${BIN_DIR}:${process.env.PATH ?? ""}`,
    HOME: home,
    RAD_HOME: home,
    RAD_PASSPHRASE: "",
    RAD_SOCKET: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@localhost",
    // No GIT_AUTHOR_DATE / GIT_COMMITTER_DATE here, however tempting a fixed clock is: rad
    // 1.10.2 PANICS on an ISO-8601 value ("Invalid timestamp value … for `GIT_COMMITTER_DATE`",
    // radicle-cob/src/backend/git/change.rs:321) the moment it writes a COB. Found the hard way.
  };
}

/** A fresh identity in a fresh home. `socket` defaults to /dev/null — no node is contacted. */
export async function makePeer(alias: string, socket = "/dev/null"): Promise<Peer> {
  const home = await mkdtemp(join(tmpdir(), `ryph-rad-${alias}-`));
  const auth = await run(`${BIN_DIR}/rad`, ["auth", "--alias", alias], gitEnv(home));
  if (auth.code !== 0) {
    throw new Error(`rad auth failed for ${alias}: ${auth.stderr}${auth.stdout}`);
  }
  const exec = cliRadExec({ home, passphrase: "", binDir: BIN_DIR, socket });
  const did = (await exec.rad(["self", "--did"])).stdout.trim();
  return {
    alias,
    home,
    exec,
    did,
    nid: did.slice("did:key:".length),
    dispose: () => rm(home, { recursive: true }).catch(() => {}).then(() => {}),
  };
}

export interface TestRepo {
  rid: string;
  /** The working checkout `rad init` was run in. */
  workDir: string;
  /** The default branch's head after the initial commit. */
  head: string;
  defaultBranch: string;
}

/** A git repository with one commit, initialized as a Radicle repository owned by `peer`. */
export async function initRepo(
  peer: Peer,
  opts: {
    name?: string;
    description?: string;
    branch?: string;
    /** Extra files in the initial commit, by path — `.ryph/services.yml` and the like. */
    files?: Record<string, string>;
  } = {},
): Promise<TestRepo> {
  const name = opts.name ?? "proj";
  const branch = opts.branch ?? "main";
  const workDir = await mkdtemp(join(tmpdir(), `ryph-rad-work-${name}-`));
  const env = gitEnv(peer.home);
  await run("git", ["init", "--quiet", "-b", branch, "."], env, workDir);
  await writeFile(`${workDir}/README.md`, "hello\n");
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    const cut = path.lastIndexOf("/");
    if (cut > 0) await mkdir(`${workDir}/${path.slice(0, cut)}`, { recursive: true });
    await writeFile(`${workDir}/${path}`, content);
  }
  await run("git", ["add", "-A"], env, workDir);
  await run("git", ["commit", "--quiet", "-m", "initial"], env, workDir);
  const init = await run(
    `${BIN_DIR}/rad`,
    [
      "init",
      "--name",
      name,
      "--description",
      opts.description ?? "a test repository",
      "--default-branch",
      branch,
      "--public",
      "--no-confirm",
    ],
    env,
    workDir,
  );
  if (init.code !== 0) throw new Error(`rad init failed: ${init.stderr}${init.stdout}`);
  const rid = (await run(`${BIN_DIR}/rad`, ["inspect", "--rid"], env, workDir)).stdout.trim();
  const head = (await run("git", ["rev-parse", "HEAD"], env, workDir)).stdout.trim();
  return { rid, workDir, head, defaultBranch: branch };
}

/** Adds a commit to `workDir` and answers its sha. */
export async function commit(
  peer: Peer,
  workDir: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  const env = gitEnv(peer.home);
  await writeFile(`${workDir}/${file}`, content);
  await run("git", ["add", "-A"], env, workDir);
  const committed = await run("git", ["commit", "--quiet", "-m", message], env, workDir);
  if (committed.code !== 0) throw new Error(`git commit failed: ${committed.stderr}`);
  return (await run("git", ["rev-parse", "HEAD"], env, workDir)).stdout.trim();
}

/**
 * A bundle of `base..head`, carrying ONE named ref — exactly the shape a run emits.
 *
 * The ref name matters: `git bundle create <file> <base>..<sha>` refuses with "Refusing to
 * create empty bundle", because a bundle records REFS and a raw sha is not one. The tip has to
 * be a reference, so a throwaway branch is pointed at `head` first.
 */
export async function makeBundle(
  peer: Peer,
  workDir: string,
  base: string,
  head: string,
  path: string,
  branch = "ryph/out",
): Promise<void> {
  const env = gitEnv(peer.home);
  const marked = await run("git", ["branch", "--force", branch, head], env, workDir);
  if (marked.code !== 0) throw new Error(`git branch failed: ${marked.stderr}`);
  const out = await run(
    "git",
    [
      "bundle",
      "create",
      path,
      `${base}..refs/heads/${branch}`,
    ],
    env,
    workDir,
  );
  if (out.code !== 0) throw new Error(`git bundle create failed: ${out.stderr}`);
}

/**
 * Copies a repository from one peer's storage into another's — what `rad clone` would have done
 * over the network. The destination also gets a seeding policy, because the reads and writes
 * that follow go through the policy table.
 */
export async function seedFrom(from: Peer, to: Peer, rid: string): Promise<void> {
  const src = from.exec.storageDir(rid);
  const dst = to.exec.storageDir(rid);
  await mkdir(`${to.home}/storage`, { recursive: true });
  await copyDir(src, dst);
  // RAD_SOCKET=/dev/null for this ONE command: a peer whose CLI is pointed at a fake node would
  // hand the policy to it (`Command::Seed`), and a fake that answers `{"updated":true}` keeps
  // nothing — after which `rad sync` says the repository is not seeded. Without a node the CLI
  // writes the policy database itself, which is what the real bridge's node does for it.
  const seeded = await to.exec.rad(["seed", rid, "--scope", "all"], {
    env: { RAD_SOCKET: "/dev/null" },
  });
  if (seeded.code !== 0) throw new Error(`rad seed failed: ${seeded.stderr}${seeded.stdout}`);
  // `rad cob show` reads the profile's COB cache, which a hand-copied storage has not filled.
  await to.exec.rad(["patch", "cache", "--repo", rid, "--no-announce", "-q"]);
  await to.exec.rad(["issue", "cache", "-r", rid, "--no-announce", "-q"]);
}

/**
 * Moves every reference from one peer's storage to the other's — the offline stand-in for a
 * node fetch. `git fetch` between two bare repositories writes exactly the refs and objects a
 * real fetch would, minus the signature verification the node does on the way in.
 */
export async function pullRefs(from: Peer, to: Peer, rid: string): Promise<void> {
  const out = await to.exec.git(to.exec.storageDir(rid), [
    "fetch",
    "--quiet",
    "--force",
    from.exec.storageDir(rid),
    "+refs/namespaces/*:refs/namespaces/*",
    "+refs/heads/*:refs/heads/*",
    "+refs/rad/*:refs/rad/*",
  ]);
  if (out.code !== 0) throw new Error(`storage fetch failed: ${out.stderr}`);
}

async function copyDir(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = `${src}/${entry.name}`;
    const to = `${dst}/${entry.name}`;
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isSymbolicLink()) continue;
    else await copyFile(from, to);
  }
}

/** A short-lived directory the test removes itself. */
export async function tempDir(prefix: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), `ryph-${prefix}-`));
  return {
    path,
    dispose: () => rm(path, { recursive: true }).catch(() => {}).then(() => {}),
  };
}

/** A unix socket path short enough for the platform's sun_path limit (104 bytes on macOS). */
export async function socketPath(): Promise<{ path: string; dispose(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "rn-"));
  return {
    path: `${dir}/s`,
    dispose: () => rm(dir, { recursive: true }).catch(() => {}).then(() => {}),
  };
}
