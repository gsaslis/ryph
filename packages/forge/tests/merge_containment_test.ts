// The merge containment read: which pushed heads a merge contained, answered by git against the
// repo cache — through the pure handler, with real git on temp dirs. The properties pinned here
// are the ones a settle rests on: an older head merged leaves the newer one missed, a push that
// raced the merge or was force-pushed away is never contained, and nothing that could not be
// answered is ever answered "contained".

import { test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { type ForgeApi, providerRegistry } from "../src/ports/forge_api.ts";
import { git, makeGitInput } from "../src/helpers/git_exec.ts";
import { anonymous } from "../src/ports/repo_cache.ts";
import { containedIn, NotACommit } from "../src/helpers/containment.ts";
import { commit, makeUpstream, merge, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";
const REPO = { provider: "github", repoRef: "acme/app", tenantId: "42" };

async function build(root: string, config: Partial<AppDeps["config"]> = {}) {
  const diag = silentDiagnostics();
  await mkdir(`${root}/staging`, { recursive: true });
  const never = () => Promise.reject(new Error("not part of this surface"));
  const api = {
    upstreamUrl: (_repo: unknown, url: string) => url,
    fetchAuth: () => Promise.resolve(null),
  } as unknown as ForgeApi;
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: providerRegistry({ github: api }, "forge API"),
    transports: providerRegistry({ github: { deliver: never } }, "change transport"),
    serviceToken: SERVICE_TOKEN,
    config: {
      maxUploadPackBytes: 1024,
      maxBundleBytes: 1024,
      stagingDir: `${root}/staging`,
      ...config,
    },
  };
  const handler = makeHandler(deps);
  /** The answer, its `intoTip` left out unless `withTip`: most tests judge the partition alone. */
  return async (body: Record<string, unknown>, withTip = false) => {
    const res = await handler(
      new Request("http://forge/v1/service/merge-containment", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SERVICE_TOKEN}`,
        },
        body: JSON.stringify({ repo: REPO, into: "main", ...body }),
      }),
    );
    const answer = await res.json();
    if (!withTip) delete answer.intoTip;
    return { status: res.status, body: answer };
  };
}

/** One commit on the upstream's current branch; answers it. */
async function work(dir: string, file: string): Promise<string> {
  await writeFile(`${dir}/${file}`, `${file}\n`);
  await git(dir, "add", ".");
  await commit(dir, `add ${file}`);
  return await git(dir, "rev-parse", "HEAD");
}

async function withRoot(fn: (root: string, upstream: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    await fn(root, upstream);
  } finally {
    await rm(root, { recursive: true });
  }
}

test("an older head merged contains itself and its ancestors, never the newer push", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const base = await git(upstream, "rev-parse", "HEAD");
    // Two pushes onto one change request: the second on top of the first.
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const first = await work(upstream, "one.md");
    const second = await work(upstream, "two.md");

    const older = await ask({ url: upstream, mergedHeads: [first], heads: [first, second, base] });
    assertEquals(older, {
      status: 200,
      body: { contained: [first, base], missed: [second] },
    });

    // The latest merged: everything it carries is contained, each head answered once.
    const latest = await ask({
      url: upstream,
      mergedHeads: [second],
      heads: [second, first, first],
    });
    assertEquals(latest.body, {
      contained: [second, first],
      missed: [],
    });
  });
});

test("the answer carries the tip of `into` it was read against, and none where none was named", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const head = await work(upstream, "feature.md");
    await git(upstream, "checkout", "--quiet", "main");
    await merge(upstream, "--quiet", "--no-ff", "feat");
    const tip = await git(upstream, "rev-parse", "HEAD");
    const named = await ask({ url: upstream, mergedHeads: [head], heads: [head] }, true);
    assertEquals(named.body, { contained: [head], missed: [], intoTip: tip });
    const none = await ask(
      { url: upstream, mergedHeads: [head], heads: [head], into: undefined },
      true,
    );
    assertEquals(none.body, { contained: [head], missed: [] });
  });
});

test("a squash merge is judged by the head that was merged, not the commit it made", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const head = await work(upstream, "feature.md");
    await git(upstream, "checkout", "--quiet", "main");
    await git(upstream, "merge", "--quiet", "--squash", "feat");
    await commit(upstream, "the feature, squashed");
    // A push that raced the merge lands on the head branch after it.
    await git(upstream, "checkout", "--quiet", "feat");
    const raced = await work(upstream, "late.md");

    const res = await ask({ url: upstream, mergedHeads: [head], heads: [head, raced] });
    assertEquals(res.body, { contained: [head], missed: [raced] });
  });
});

test("a push force-pushed away is missed, whether or not the cache ever saw it", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const base = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const dropped = await work(upstream, "dropped.md");
    // A person rewrites the branch without it, and that is what merges.
    await git(upstream, "reset", "--hard", "--quiet", base);
    const kept = await work(upstream, "kept.md");

    // The cache has never held `dropped`: no history it holds can contain it.
    const unseen = await ask({ url: upstream, mergedHeads: [kept], heads: [dropped, kept] });
    assertEquals(unseen.body, {
      contained: [kept],
      missed: [dropped],
    });

    // Now held (an earlier read fetched it), and still in no merged head's history.
    const held = await ask({ url: upstream, mergedHeads: [dropped], heads: [dropped] });
    assertEquals(held.body, { contained: [dropped], missed: [] });
    const again = await ask({ url: upstream, mergedHeads: [kept], heads: [dropped, kept] });
    assertEquals(again.body, {
      contained: [kept],
      missed: [dropped],
    });
  });
});

test("several merged heads: a head is contained when ANY of them holds it", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const base = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "-b", "one");
    const one = await work(upstream, "one.md");
    await git(upstream, "checkout", "--quiet", "-b", "two", base);
    const two = await work(upstream, "two.md");
    await git(upstream, "checkout", "--quiet", "-b", "three", base);
    const three = await work(upstream, "three.md");

    const res = await ask({ url: upstream, mergedHeads: [one, two], heads: [three, two, one] });
    assertEquals(res.body, {
      contained: [two, one],
      missed: [three],
    });
  });
});

test("what cannot be answered is never contained: a missing merged head, an upstream away", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const head = await git(upstream, "rev-parse", "HEAD");

    // The upstream answered, and holds no such commit: terminal, and said as such.
    const missing = await ask({ url: upstream, mergedHeads: ["f".repeat(40)], heads: [head] });
    assertEquals(missing.status, 404);
    assertEquals(missing.body.kind, "missing-merged-head");
    assertEquals(missing.body.terminal, true);

    // One merged head absent, another present, and it contains every head: that stands.
    const covered = await ask({
      url: upstream,
      mergedHeads: ["f".repeat(40), head],
      heads: [head],
    });
    assertEquals(covered, {
      status: 200,
      body: { contained: [head], missed: [] },
    });
    // A head the present one does not contain might be in the absent one: not "missed", but
    // worth asking again.
    const partly = await ask({
      url: upstream,
      mergedHeads: ["f".repeat(40), head],
      heads: [head, "e".repeat(40)],
    });
    assertEquals(partly.status, 502);
    assertEquals(partly.body.terminal, false);

    // No upstream to ask at all: worth asking again, never an answer.
    const away = await ask({ url: `${root}/nowhere`, mergedHeads: [head], heads: [head] });
    assertEquals(away.status, 502);
    assertEquals(away.body.terminal, false);

    // A question this version cannot read never reaches git.
    for (
      const body of [
        { url: upstream, mergedHeads: [], heads: [head] },
        { url: upstream, mergedHeads: [head], heads: [] },
        { url: upstream, mergedHeads: ["main"], heads: [head] },
        { url: upstream, mergedHeads: [head], heads: [head], extra: 1 },
      ]
    ) {
      const refused = await ask(body);
      assertEquals(refused.status, 400, JSON.stringify(body));
    }
    // The bases are the runner's word, relayed: a bad entry is dropped, never the question.
    for (
      const bases of [{ [head]: "main" }, { main: head }, { [head]: 7 }, "main", [head], null]
    ) {
      const lenient = await ask({ url: upstream, mergedHeads: [head], heads: [head], bases });
      assertEquals(
        lenient,
        { status: 200, body: { contained: [head], missed: [] } },
        JSON.stringify(bases),
      );
    }
  });
});

test("git failing to answer is thrown, never read as contained or missed", async () => {
  const failing = (code: number) => (_cwd: string, ...args: string[]) =>
    Promise.reject(new Error(`git ${args[0]} failed (exit ${code}): boom`));
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  /** `cat-file --batch-check` answering every id as `type`. */
  const typed = (type: string) => (_cwd: string, input: string) =>
    Promise.resolve(input.split("\n").filter(Boolean).map((id) => `${id} ${type}`).join("\n"));
  const nothingAbsent = () =>
    Promise.resolve({ absent: new Set<string>(), notCommits: new Set<string>() });
  await assertRejects(() =>
    containedIn(
      { git: failing(128), gitInput: () => Promise.reject(new Error("boom")) },
      "/x",
      [a],
      [b],
      nothingAbsent,
    )
  );
  // Held, then the ancestry question fails in a way that is not git's "no".
  await assertRejects(() =>
    containedIn({ git: failing(128), gitInput: typed("commit") }, "/x", [a], [b], nothingAbsent)
  );
  // A head that cannot be fetched for want of an upstream is no "missed" either.
  await assertRejects(() =>
    containedIn(
      { git: failing(1), gitInput: typed("missing") },
      "/x",
      [a],
      [b],
      () => Promise.reject(new Error("upstream away")),
    )
  );
  // Every head judged missed, and a merged head gone from under the answer: thrown.
  let checks = 0;
  const goneLater = (_cwd: string, input: string) =>
    typed(checks++ === 0 ? "commit" : "missing")(_cwd, input);
  // Every question git's "no" (exit 1), but trees, which differ.
  const no = (_cwd: string, ...args: string[]) =>
    args[0] === "rev-parse" ? Promise.resolve(`tree of ${args.at(-1)}`) : failing(1)(_cwd, ...args);
  await assertRejects(
    () => containedIn({ git: no, gitInput: goneLater }, "/x", [a], [b], nothingAbsent),
    Error,
    "no longer in the cache",
  );
  // An id that names a tree is no question git can answer, now or later.
  await assertRejects(
    () => containedIn({ git: failing(1), gitInput: typed("tree") }, "/x", [a], [b], nothingAbsent),
    NotACommit,
  );
});

test("a git with no `merge-tree --merge-base` (older than 2.40) fails the read, never misses a head", async () => {
  await withRoot(async (_root, upstream) => {
    const base = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const head = await work(upstream, "one.md");
    // A person rebases the change request onto a moved main and squashes it: the head's change
    // is replayed onto where the merged head left main, which needs `--merge-base`.
    await moveMain(upstream);
    const rebased = await rebaseFeat(upstream);
    await git(upstream, "checkout", "--quiet", "main");
    await merge(upstream, "--quiet", "--squash", "feat");
    await commit(upstream, "the feature, squashed");
    const tip = await git(upstream, "rev-parse", "HEAD");
    // Its usage error, as git 2.39 prints it.
    const old = (cwd: string, ...args: string[]) =>
      args[0] === "merge-tree" && args.some((a) => a.startsWith("--merge-base"))
        ? Promise.reject(new Error(`git ${args.join(" ")} failed (exit 129): unknown option`))
        : git(cwd, ...args);
    const held = () =>
      Promise.resolve({ absent: new Set<string>(), notCommits: new Set<string>() });
    await assertRejects(
      () =>
        containedIn(
          { git: old, gitInput: makeGitInput(silentDiagnostics()) },
          upstream,
          [rebased],
          [head],
          held,
          { [head]: base },
          tip,
        ),
      Error,
      "exit 129",
    );
  });
});

/** Rewrites the upstream's `feat` the way GitHub's "Update branch" (rebase) does: onto `main`'s
 * tip, every commit replayed with a new id. Answers the new head. */
async function rebaseFeat(upstream: string): Promise<string> {
  await git(upstream, "checkout", "--quiet", "feat");
  await git(upstream, "rebase", "--quiet", "main");
  return await git(upstream, "rev-parse", "HEAD");
}

/** One commit on `main` that the change request's branch does not have. */
async function moveMain(upstream: string): Promise<void> {
  await git(upstream, "checkout", "--quiet", "main");
  await work(upstream, "elsewhere.md");
}

test("a branch rebased before its squash merge contains every push by content", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const first = await work(upstream, "one.md");
    const second = await work(upstream, "two.md");
    await moveMain(upstream);
    const rebased = await rebaseFeat(upstream);
    await git(upstream, "checkout", "--quiet", "main");
    await git(upstream, "merge", "--quiet", "--squash", "feat");
    await commit(upstream, "the feature, squashed");

    // Neither push is in the merged head's history, and the cache has never held either: both
    // are fetched by id and found merged by what they change.
    const res = await ask({ url: upstream, mergedHeads: [rebased], heads: [first, second] });
    assertEquals(res.body, {
      contained: [first, second],
      missed: [],
    });
  });
});

test("a rewrite that dropped a push, whole or in part, leaves it missed", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const first = await work(upstream, "one.md");
    await writeFile(`${upstream}/two.md`, "two\n");
    await writeFile(`${upstream}/three.md`, "three\n");
    await git(upstream, "add", ".");
    await commit(upstream, "two and three");
    const second = await git(upstream, "rev-parse", "HEAD");
    await moveMain(upstream);

    // Rebased, and the second push dropped whole.
    await git(upstream, "checkout", "--quiet", "-b", "whole", "feat~1");
    await git(upstream, "rebase", "--quiet", "main");
    const withoutSecond = await git(upstream, "rev-parse", "HEAD");
    const whole = await ask({
      url: upstream,
      mergedHeads: [withoutSecond],
      heads: [first, second],
    });
    assertEquals(whole.body, {
      contained: [first],
      missed: [second],
    });

    // Rebased, and half of the second push dropped: still missed, since merging it would add
    // what was dropped. And so is the first, whose change is now only a part of what merged.
    await git(upstream, "checkout", "--quiet", "-b", "part", "feat");
    await git(upstream, "rebase", "--quiet", "main");
    await git(upstream, "rm", "--quiet", "three.md");
    await git(upstream, "commit", "--quiet", "--amend", "--no-edit");
    const withHalf = await git(upstream, "rev-parse", "HEAD");
    const part = await ask({ url: upstream, mergedHeads: [withHalf], heads: [first, second] });
    assertEquals(part.body, { contained: [], missed: [first, second] });
  });
});

test("a containment read pins nothing: what was force-pushed away is the cache's to prune", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const base = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const leaked = await work(upstream, "secret.md");
    await moveMain(upstream);
    const rebased = await rebaseFeat(upstream);
    // A person removes the push upstream; what merges is the branch without it.
    await git(upstream, "checkout", "--quiet", "-B", "feat", base);
    const kept = await work(upstream, "kept.md");

    const res = await ask({ url: upstream, mergedHeads: [kept], heads: [leaked, rebased] });
    assertEquals(res.body.missed, [leaked, rebased]);

    const [entry] = await readdir(`${root}/cache`);
    const dir = `${root}/cache/${entry}`;
    assertEquals(await git(dir, "for-each-ref", "--format=%(refname)"), "");
    await assertRejects(() => git(dir, "config", "--get", "uploadpack.hideRefs"));
    // Nothing reaches the removed push in the entry, so git's own gc prunes it.
    await git(dir, "gc", "--quiet", "--prune=now");
    await assertRejects(() => git(dir, "cat-file", "-e", `${leaked}^{commit}`));
  });
});

test("a held entry takes no fetch until the read holding it is done", async () => {
  await withRoot(async (root, upstream) => {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    const head = await git(upstream, "rev-parse", "HEAD");
    let release = () => {};
    const released = new Promise<void>((resolve) => release = resolve);
    let entered = () => {};
    const inside = new Promise<void>((resolve) => entered = resolve);
    const order: string[] = [];
    const reading = cache.withHeld({ url: upstream }, anonymous, async (entry) => {
      await entry.hold([head]);
      entered();
      await released;
      order.push("read done");
    });
    await inside;
    const fetching = cache.ensureCommit({ url: upstream }, head, anonymous).then(() => {
      order.push("fetch done");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(order.length === 0);
    release();
    await Promise.all([reading, fetching]);
    assertEquals(order, ["read done", "fetch done"]);
  });
});

const AS_TEST = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

/** One commit on the current branch writing `content` to `file`, authored at `date`. */
async function workAt(dir: string, file: string, content: string, message: string, date: string) {
  await writeFile(`${dir}/${file}`, content);
  await git(dir, "add", ".");
  await git(dir, ...AS_TEST, "commit", "--quiet", `--date=${date}`, "-m", message);
  return await git(dir, "rev-parse", "HEAD");
}

/**
 * A change request whose first push edits `shared.md`, which `main` then edits too, and whose
 * second push adds `two.md`. Answers both pushes, with `main` checked out.
 */
async function conflictingPushes(upstream: string) {
  const date = "2026-01-01T00:00:00+0000";
  await workAt(upstream, "shared.md", "base\n", "shared", date);
  await git(upstream, "checkout", "--quiet", "-b", "feat");
  const first = await workAt(upstream, "shared.md", "feat\n", "feat edit", date);
  const second = await workAt(upstream, "two.md", "two\n", "add two", date);
  await git(upstream, "checkout", "--quiet", "main");
  await workAt(upstream, "shared.md", "main\n", "main edit", date);
  return { first, second };
}

/** Rebases `branch` onto `main`, resolving the conflict on `shared.md` by hand. Answers its head. */
async function rebaseResolving(upstream: string, branch: string): Promise<string> {
  await git(upstream, "checkout", "--quiet", branch);
  await git(upstream, ...AS_TEST, "rebase", "--quiet", "main").catch(() => {});
  await writeFile(`${upstream}/shared.md`, "main and feat\n");
  await git(upstream, "add", "shared.md");
  await git(upstream, ...AS_TEST, "-c", "core.editor=true", "rebase", "--continue");
  return await git(upstream, "rev-parse", "HEAD");
}

test("a rebase whose conflict a person resolved over the head's own lines leaves it missed", async () => {
  for (const style of ["squash", "merge commit"] as const) {
    await withRoot(async (root, upstream) => {
      const ask = await build(root);
      const { first, second } = await conflictingPushes(upstream);
      const rebased = await rebaseResolving(upstream, "feat");
      await git(upstream, "checkout", "--quiet", "main");
      if (style === "squash") {
        await merge(upstream, "--quiet", "--squash", "feat");
        await commit(upstream, "the feature, squashed");
      } else {
        await merge(upstream, "--quiet", "--no-ff", "-m", "merge feat", "feat");
      }

      // What merged holds the person's version of the first push's line, not the agent's: the
      // agent's change is not there, so both pushes ride the next generation (a replay, never a
      // skip). Measured past the first, the second push's own commit merged untouched, but what
      // merged changed more than that: the person's line too. Not the same change: missed.
      const res = await ask({ url: upstream, mergedHeads: [rebased], heads: [first, second] });
      assertEquals(res.body, { contained: [], missed: [first, second] }, style);
      const past = await ask({
        url: upstream,
        mergedHeads: [rebased],
        heads: [second],
        bases: { [second]: first },
      });
      assertEquals(past.body, { contained: [], missed: [second] }, style);
    });
  }
});

test("a conflict on adjacent lines, resolved by keeping both, is still git's conflict: missed", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const date = "2026-01-01T00:00:00+0000";
    await workAt(upstream, "f.md", "1\n2\n3\n4\n", "lines", date);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const head = await workAt(upstream, "f.md", "1\n2 feat\n3\n4\n", "feat", date);
    await git(upstream, "checkout", "--quiet", "main");
    await workAt(upstream, "f.md", "1\n2\n3 main\n4\n", "main", date);
    await git(upstream, "checkout", "--quiet", "feat");
    await git(upstream, ...AS_TEST, "rebase", "--quiet", "main").catch(() => {});
    // Both lines kept: the agent's change is in what merged, word for word.
    await writeFile(`${upstream}/f.md`, "1\n2 feat\n3 main\n4\n");
    await git(upstream, "add", "f.md");
    await git(upstream, ...AS_TEST, "-c", "core.editor=true", "rebase", "--continue");
    const rebased = await git(upstream, "rev-parse", "HEAD");

    // Git's merge calls changes to adjacent lines a conflict however they were resolved, so
    // neither rule can show the change merged. The replay costs the agent that same conflict.
    const res = await ask({ url: upstream, mergedHeads: [rebased], heads: [head] });
    assertEquals(res.body, { contained: [], missed: [head] });
  });
});

test("a conflict-resolved rebase that dropped a push leaves it missed", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const { first, second } = await conflictingPushes(upstream);
    await git(upstream, "checkout", "--quiet", "-b", "short", first);
    const rebased = await rebaseResolving(upstream, "short");

    const res = await ask({
      url: upstream,
      mergedHeads: [rebased],
      heads: [second],
      bases: { [second]: first },
    });
    assertEquals(res.body, { contained: [], missed: [second] });
  });
});

test("an amended head is missed: the same author, date, message and paths, and more work", async () => {
  for (const rebased of [false, true]) {
    await withRoot(async (root, upstream) => {
      const ask = await build(root);
      const date = "2026-01-01T00:00:00+0000";
      const base = await workAt(upstream, "shared.md", "base\n", "shared", date);
      await git(upstream, "checkout", "--quiet", "-b", "feat");
      const head = await workAt(upstream, "one.md", "one\n", "add one", date);
      // The agent amends its commit: the same everything, and a line more.
      await git(upstream, "checkout", "--quiet", "-b", "amended", base);
      const amended = await workAt(upstream, "one.md", "one\nextra\n", "add one", date);
      // What merged is the first head, as pushed or rebased onto a moved main.
      let merged = head;
      if (rebased) {
        await moveMain(upstream);
        merged = await rebaseFeat(upstream);
      }

      const res = await ask({
        url: upstream,
        mergedHeads: [merged],
        heads: [head, amended],
        bases: { [head]: base, [amended]: base },
      });
      assertEquals(res.body, {
        contained: [head],
        missed: [amended],
      }, `rebased: ${rebased}`);
    });
  }
});

test("commits of the head that overlap each other, rebased cleanly, are contained", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const date = "2026-01-01T00:00:00+0000";
    const base = await workAt(upstream, "shared.md", "base\n", "shared", date);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    // The second commit rewrites the first's line: neither commit's own change applies to
    // what merged alone, but the head's whole change does.
    await workAt(upstream, "one.md", "one\n", "add one", date);
    const head = await workAt(upstream, "one.md", "one, again\n", "edit one", date);
    await moveMain(upstream);
    const rebased = await rebaseFeat(upstream);

    const res = await ask({
      url: upstream,
      mergedHeads: [rebased],
      heads: [head],
      bases: { [head]: base },
    });
    assertEquals(res.body, { contained: [head], missed: [] });
  });
});

test("own work is bounded by the head's base: a person's squash of their own commits beneath it", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const date = "2026-01-01T00:00:00+0000";
    await workAt(upstream, "shared.md", "base\n", "shared", date);
    // A person's change request: two commits of theirs, the second over the first's line.
    await git(upstream, "checkout", "--quiet", "-b", "theirs");
    await workAt(upstream, "shared.md", "theirs one\n", "theirs one", date);
    const theirs = await workAt(upstream, "shared.md", "theirs two\n", "theirs two", date);
    // The agent's patch, built on the person's head.
    const head = await workAt(upstream, "agent.md", "agent\n", "agent work", date);
    // Main moves over the same line; the person squashes their two commits onto it, resolving,
    // and lands that first. Then the agent's commit goes on top, as its own change request.
    await git(upstream, "checkout", "--quiet", "main");
    const mainEdit = await workAt(upstream, "shared.md", "main\n", "main edit", date);
    await workAt(upstream, "shared.md", "main and theirs\n", "theirs, squashed", date);
    await git(upstream, "checkout", "--quiet", "-b", "landed");
    await git(upstream, ...AS_TEST, "cherry-pick", head);
    const merged = await git(upstream, "rev-parse", "HEAD");

    // With no base, the person's own commits count as the head's, and their change is not what
    // merged: missed. Past its base, the head's own work is the agent's commit alone, exactly
    // what merged past where it left main.
    const unbounded = await ask({ url: upstream, mergedHeads: [merged], heads: [head] });
    assertEquals(unbounded.body, { contained: [], missed: [head] });
    const bounded = await ask({
      url: upstream,
      mergedHeads: [merged],
      heads: [head],
      bases: { [head]: theirs },
    });
    assertEquals(bounded.body, { contained: [head], missed: [] });
    // A base the upstream does not have (a 64-digit id included, which git cannot even ask a
    // SHA-1 repository for: "couldn't find remote ref"), one that is no commit id, or one that is
    // no ancestor of the head, is as good as none.
    for (const base of ["e".repeat(40), "e".repeat(64), "main", mainEdit]) {
      const none = await ask({
        url: upstream,
        mergedHeads: [merged],
        heads: [head],
        bases: { [head]: base },
      });
      assertEquals(none.body, { contained: [], missed: [head] }, base);
    }
  });
});

test("a push that undid part of a merged head's work is missed, measured from its base", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const date = "2026-01-01T00:00:00+0000";
    const lines = (...ls: string[]) => ls.join("\n") + "\n";
    const base = await workAt(upstream, "f.ts", lines("1", "2", "3", "4", "5"), "file", date);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const first = await workAt(
      upstream,
      "f.ts",
      lines("1", "feature", "3", "4", "console.log(debug)"),
      "feature, with a debug line",
      date,
    );
    // The second push drops the debug line on review; the first is what merged.
    const second = await workAt(
      upstream,
      "f.ts",
      lines("1", "feature", "3", "4", "5"),
      "drop the debug line",
      date,
    );
    // And a third that takes all of it back.
    const reverted = await workAt(upstream, "f.ts", lines("1", "2", "3", "4", "5"), "revert", date);

    // From the base, the second push's net change (the feature) is in what merged; but what
    // merged still holds the line it dropped, so it did not merge. Measured from where the two
    // meet, base given or not.
    const heads = [first, second, reverted];
    for (const bases of [undefined, Object.fromEntries(heads.map((h) => [h, base]))]) {
      const res = await ask({ url: upstream, mergedHeads: [first], heads, bases });
      assertEquals(res.body, { contained: [first], missed: [second, reverted] });
    }
  });
});

test("a force-push that dropped part of a commit's change leaves it missed, base or not", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const base = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    await writeFile(`${upstream}/two.md`, "two\n");
    await writeFile(`${upstream}/three.md`, "three\n");
    await git(upstream, "add", ".");
    await commit(upstream, "two and three");
    const head = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "rm", "--quiet", "three.md");
    await git(upstream, "commit", "--quiet", "--amend", "--no-edit");
    const merged = await git(upstream, "rev-parse", "HEAD");

    for (const bases of [undefined, { [head]: base }]) {
      const res = await ask({ url: upstream, mergedHeads: [merged], heads: [head], bases });
      assertEquals(res.body, { contained: [], missed: [head] });
    }
  });
});

test("a base that is no strict ancestor of its head is ignored: the head itself, or past it", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    await writeFile(`${upstream}/two.md`, "two\n");
    await writeFile(`${upstream}/three.md`, "three\n");
    await git(upstream, "add", ".");
    await commit(upstream, "two and three");
    const head = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "rm", "--quiet", "three.md");
    await git(upstream, "commit", "--quiet", "--amend", "--no-edit");
    const merged = await git(upstream, "rev-parse", "HEAD");
    // Measured from itself, the head would change nothing, so anything would contain it.
    const later = await work(upstream, "four.md");
    for (const base of [head, merged, later]) {
      const res = await ask({
        url: upstream,
        mergedHeads: [merged],
        heads: [head],
        bases: { [head]: base },
      });
      assertEquals(res.body, { contained: [], missed: [head] }, base);
    }
  });
});

test("commits alike in author, date and message count for nothing", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const date = "2026-01-01T00:00:00+0000";
    await workAt(upstream, "shared.md", "base\n", "shared", date);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    await workAt(upstream, "shared.md", "one\n", "tweak", date);
    const head = await workAt(upstream, "shared.md", "two\n", "tweak", date);
    await git(upstream, "checkout", "--quiet", "main");
    await workAt(upstream, "shared.md", "main\n", "main edit", date);
    // A person lands one "tweak" in place of both, with a resolution of their own.
    await git(upstream, "checkout", "--quiet", "-b", "landed");
    const landed = await workAt(upstream, "shared.md", "main and one\n", "tweak", date);

    const res = await ask({ url: upstream, mergedHeads: [landed], heads: [head] });
    assertEquals(res.body, { contained: [], missed: [head] });
  });
});

test("a head whose own work is only a merge is judged by content", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const first = await work(upstream, "one.md");
    await moveMain(upstream);
    // What merged: the branch with main merged in, by a person.
    await git(upstream, "checkout", "--quiet", "-b", "theirs", first);
    await merge(upstream, "--quiet", "--no-ff", "-m", "theirs", "main");
    const merged = await git(upstream, "rev-parse", "HEAD");
    // The agent made the same merge on its own: a different commit, the same tree.
    await git(upstream, "checkout", "--quiet", "-b", "ours", first);
    await merge(upstream, "--quiet", "--no-ff", "-m", "ours", "main");
    const same = await git(upstream, "rev-parse", "HEAD");
    // And once more, with something of its own in the merge.
    await git(upstream, "checkout", "--quiet", "-b", "evil", first);
    await merge(upstream, "--quiet", "--no-ff", "--no-commit", "main");
    await writeFile(`${upstream}/extra.md`, "extra\n");
    await git(upstream, "add", "extra.md");
    await commit(upstream, "evil");
    const evil = await git(upstream, "rev-parse", "HEAD");

    const res = await ask({ url: upstream, mergedHeads: [merged], heads: [same, evil] });
    assertEquals(res.body, {
      contained: [same],
      missed: [evil],
    });
  });
});

test("an id that is not a commit is a terminal answer, held or not", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const head = await git(upstream, "rev-parse", "HEAD");
    const tree = await git(upstream, "rev-parse", "HEAD^{tree}");

    // The cache has never held the tree: fetched by id, and found to be one.
    const cold = await ask({ url: upstream, mergedHeads: [head], heads: [tree] });
    assertEquals(cold.status, 404);
    assertEquals(cold.body.kind, "not-a-commit");
    assertEquals(cold.body.terminal, true);
    // Now it holds it.
    const warm = await ask({ url: upstream, mergedHeads: [head], heads: [head, tree] });
    assertEquals([warm.status, warm.body.kind, warm.body.terminal], [404, "not-a-commit", true]);
    // As a merged head, the same.
    const merged = await ask({ url: upstream, mergedHeads: [tree], heads: [head] });
    assertEquals([merged.status, merged.body.kind, merged.body.terminal], [
      404,
      "not-a-commit",
      true,
    ]);
  });
});

test("a hold fetches every missing head in one fetch, and sets aside what the upstream lacks", async () => {
  await withRoot(async (root, upstream) => {
    const fetches: string[][] = [];
    const diag = {
      debug(event: string, fields?: Record<string, unknown>) {
        if (event === "git.exec" && fields?.op === "fetch") {
          fetches.push(String(fields.args).split(" "));
        }
      },
      warn() {},
    };
    const cache = localFsRepoCache({ root: `${root}/cache`, diag });
    await git(upstream, "checkout", "--quiet", "-b", "one");
    const one = await work(upstream, "one.md");
    await git(upstream, "checkout", "--quiet", "-b", "two", "main");
    const two = await work(upstream, "two.md");
    const nowhere = "e".repeat(40);

    const held = await cache.withHeld(
      { url: upstream },
      anonymous,
      (entry) => entry.hold([one, nowhere, two]),
    );
    assertEquals([...held.absent], [nowhere]);
    assertEquals([...held.notCommits], []);
    // The batch, refused for the one id; then the rest, in one fetch. No gc behind either.
    assertEquals(fetches.length, 2);
    for (const args of fetches) assert(args.includes("--no-auto-gc"));
    // Held now: nothing more to fetch.
    const again = await cache.withHeld(
      { url: upstream },
      anonymous,
      (entry) => entry.hold([one, two]),
    );
    assertEquals(again.absent.size, 0);
    assertEquals(fetches.length, 2);
  });
});

test("a hold sets aside a 64-digit id a SHA-1 upstream cannot even be asked for", async () => {
  await withRoot(async (root, upstream) => {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    const head = await git(upstream, "rev-parse", "HEAD");
    const wide = "e".repeat(64);
    // git's own words for it are "couldn't find remote ref <id>": no such commit, not an outage.
    const held = await cache.withHeld(
      { url: upstream },
      anonymous,
      (entry) => entry.hold([wide, head]),
    );
    assertEquals([...held.absent], [wide]);
    assertEquals([...held.notCommits], []);
  });
});

test("a hold's budget covers its wait for the entry: run out, and the read never runs", async () => {
  await withRoot(async (root, upstream) => {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    let release = () => {};
    const released = new Promise<void>((resolve) => release = resolve);
    const first = cache.withHeld({ url: upstream }, anonymous, () => released);
    let ran = false;
    const started = Date.now();
    await assertRejects(() =>
      cache.withHeld({ url: upstream }, anonymous, () => {
        ran = true;
        return Promise.resolve();
      }, { signal: AbortSignal.timeout(50) })
    );
    assert(Date.now() - started < 5_000);
    release();
    await first;
    // The queued read had its turn after the first, and declined it.
    await cache.withHeld({ url: upstream }, anonymous, () => Promise.resolve());
    assertEquals(ran, false);
  });
});

test("a hold's fetch outlives the budget that ran out: the next ask finds it held", async () => {
  await withRoot(async (root, upstream) => {
    let fetches = 0;
    const diag = {
      debug(event: string, fields?: Record<string, unknown>) {
        if (event === "git.exec" && fields?.op === "fetch") fetches++;
      },
      warn() {},
    };
    const cache = localFsRepoCache({ root: `${root}/cache`, diag });
    await git(upstream, "checkout", "--quiet", "-b", "one");
    const one = await work(upstream, "one.md");
    const budget = new AbortController();

    // The budget runs out with the fetch of a cold entry under way: the read answers that, and
    // the fetch carries on with the entry held.
    await assertRejects(() =>
      cache.withHeld({ url: upstream }, anonymous, async (entry) => {
        const holding = entry.hold([one]);
        budget.abort(new Error("budget"));
        return await holding;
      }, { signal: budget.signal })
    );
    // The next read has its turn once that fetch is done, and finds the head already there.
    const found = await cache.withHeld(
      { url: upstream },
      anonymous,
      (entry) => git(entry.dir, "cat-file", "-t", one),
    );
    assertEquals([found, fetches], ["commit", 1]);
  });
});

test("a hold whose budget ran out starts no further fetch: no retry of the batch, no id alone", async () => {
  await withRoot(async (root, upstream) => {
    const budget = new AbortController();
    let fetches = 0;
    const diag = {
      debug(event: string, fields?: Record<string, unknown>) {
        if (event === "git.exec" && fields?.op === "fetch") {
          fetches++;
          // The budget runs out while the first fetch, the whole batch, is under way.
          budget.abort(new Error("budget"));
        }
      },
      warn() {},
    };
    const cache = localFsRepoCache({ root: `${root}/cache`, diag });
    await git(upstream, "checkout", "--quiet", "-b", "one");
    const one = await work(upstream, "one.md");
    const nowhere = "e".repeat(40);

    let holding: Promise<unknown> = Promise.resolve();
    await assertRejects(() =>
      cache.withHeld({ url: upstream }, anonymous, (entry) => {
        holding = entry.hold([one, nowhere]);
        return holding;
      }, { signal: budget.signal })
    );
    await assertRejects(() => holding, Error, "budget");
    // The batch was refused for the one id the upstream lacks; nothing was asked again.
    assertEquals(fetches, 1);
    // And the hold that ran out is no longer holding the entry.
    await cache.withHeld({ url: upstream }, anonymous, () => Promise.resolve());
    // A hold asked after the budget ran out starts nothing.
    await assertRejects(() =>
      cache.withHeld({ url: upstream }, anonymous, (entry) => {
        const held = entry.hold([one]);
        held.catch(() => {});
        return held;
      }, { signal: budget.signal })
    );
    assertEquals(fetches, 1);
  });
});

/**
 * A change request's two pushes onto `feat`: the first adds a feature and a debug line, the
 * second drops the debug line on review — on top of the first, or (`amend`) as the first
 * amended. Answers both, with `main` checked out.
 */
async function debugPushes(upstream: string, how: "on top" | "amend") {
  const lines = (...ls: string[]) => ls.join("\n") + "\n";
  const date = "2026-01-01T00:00:00+0000";
  const base = await workAt(upstream, "f.ts", lines("1", "2", "3"), "file", date);
  await git(upstream, "checkout", "--quiet", "-b", "feat");
  const first = await workAt(
    upstream,
    "f.ts",
    lines("1", "DEBUG", "2", "3", "feature"),
    "r1",
    date,
  );
  if (how === "amend") await git(upstream, "checkout", "--quiet", "-b", "amended", base);
  const second = await workAt(upstream, "f.ts", lines("1", "2", "3", "feature"), "r2", date);
  await git(upstream, "checkout", "--quiet", "main");
  return { base, first, second };
}

/** A person rebases `first` onto main (moved first) and merges that as `style` says. Answers the
 * rebased head: what the forge names merged. */
async function rebaseAndMerge(
  upstream: string,
  head: string,
  style: "squash" | "merge commit" | "fast-forward",
): Promise<string> {
  await moveMain(upstream);
  await git(upstream, "checkout", "--quiet", "-B", "pr", head);
  await git(upstream, "rebase", "--quiet", "main");
  const rebased = await git(upstream, "rev-parse", "HEAD");
  await git(upstream, "checkout", "--quiet", "main");
  if (style === "squash") {
    await merge(upstream, "--quiet", "--squash", "pr");
    await commit(upstream, "squashed");
  } else if (style === "merge commit") {
    await merge(upstream, "--quiet", "--no-ff", "-m", "merge pr", "pr");
  } else {
    await merge(upstream, "--quiet", "--ff-only", "pr");
  }
  return rebased;
}

test("a later push that drops what an earlier merged push added is missed: both ways, exactly", async () => {
  for (const how of ["on top", "amend"] as const) {
    for (const style of ["squash", "merge commit"] as const) {
      await withRoot(async (root, upstream) => {
        const ask = await build(root);
        const { base, first, second } = await debugPushes(upstream, how);
        const merged = await rebaseAndMerge(upstream, first, style);
        // The second push's change is in what merged forwards (the feature is there), but what
        // merged also holds the debug line the second dropped: not its change, so missed, and
        // its commits ride the next generation. The first's change is exactly what merged.
        const res = await ask({
          url: upstream,
          mergedHeads: [merged],
          heads: [first, second],
          bases: { [first]: base, [second]: base },
        });
        assertEquals(res.body, { contained: [first], missed: [second] }, `${how}, ${style}`);
      });
    }
  }
});

test("a push under one that merged by exact content merged with it", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const { first, second } = await debugPushes(upstream, "on top");
    const merged = await rebaseAndMerge(upstream, second, "squash");
    const res = await ask({ url: upstream, mergedHeads: [merged], heads: [first, second] });
    assertEquals(res.body, { contained: [first, second], missed: [] });
  });
});

test("with no branch to measure what merged from, only the same tree is the same change", async () => {
  for (const into of [undefined, "gone", "refs/tags/v1"]) {
    await withRoot(async (root, upstream) => {
      const ask = await build(root);
      const { first } = await debugPushes(upstream, "on top");
      // Main moved under the rebase: the trees differ by main's own commit.
      const merged = await rebaseAndMerge(upstream, first, "squash");
      const res = await ask({ url: upstream, mergedHeads: [merged], heads: [first], into });
      assertEquals(res.body, { contained: [], missed: [first] }, String(into));
    });
  }
  // A fast-forward the same way: with no branch named, nothing says where on its own line the
  // merged head's change starts.
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const { first } = await debugPushes(upstream, "on top");
    const merged = await rebaseAndMerge(upstream, first, "fast-forward");
    const res = await ask({
      url: upstream,
      mergedHeads: [merged],
      heads: [first],
      into: undefined,
    });
    assertEquals(res.body, { contained: [], missed: [first] });
  });
});

test("a rebased revision fast-forwarded onto a moved target is measured from a point on its line", async () => {
  for (const how of ["on top", "amend"] as const) {
    await withRoot(async (root, upstream) => {
      const ask = await build(root);
      const { base, first, second } = await debugPushes(upstream, how);
      // A person rebases the first push onto main, which moved, and fast-forwards main to it (a
      // Radicle delegate's merge): the merged head is main's own line.
      const merged = await rebaseAndMerge(upstream, first, "fast-forward");
      assertEquals(await git(upstream, "rev-parse", "main"), merged);
      // The first's change is exactly what main took past the commit under it; the second's
      // drops the debug line main took: missed.
      const res = await ask({
        url: upstream,
        mergedHeads: [merged],
        heads: [first, second],
        bases: { [first]: base, [second]: base },
      });
      assertEquals(res.body, { contained: [first], missed: [second] }, how);
      // Measured from where it meets the merged head, no base named: the same.
      const unnamed = await ask({ url: upstream, mergedHeads: [merged], heads: [first, second] });
      assertEquals(unnamed.body, { contained: [first], missed: [second] }, how);
    });
  }
});

test("a multi-commit revision rebased and fast-forwarded: exact change contained, part of it missed", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const base = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    const part = await work(upstream, "a.md");
    const head = await work(upstream, "b.md");
    // The same first commit pushed on its own, as an amend would leave it: another commit.
    await git(upstream, "checkout", "--quiet", "-b", "alone", base);
    await writeFile(`${upstream}/a.md`, "a.md\n");
    await git(upstream, "add", ".");
    await commit(upstream, "a alone");
    const alone = await git(upstream, "rev-parse", "HEAD");
    // Main moves twice, then takes the rebased branch, with a commit past it.
    await git(upstream, "checkout", "--quiet", "main");
    await work(upstream, "main-one.md");
    await work(upstream, "main-two.md");
    await git(upstream, "checkout", "--quiet", "-B", "pr", head);
    await git(upstream, "rebase", "--quiet", "main");
    const merged = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "main");
    await merge(upstream, "--quiet", "--ff-only", "pr");
    await work(upstream, "after.md");

    // The head's two commits are what main took past main-two; a head with only the first is
    // short of b.md there, and one past the first commit's rebase is short of a.md.
    const res = await ask({
      url: upstream,
      mergedHeads: [merged],
      heads: [head, alone],
      bases: { [head]: base, [alone]: base },
    });
    assertEquals(res.body, { contained: [head], missed: [alone] });
    // `part` is under the contained head, and so merged with it.
    const under = await ask({ url: upstream, mergedHeads: [merged], heads: [part, head] });
    assertEquals(under.body, { contained: [part, head], missed: [] });
  });
});

test("the same tree is not enough where the merged head left the target holding part of the head", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const base = await git(upstream, "rev-parse", "HEAD");
    // The agent's head adds a.md and b.md.
    await git(upstream, "checkout", "--quiet", "-b", "feat");
    await writeFile(`${upstream}/a.md`, "a\n");
    await writeFile(`${upstream}/b.md`, "b\n");
    await git(upstream, "add", ".");
    await commit(upstream, "a and b");
    const head = await git(upstream, "rev-parse", "HEAD");
    // Main takes a.md on its own; a person's revision forks there and adds b.md: the head's tree.
    await git(upstream, "checkout", "--quiet", "main");
    await writeFile(`${upstream}/a.md`, "a\n");
    await git(upstream, "add", ".");
    await commit(upstream, "a on main");
    await git(upstream, "checkout", "--quiet", "-b", "pr");
    await writeFile(`${upstream}/b.md`, "b\n");
    await git(upstream, "add", ".");
    await commit(upstream, "b");
    const merged = await git(upstream, "rev-parse", "HEAD");
    assertEquals(
      await git(upstream, "rev-parse", `${merged}^{tree}`),
      await git(upstream, "rev-parse", `${head}^{tree}`),
    );
    // Main takes a.md back out, then merges the revision: main has b.md and no a.md.
    await git(upstream, "checkout", "--quiet", "main");
    await git(upstream, "rm", "--quiet", "a.md");
    await commit(upstream, "revert a");
    await merge(upstream, "--quiet", "--no-ff", "-m", "merge pr", "pr");

    const res = await ask({
      url: upstream,
      mergedHeads: [merged],
      heads: [head],
      bases: { [head]: base },
    });
    assertEquals(res.body, { contained: [], missed: [head] });
  });
});

test("an `into` the ref rules refuse is no target, never a refusal of the question", async () => {
  for (const into of ["a..b", "-x", "--upload-pack=touch pwned", "x.lock", "has space", "*", 7]) {
    await withRoot(async (root, upstream) => {
      const ask = await build(root);
      const { first } = await debugPushes(upstream, "on top");
      const merged = await rebaseAndMerge(upstream, first, "squash");
      const res = await ask({ url: upstream, mergedHeads: [merged, first], heads: [first], into });
      assertEquals(res, { status: 200, body: { contained: [first], missed: [] } }, String(into));
      // Measured with no target: the same answer as none named.
      const content = await ask({ url: upstream, mergedHeads: [merged], heads: [first], into });
      assertEquals(content.body, { contained: [], missed: [first] }, String(into));
    });
  }
});

test("the read of `into` runs under the read's budget: an upstream that never answers is a 502", async () => {
  await withRoot(async (root) => {
    // An upstream that takes the connection and never says a word.
    const sockets: Array<{ end(): void }> = [];
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          sockets.push(socket);
        },
        data() {},
      },
    });
    try {
      const ask = await build(root, { mergeContainmentBudgetMs: 300 });
      const started = Date.now();
      const res = await ask({
        url: `http://127.0.0.1:${server.port}/repo.git`,
        mergedHeads: ["a".repeat(40)],
        heads: ["b".repeat(40)],
      });
      assertEquals(res.status, 502);
      assertEquals(res.body.terminal, false);
      assert(Date.now() - started < 4_000, `took ${Date.now() - started} ms`);
    } finally {
      for (const socket of sockets) socket.end();
      server.stop(true);
    }
  });
});

