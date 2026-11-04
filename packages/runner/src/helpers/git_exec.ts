// Tiny wrapper around the git CLI.
// Every git subprocess in the codebase runs through here, which buys two things for free:
//   1. Tracing — makeGit(diag) binds an executor to a `Diagnostics`,
//      and each command emits a "git.exec" debug line (subcommand, exit code, duration).
//   2. Hermeticity — the hardened env below (see Invariants) applies to every caller,
//      tests and scripts included, with no way to opt out.
// Callers don't see any of this; they just run git.
//
// None of it is a defence against the agent. The agent shares the runner's uid: it can read the
// runner's environment and memory through /proc, and run git with whatever config it likes. What
// these buy is a runner whose own git behaves the same whatever a setup step or the agent left in
// the checkout — no hang, no prompt, no stray program under finalize's commit — and logs that
// carry no credential. What must hold against the agent is checked at the forge's intake, at
// approval, and by the credentials only the forge holds.
//
// Invariants:
// - hermetic: the user's global/system git config is ignored,
//   so runs behave identically on any machine (a runner box has no personal config)
// - non-interactive: no git subprocess can prompt (https auth, ssh host keys) —
//   a would-be prompt fails fast as a normal command failure instead of hanging an unattended run
// - real transports only: remote-helper schemes like ext:: turn a URL into command execution
//   and are refused
// - credentials never leave: both the trace line and a failing command's thrown error are redacted,
//   so a credentialed URL cannot reach logs or a reported `Result`
// - the child environment is BUILT, never inherited: `clearEnv` plus a named allowlist, so the
//   runner's own credentials (run token, control token, git virtual key, MCP token) reach no
//   git subprocess and nothing it starts
// - no ambient credential: the only credential git presents is the extraheader a caller injects.
//   The macOS keychain (Apple's built-in config), a credential helper from any config scope,
//   `~/.netrc` and ssh keys or agents are all out of reach — see `hardenedEnv`
// - checkout hooks are inert: `core.hooksPath` points at a runner-owned directory on every
//   invocation, so a `.git/hooks/pre-commit` the repo's setup steps or the agent wrote does not
//   block or slow finalize's commit (the run trailer lives in that directory instead); a
//   `core.fsmonitor` command they configure does not run either, and nothing is signed
// - replace refs are ignored (`GIT_NO_REPLACE_OBJECTS`): an id means the object the repository
//   holds under it, so a `refs/replace/` entry a setup step or the agent wrote does not make a
//   checkout, a commit, a diff or a push read one object as another
// - no lazy fetch (`GIT_NO_LAZY_FETCH`, git 2.44+): a step can make a clone a partial one, and git
//   would then fetch any object it lacks the moment a command reads it — dialing out, or running
//   the `remote.<name>.uploadpack` the step configured, with no timeout. A missing object is an
//   error instead, never a hang. Every clone the runner makes is a full one, so nothing it needs is missing.

/**
 * The slice of the `Diagnostics` port this helper needs,
 * declared locally so helpers stay inside the dependency fence (helpers never reach ports).
 * Structural: any real `Diagnostics` satisfies it.
 */
import { mkdtempSync } from "node:fs";
import { type Child, command } from "@ryph/process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "./errors.ts";

export interface GitTracer {
  debug(event: string, fields?: Record<string, unknown>): void;
}

/** Executes a git command in `cwd`, returns trimmed stdout, throws on non-zero exit. */
export type Git = (cwd: string, ...args: string[]) => Promise<string>;

// A local, dependency-free silent sink, so the plain `git` export owes nothing to the adapters.
const SILENT: GitTracer = { debug() {} };

/**
 * The parent-environment variables a git subprocess genuinely needs, and the whole list of them:
 * the toolchain path, a writable temp dir, and the locale git formats its output in. Everything
 * else — the runner's brand-scoped credentials above all — stays in this process. HOME is not
 * inherited but set (`hardenedEnv`), and SSH_AUTH_SOCK not at all: neither is anything git needs
 * once ssh is refused, and both are credentials.
 */
