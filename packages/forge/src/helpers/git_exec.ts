// Tiny wrapper around the git CLI.
//
// DUPLICATED from @ryph/runner's helpers/git_exec.ts on purpose, the same way the
// orchestrator duplicates the runner's WorkItem (see orchestrator/src/core/types.ts):
// importing another package's internals couples them at the source level, and the contract
// has not settled. The gateway shells out to git too, and it needs the SAME hardened env for
// the SAME reason — a 401 from an upstream must fail fast, never hang a fetch on a credential
// prompt (see docs/git-gateway.md, "gotchas paid for in blood"). Do not soften this env.
//
// Every git subprocess in this package runs through here (`makeGitCapped`, `makeGitBounded`,
// `makeGitInput` and `makeCatFileBatch` spawn and stream inside this module, for output too large
// to buffer or input fed on stdin), with
// ONE exception:
// helpers/http_backend.ts spawns `git upload-pack` raw because it must stream — it documents
// how it keeps the same invariants.
//
// Invariants:
// - hermetic: the user's global/system git config is ignored, and no inherited `GIT_*` variable
//   that says WHICH repository git acts on, or what config it reads, reaches git
//   (`REDIRECTING_GIT_ENV`). An inherited `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
//   `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG_PARAMETERS` or `GIT_NAMESPACE` (a forge
//   started from a git hook, or from a shell that exported one) would point every command at
//   another repository's store, borrow objects from one, or inject config at command-line
//   precedence — so the gateway behaves identically on any machine, and in the binary, on
//   whatever machine it was started from. The rest pass: `GIT_SSL_CAINFO`, `GIT_PROXY_*`,
//   `GIT_HTTP_*` and their kind are how a machine behind a corporate proxy or a private CA
//   reaches GitHub at all, and they name no repository
// - no ambient credential: the only credential git presents is the extraheader a caller injects.
//   The macOS keychain (Apple's built-in config), a credential helper from any config scope,
//   `~/.netrc` and ssh keys or agents are all out of reach — see `hardenedEnv`
// - non-interactive: no git subprocess can prompt (https auth, ssh host keys) —
//   a would-be prompt fails fast as a normal command failure instead of hanging a request
// - real transports only: remote-helper schemes like ext:: turn a URL into command execution
//   and are refused
// - credentials never leave: the trace line and a failing command's thrown error are redacted —
//   both credentialed URLs and Authorization headers (which ride `extraEnv` here) stay out of
//   logs and error responses

import { type Child, command } from "@ryph/process";

/**
 * The slice of the `Diagnostics` port this helper needs,
 * declared locally so helpers stay inside the dependency fence (helpers never reach ports).
 * Structural: any real `Diagnostics` satisfies it.
 */
