// What `ryph checks` reads from the repository it is run in: which repo it is on the forge, the
// commit and branch to check, and whether the forge already has that commit — and, when it does
// not, the bundle that carries it there.
//
// Invariants:
// - read-only on the repository: `git bundle create` writes only the temp file it is given, and
//   nothing here fetches, so a check never moves a remote-tracking ref behind the person's back
// - the bundle's ONE ref is `refs/heads/<branch>`, exactly what the forge's intake allows, and
//   its prerequisite is the merge-base with the base, so it carries only the branch's own commits
// - the commit checked is HEAD, never the working tree: a dirty tree is said, not bundled

import { stat } from "node:fs/promises";
import { type Child, command, type CommandOutput } from "@ryph/process";
import { resolve } from "@std/path";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** One git command in `cwd`; its stdout trimmed, or a `GitError` with what it printed. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const out = await gitRaw(cwd, args);
  if (!out.ok) throw new GitError(`git ${args[0]} failed: ${out.stderr || `exit ${out.code}`}`);
  return out.stdout;
}

/** How long a command that talks to a remote may take before it is killed. */
export const REMOTE_TIMEOUT_MS = 20_000;

interface GitOptions {
  /** Talks to a remote: no ssh prompt either, and killed after `timeoutMs`. */
  remote?: boolean;
  timeoutMs?: number;
}