const INHERITED_ENV = ["PATH", "TMPDIR", "LANG", "LC_ALL"];

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Where the runner's OWN git hooks live: one directory per process, outside every checkout,
 * pointed at with `-c core.hooksPath=` on every invocation below.
 *
 * It does two things at once. A hook in the checkout's `.git/hooks` — writable both by the
 * repo's `setup.yml` steps and by the agent — never runs under the runner, so one that fails,
 * hangs or prompts cannot stop finalize's `git commit` or a `git push`. Not a boundary: the agent
 * shares the runner's uid and can run whatever it likes itself. And the run-traceability trailer
 * keeps working, because `installRunTrailer` writes its `commit-msg` hook here as well as into
 * the clone.
 *
 * Created lazily and never removed: the run is one process in a container that goes away with
 * it. One per process is also one per run.
 */
let hooksPath: string | undefined;
export function gitHooksDir(): string {
  hooksPath ??= mkdtempSync(join(tmpdir(), "ryph-git-hooks-"));
  return hooksPath;
}

/**
 * The `-c` options every invocation leads with: the runner's own hooks directory (above), no
 * filesystem monitor — `core.fsmonitor` may name a command, and the checkout's config is writable
 * by setup steps and the agent, so `git status` would run it — and no signing or signature
 * checks: the runner signs nothing, so a `commit.gpgsign` (with a `gpg.program` of its own) or a
 * `merge.verifySignatures` the checkout configures cannot fail finalize's commit or an update's
 * merge, nor run a program from them. Passed on to the git processes a
 * command starts in submodules too (git hands `-c` down through `GIT_CONFIG_PARAMETERS`).
 * `submodule.recurse` is not overridden here: it also sets `fetch.recurseSubmodules`, which
 * fetches keep as the checkout configures it. Put-back's checkouts and resets pass
 * `--no-recurse-submodules` themselves (helpers/checkout.ts). Filter drivers are not overridden
 * either — turning a repository's own off makes a checkout write what its status then reads as
 * modified — so a driver a failed setup step configured is removed from the config instead,
 * before put-back runs anything there (helpers/checkout.ts `restoreDrivers`).
 */