test("a second merge of the change request is measured past the first: a push that dropped part of the first is missed", async () => {
  await withRoot(async (root, upstream) => {
    const ask = await build(root);
    const lines = (...ls: string[]) => ls.join("\n") + "\n";
    const date = "2026-01-01T00:00:00+0000";
    const { base, first } = await debugPushes(upstream, "on top");
    // The agent's next push drops the debug line and adds more, as an amend of the first.
    await git(upstream, "checkout", "--quiet", "-b", "next", base);
    const next = await workAt(
      upstream,
      "f.ts",
      lines("1", "2", "3", "feature", "more"),
      "r2",
      date,
    );
    // A person merged their rebase of the first, then merges a revision of theirs with the
    // more, the debug line kept.
    const once = await rebaseAndMerge(upstream, first, "merge commit");
    await git(upstream, "checkout", "--quiet", "-B", "pr2", once);
    const again = await workAt(
      upstream,
      "f.ts",
      lines("1", "DEBUG", "2", "3", "feature", "more"),
      "more",
      date,
    );
    await git(upstream, "checkout", "--quiet", "main");
    await merge(upstream, "--quiet", "--no-ff", "-m", "merge pr2", "pr2");
    // Measured past the first merge, what merged is only "more", which the push has; but the
    // push's change, replayed there, would not make what merged (the debug line stays), and
    // what merged, replayed on the push's base, is not the push.
    const res = await ask({
      url: upstream,
      mergedHeads: [again],
      heads: [next],
      bases: { [next]: base },
    });
    assertEquals(res.body, { contained: [], missed: [next] });
  });
});