export interface GitTracer {
  debug(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Executes a git command in `cwd`, returns stdout — trimmed, unless built by `makeGitRaw` —
 * and throws on non-zero exit.
 */
export type Git = (cwd: string, ...args: string[]) => Promise<string>;

// A local, dependency-free silent sink, so the plain `git` export owes nothing to the adapters.
const SILENT: GitTracer = { debug() {} };

/**
 * Builds a `Git` executor that traces every command it runs to `diag`.
 * `extraEnv` is the credential seam: `http.<origin>.extraheader` injected via
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` — command-line-precedence config
 * that the /dev/null hardening below deliberately does NOT touch. Number the pairs from 0: the
 * executor puts its own `credential.helper` reset in front of them (`commandConfig`). Never munge a URL instead:
 * a credentialed URL lands in `.git/config` where anything in the workspace can read it.
 * `signal`, when given, kills whatever command is running once it aborts, and fails every
 * command started after: for a read with a budget of its own.
 */
export function makeGit(
  diag: GitTracer,
  extraEnv: Record<string, string> = {},
  signal?: AbortSignal,
): Git {
  return build(diag, extraEnv, true, signal);
}

/** Whether a git failure from this module is exit 1 — `config --get` of an unset key,
 * `merge-base` of two commits with nothing in common — rather than git failing to answer. Kept
 * beside the `failed (exit N)` messages it reads, so the two change together. */
export const isExitOne = (err: unknown): boolean => /failed \(exit 1\)/.test(String(err));

/**
 * `makeGit`, except stdout comes back exactly as git wrote it. For CONTENT — `cat-file -p` of a
 * blob — where whitespace is data: a trim drops a YAML document's leading lines and the trailing
 * newlines a `|+` block scalar keeps. Everything else wants `makeGit`, whose trim is what turns a
 * one-line answer (a sha, a type, a size) into a value.
 */
export function makeGitRaw(diag: GitTracer, extraEnv: Record<string, string> = {}): Git {
  return build(diag, extraEnv, false);
}

/**
 * Executes a git command whose output may be far larger than anything worth holding — a diff —
 * and keeps at most `maxBytes` of its stdout. Past that the child is killed and `truncated` is
 * set: the bytes are never buffered, so a diff of a vendored blob costs the cap, not its size.
 * A command that fails before reaching the cap throws as `Git` does; one cut by the cap does
 * not, since its exit status is the kill's.
 */
export type CappedGit = (
  cwd: string,
  maxBytes: number,
  ...args: string[]
) => Promise<{ out: Uint8Array; truncated: boolean }>;

export function makeGitCapped(diag: GitTracer, extraEnv: Record<string, string> = {}): CappedGit {
  return async (cwd, maxBytes, ...args) => {
    const started = performance.now();
    const child = await command("git", {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: hardenedEnv(extraEnv),
    }).spawn();
    const [{ bytes: out, truncated }, { code }, err] = await Promise.all([
      readCapped(child, maxBytes),
      child.status,
      new Response(child.stderr).text(),
    ]);
    const safeArgs = redact(args.join(" "));
    diag.debug("git.exec", {
      op: args[0],
      args: safeArgs,
      code,
      truncated,
      ms: Math.round(performance.now() - started),
    });
    if (!truncated && code !== 0) {
      throw new Error(`git ${safeArgs} failed (exit ${code}): ${redact(err.trim())}`);
    }
    return { out, truncated };
  };
}

/**
 * The inherited `GIT_*` variables git never sees from this process: everything that redirects
 * which repository, object store, index, worktree, namespace, replace or graft view git acts on,
 * or where its config, templates and helper programs come from — and the few that change what a
 * read ANSWERS (pathspec magic, the default hash, an external diff command). A deny-list, so the
 * transport settings a machine needs (`GIT_SSL_*`, `GIT_PROXY_*`, `GIT_HTTP_*`, `GIT_TRACE*`)
 * keep working; the variables this module sets itself are set after the drop.
 */
const REDIRECTING_GIT_ENV = new Set([
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_REPLACE_REF_BASE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_QUARANTINE_PATH",
  "GIT_PREFIX",
  // What a read answers, rather than where it reads: a scratch repo `init`ed as sha256, a
  // pathspec read as a glob, a diff handed to a command.
  "GIT_DEFAULT_HASH",
  "GIT_DEFAULT_REF_FORMAT",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_ATTR_SOURCE",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
]);

/** Whether an inherited variable is dropped: the set above, and every config channel —
 * `GIT_CONFIG`, `_PARAMETERS`, `_COUNT`, `_KEY_n`/`_VALUE_n`, `_GLOBAL`, `_SYSTEM`,
 * `_NOSYSTEM` — and the external diff's per-path variables. */
export function isRedirectingGitEnv(key: string): boolean {
  return REDIRECTING_GIT_ENV.has(key) || key.startsWith("GIT_CONFIG") ||
    key.startsWith("GIT_DIFF_PATH_");
}

/**
 * The environment every git subprocess here runs with — see the invariants above. The WHOLE
 * environment, spawned with `clearEnv`: a command's `env` is merged over the parent's, which
 * can set a variable but never remove one, so dropping the redirecting `GIT_*` set means handing
 * over everything else explicitly. PATH, the locale, the TLS and proxy settings and the rest
 * pass through untouched; HOME does not (see below).
 */
function hardenedEnv(extraEnv: Record<string, string>): Record<string, string> {
  const inherited = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(inherited)) {
    if (isRedirectingGitEnv(key)) delete inherited[key];
  }
  return {
    ...inherited,
    // Set, never merely dropped: libcurl reads `$HOME/.netrc` on its own — no git config can
    // turn that off — and falls back to the passwd entry's home when HOME is unset. A
    // non-directory closes it, so a fetch the service sent anonymously stays anonymous.
    HOME: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // Apple's git also loads a config file compiled into the binary — at scope `unknown`, so
    // GIT_CONFIG_SYSTEM does not reach it — and that file turns on the login keychain
    // (`credential.helper=osxkeychain`). This is the switch that skips it.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // GIT_TERMINAL_PROMPT disables only the TERMINAL prompt: an inherited GIT_ASKPASS
    // (VS Code sets one in every integrated terminal) is a separate channel that would
    // still pop a GUI credential dialog on a 401. Both askpass vars are emptied so an
    // auth failure fails fast — proven live when a gateway test 401 popped a real
    // VS Code prompt through this exact hole.
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
    // No ssh: BatchMode only stops a prompt, so an ssh URL would still authenticate with
    // whatever keys and agent the machine offers. `file` stays — a bare local path is the
    // file transport, and local upstreams are supported on purpose.
    GIT_ALLOW_PROTOCOL: "file:https:http",
    ...extraEnv,
    ...commandConfig(extraEnv),
  };
}

/**
 * The `GIT_CONFIG_COUNT` pairs a command runs with: `extraEnv`'s own, behind a
 * `credential.helper=` reset that is always pair 0. An empty value clears every helper
 * configured before it — a repository's own `.git/config` included, which setup steps and agents
 * can write — so the only credential git ever presents is one a caller injected as an
 * extraheader. Composed here rather than at each call site, so no caller can drop it by omission.
 * An ambient GIT_CONFIG_COUNT never gets this far: it is dropped with every other config channel.
 */
function commandConfig(extraEnv: Record<string, string>): Record<string, string> {
  const pairs: Array<[string, string]> = [["credential.helper", ""]];
  const count = Number(extraEnv.GIT_CONFIG_COUNT ?? "0");
  for (let i = 0; i < count; i++) {
    pairs.push([extraEnv[`GIT_CONFIG_KEY_${i}`] ?? "", extraEnv[`GIT_CONFIG_VALUE_${i}`] ?? ""]);
  }
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

function build(
  diag: GitTracer,
  extraEnv: Record<string, string>,
  trim: boolean,
  signal?: AbortSignal,
): Git {
  return async (cwd: string, ...args: string[]): Promise<string> => {
    signal?.throwIfAborted();
    const started = performance.now();
    const cmd = command("git", {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: hardenedEnv(extraEnv),
      signal,
    });
    const { code, stdout, stderr } = await cmd.output();
    const safeArgs = redact(args.join(" "));
    diag.debug("git.exec", {
      op: args[0],
      args: safeArgs,
      code,
      ms: Math.round(performance.now() - started),
    });
    if (code !== 0) {
      const err = new TextDecoder().decode(stderr).trim();
      throw new Error(`git ${safeArgs} failed (exit ${code}): ${redact(err)}`);
    }
    const out = new TextDecoder().decode(stdout);
    return trim ? out.trim() : out;
  };
}

/**
 * Executes a git command in `cwd` and returns its stdout as git wrote it, untrimmed, or null once
 * stdout passes `maxBytes`: git is killed there, so a listing a committer made enormous costs this
 * process at most that much. Throws on a non-zero exit otherwise. For output whose size the repo
 * decides, like `ls-tree -r` of a directory anyone who can push may fill.
 */
export type GitBounded = (
  cwd: string,
  maxBytes: number,
  ...args: string[]
) => Promise<string | null>;

/** A `GitBounded` that traces every command it runs to `diag`, under the same hardened env. */
export function makeGitBounded(diag: GitTracer): GitBounded {
  return async (cwd, maxBytes, ...args) => {
    const started = performance.now();
    const child = await command("git", {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: hardenedEnv({}),
    }).spawn();
    const [stdout, status, stderr] = await Promise.all([
      readBounded(child, maxBytes),
      child.status,
      new Response(child.stderr).text(),
    ]);
    const safeArgs = redact(args.join(" "));
    diag.debug("git.exec", {
      op: args[0],
      args: safeArgs,
      code: status.code,
      ms: Math.round(performance.now() - started),
    });
    if (stdout === null) return null;
    if (!status.success) {
      throw new Error(`git ${safeArgs} failed (exit ${status.code}): ${redact(stderr.trim())}`);
    }
    return new TextDecoder().decode(stdout);
  };
}

/**
 * Executes a git command that reads its input on stdin — `cat-file --batch-check`, `log --stdin`,
 * `patch-id` — and returns its stdout as git wrote it, or null once stdout passes `maxBytes`, where
 * git is killed. Throws on a non-zero exit otherwise. Input is written while output is read, so a
 * long list never deadlocks on full pipes.
 */
export type GitInput = (
  cwd: string,
  input: string,
  maxBytes: number,
  ...args: string[]
) => Promise<string | null>;

/** A `GitInput` that traces every command it runs to `diag`, under the same hardened env, and
 * stops with `signal` as `makeGit` does. */
export function makeGitInput(diag: GitTracer, signal?: AbortSignal): GitInput {
  return async (cwd, input, maxBytes, ...args) => {
    signal?.throwIfAborted();
    const started = performance.now();
    const child = await command("git", {
      args,
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: hardenedEnv({}),
      signal,
    }).spawn();
    const write = (async () => {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(input));
        await writer.close();
      } catch {
        // git closed its end early (it failed, or was killed at the bound): the exit says why.
      }
    })();
    const [, stdout, status, stderr] = await Promise.all([
      write,
      readBounded(child, maxBytes),
      child.status,
      new Response(child.stderr).text(),
    ]);
    const safeArgs = redact(args.join(" "));
    diag.debug("git.exec", {
      op: args[0],
      args: safeArgs,
      code: status.code,
      ms: Math.round(performance.now() - started),
    });
    if (stdout === null) return null;
    if (!status.success) {
      throw new Error(`git ${safeArgs} failed (exit ${status.code}): ${redact(stderr.trim())}`);
    }
    return new TextDecoder().decode(stdout);
  };
}