async function gitRaw(
  cwd: string,
  args: string[],
  opts: GitOptions = {},
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  // Never a credential prompt: an `ls-remote` that would ask for a password answers "unknown"
  // instead, and the ask falls back to a bundle.
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (opts.remote) {
    // A stalled http transfer ends itself ("Operation too slow") rather than leaving
    // git-remote-http behind when the backstop below kills only git.
    env.GIT_HTTP_LOW_SPEED_LIMIT = "1";
    env.GIT_HTTP_LOW_SPEED_TIME = "15";
  }
  if (opts.remote && !await userSetsSsh(cwd)) {
    // Nor an ssh prompt (a passphrase, an unknown host key), which GIT_TERMINAL_PROMPT does not
    // cover; and an ssh that gives up by itself on a connect or a silent server, for the same
    // reason as the http limits. Only when the person has not chosen their own ssh command:
    // theirs may pick the key.
    env.GIT_SSH_COMMAND =
      "ssh -oBatchMode=yes -oConnectTimeout=15 -oServerAliveInterval=5 -oServerAliveCountMax=3";
  }
  let child: Child;
  try {
    child = await command("git", {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env,
    }).spawn();
  } catch (err) {
    if (((err as NodeJS.ErrnoException)?.code === "ENOENT")) {
      throw new GitError("git is not on PATH");
    }
    throw err;
  }
  const done = child.output();
  let output: CommandOutput | null;
  if (opts.remote) {
    // The backstop: a remote still hung past the transport limits above is killed at the
    // timeout and reads as a failure like any other. Not an AbortSignal on the command: that waits for the
    // pipes to close, and ssh, git's child, keeps them open after git is gone.
    let timer: ReturnType<typeof setTimeout> | undefined;
    output = await Promise.race([
      done,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), opts.timeoutMs ?? REMOTE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (output === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      done.catch(() => {});
      return { ok: false, code: -1, stdout: "", stderr: "timed out talking to the remote" };
    }
  } else {
    output = await done;
  }
  const decode = (b: Uint8Array) => new TextDecoder().decode(b).trim();
  return {
    ok: output.success,
    code: output.code,
    stdout: decode(output.stdout),
    stderr: decode(output.stderr),
  };
}

/** Whether the person chose how git runs ssh: the environment, or `core.sshCommand`. */
async function userSetsSsh(cwd: string): Promise<boolean> {
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return true;
  return (await gitRaw(cwd, ["config", "--get", "core.sshCommand"])).stdout !== "";
}

/** Where a remote points: the forge host (lower-cased, with any port; null for Radicle, which
 * has none), and the repo's address there as ryph names it. */
export interface RemoteAddress {
  host: string | null;
  repo: string;
}

export interface RemoteOptions {
  /** The deployment's GitLab (`RYPH_GITLAB_URL`). An instance served under a path prefix
   * (`https://git.example.com/gitlab`) has that prefix in its https remotes but not in its ssh
   * ones; naming the instance strips it. Absent: no prefix is known, and none is stripped. */
  gitlabUrl?: string | null;
}

/** One project path segment, as GitHub and GitLab both allow it: never a dot segment, and never
 * `-`, which GitLab keeps for its own routes (`/-/tree/…`). */
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
/** GitLab nests groups up to 20 levels, project included; its full path is at most 255. */
const MAX_DEPTH = 20;
const MAX_PATH = 255;

/**
 * The repo coordinates ryph knows a remote by, and the host it is on:
 * - GitHub (github.com, https, ssh or scp-style): `owner/name`, exactly two segments;
 * - GitLab, on gitlab.com or a self-managed host: the project's full path, groups nested,
 *   `group/sub/…/project` (2 to 20 segments);
 * - Radicle: `rad:z…` (`rad://z…`, `rad:z…`, or a seed's `https://…/z….git`), host null.
 * Null for anything else, which the caller answers by asking for `--repo`. The host is said, not
 * judged: any other host's two-or-more-segment path is taken, since a self-managed GitLab can
 * live anywhere and the server matches the address against the repos it has connected.
 */
export function remoteAddress(remote: string, opts: RemoteOptions = {}): RemoteAddress | null {
  const url = remote.trim();
  const rad = /^rad:(?:\/\/)?(z[1-9A-HJ-NP-Za-km-z]+)/.exec(url);
  if (rad) return { host: null, repo: `rad:${rad[1]}` };

  let host: string;
  let path: string;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url);
  if (scp) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.host === "") return null;
    host = parsed.host.toLowerCase();
    path = parsed.pathname;
    const prefix = httpPrefixOf(opts.gitlabUrl ?? null, host);
    if (prefix !== null && /^https?:$/.test(parsed.protocol)) {
      if (path.toLowerCase().startsWith(`${prefix}/`)) path = path.slice(prefix.length);
    }
  }
  const segments = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  // A Radicle seed serving git over http names the repo by its RID alone.
  if (segments.length === 1 && /^z[1-9A-HJ-NP-Za-km-z]{20,}$/.test(segments[0])) {
    return { host: null, repo: `rad:${segments[0]}` };
  }
  const max = host === "github.com" ? 2 : MAX_DEPTH;
  if (segments.length < 2 || segments.length > max) return null;
  if (segments.some((seg) => !PATH_SEGMENT.test(seg) || /^\.+$/.test(seg) || seg === "-")) {
    return null;
  }
  const repo = segments.join("/");
  return repo.length > MAX_PATH ? null : { host, repo };
}

/** `remoteAddress`'s repo alone: what the server is asked about. */
export function repoFromRemote(remote: string, opts: RemoteOptions = {}): string | null {
  return remoteAddress(remote, opts)?.repo ?? null;
}

/** The lower-cased path prefix the GitLab at `gitlabUrl` is served under, when it is on `host`
 * and has one; null otherwise. */
function httpPrefixOf(gitlabUrl: string | null, host: string): string | null {
  if (gitlabUrl === null) return null;
  let instance: URL;
  try {
    instance = new URL(gitlabUrl);
  } catch {
    return null;
  }
  if (instance.host.toLowerCase() !== host) return null;
  const prefix = instance.pathname.replace(/\/+$/, "").toLowerCase();
  return prefix === "" ? null : prefix;
}

/**
 * The top of the repository `path` is in: what an agent passes as the directory it works in,
 * which may be a worktree the MCP server was not started in. Relative to `from`.
 */
