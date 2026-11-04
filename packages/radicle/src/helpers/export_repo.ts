// The read-only view of a repository the git gateway serves.
//
// The problem it solves: a Radicle storage repository is ONE git repository holding every peer's
// namespace — `refs/namespaces/<nid>/refs/heads/*`, everyone's patch heads, everyone's COBs —
// plus the canonical `refs/heads/*` and `refs/tags/*` the delegates agreed on. Pointing
// `upload-pack` at it would advertise all of that. That is not a secret (the repo is public, and
// a peer can fetch the same refs over the Radicle protocol), but it is wrong: the forge's cache
// would clone a few hundred namespaced refs, and every consumer downstream would have to learn
// to ignore them.
//
// So the gateway serves a MIRROR: a bare repository whose `objects/info/alternates` points at
// the storage repository's object database — no copy, no fetch, no extra bytes on disk — and
// whose refs are only the canonical ones, rewritten from storage on each advertisement. The
// mirror is disposable; deleting it costs one re-list.
//
// It is also the structural half of "read-only": upload-pack is pointed at a directory nothing
// ever writes to, so a receive-pack that does not exist could not reach the real storage anyway.

import { mkdir, stat, writeFile } from "node:fs/promises";

/** The subprocess seam, declared locally: helpers never reach ports. A `RadExec`'s `git`. */
export type GitRunner = (
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; stdin?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ExportRepoOptions {
  /** The bare storage repository for the RID. */
  storageDir: string;
  /** Where the mirror lives — one directory per RID, owned entirely by this process. */
  exportDir: string;
  /** Our own node id. When two peers hold a head for the same change request, ours wins —
   * which is the case that matters: a run adding a revision to a change request ryph
   * submitted must check out what ryph last pushed. Null: first namespace in sorted order. */
  selfNid?: string | null;
  git: GitRunner;
}

const CANONICAL = ["refs/heads/", "refs/tags/"];

/** Where a change request's head lives in a peer's namespace. */
const PATCH_HEAD = /^refs\/namespaces\/([^/]+)\/refs\/heads\/patches\/([0-9a-f]{40})$/;

/**
 * Creates the mirror if it is missing, then makes its refs exactly the canonical refs of
 * storage. Returns the directory to hand `upload-pack`.
 *
 * Throws if storage does not exist — a RID we do not hold is a 404, decided by the caller.
 */
export async function syncExportRepo(opts: ExportRepoOptions): Promise<string> {
  const { storageDir, exportDir, git } = opts;
  const info = await stat(storageDir).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new Error(`no storage repository at ${storageDir}`);
  }

  const alternates = `${exportDir}/objects/info/alternates`;
  const initialized = await stat(`${exportDir}/HEAD`).catch(() => null);
  if (initialized === null) {
    await mkdir(exportDir, { recursive: true });
    const init = await git(exportDir, ["init", "--quiet", "--bare", "."]);
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
  }
  // Rewritten every time: a storage path that moved (a container restart with a new mount
  // point) would otherwise leave a mirror pointing at nothing, and `upload-pack` would answer
  // an advertisement of refs whose objects it cannot read.
  await mkdir(`${exportDir}/objects/info`, { recursive: true });
  await writeFile(alternates, `${storageDir}/objects\n`);

  const listed = await git(storageDir, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    ...CANONICAL,
  ]);
  if (listed.code !== 0) throw new Error(`git for-each-ref failed: ${listed.stderr.trim()}`);

  const wanted = new Map<string, string>();
  for (const line of listed.stdout.split("\n")) {
    const [oid, name] = line.trim().split(" ");
    // `for-each-ref` is given prefixes, but a defensive check costs nothing and this is the
    // line that decides what leaves the process.
    if (!oid || !name || !CANONICAL.some((p) => name.startsWith(p))) continue;
    wanted.set(name, oid);
  }

  // Change request heads, flattened out of the namespaces they are signed in. Without them a
  // run commanded from a change request's discussion has nothing to check out: the head of a
  // patch is a commit in somebody's namespace and never a canonical branch. They are exported
  // under `refs/heads/patches/<id>`, which is the name the forge hands the run.
  //
  // Read-only is unaffected: the mirror still borrows storage's objects and is still a
  // directory nothing ever writes to, and every head here is already fetchable by any peer
  // over the Radicle protocol.
  const patchHeads = await git(storageDir, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/namespaces/",
  ]);
  const claimed = new Map<string, { oid: string; nid: string }>();
  for (const line of patchHeads.stdout.split("\n")) {
    const [oid, name] = line.trim().split(" ");
    const matched = name === undefined ? null : PATCH_HEAD.exec(name);
    if (!oid || matched === null) continue;
    const [, nid, id] = matched;
    const held = claimed.get(id);
    // Ours wins outright; otherwise the lowest node id, so the answer is at least stable
    // across advertisements rather than whatever order git listed the namespaces in.
    if (
      held === undefined || nid === opts.selfNid ||
      (held.nid !== opts.selfNid && nid < held.nid)
    ) {
      claimed.set(id, { oid, nid });
    }
  }
  for (const [id, { oid }] of claimed) wanted.set(`refs/heads/patches/${id}`, oid);

  const have = await git(exportDir, ["for-each-ref", "--format=%(objectname) %(refname)"]);
  const commands: string[] = [];
  for (const line of have.stdout.split("\n")) {
    const [oid, name] = line.trim().split(" ");
    if (!name) continue;
    if (!wanted.has(name)) commands.push(`delete ${name} ${oid}`);
  }
  for (const [name, oid] of wanted) commands.push(`update ${name} ${oid}`);

  if (commands.length > 0) {
    const updated = await git(exportDir, ["update-ref", "--stdin"], {
      stdin: `${commands.join("\n")}\n`,
    });
    if (updated.code !== 0) throw new Error(`git update-ref failed: ${updated.stderr.trim()}`);
  }

  // HEAD has to name a ref that exists or a clone lands detached with a warning. The default
  // branch is whatever the identity document says, but `refs/heads/*` is what we have here;
  // the caller passes the identity's branch when it knows it.
  return exportDir;
}

/** Points the mirror's HEAD at `branch` when that branch exists. Best-effort and silent. */
export async function setExportHead(
  exportDir: string,
  branch: string,
  git: GitRunner,
): Promise<void> {
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || branch.includes("..")) return;
  const ref = `refs/heads/${branch}`;
  const exists = await git(exportDir, ["rev-parse", "--verify", "--quiet", ref]);
  if (exists.code !== 0) return;
  await git(exportDir, ["symbolic-ref", "HEAD", ref]);
}
