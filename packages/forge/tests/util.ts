// Shared fixture kit: real repos on temp dirs, driven through the package's own hermetic git.

import { mkdir, writeFile } from "node:fs/promises";
import { serve } from "@ryph/service";
import { git } from "../src/helpers/git_exec.ts";
import { advertiseRefs, uploadPack } from "../src/helpers/http_backend.ts";
import type { Diagnostics } from "../src/ports/diagnostics.ts";
import { type ForgeApi, type ForgeRegistry, providerRegistry } from "../src/ports/forge_api.ts";

/** Commits as a fixed test identity — the hermetic env has no user config to fall back on. */
export function commit(dir: string, message: string): Promise<string> {
  return git(
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    message,
  );
}

/** Merges as the same fixed identity: a merge commit needs one as much as a commit does. */
export function merge(dir: string, ...args: string[]): Promise<string> {
  return git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", ...args);
}

/** A non-bare upstream repo with one commit on `main`; returns its head SHA.
 * `seed` varies the tree: two fixture repos made in the same second would otherwise produce
 * IDENTICAL commit SHAs (same tree, same message, same one-second timestamp) — a "foreign"
 * repo that isn't. */
export async function makeUpstream(dir: string, seed = "upstream"): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "--quiet", "-b", "main");
  // No housekeeping behind a commit: git detaches an auto gc/maintenance once enough loose
  // objects pile up (a 3000-file fixture does), and its writes race the test's cleanup into
  // "Directory not empty".
  await git(dir, "config", "gc.auto", "0");
  await git(dir, "config", "maintenance.auto", "false");
  // The same fixed identity `commit` and `merge` pass, for what a test runs bare in the upstream
  // (a rebase, an amend): `git` ignores the global config, and CI's image has no identity to
  // guess from its hostname.
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.com");
  await writeFile(`${dir}/README.md`, `# ${seed}\n`);
  await git(dir, "add", ".");
  await commit(dir, "initial commit");
  return await git(dir, "rev-parse", "HEAD");
}

/** A Diagnostics that records every event for assertion, silently. */
export function recordingDiagnostics() {
  const events: Array<{ level: "debug" | "warn"; event: string }> = [];
  const diag: Diagnostics = {
    debug: (event) => void events.push({ level: "debug", event }),
    warn: (event) => void events.push({ level: "warn", event }),
  };
  return { diag, events };
}

export function silentDiagnostics(): Diagnostics {
  return { debug() {}, warn() {} };
}

/**
 * `dir` over smart HTTP, speaking protocol v0 ONLY: the client's `Git-Protocol` header is
 * dropped, so upload-pack serves an id only when a ref names it exactly — the way a forge that
 * will not serve an unadvertised commit by id behaves. Close it with `shutdown`.
 */
export async function serveProtocolV0(dir: string) {
  const silent = { debug() {}, warn() {} };
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/info/refs")) return advertiseRefs(dir, null, silent);
    if (path.endsWith("/git-upload-pack")) {
      const headers = new Headers(req.headers);
      headers.delete("git-protocol");
      return uploadPack(
        dir,
        new Request(req.url, { method: "POST", headers, body: req.body }),
        { maxRequestBytes: 10 * 1024 * 1024, diag: silent },
      );
    }
    return new Response("nope", { status: 404 });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}/repo.git`,
    shutdown: () => server.shutdown(),
  };
}

/**
 * A pull request whose head was pushed over: `refs/pull/42/head` names a commit on top of the
 * one returned, and no branch names either. Answers the OLD head — reachable only through the
 * pull request's ref, and never a tip itself.
 */
export async function pushedOverPullRequest(upstream: string): Promise<string> {
  await git(upstream, "checkout", "--quiet", "-b", "contributor");
  await writeFile(`${upstream}/contribution.txt`, "first\n");
  await git(upstream, "add", ".");
  await commit(upstream, "contribute");
  const old = await git(upstream, "rev-parse", "HEAD");
  await writeFile(`${upstream}/contribution.txt`, "second\n");
  await git(upstream, "add", ".");
  await commit(upstream, "contribute again");
  await git(upstream, "update-ref", "refs/pull/42/head", "HEAD");
  await git(upstream, "checkout", "--quiet", "main");
  await git(upstream, "branch", "--quiet", "-D", "contributor");
  return old;
}

/**
 * A forge registry whose GitHub adapter fetches a row's URL exactly as given, anonymously — for
 * the gateway fixtures, whose "GitHub" upstream is a repository on disk. The gateway itself
 * refuses to fetch a non-network URL on its own say-so (http/fetch_auth.ts): only an adapter
 * may vouch for one, and this is the adapter that does, in tests.
 */
export function pathForges(): ForgeRegistry {
  const api = {
    upstreamUrl: (_repo: unknown, url: string) => url,
    fetchAuth: () => Promise.resolve(null),
  } as unknown as ForgeApi;
  return providerRegistry({ github: api }, "forge API");
}
