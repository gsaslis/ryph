// `ryph checks`: which repo a remote names, whether a commit goes the pushed way or in a bundle
// (and that the bundle is what the forge's intake accepts), the exit codes, the HTTP client's
// token handling, and the MCP server's framing — every network call against a stub fetch.

import { test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { command } from "@ryph/process";
import { join } from "@std/path";
import { ApiError, resolveClientConfig, RyphClient, UsageError } from "../src/api/client.ts";
import { ChecksClient, type SuiteView } from "../src/checks/api.ts";
import { reportFailure } from "../src/checks/cli.ts";
import {
  chooseSource,
  createBundle,
  defaultBase,
  normaliseBase,
  readLocalState,
  remoteAddress,
  remoteBranchHead,
  repoFromRemote,
  repoRoot,
} from "../src/checks/git.ts";
import { askForChecks, exitCodeFor, tail, waitFor } from "../src/checks/run.ts";
import { ryphServer } from "../src/mcp/server.ts";
import { serveStdio } from "../src/mcp/stdio.ts";

// ---- remotes ----------------------------------------------------------------------------------

test("a GitHub remote names owner/name, in every URL shape git accepts", () => {
  for (
    const url of [
      "https://github.com/acme/api.git",
      "https://github.com/acme/api",
      "https://github.com/acme/api/",
      "git@github.com:acme/api.git",
      "ssh://git@github.com/acme/api.git",
      "https://token@github.com/acme/api.git",
    ]
  ) {
    assertEquals(repoFromRemote(url), "acme/api", url);
  }
});

test("a Radicle remote names its RID", () => {
  const rid = "z3gqcJUoA1n9HaHKufZs5FCSGazv5";
  assertEquals(repoFromRemote(`rad://${rid}`), `rad:${rid}`);
  assertEquals(
    repoFromRemote(`rad://${rid}/z6MksFqXN3Yhqk8pTJdUGLwATkRfQvwZXPqR2qMEhbS9wzpT`),
    `rad:${rid}`,
  );
  assertEquals(repoFromRemote(`rad:${rid}`), `rad:${rid}`);
  assertEquals(repoFromRemote(`https://seed.radicle.example/${rid}.git`), `rad:${rid}`);
});

test("a GitLab remote names the project's full path, groups nested, on any host", () => {
  for (
    const [url, host] of [
      ["https://gitlab.com/acme/platform/api.git", "gitlab.com"],
      ["git@gitlab.com:acme/platform/api.git", "gitlab.com"],
      ["ssh://git@gitlab.com/acme/platform/api.git", "gitlab.com"],
      ["https://oauth2:tok@gitlab.com/acme/platform/api", "gitlab.com"],
      ["https://Git.Example.com/acme/platform/api.git", "git.example.com"],
      ["ssh://git@git.example.com:2222/acme/platform/api.git", "git.example.com:2222"],
      ["git@git.example.com:acme/platform/api.git", "git.example.com"],
    ] as const
  ) {
    assertEquals(remoteAddress(url), { host, repo: "acme/platform/api" }, url);
  }
  assertEquals(remoteAddress("https://gitlab.com/acme/api.git"), {
    host: "gitlab.com",
    repo: "acme/api",
  });
  const deepest = Array.from({ length: 20 }, (_, i) => `g${i}`).join("/");
  assertEquals(repoFromRemote(`https://gitlab.com/${deepest}.git`), deepest);
  assertEquals(repoFromRemote(`https://gitlab.com/${deepest}/one-more.git`), null);
});

test("a self-managed GitLab under a path prefix drops it from https remotes, not ssh ones", () => {
  const opts = { gitlabUrl: "https://git.example.com/GitLab/" };
  assertEquals(
    repoFromRemote("https://git.example.com/gitlab/acme/sub/api.git", opts),
    "acme/sub/api",
  );
  // ssh paths never carry the prefix.
  assertEquals(repoFromRemote("git@git.example.com:acme/sub/api.git", opts), "acme/sub/api");
  // Without the instance named, the prefix reads as a group.
  assertEquals(
    repoFromRemote("https://git.example.com/gitlab/acme/sub/api.git"),
    "gitlab/acme/sub/api",
  );
  // Another host keeps its path whole.
  assertEquals(
    repoFromRemote("https://other.example/gitlab/acme/api.git", opts),
    "gitlab/acme/api",
  );
});

test("a remote ryph cannot name is null, so the command asks for --repo", () => {
  assertEquals(repoFromRemote("/srv/git/api.git"), null);
  assertEquals(repoFromRemote("file:///srv/git/acme/api.git"), null);
  assertEquals(repoFromRemote("https://gitlab.example/api.git"), null);
  // GitHub has no nesting: a deeper path is not a repo.
  assertEquals(repoFromRemote("https://github.com/acme/api/extra.git"), null);
  // `-` is GitLab's route separator, `..` a climb.
  assertEquals(repoFromRemote("https://gitlab.com/acme/-/api.git"), null);
  assertEquals(repoFromRemote("https://gitlab.com/acme/../api.git"), null);
  assertEquals(repoFromRemote("not a url"), null);
});

// ---- a repository to read ---------------------------------------------------------------------

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const out = await command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/** A bare "forge" with main, and a clone of it on branch `feature` two commits past main. */
async function fixture(): Promise<{ dir: string; clone: string; mainSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ryph-checks-test-"));
  const bare = join(dir, "forge.git");
  const clone = join(dir, "clone");
  await sh(dir, "init", "--bare", "-b", "main", bare);
  await sh(dir, "clone", "--quiet", bare, clone);
  // Origin names the forge's repo; git reaches it at the bare one, as a mirror would.
  await sh(clone, "remote", "set-url", "origin", "https://github.com/acme/api.git");
  await sh(clone, "config", `url.${bare}.insteadOf`, "https://github.com/acme/api.git");
  await writeFile(join(clone, "a.txt"), "one\n");
  await sh(clone, "add", ".");
  await sh(clone, "commit", "--quiet", "-m", "one");
  await sh(clone, "push", "--quiet", "origin", "main");
  // A clone of an empty repo has no origin/HEAD; set it the way a normal clone would.
  await sh(clone, "remote", "set-head", "origin", "main");
  const mainSha = await sh(clone, "rev-parse", "HEAD");
  await sh(clone, "checkout", "--quiet", "-b", "feature");
  for (const n of ["two", "three"]) {
    await writeFile(join(clone, "a.txt"), `${n}\n`);
    await sh(clone, "commit", "--quiet", "-am", n);
  }
  return { dir, clone, mainSha };
}

test("the repository's state: branch, HEAD, the remote and whether the tree is dirty", async () => {
  const { dir, clone } = await fixture();
  try {
    const state = await readLocalState(clone);
    assertEquals(state.remote, "origin");
    assertEquals(state.branch, "feature");
    assertEquals(state.head, await sh(clone, "rev-parse", "HEAD"));
    assertEquals(state.dirty, false);
    // The configured URL, not the one insteadOf rewrites it to.
    assertEquals(state.repo, "acme/api");
    assertEquals(await defaultBase(clone, "origin"), "main");

    await writeFile(join(clone, "a.txt"), "edited\n");
    assertEquals((await readLocalState(clone)).dirty, true);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a detached HEAD is refused: an ask needs a branch", async () => {
  const { dir, clone } = await fixture();
  try {
    await sh(clone, "checkout", "--quiet", "--detach");
    await assertRejects(() => readLocalState(clone), Error, "detached");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("an unpushed branch goes as a bundle; once the remote's branch is HEAD, the pushed way", async () => {
  const { dir, clone } = await fixture();
  try {
    const state = await readLocalState(clone);
    assertEquals(await chooseSource(clone, state, { force: null }), "bundle");
    await sh(clone, "push", "--quiet", "origin", "feature");
    assertEquals(await chooseSource(clone, state, { force: null }), "pushed");
    // A commit past what was pushed is not on the forge yet.
    await sh(clone, "commit", "--quiet", "--allow-empty", "-m", "four");
    const moved = await readLocalState(clone);
    assertEquals(await chooseSource(clone, moved, { force: null }), "bundle");
    // The flags decide it outright.
    assertEquals(await chooseSource(clone, moved, { force: "pushed" }), "pushed");
    assertEquals(await chooseSource(clone, state, { force: "bundle" }), "bundle");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("the bundle's one ref is refs/heads/<branch>, and its prerequisite the merge-base", async () => {
  const { dir, clone, mainSha } = await fixture();
  try {
    const path = join(dir, "x.bundle");
    const prerequisite = await createBundle(clone, {
      remote: "origin",
      base: "main",
      branch: "feature",
      path,
    });
    assertEquals(prerequisite, mainSha);
    const heads = (await sh(clone, "bundle", "list-heads", path)).split("\n");
    assertEquals(heads, [`${await sh(clone, "rev-parse", "HEAD")} refs/heads/feature`]);
    const header = (await readFile(path, "utf8")).split("\n\n")[0];
    assertStringIncludes(header, `-${mainSha}`);

    // A repository that has main verifies it, which is what the forge's base cache does.
    const other = join(dir, "other");
    await sh(dir, "clone", "--quiet", join(dir, "forge.git"), other);
    await sh(other, "bundle", "verify", "--quiet", path);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a branch with nothing past the base still bundles its HEAD", async () => {
  const { dir, clone, mainSha } = await fixture();
  try {
    await sh(clone, "checkout", "--quiet", "-b", "same", "main");
    const path = join(dir, "same.bundle");
    const prerequisite = await createBundle(clone, {
      remote: "origin",
      base: "main",
      branch: "same",
      path,
    });
    // main's only commit is a root, so there is no parent to stand on: the whole history goes.
    assertEquals(prerequisite, null);
    assertEquals(await sh(clone, "bundle", "list-heads", path), `${mainSha} refs/heads/same`);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a Radicle repo gets a bundle even when the remote's branch is HEAD; --push still forces", async () => {
  const { dir, clone } = await fixture();
  try {
    await sh(clone, "push", "--quiet", "origin", "feature");
    const state = await readLocalState(clone);
    assertEquals(await chooseSource(clone, state, { force: null }), "pushed");
    assertEquals(
      await chooseSource(clone, state, { force: null, remoteProvesNothing: true }),
      "bundle",
    );
    assertEquals(
      await chooseSource(clone, state, { force: "pushed", remoteProvesNothing: true }),
      "pushed",
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

// The hung transport outlives git by design: what is killed is git, and the test is that the
// answer does not wait for its child.
test("a remote that does not answer in time reads as not pushed", async () => {
  const { dir, clone } = await fixture();
  try {
    // A remote whose transport hangs: `ext::` runs a command as the connection, and this one
    // never speaks. Allowed for this one command only.
    await sh(clone, "config", "protocol.ext.allow", "always");
    await sh(clone, "remote", "add", "hung", "ext::sleep 3");
    const started = Date.now();
    assertEquals(await remoteBranchHead(clone, "hung", "feature", 300), null);
    assert(Date.now() - started < 10_000, "killed at the timeout, not left to hang");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("--base is read as a branch name", async () => {
  const { dir, clone } = await fixture();
  try {
    // A remote named like a branch's first segment, and a local branch named like a tracking one.
    await sh(clone, "remote", "add", "release", join(dir, "forge.git"));
    await sh(clone, "branch", "origin/local", "main");
    await sh(clone, "update-ref", "refs/remotes/origin/local", "main");
    const remotes = ["origin", "release"];
    const norm = (base: string) => normaliseBase(clone, base, remotes);
    assertEquals(await norm("main"), "main");
    assertEquals(await norm("refs/heads/main"), "main");
    assertEquals(await norm("refs/heads/origin/x"), "origin/x");
    assertEquals(await norm("refs/remotes/origin/main"), "main");
    // origin/main tracks a branch this clone knows: the branch is main.
    assertEquals(await norm("origin/main"), "main");
    // `release` is a remote, but it tracks no 1.2: the branch is release/1.2.
    assertEquals(await norm("release/1.2"), "release/1.2");
    // A local branch of that very name wins over the tracking ref.
    assertEquals(await norm("origin/local"), "origin/local");
    assertEquals(await norm("fork/main"), "fork/main");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("the branch is the full ref's name, even beside a tag of the same name", async () => {
  const { dir, clone } = await fixture();
  try {
    await sh(clone, "checkout", "--quiet", "-b", "v1");
    await sh(clone, "tag", "v1");
    // `symbolic-ref --short` would say heads/v1 here.
    assertEquals((await readLocalState(clone)).branch, "v1");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("an agent's path names the repository to check, from any directory inside it", async () => {
  const { dir, clone } = await fixture();
  try {
    await mkdir(join(clone, "sub"));
    const top = await realpath(clone);
    assertEquals(await repoRoot(join(clone, "sub"), "/"), top);
    assertEquals(await repoRoot("clone/sub", dir), top);
    await assertRejects(() => repoRoot(join(dir, "nope"), "/"), Error, "not a directory");
    await assertRejects(() => repoRoot(dir, "/"), Error, "not inside a git repository");
  } finally {
    await rm(dir, { recursive: true });
  }
});

// ---- exit codes -------------------------------------------------------------------------------

const suite = (over: Partial<SuiteView> = {}): SuiteView => ({
  id: "cs-0000000001",
  repoRef: "acme/api",
  commit: "a".repeat(40),
  checksRef: "main",
  state: "running",
  reason: null,
  generation: 1,
  partial: false,
  detailsUrl: null,
  checks: [{ name: "test", state: "running", exitCode: null, hasLog: false, logTail: null }],
  ...over,
});

test("exit codes: 0 passed, 1 failed or error, 2 for everything else", () => {
  assertEquals(exitCodeFor({ kind: "suite", suite: suite({ state: "passed" }) }), 0);
  assertEquals(exitCodeFor({ kind: "suite", suite: suite({ state: "failed" }) }), 1);
  assertEquals(exitCodeFor({ kind: "suite", suite: suite({ state: "error" }) }), 1);
  assertEquals(exitCodeFor({ kind: "suite", suite: suite({ state: "cancelled" }) }), 2);
  assertEquals(exitCodeFor({ kind: "suite", suite: suite({ state: "running" }) }), 2);
  assertEquals(
    exitCodeFor({ kind: "no-suite", request: { id: "cq-1", state: "refused", suiteId: null } }),
    2,
  );
  assertEquals(exitCodeFor({ kind: "pending" }), 2);
});

test("with --json a failure is one JSON object on stdout too", () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) };
  assertEquals(reportFailure(new ApiError(403, "403: not allowed"), true, out), 3);
  assertEquals(JSON.parse(lines[0]), { error: "403: not allowed", status: 403 });
  assertEquals(reportFailure(new UsageError("set RYPH_URL\n\nUSAGE..."), true, out), 3);
  assertEquals(JSON.parse(lines[1]), { error: "set RYPH_URL" });
  assertEquals(reportFailure(new ApiError(409, "409: moved"), true, out), 2);
  assertEquals(reportFailure(new ApiError(0, "could not reach"), false, out), 2);
  assertEquals(lines.length, 3, "nothing on stdout without --json");
  assertEquals(errors.length, 4);
});

// ---- configuration ----------------------------------------------------------------------------

test("configuration: the environment wins over the settings file", async () => {
  const file = new Map([["RYPH_URL", "https://file.example"], ["RYPH_TOKEN", "ryph_pat_file"]]);
  assertEquals(
    await resolveClientConfig((n) => n === "RYPH_URL" ? "https://env.example" : undefined, file),
    { url: "https://env.example", token: "ryph_pat_file" },
  );
  await assertRejects(
    () => resolveClientConfig(() => undefined, new Map()),
    UsageError,
    "RYPH_URL and RYPH_TOKEN",
  );
  await assertRejects(
    () =>
      resolveClientConfig(() => undefined, new Map([["RYPH_URL", "ftp://x"], ["RYPH_TOKEN", "t"]])),
    UsageError,
    "http(s)",
  );
});

// ---- the HTTP client --------------------------------------------------------------------------

interface Seen {
  method: string;
  url: URL;
  authorization: string | null;
  body: Uint8Array | null;
}

/** A stub deployment: the token exchange, plus whatever `routes` answers. */
function stubFetch(
  routes: (req: Seen) => Response | undefined,
  opts: { expireFirst?: boolean } = {},
): { fetch: typeof globalThis.fetch; seen: Seen[]; exchanges: () => number } {
  const seen: Seen[] = [];
  let exchanges = 0;
  let expired = opts.expireFirst ?? false;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body == null
      ? null
      : new Uint8Array(await new Response(init.body).arrayBuffer());
    const req: Seen = {
      method: init?.method ?? "GET",
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    };
    seen.push(req);
    if (url.pathname === "/api/v1/auth/token") {
      exchanges++;
      return Response.json({ accessToken: `jwt-${exchanges}`, expiresIn: 900 });
    }
    if (expired) {
      expired = false;
      return Response.json({ error: "expired" }, { status: 401 });
    }
    return routes(req) ?? Response.json({ error: "not found" }, { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, seen, exchanges: () => exchanges };
}

test("the client exchanges the token once and talks to the app's /api", async () => {
  const stub = stubFetch((req) =>
    req.url.pathname === "/api/v1/check-suites/cs-1"
      ? Response.json({ suite: suite({ id: "cs-1" }) })
      : undefined
  );
  const client = new ChecksClient({
    url: "https://ryph.example/",
    token: "ryph_pat_x",
    fetch: stub.fetch,
  });
  await client.getSuite("cs-1");
  await client.getSuite("cs-1");
  assertEquals(stub.exchanges(), 1);
  assertEquals(
    stub.seen[0].body && new TextDecoder().decode(stub.seen[0].body),
    '{"token":"ryph_pat_x"}',
  );
  assertEquals(stub.seen[1].authorization, "Bearer jwt-1");
  assertEquals(client.suiteUrl("cs-1"), "https://ryph.example/checks/cs-1");
});

test("the deployment's GitLab instance is read from its forge providers", async () => {
  const stub = stubFetch((req) =>
    req.url.pathname === "/api/v1/forge-providers"
      ? Response.json({
        providers: ["gitlab"],
        github: null,
        gitlab: { mode: "bot", login: "ryph", url: "https://git.example.com/gitlab" },
      })
      : undefined
  );
  const client = new ChecksClient({
    url: "https://ryph.example",
    token: "ryph_pat_x",
    fetch: stub.fetch,
  });
  assertEquals(await client.gitlabUrl(), "https://git.example.com/gitlab");
  // A deployment without one, or that does not say, names none.
  const none = new ChecksClient({
    url: "https://ryph.example",
    token: "ryph_pat_x",
    fetch: stubFetch(() => undefined).fetch,
  });
  assertEquals(await none.gitlabUrl(), null);
});

test("a token refused right after it was minted is not minted again", async () => {
  const stub = stubFetch(() => Response.json({ suite: suite() }), { expireFirst: true });
  const client = new ChecksClient({
    url: "https://ryph.example",
    token: "ryph_pat_x",
    fetch: stub.fetch,
  });
  await assertRejects(() => client.getSuite("cs-1"), Error, "401");
  assertEquals(stub.exchanges(), 1);
});

test("an expired access token is renewed once and the request sent again", async () => {
  let refuseNext = false;
  let exchanges = 0;
  const fetch = ((input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/auth/token") {
      exchanges++;
      return Promise.resolve(Response.json({ accessToken: `jwt-${exchanges}`, expiresIn: 900 }));
    }
    if (refuseNext) {
      refuseNext = false;
      return Promise.resolve(Response.json({ error: "expired" }, { status: 401 }));
    }
    return Promise.resolve(Response.json({ suite: suite() }));
  }) as typeof globalThis.fetch;
  const client = new ChecksClient({ url: "https://ryph.example", token: "ryph_pat_x", fetch });
  await client.getSuite("cs-1");
  refuseNext = true;
  await client.getSuite("cs-1");
  assertEquals(exchanges, 2);
});

test("a refused API token is a configuration error with a plain message", async () => {
  const fetch = (() =>
    Promise.resolve(
      Response.json({ error: "nope" }, { status: 401 }),
    )) as unknown as typeof globalThis.fetch;
  const client = new ChecksClient({ url: "https://ryph.example", token: "ryph_pat_x", fetch });
  const err = await assertRejects(() => client.getSuite("cs-1"), Error, "RYPH_TOKEN was refused");
  assertEquals((err as { status?: number }).status, 401);
});

test("an unpushed branch is uploaded as a bundle to the bundle route", async () => {
  const { dir, clone } = await fixture();
  try {
    const stub = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites/bundle"
        ? Response.json({
          suite: suite({ id: "cs-9" }),
          request: { id: "cq-9", state: "active", suiteId: "cs-9" },
        }, {
          status: 201,
        })
        : undefined
    );
    const client = new ChecksClient({
      url: "https://ryph.example",
      token: "ryph_pat_x",
      fetch: stub.fetch,
    });
    const asked = await askForChecks(client, {
      cwd: clone,
      repo: "acme/api",
      checks: ["lint", "test"],
    });
    assertEquals(asked.source, "bundle");
    assertEquals(asked.answer.suite?.id, "cs-9");
    const upload = stub.seen.find((r) => r.url.pathname === "/api/v1/check-suites/bundle")!;
    assertEquals(upload.method, "POST");
    assertEquals(upload.url.searchParams.get("repo"), "acme/api");
    // The remote's host goes with it: acme/api may be connected on GitLab too.
    assertEquals(upload.url.searchParams.get("host"), "github.com");
    assertEquals(upload.url.searchParams.get("branch"), "feature");
    assertEquals(upload.url.searchParams.getAll("check"), ["lint", "test"]);
    // No --base: the server's default is the repo's own, so none is sent.
    assertEquals(upload.url.searchParams.get("base"), null);
    assertStringIncludes(new TextDecoder().decode(upload.body!.slice(0, 20)), "# v2 git bundle");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a --repo the remote does not name is sent without the remote's host", async () => {
  const { dir, clone } = await fixture();
  try {
    const stub = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites/bundle"
        ? Response.json({ suite: null, request: { id: "cq-8", state: "pending", suiteId: null } }, {
          status: 202,
        })
        : undefined
    );
    const client = new ChecksClient({
      url: "https://ryph.example",
      token: "ryph_pat_x",
      fetch: stub.fetch,
    });
    await askForChecks(client, { cwd: clone, repo: "other/repo" });
    const upload = stub.seen.find((r) => r.url.pathname === "/api/v1/check-suites/bundle")!;
    assertEquals(upload.url.searchParams.get("repo"), "other/repo");
    assertEquals(upload.url.searchParams.get("host"), null);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a pushed branch is asked for by commit on the JSON route", async () => {
  const { dir, clone } = await fixture();
  try {
    await sh(clone, "push", "--quiet", "origin", "feature");
    const stub = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites"
        ? Response.json({ suite: null, request: { id: "cq-3", state: "pending", suiteId: null } }, {
          status: 202,
        })
        : undefined
    );
    const client = new ChecksClient({
      url: "https://ryph.example",
      token: "ryph_pat_x",
      fetch: stub.fetch,
    });
    const asked = await askForChecks(client, { cwd: clone, repo: "acme/api", base: "main" });
    assertEquals(asked.source, "pushed");
    assertEquals(asked.answer.request.id, "cq-3");
    const post = stub.seen.find((r) => r.url.pathname === "/api/v1/check-suites")!;
    assertEquals(post.url.searchParams.get("host"), "github.com");
    assertEquals(JSON.parse(new TextDecoder().decode(post.body!)), {
      repo: "acme/api",
      commit: await sh(clone, "rev-parse", "HEAD"),
      branch: "feature",
      base: "main",
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a forced push the forge refuses as not its head says so plainly, and names --bundle", async () => {
  const { dir, clone } = await fixture();
  try {
    const stub = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites"
        ? Response.json(
          {
            error: "abc is not the head of feature on the forge; push it, or upload a bundle",
            code: "not-branch-head",
          },
          { status: 409 },
        )
        : undefined
    );
    const client = new ChecksClient({
      url: "https://ryph.example",
      token: "ryph_pat_x",
      fetch: stub.fetch,
    });
    const err = await assertRejects(
      () => askForChecks(client, { cwd: clone, force: "pushed" }),
      ApiError,
    );
    assertEquals(err.status, 409);
    assertStringIncludes(err.message, "409: abc is not the head of feature on the forge");
    assertEquals(err.code, "not-branch-head");
    assertStringIncludes(err.message, "--bundle");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("in auto mode a pushed ask refused as not the head falls back to a bundle, and says so", async () => {
  const { dir, clone } = await fixture();
  try {
    await sh(clone, "push", "--quiet", "origin", "feature");
    const stub = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites"
        ? Response.json({ error: "moved", code: "not-branch-head" }, { status: 409 })
        : req.url.pathname === "/api/v1/check-suites/bundle"
        ? Response.json({ suite: null, request: { id: "cq-8", state: "pending", suiteId: null } }, {
          status: 202,
        })
        : undefined
    );
    const client = new ChecksClient({
      url: "https://ryph.example",
      token: "ryph_pat_x",
      fetch: stub.fetch,
    });
    const asked = await askForChecks(client, { cwd: clone });
    assertEquals(asked.source, "bundle");
    assertEquals(asked.answer.request.id, "cq-8");
    assert(
      asked.warnings.some((w) => w.includes("sent as a bundle instead")),
      asked.warnings.join(),
    );
    assertEquals(
      stub.seen.filter((r) => r.url.pathname.startsWith("/api/v1/check-suites")).length,
      2,
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("any other 409 on a pushed ask is the answer, not a reason to send a bundle", async () => {
  const { dir, clone } = await fixture();
  try {
    await sh(clone, "push", "--quiet", "origin", "feature");
    const stub = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites"
        ? Response.json({ error: "the repo is no longer connected" }, { status: 409 })
        : undefined
    );
    const client = new ChecksClient({
      url: "https://ryph.example",
      token: "ryph_pat_x",
      fetch: stub.fetch,
    });
    const err = await assertRejects(() => askForChecks(client, { cwd: clone }), ApiError);
    assertEquals(err.message, "409: the repo is no longer connected");
    assertEquals(stub.seen.some((r) => r.url.pathname === "/api/v1/check-suites/bundle"), false);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a remote with several urls is read by its first, the one git fetches from", async () => {
  const { dir, clone } = await fixture();
  try {
    await sh(clone, "config", "--add", "remote.origin.url", "https://github.com/acme/other.git");
    assertEquals((await readLocalState(clone)).repo, "acme/api");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a --repo other than origin's goes as a bundle even when origin has the commit", async () => {
  const { dir, clone } = await fixture();
  try {
    await sh(clone, "push", "--quiet", "origin", "feature");
    const stub = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites/bundle"
        ? Response.json({ suite: null, request: { id: "cq-6", state: "pending", suiteId: null } }, {
          status: 202,
        })
        : undefined
    );
    const client = new ChecksClient({
      url: "https://ryph.example",
      token: "ryph_pat_x",
      fetch: stub.fetch,
    });
    assertEquals((await askForChecks(client, { cwd: clone, repo: "acme/fork" })).source, "bundle");
    // The same repo, spelled in another case, is still origin's.
    const json = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites"
        ? Response.json({ suite: null, request: { id: "cq-7", state: "pending", suiteId: null } }, {
          status: 202,
        })
        : undefined
    );
    const again = new ChecksClient({
      url: "https://ryph.example",
      token: "ryph_pat_x",
      fetch: json.fetch,
    });
    assertEquals((await askForChecks(again, { cwd: clone, repo: "Acme/API" })).source, "pushed");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("--base is normalised before it is sent", async () => {
  const { dir, clone } = await fixture();
  try {
    const stub = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites/bundle"
        ? Response.json({ suite: null, request: { id: "cq-5", state: "pending", suiteId: null } }, {
          status: 202,
        })
        : undefined
    );
    const client = new ChecksClient({
      url: "https://ryph.example",
      token: "ryph_pat_x",
      fetch: stub.fetch,
    });
    await askForChecks(client, { cwd: clone, repo: "acme/api", base: "origin/main" });
    const upload = stub.seen.find((r) => r.url.pathname === "/api/v1/check-suites/bundle")!;
    assertEquals(upload.url.searchParams.get("base"), "main");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("waiting on an ask follows it to its suite and the suite to its verdict", async () => {
  const reads: string[] = [];
  let requestReads = 0;
  let suiteReads = 0;
  const stub = stubFetch((req) => {
    reads.push(req.url.pathname);
    if (req.url.pathname === "/api/v1/check-requests/cq-1") {
      requestReads++;
      return Response.json(
        requestReads === 1
          ? { request: { id: "cq-1", state: "pending", suiteId: null }, suite: null }
          : {
            request: { id: "cq-1", state: "active", suiteId: "cs-1" },
            suite: suite({ id: "cs-1" }),
          },
      );
    }
    if (req.url.pathname === "/api/v1/check-suites/cs-1") {
      suiteReads++;
      return Response.json({
        suite: suiteReads < 3 ? suite({ id: "cs-1" }) : suite({
          id: "cs-1",
          state: "failed",
          checks: [{ name: "test", state: "failed", exitCode: 1, hasLog: true, logTail: "x" }],
        }),
      });
    }
  });
  const client = new ChecksClient({
    url: "https://ryph.example",
    token: "ryph_pat_x",
    fetch: stub.fetch,
  });
  const changes: string[] = [];
  const outcome = await waitFor(client, "cq-1", {
    sleep: () => Promise.resolve(),
    onChange: (now) => changes.push(now.state),
  });
  assertEquals(outcome.kind, "suite");
  assertEquals(exitCodeFor(outcome), 1);
  // The unchanged middle read prints nothing.
  assertEquals(changes, ["running", "failed"]);
});

test("an ask refused before it had a suite ends the wait without one", async () => {
  const stub = stubFetch(() =>
    Response.json({
      request: { id: "cq-2", state: "refused", suiteId: null, reason: "no checks" },
      suite: null,
    })
  );
  const client = new ChecksClient({
    url: "https://ryph.example",
    token: "ryph_pat_x",
    fetch: stub.fetch,
  });
  const outcome = await waitFor(client, "cq-2", { sleep: () => Promise.resolve() });
  assertEquals(outcome, {
    kind: "no-suite",
    request: { id: "cq-2", state: "refused", suiteId: null, reason: "no checks" },
  });
});

// ---- the checks tools of `ryph mcp` ---------------------------------------------------------

async function converse(
  frames: unknown[],
  fetch: typeof globalThis.fetch,
  cwd = process.cwd(),
): Promise<Array<Record<string, unknown>>> {
  // Held open until every request is answered: the input's end cancels whatever is in flight.
  // Everything but a notification is answered, a malformed message included.
  const notification = (f: unknown) =>
    f !== null && typeof f === "object" && "method" in f && !("id" in f);
  const requests = frames.filter((f) => !notification(f)).length;
  let answered = 0;
  let close = () => {};
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(f)}\n`));
      }
      close = () => controller.close();
      if (requests === 0) close();
    },
  });
  const chunks: Uint8Array[] = [];
  const output = new WritableStream<Uint8Array>({
    write: (c) => {
      chunks.push(c);
      for (const line of new TextDecoder().decode(c).split("\n")) {
        if (line !== "" && "id" in JSON.parse(line)) answered++;
      }
      if (answered === requests) close();
    },
  });
  const client = new RyphClient({ url: "https://ryph.example", token: "ryph_pat_x", fetch });
  await serveStdio(ryphServer(), {
    api: () => Promise.resolve(client),
    cwd,
    intervalMs: 0,
    input,
    output,
  });
  const text = new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));
  assert(text.endsWith("\n"), "every frame ends its line");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

test("mcp: initialize, tools/list and a checks_status call, one JSON frame per line", async () => {
  const log = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
  const stub = stubFetch((req) => {
    if (req.url.pathname === "/api/v1/check-suites/cs-7") {
      return Response.json({
        suite: suite({
          id: "cs-7",
          state: "failed",
          generation: 2,
          checks: [
            { name: "lint", state: "passed", exitCode: 0, hasLog: true, logTail: null },
            { name: "test", state: "failed", exitCode: 1, hasLog: true, logTail: "tail" },
          ],
        }),
      });
    }
    if (req.url.pathname === "/api/v1/check-suites/cs-7/log") {
      assertEquals(req.url.searchParams.get("generation"), "2");
      assertEquals(req.url.searchParams.get("check"), "test");
      return new Response(log, { headers: { "content-type": "text/plain" } });
    }
  });
  const replies = await converse([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "checks_status", arguments: { suiteId: "cs-7" } },
    },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } },
  ], stub.fetch);

  const byId = new Map(replies.map((r) => [r.id, r]));
  assertEquals(replies.length, 4, "the notification gets no answer");
  const init = byId.get(1)!.result as Record<string, unknown>;
  assertEquals(init.protocolVersion, "2025-03-26");
  assertEquals((init.serverInfo as { name: string }).name, "ryph");

  const tools = (byId.get(2)!.result as { tools: Array<{ name: string }> }).tools.map((t) =>
    t.name
  );
  assert(tools.includes("checks_run") && tools.includes("checks_status"));

  const call = byId.get(3)!.result as { content: Array<{ text: string }>; isError?: boolean };
  assertEquals(call.isError, undefined);
  const text = call.content[0].text;
  assertStringIncludes(text, "Suite cs-7: failed");
  assertStringIncludes(text, "https://ryph.example/checks/cs-7");
  assertStringIncludes(text, "- test: failed (exit 1)");
  assertStringIncludes(text, "line 200");
  assertStringIncludes(text, "line 51\n");
  assert(!text.includes("line 50\n"), "only the last 150 lines");

  // An unknown tool is a tool error the model reads, not a protocol error.
  assertEquals((byId.get(4)!.result as { isError: boolean }).isError, true);
});

test("mcp: a call that cannot be made is a tool error, not a dead server", async () => {
  const fetch = (() =>
    Promise.resolve(
      Response.json({ error: "nope" }, { status: 401 }),
    )) as unknown as typeof globalThis.fetch;
  const replies = await converse([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "checks_status", arguments: { suiteId: "cs-1" } },
    },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    "not json",
  ], fetch);
  const byId = new Map(replies.map((r) => [r.id, r]));
  const call = byId.get(1)!.result as { content: Array<{ text: string }>; isError?: boolean };
  assertEquals(call.isError, true);
  assertStringIncludes(call.content[0].text, "RYPH_TOKEN was refused");
  assertEquals(byId.get(2)!.result, {});
  // A JSON string is valid JSON but not a request.
  assertEquals((byId.get(null)!.error as { code: number }).code, -32600);
});

test("mcp: checks_run asks about the repository its path names, not the server's directory", async () => {
  const { dir, clone } = await fixture();
  try {
    await mkdir(join(clone, "sub"));
    const stub = stubFetch((req) =>
      req.url.pathname === "/api/v1/check-suites/bundle"
        ? Response.json({ suite: null, request: { id: "cq-4", state: "pending", suiteId: null } }, {
          status: 202,
        })
        : undefined
    );
    const call = (args: Record<string, unknown>) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "checks_run", arguments: { wait: false, ...args } },
    });
    // Started outside any repository, as a client started in another checkout would be.
    const [outside] = await converse([call({})], stub.fetch, dir);
    assertEquals((outside.result as { isError?: boolean }).isError, true);
    const [inside] = await converse([call({ path: join(clone, "sub") })], stub.fetch, dir);
    const text = (inside.result as { content: Array<{ text: string }> }).content[0].text;
    assertStringIncludes(text, "(feature) in acme/api");
    assertStringIncludes(text, "cq-4");
    const upload = stub.seen.find((r) => r.url.pathname === "/api/v1/check-suites/bundle")!;
    assertEquals(upload.url.searchParams.get("branch"), "feature");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("tail keeps the last lines", () => {
  assertEquals(tail("a\nb\nc\n", 2), "b\nc");
  assertEquals(tail("a", 5), "a");
});