function inertConfig(): string[] {
  return [
    "-c",
    `core.hooksPath=${gitHooksDir()}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "push.gpgsign=false",
    "-c",
    "merge.verifySignatures=false",
  ];
}

/** The environment every git subprocess here runs with — see the invariants above. */
function hardenedEnv(extraEnv: Record<string, string>): Record<string, string> {
  return {
    ...inheritedEnv(),
    // Set, never merely left out: libcurl reads `$HOME/.netrc` on its own — no git config can
    // turn that off — and falls back to the passwd entry's home when HOME is unset. A
    // non-directory closes it, so a fetch sent anonymously stays anonymous.
    HOME: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // Apple's git also loads a config file compiled into the binary — at scope `unknown`, so
    // GIT_CONFIG_SYSTEM does not reach it — and that file turns on the login keychain
    // (`credential.helper=osxkeychain`). This is the switch that skips it.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // GIT_TERMINAL_PROMPT disables only the TERMINAL prompt: GIT_ASKPASS (VS Code sets one
    // in every integrated terminal) is a separate channel that would still pop a GUI
    // credential dialog on a 401. The allowlist above already keeps it out; both askpass
    // vars are emptied anyway, so a git that reads one from its own config still fails
    // fast — proven live when a gateway test 401 popped a real VS Code prompt.
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
    // No ssh: BatchMode only stops a prompt, so an ssh URL would still authenticate with
    // whatever keys the machine offers. `file` stays — a bare local path is the file transport.
    GIT_ALLOW_PROTOCOL: "file:https:http",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    ...extraEnv,
    ...commandConfig(extraEnv),
  };
}

/**
 * The `GIT_CONFIG_COUNT` pairs a command runs with: `extraEnv`'s own, behind a
 * `credential.helper=` reset that is always pair 0. An empty value clears every helper
 * configured before it — the checkout's own `.git/config` included, which setup steps and the
 * agent can write — so the only credential git ever presents is one a caller injected as an
 * extraheader. Composed here rather than at each call site, so no caller can drop it by omission.
 * The allowlist keeps an ambient GIT_CONFIG_COUNT out.
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

/**
 * Builds a `Git` executor that traces every command it runs to `diag`.
 * `extraEnv` is the credential seam: `http.<origin>.extraheader` injected via
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` — command-line-precedence config
 * that the /dev/null hardening in `hardenedEnv` deliberately does NOT touch. Number the pairs
 * from 0: the executor puts its own `credential.helper` reset in front of them (`commandConfig`).
 * Never munge a URL instead:
 * `git clone` writes the remote URL into `.git/config`, where anything in the checkout
 * (the agent included) can read it back.
 */
export function makeGit(diag: GitTracer, extraEnv: Record<string, string> = {}): Git {
  return async (cwd: string, ...args: string[]): Promise<string> => {
    const started = performance.now();
    const cmd = command("git", {
      // `-c` before the subcommand applies to this invocation only — it is not written into a
      // clone's `.git/config`, verified against git 2.52 — so every command, clone included,
      // runs with the checkout's own hooks directory out of the picture.
      args: [...inertConfig(), ...args],
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      // The child environment is built, not inherited: without this, every git subprocess —
      // and every hook, credential helper and ssh it starts — would carry the runner's whole
      // environment, the brand-scoped credentials included.
      clearEnv: true,
      env: hardenedEnv(extraEnv),
    });
    const { code, stdout, stderr } = await cmd.output();
    const safeArgs = redact(args.join(" "));
    diag.debug("git.exec", {
      op: subcommand(args),
      args: safeArgs,
      code,
      ms: Math.round(performance.now() - started),
    });
    if (code !== 0) {
      const err = new TextDecoder().decode(stderr).trim();
      throw new Error(`git ${safeArgs} failed (exit ${code}): ${redact(err)}`);
    }
    return new TextDecoder().decode(stdout).trim();
  };
}

/** The subcommand of `args`, past any `-c <key>=<value>` pairs a caller leads with. */
function subcommand(args: readonly string[]): string | undefined {
  let at = 0;
  while (args[at] === "-c") at += 2;
  return args[at];
}

/**
 * Executes a git command in `cwd` and returns its stdout as git wrote it, untrimmed, or null once
 * stdout passes `maxBytes`: git is killed there, so a listing a committer made enormous costs this
 * process at most that much. Throws on a non-zero exit otherwise. For output whose size the repo
 * decides, like `ls-tree -r` of a directory anyone can commit to.
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
      args: [...inertConfig(), ...args],
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
      op: subcommand(args),
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
 * Reads blobs by id, byte for byte, through ONE `git cat-file --batch` process: the ids go in on
 * stdin and the `<oid> <type> <size>\n<bytes>\n` framing is parsed out of raw stdout. `Git` cannot
 * do this — it takes no stdin and decodes stdout as text, which would corrupt a binary blob.
 * Throws when an id is missing or not a blob, and once the content passes `maxBytes`, which the
 * caller has already checked against the sizes a listing gave; the bound here is the backstop, so
 * a lying listing still cannot make this hold more than that in memory.
 *
 * Restated from @ryph/forge's helpers/git_exec.ts, for this file's reason. Replace refs are
 * ignored here as everywhere (`GIT_NO_REPLACE_OBJECTS` in `hardenedEnv`): an id read here means
 * the object the repository holds under it, not one a `refs/replace/` entry substitutes for it.
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
      args: [...inertConfig(), "cat-file", "--batch"],
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

    // Written and read at once: with many ids the pipes fill both ways, and writing every id
    // before reading a byte would wait on git while git waits on us.
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
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of child.stdout) {
    total += chunk.length;
    if (total > ceiling) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      return null;
    }
    chunks.push(chunk);
  }
  return concat(chunks, total);
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

/** The silent `CatFileBatch`, for tests and fixtures. */
export const catFileBatch: CatFileBatch = makeCatFileBatch(SILENT);

/** The silent `GitBounded`, for tests and fixtures. */
export const gitBounded: GitBounded = makeGitBounded(SILENT);

/**
 * A URL should never carry credentials here (see core/types.ts invariants),
 * but if one ever does, keep it out of everything that leaves this module:
 * the trace line and the thrown error (whose message ends up in `Result.reason`).
 * Strips any user:pass@ — greedily through the LAST `@` before the path,
 * so an `@` inside the password cannot split the match and leak its tail.
 * Git's own stderr echoes the URL too, so failures pass through the same scrub.
 * Authorization headers (the extraEnv credential seam) are scrubbed to end of line for the
 * same reason: git echoes bad config values back in its errors. Exported so the gateway
 * transport can pass its own error messages through the same scrub.
 */
export function redact(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^/\s]*@/g, "$1***@")
    .replace(/(authorization:)[^\n]*/gi, "$1 ***");
}

/** A failure as the agent reads it inside a sentence: redacted, on one line, at most `max`
 * characters. */
export function briefError(err: unknown, max: number): string {
  const reason = redact(errorMessage(err)).replace(/\s+/g, " ").trim();
  return reason.length > max ? `${reason.slice(0, max)}…` : reason;
}
