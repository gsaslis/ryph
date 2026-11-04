// The bare repositories behind the fake's projects, driven through the git CLI: making one,
// committing to it without a worktree, reading branches, diffs and logs, and the three merge
// methods. Every call runs with the user's own git configuration shut out, so a signing key or
// a `diff.noprefix` on the machine never changes what the fake answers.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";

export const ZERO_SHA = "0".repeat(40);

/** The environment every git the fake runs gets: no global or system config. */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    ...extra,
  };
}

export class GitError extends Error {
  constructor(readonly args: string[], readonly code: number, readonly stderr: string) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
}

const decoder = new TextDecoder();

/** Runs git in `gitDir`, answering stdout; throws `GitError` on a non-zero exit unless `ok`
 * lists the code. */
export async function git(
  gitDir: string,
  args: string[],
  opts: { env?: Record<string, string>; stdin?: Uint8Array | string; ok?: number[] } = {},
): Promise<{ code: number; stdout: string }> {
  const full = ["--git-dir", gitDir, ...args];
  const child = await command("git", {
    args: full,
    env: gitEnv(opts.env),
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (opts.stdin !== undefined) {
    const bytes = typeof opts.stdin === "string"
      ? new TextEncoder().encode(opts.stdin)
      : opts.stdin;
    const w = child.stdin.getWriter();
    await w.write(bytes);
    await w.close();
  }
  const out = await child.output();
  if (out.code !== 0 && !(opts.ok ?? []).includes(out.code)) {
    throw new GitError(args, out.code, decoder.decode(out.stderr));
  }
  return { code: out.code, stdout: decoder.decode(out.stdout) };
}

/** A new bare repository, ready to be served: pushes enabled over HTTP, push options
 * advertised, and the fake's pre-receive hook in `hooksDir`. */
export async function initBare(gitDir: string, defaultBranch: string, hooksDir: string) {
  await command("git", {
    args: ["init", "--quiet", "--bare", `--initial-branch=${defaultBranch}`, gitDir],
    env: gitEnv(),
  }).output().then((o) => {
    if (o.code !== 0) throw new GitError(["init"], o.code, decoder.decode(o.stderr));
  });
  for (
    const [k, v] of [
      ["http.receivepack", "true"],
      ["receive.advertisePushOptions", "true"],
      ["uploadpack.allowReachableSHA1InWant", "true"],
      ["core.hooksPath", hooksDir],
    ]
  ) await git(gitDir, ["config", k, v]);
}

/** A bare copy of `from` (a fork), with the same configuration as a fresh one. */
export async function cloneBare(from: string, gitDir: string, hooksDir: string) {
  const o = await command("git", {
    args: ["clone", "--quiet", "--bare", "--no-local", from, gitDir],
    env: gitEnv(),
  }).output();
  if (o.code !== 0) throw new GitError(["clone"], o.code, decoder.decode(o.stderr));
  for (
    const [k, v] of [
      ["http.receivepack", "true"],
      ["receive.advertisePushOptions", "true"],
      ["uploadpack.allowReachableSHA1InWant", "true"],
      ["core.hooksPath", hooksDir],
    ]
  ) await git(gitDir, ["config", k, v]);
}

export async function revParse(gitDir: string, rev: string): Promise<string | null> {
  const r = await git(gitDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { ok: [1] });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Every branch and tag, ref → sha. */
export async function refs(gitDir: string): Promise<Map<string, string>> {
  const r = await git(gitDir, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads",
    "refs/tags",
  ]);
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const i = line.indexOf(" ");
    out.set(line.slice(i + 1), line.slice(0, i));
  }
  return out;
}

export async function isAncestor(gitDir: string, a: string, b: string): Promise<boolean> {
  const r = await git(gitDir, ["merge-base", "--is-ancestor", a, b], { ok: [1] });
  return r.code === 0;
}

export async function mergeBase(gitDir: string, a: string, b: string): Promise<string | null> {
  const r = await git(gitDir, ["merge-base", a, b], { ok: [1] });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function updateRef(gitDir: string, ref: string, sha: string, old?: string) {
  await git(gitDir, ["update-ref", ref, sha, ...(old === undefined ? [] : [old])]);
}

export async function deleteRef(gitDir: string, ref: string) {
  await git(gitDir, ["update-ref", "-d", ref]);
}

/** Copies `ref` of another repository into this one under `as` (a fork's branch into the target
 * project's `refs/merge-requests/<iid>/head`). */
export async function fetchRef(gitDir: string, fromGitDir: string, ref: string, as: string) {
  await git(gitDir, ["fetch", "--quiet", "--no-tags", fromGitDir, `+${ref}:${as}`]);
}

export interface Person {
  name: string;
  email: string;
}

function personEnv(author: Person, date: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: date,
  };
}

/**
 * Commits `files` onto `branch` without a worktree (a scratch index), creating the branch when
 * it does not exist; a null content deletes the path. Answers the branch's tip before (null:
 * created) and after.
 */
export async function commitFiles(
  gitDir: string,
  params: {
    branch: string;
    files: Record<string, string | Uint8Array | null>;
    message: string;
    author: Person;
    date: string;
    /** Start a new branch from here instead of the default branch's tip. */
    from?: string;
  },
): Promise<{ before: string | null; after: string }> {
  const ref = `refs/heads/${params.branch}`;
  const before = await revParse(gitDir, ref);
  const parent = before ?? (params.from ? await revParse(gitDir, params.from) : null);
  const scratch = await mkdtemp(join(tmpdir(), "fake-gitlab-index-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index"), ...personEnv(params.author, params.date) };
  try {
    if (parent) await git(gitDir, ["read-tree", parent], { env });
    for (const [path, content] of Object.entries(params.files)) {
      if (content === null) {
        await git(gitDir, ["update-index", "--force-remove", "--", path], { env });
        continue;
      }
      const blob = (await git(gitDir, ["hash-object", "-w", "--stdin"], { env, stdin: content }))
        .stdout.trim();
      await git(gitDir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], {
        env,
      });
    }
    const tree = (await git(gitDir, ["write-tree"], { env })).stdout.trim();
    const commit = (await git(
      gitDir,
      ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"],
      { env, stdin: params.message },
    )).stdout.trim();
    await updateRef(gitDir, ref, commit, before ?? ZERO_SHA);
    return { before, after: commit };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface Commit {
  id: string;
  parentIds: string[];
  authorName: string;
  authorEmail: string;
  authoredDate: string;
  committerName: string;
  committerEmail: string;
  committedDate: string;
  message: string;
}

const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B%x1e";

function parseLog(stdout: string): Commit[] {
  return stdout.split("\x1e").map((s) => s.replace(/^\n/, "")).filter((s) => s !== "").map(
    (rec) => {
      const [id, parents, an, ae, ad, cn, ce, cd, message] = rec.split("\x00");
      return {
        id: id!,
        parentIds: parents ? parents.split(" ") : [],
        authorName: an!,
        authorEmail: ae!,
        authoredDate: ad!,
        committerName: cn!,
        committerEmail: ce!,
        committedDate: cd!,
        message: message ?? "",
      };
    },
  );
}

/** Commits in `range` (`a..b`, or one sha for that commit alone), newest first. */
export async function log(gitDir: string, range: string, single = false): Promise<Commit[]> {
  const r = await git(gitDir, ["log", `--format=${LOG_FORMAT}`, ...(single ? ["-1"] : []), range]);
  return parseLog(r.stdout);
}

/** One file of a diff, as `GET /merge_requests/:iid/diffs` answers it. */
export interface FileDiff {
  old_path: string;
  new_path: string;
  a_mode: string;
  b_mode: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  generated_file: boolean;
  /** The hunks, from the first `@@` on; empty for a binary or mode-only change, and for one
   * past COLLAPSE_BYTES. GitLab 17.11's `/diffs` says no more: no `collapsed`, no `too_large`. */
  diff: string;
}

/** A file's diff above this many bytes comes back with its text withheld (an empty `diff`):
 * a tenth of `diff_max_patch_bytes` (200 KiB by default), where GitLab's merge request `/diffs`
 * collapses one — verified on GitLab 17.11, which showed a 15 KB diff and withheld a 25 KB one. */
export const COLLAPSE_BYTES = 20 * 1024;

/** A file's diff above this many bytes comes back without text from a merge request VERSION
 * (`/versions/:id`): `diff_max_patch_bytes`, 200 KiB by default (verified on GitLab 17.11, which
 * carried there the 25 KB diff `/diffs` withheld). */
export const VERSION_LIMIT_BYTES = 200 * 1024;

/** The diff from `base` to `head`, file by file; `collapse: false` keeps every file's text, and
 * `limit` sets the size past which a file's text is withheld (`COLLAPSE_BYTES` by default). */
export async function diff(
  gitDir: string,
  base: string,
  head: string,
  opts: { collapse?: boolean; limit?: number } = {},
): Promise<FileDiff[]> {
  const r = await git(gitDir, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "-M",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    base,
    head,
  ]);
  return parseDiff(r.stdout, opts.collapse ?? true, opts.limit);
}

export function parseDiff(text: string, collapse = true, limit = COLLAPSE_BYTES): FileDiff[] {
  const out: FileDiff[] = [];
  const blocks = text.split(/^diff --git /m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const head = lines[0]!;
    const hunkAt = lines.findIndex((l) => l.startsWith("@@"));
    const header = hunkAt === -1 ? lines.slice(1) : lines.slice(1, hunkAt);
    // Same path on both sides, the only spelling `diff --git a/x b/x` leaves unambiguous.
    const half = (head.length - 1) / 2;
    const guess = head.slice(2, half);
    const f: FileDiff = {
      old_path: guess,
      new_path: guess,
      a_mode: "100644",
      b_mode: "100644",
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      generated_file: false,
      diff: "",
    };
    for (const l of header) {
      if (l.startsWith("new file mode ")) {
        f.new_file = true;
        f.a_mode = "0";
        f.b_mode = l.slice(14);
      } else if (l.startsWith("deleted file mode ")) {
        f.deleted_file = true;
        f.a_mode = l.slice(18);
        f.b_mode = "0";
      } else if (l.startsWith("old mode ")) f.a_mode = l.slice(9);
      else if (l.startsWith("new mode ")) f.b_mode = l.slice(9);
      else if (l.startsWith("rename from ")) {
        f.renamed_file = true;
        f.old_path = l.slice(12);
      } else if (l.startsWith("rename to ")) f.new_path = l.slice(10);
      else if (l.startsWith("--- a/")) f.old_path = l.slice(6);
      else if (l.startsWith("+++ b/")) f.new_path = l.slice(6);
      else if (l.startsWith("index ")) {
        const mode = l.split(" ")[2];
        if (mode && !f.new_file && !f.deleted_file) f.a_mode = f.b_mode = mode;
      }
    }
    if (f.new_file) f.old_path = f.new_path;
    if (f.deleted_file) f.new_path = f.old_path;
    if (hunkAt !== -1) {
      const body = lines.slice(hunkAt).join("\n");
      const text = body.endsWith("\n") ? body : `${body}\n`;
      if (!collapse || text.length <= limit) f.diff = text;
    }
    out.push(f);
  }
  return out;
}

/** Merges two commits' trees, or throws on a conflict. */
async function mergeTree(gitDir: string, ours: string, theirs: string): Promise<string> {
  const r = await git(gitDir, ["merge-tree", "--write-tree", ours, theirs], { ok: [1] });
  if (r.code === 1) throw new Error("merge request has conflicts");
  return r.stdout.split("\n")[0]!.trim();
}

async function commitTree(
  gitDir: string,
  tree: string,
  parents: string[],
  message: string,
  who: Person,
  date: string,
): Promise<string> {
  return (await git(
    gitDir,
    ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"],
    { env: personEnv(who, date), stdin: message },
  )).stdout.trim();
}

export type MergeMethod = "merge" | "squash" | "ff";

/**
 * Lands `head` on `target` in `gitDir` and answers the new tip. `merge` writes a merge commit;
 * `squash` writes one squash commit onto the merge base, then a merge commit of it (GitLab's
 * default with squash on); `ff` moves the branch to `head` when it can, else rebases `head`'s
 * commits onto the target first (GitLab's "fast-forward merge" with its automatic rebase), so
 * the merged tip is NOT the merge request's head.
 */
export async function land(
  gitDir: string,
  params: {
    target: string;
    head: string;
    method: MergeMethod;
    message: string;
    squashMessage: string;
    who: Person;
    date: string;
  },
): Promise<{ tip: string; mergeCommit: string | null; squashCommit: string | null }> {
  const { target, head, who, date } = params;
  if (params.method === "ff") {
    if (await isAncestor(gitDir, target, head)) {
      return { tip: head, mergeCommit: null, squashCommit: null };
    }
    const base = await mergeBase(gitDir, target, head);
    if (!base) throw new Error("no merge base");
    let tip = target;
    for (const c of (await log(gitDir, `${base}..${head}`)).reverse()) {
      if (c.parentIds.length > 1) continue;
      const tree = await mergeTreeOnto(gitDir, tip, c);
      tip = await commitTree(gitDir, tree, [tip], c.message, who, date);
    }
    return { tip, mergeCommit: null, squashCommit: null };
  }
  let incoming = head;
  let squashCommit: string | null = null;
  if (params.method === "squash") {
    const base = await mergeBase(gitDir, target, head);
    if (!base) throw new Error("no merge base");
    const tree = (await git(gitDir, ["rev-parse", `${head}^{tree}`])).stdout.trim();
    squashCommit = await commitTree(gitDir, tree, [base], params.squashMessage, who, date);
    incoming = squashCommit;
  }
  const tree = await mergeTree(gitDir, target, incoming);
  const merge = await commitTree(gitDir, tree, [target, incoming], params.message, who, date);
  return { tip: merge, mergeCommit: merge, squashCommit };
}

/** Replays one commit's change onto `onto`: a three-way merge with the commit's parent as base. */
async function mergeTreeOnto(gitDir: string, onto: string, c: Commit): Promise<string> {
  const r = await git(
    gitDir,
    ["merge-tree", "--write-tree", `--merge-base=${c.parentIds[0]}`, onto, c.id],
    { ok: [1] },
  );
  if (r.code === 1) throw new Error("rebase has conflicts");
  return r.stdout.split("\n")[0]!.trim();
}

/** Writes the fake's pre-receive hook into `dir`, run by `runtime` (this process's own bun or
 * node). It enforces what the HTTP layer decided per ref (`FAKE_GITLAB_RULES`): a denied ref is
 * refused with GitLab's sentence, and a protected one may not be force-pushed or deleted. */
export async function writeHooks(dir: string, runtime: string) {
  const script = `#!${runtime}
const { execFileSync } = require("node:child_process");
const rules = JSON.parse(process.env.FAKE_GITLAB_RULES || '{"deny":{},"protected":[]}');
const zero = "0".repeat(40);
const input = require("node:fs").readFileSync(0, "utf8");
for (const line of input.split("\\n")) {
  if (!line.trim()) continue;
  const [oldSha, newSha, ref] = line.split(" ");
  const fail = (msg) => { process.stderr.write("GitLab: " + msg + "\\n"); process.exit(1); };
  if (rules.deny[ref]) fail(rules.deny[ref]);
  if (!rules.protected.includes(ref)) continue;
  if (newSha === zero) fail("You can only delete protected branches using the web interface.");
  if (oldSha === zero) continue;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", oldSha, newSha], { stdio: "ignore" });
  } catch {
    fail("You are not allowed to force push code to a protected branch on this project.");
  }
}
`;
  const path = join(dir, "pre-receive");
  await writeFile(path, script, { mode: 0o755 });
}