/**
 * The type of each object `ids` names in `dir` (`commit`, `tree`, `blob`, `tag`), or `missing`,
 * in one `cat-file --batch-check`. Each id is taken as named, never peeled: a tag is a tag.
 */
export async function objectTypes(
  gitInput: GitInput,
  dir: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const types = new Map<string, string>();
  if (ids.length === 0) return types;
  const out = await gitInput(
    dir,
    ids.map((id) => `${id}\n`).join(""),
    ids.length * 128,
    "cat-file",
    "--batch-check=%(objectname) %(objecttype)",
  );
  if (out === null) throw new Error("cat-file --batch-check answered more than it was asked");
  // A missing object is echoed back as asked, followed by `missing`.
  for (const line of out.split("\n")) {
    const [id, type] = line.split(" ");
    if (id && type) types.set(id, type);
  }
  return types;
}

/**
 * Reads blobs by id, byte for byte, through ONE `git cat-file --batch` process: the ids go in on
 * stdin and the `<oid> <type> <size>\n<bytes>\n` framing is parsed out of raw stdout. `Git` cannot
 * do this — it takes no stdin and decodes stdout as text, which would corrupt a binary blob and
 * make the bytes disagree with anything hashed over them. Throws when an id is missing or not a
 * blob, and once the content passes `maxBytes`, which the caller has already checked against the
 * sizes a listing gave; the bound here is the backstop, so a lying listing still cannot make this
 * hold more than that in memory.
 */