export async function repoRoot(path: string, from: string): Promise<string> {
  const dir = resolve(from, path);
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error();
  } catch {
    throw new GitError(`${dir} is not a directory`);
  }
  const out = await gitRaw(dir, ["rev-parse", "--show-toplevel"]);
  if (!out.ok || out.stdout === "") throw new GitError(`${dir} is not inside a git repository`);
  return out.stdout;
}

/** What a check is asked about, as the repository says it. */
export interface LocalState {
  /** The remote the forge knows: `origin`, else `rad`, else the only one there is. */
  remote: string;
  /** Every remote this clone has, for reading a `--base` written as `origin/main`. */
  remotes: string[];
  /** `owner/name`, a GitLab project's `group/…/project`, or `rad:z…`; null when the remote URL
   * is not one ryph can name. */
  repo: string | null;
  /** The forge host the remote is on (`github.com`, `gitlab.example.com:8443`); null for a
   * Radicle remote or one ryph cannot name. */
  host: string | null;
  branch: string;
  head: string;
  /** Tracked changes not in HEAD: checks run on the commit, so these are not in it. */
  dirty: boolean;
}

export async function readLocalState(
  cwd: string,
  opts: RemoteOptions = {},
): Promise<LocalState> {
  const inside = await gitRaw(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    throw new GitError(`${cwd} is not inside a git repository`);
  }
  const remotes = (await git(cwd, ["remote"])).split("\n").filter(Boolean);
  const remote = remotes.includes("origin")
    ? "origin"
    : remotes.includes("rad")
    ? "rad"
    : remotes.length === 1
    ? remotes[0]
    : null;
  if (remote === null) {
    throw new GitError(
      remotes.length === 0
        ? "this repository has no remote, so the forge cannot know it"
        : `no remote named origin among ${remotes.join(", ")}`,
    );
  }
  // The URL as configured, not `get-url`'s: that one applies `url.*.insteadOf` rewrites, which
  // can turn a forge's address into a mirror's or a local path.
  // The FIRST url, as fetch and ls-remote use it; `--get` would answer the last of several.
  const url = (await git(cwd, ["config", "--get-all", `remote.${remote}.url`])).split("\n")[0];
  // The full ref, not `--short`: that one answers `heads/v1` for a branch v1 when a tag v1 exists.
  const branchOut = await gitRaw(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  if (!branchOut.ok || !branchOut.stdout.startsWith("refs/heads/")) {
    throw new GitError("HEAD is detached: check out a branch first, checks are asked on one");
  }
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const address = remoteAddress(url, opts);
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return {
    remote,
    remotes,
    repo: address?.repo ?? null,
    host: address?.host ?? null,
    branch: branchOut.stdout.slice("refs/heads/".length),
    head,
    dirty: status !== "",
  };
}

/**
 * The commit `refs/heads/<branch>` names on the remote, or null when the branch is not there —
 * or the remote cannot be asked (offline, no credentials), which comes to the same answer: the
 * forge cannot be trusted to have HEAD, so it gets a bundle.
 */
export async function remoteBranchHead(
  cwd: string,
  remote: string,
  branch: string,
  timeoutMs = REMOTE_TIMEOUT_MS,
): Promise<string | null> {
  const out = await gitRaw(cwd, ["ls-remote", remote, `refs/heads/${branch}`], {
    remote: true,
    timeoutMs,
  });
  if (!out.ok) return null;
  const line = out.stdout.split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
  return line ? line.split("\t")[0] : null;
}

/** The remote's default branch as this clone last saw it, else `main`. */
export async function defaultBase(cwd: string, remote: string): Promise<string> {
  const out = await gitRaw(cwd, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  const prefix = `refs/remotes/${remote}/`;
  return out.ok && out.stdout.startsWith(prefix) ? out.stdout.slice(prefix.length) : "main";
}

/**
 * Writes a bundle of `refs/heads/<branch>` to `path`, with the merge-base of HEAD and
 * `<remote>/<base>` as its prerequisite, and returns that prerequisite (null: none, the whole
 * history rides along).
 *
 * No remote-tracking base, or no common history, means no prerequisite: bigger, still correct.
 * A branch with nothing past the base would make an empty bundle, which git refuses, so its
 * prerequisite steps back to HEAD's parent and the bundle carries HEAD alone.
 */
export async function createBundle(
  cwd: string,
  opts: { remote: string; base: string; branch: string; path: string },
): Promise<string | null> {
  const head = await git(cwd, ["rev-parse", `refs/heads/${opts.branch}`]);
  const baseRef = await gitRaw(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${opts.remote}/${opts.base}^{commit}`,
  ]);
  let prerequisite: string | null = null;
  if (baseRef.ok) {
    const mergeBase = await gitRaw(cwd, ["merge-base", head, baseRef.stdout]);
    if (mergeBase.ok && mergeBase.stdout !== "") prerequisite = mergeBase.stdout;
  }
  if (prerequisite === head) {
    const parent = await gitRaw(cwd, ["rev-parse", "--verify", "--quiet", `${head}^`]);
    prerequisite = parent.ok ? parent.stdout : null;
  }
  await git(cwd, [
    "bundle",
    "create",
    "--quiet",
    opts.path,
    `refs/heads/${opts.branch}`,
    ...(prerequisite ? [`^${prerequisite}`] : []),
  ]);
  return prerequisite;
}

/** How the commit reaches the forge: already there on the branch, or in a bundle. */
export type SourceChoice = "pushed" | "bundle";

/**
 * Pushed when the remote's branch IS HEAD — the forge can fetch it by id — else a bundle.
 * `--push` and `--bundle` decide it outright; a forced push of a commit the remote lacks is the
 * person's call, and the forge answers it.
 *
 * `remoteProvesNothing` makes it a bundle unless forced: a Radicle repo, where `ls-remote` on a
 * `rad` remote asks the person's own node rather than the forge's, or a `--repo` other than the
 * one the remote names.
 */
export async function chooseSource(
  cwd: string,
  state: Pick<LocalState, "remote" | "branch" | "head">,
  opts: { force: SourceChoice | null; remoteProvesNothing?: boolean; timeoutMs?: number },
): Promise<SourceChoice> {
  if (opts.force !== null) return opts.force;
  if (opts.remoteProvesNothing) return "bundle";
  return await remoteBranchHead(cwd, state.remote, state.branch, opts.timeoutMs) === state.head
    ? "pushed"
    : "bundle";
}

/**
 * A `--base` as the server reads it: a branch name. `refs/heads/main` and
 * `refs/remotes/origin/main` mean `main`; so does `origin/main`, but only when this clone reads it
 * as a remote-tracking branch — `refs/remotes/origin/main` exists and no local branch is called
 * `origin/main`. A branch whose own name has a slash (`release/1.2`, even beside a remote named
 * `release` that has no such branch) is left alone.
 */
export async function normaliseBase(
  cwd: string,
  base: string,
  remotes: readonly string[],
): Promise<string> {
  const name = base.trim();
  if (name.startsWith("refs/heads/")) return name.slice("refs/heads/".length);
  if (name.startsWith("refs/remotes/")) {
    const rest = name.slice("refs/remotes/".length);
    const remote = remotes.find((r) => rest.startsWith(`${r}/`));
    return remote ? rest.slice(remote.length + 1) : rest;
  }
  const remote = remotes.find((r) => name.startsWith(`${r}/`));
  if (!remote) return name;
  const exists = async (ref: string) =>
    (await gitRaw(cwd, ["show-ref", "--verify", "--quiet", ref])).ok;
  return await exists(`refs/remotes/${name}`) && !await exists(`refs/heads/${name}`)
    ? name.slice(remote.length + 1)
    : name;
}