export type CatFileBatch = (
  dir: string,
  ids: readonly string[],
  maxBytes: number,
) => Promise<Map<string, Uint8Array>>;

/** A `CatFileBatch` that traces every batch it runs to `diag`, under the same hardened env. */
export function makeCatFileBatch(diag: GitTracer): CatFileBatch {
  return async (dir, ids, maxBytes) => {
    const out = new Map<string, Uint8Array>();
    if (ids.length === 0) return out;
    const started = performance.now();
    const child = await command("git", {
      args: ["cat-file", "--batch"],
      cwd: dir,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: hardenedEnv({}),
    }).spawn();
    // The headers' worst case on top of the content: what stdout may hold before the bound has
    // certainly been passed.
    const ceiling = maxBytes + ids.length * 128;

    // Written and read at once: with thousands of ids the pipes fill both ways, and writing every
    // id before reading a byte would wait on git while git waits on us.
    const write = (async () => {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(ids.map((id) => `${id}\n`).join("")));
        await writer.close();
      } catch {
        // git closed its end early (it failed, or we killed it at the bound): the exit says why.
      }
    })();
    const errText = new Response(child.stderr).text();
    const [, read, status, stderr] = await Promise.all([
      write,
      readBounded(child, ceiling),
      child.status,
      errText,
    ]);
    diag.debug("git.exec", {
      op: "cat-file",
      args: "cat-file --batch",
      objects: ids.length,
      code: status.code,
      ms: Math.round(performance.now() - started),
    });
    if (read === null) throw new Error(`git cat-file --batch: over the ${maxBytes}-byte limit`);
    const stdout = read;
    if (!status.success) {
      throw new Error(
        `git cat-file --batch failed (exit ${status.code}): ${redact(stderr.trim())}`,
      );
    }

    let offset = 0;
    let content = 0;
    for (const id of ids) {
      const newline = stdout.indexOf(0x0a, offset);
      if (newline < 0) throw new Error(`git cat-file --batch: no answer for ${id}`);
      const header = new TextDecoder().decode(stdout.subarray(offset, newline)).split(" ");
      if (header[0] !== id || header[1] !== "blob" || header.length !== 3) {
        throw new Error(`git cat-file --batch: ${id} is ${header.slice(1).join(" ") || "missing"}`);
      }
      const size = Number(header[2]);
      const start = newline + 1;
      if (!Number.isSafeInteger(size) || start + size > stdout.length) {
        throw new Error(`git cat-file --batch: ${id} was cut short`);
      }
      content += size;
      if (content > maxBytes) {
        throw new Error(`git cat-file --batch: over the ${maxBytes}-byte limit`);
      }
      out.set(id, stdout.slice(start, start + size));
      // The framing's own newline after the content.
      offset = start + size + 1;
    }
    return out;
  };
}

/** A child's whole stdout, or null once it passes `ceiling` bytes, when the child is killed. */
async function readBounded(
  child: Child,
  ceiling: number,
): Promise<Uint8Array | null> {
  const { bytes, truncated } = await readCapped(child, ceiling);
  return truncated ? null : bytes;
}

/** A child's stdout up to `cap` bytes; past them the child is killed, and `truncated` says the
 * bytes are only the first `cap` of it. */
async function readCapped(
  child: Child,
  cap: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of child.stdout) {
    if (total + chunk.length > cap) {
      chunks.push(chunk.subarray(0, cap - total));
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      return { bytes: concat(chunks, cap), truncated: true };
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return { bytes: concat(chunks, total), truncated: false };
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const whole = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    if (at + chunk.length > total) break;
    whole.set(chunk, at);
    at += chunk.length;
  }
  return whole;
}

/**
 * The default executor: hermetic, but silent.
 * Used by tests and fixtures, and anywhere a traced one has not been threaded in.
 * Production builds a traced one with makeGit(diag).
 */
export const git: Git = makeGit(SILENT);

/** The untrimmed counterpart of `git`, for tests and fixtures that read content. */
export const gitRaw: Git = makeGitRaw(SILENT);

/** The silent `CatFileBatch`, for tests and fixtures. */
export const catFileBatch: CatFileBatch = makeCatFileBatch(SILENT);

/** The silent `GitInput`, for tests and fixtures. */
export const gitInput: GitInput = makeGitInput(SILENT);

/** The silent `GitBounded`, for tests and fixtures. */
export const gitBounded: GitBounded = makeGitBounded(SILENT);

/**
 * A URL should never carry credentials here, but if one ever does, keep it out of everything
 * that leaves this module: the trace line and the thrown error. Strips any user:pass@ —
 * greedily through the LAST `@` before the path, so an `@` inside the password cannot split
 * the match and leak its tail. Git's own stderr echoes URLs too, so failures pass through the
 * same scrub. Authorization headers (the extraEnv credential seam) are scrubbed to end of
 * line for the same reason: git echoes bad config values back in its errors.
 */
export function redact(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^/\s]*@/g, "$1***@")
    .replace(/(authorization:)[^\n]*/gi, "$1 ***");
}

/**
 * How git words "the upstream turned the credential away": a 401, which reaches the hardened
 * env (no prompt, no helper) as one of these. A 403 or a 404 is a refusal about the repo, which
 * a different credential for the same person does not change.
 */
const CREDENTIAL_REJECTED =
  /Authentication failed|could not read Username|The requested URL returned error: 401\b/;

/**
 * A credentialed `Git` that renews its credential ONCE when the upstream rejects it: the first
 * rejection asks `auth.refresh` (a GitHub user token that was rotated under us), and the command
 * is run again with the answer. Every later command through this executor uses the renewed
 * credential; a command that fails with the renewed one fails, and a credential with no
 * `refresh`, or a refresh that answers null, leaves the rejection as the answer. A retry is safe
 * because a rejected command reached nothing upstream. Concurrent rejections share one renewal,
 * and the source behind `refresh` is single-flight on its own, so nothing here loops.
 */
export function renewingGit<A extends { refresh?: () => Promise<A | null> }>(
  auth: A,
  gitFor: (auth: A) => Git,
): Git {
  const first = gitFor(auth);
  let active = first;
  let renewal: Promise<Git | null> | null = null;
  return async (cwd, ...args) => {
    const used = active;
    try {
      return await used(cwd, ...args);
    } catch (err) {
      if (used !== first || auth.refresh === undefined) throw err;
      if (!(err instanceof Error) || !CREDENTIAL_REJECTED.test(err.message)) throw err;
      renewal ??= auth.refresh().then((fresh) => fresh === null ? null : gitFor(fresh));
      const renewed = await renewal;
      if (renewed === null) throw err;
      active = renewed;
      return await renewed(cwd, ...args);
    }
  };
}
