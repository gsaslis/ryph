// The orchestrator's side of the forge service wire, against a fake forge: what the control
// plane does with an answer it did not like.
//
// Reading a thread is the case that matters here. The answer becomes an agent's prompt, and
// it is consumed at a rung where "I could not read it" and "I read something broken" have to
// mean the same thing — retry — because the alternative is a handler that throws after the
// delivery is claimed, which swallows the redelivery that would have fixed it.
//
// `fetch` is stubbed rather than served: this package's tests hold no net permission, and a
// socket-free suite is worth keeping.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { httpForge } from "../src/adapters/forge/http.ts";
import type { Forge, SkillsTree } from "../src/ports/forge.ts";
import { ForgeEventSchema, SkillsTreeAnswerSchema } from "../src/schema.ts";
import {
  MAX_SKILLS_TREE_BYTES,
  MAX_SKILLS_TREE_ENTRIES,
} from "../../forge/src/helpers/skill_tree.ts";
import { silentDiagnostics } from "./doubles.ts";

/** A connected repo as the port is addressed with it — this suite's only forge is GitHub. */
const repo = (repoRef: string, tenantId: string) =>
  ({ provider: "github", repoRef, tenantId }) as const;

const THREAD = {
  kind: "issue",
  ref: "7",
  title: "The scheduler test is flaky",
  body: "One run in five.",
  authorLogin: "grace",
  createdAt: "2026-01-01T00:00:00.000Z",
  state: "open",
  entries: [{
    kind: "comment",
    authorLogin: "linus",
    body: "Only on CI.",
    createdAt: "2026-01-02T00:00:00.000Z",
    state: null,
    location: null,
  }],
  truncated: false,
  changeRequest: null,
};

/** Reads a thread with `fetch` answering from `reply`. Stubbed rather than served, so the
 * orchestrator's tests stay socket-free — the same trick as model_access_http_test.ts. */
async function readThread(
  reply: () => Response,
  readOpts?: Parameters<Forge["fetchThread"]>[2],
) {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(reply())) as unknown as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    return await forge.fetchThread(repo("acme/app", "42"), { kind: "issue", ref: "7" }, readOpts);
  } finally {
    globalThis.fetch = original;
  }
}

test("a well-formed thread crosses the wire whole", async () => {
  const outcome = await readThread(() => new Response(JSON.stringify(THREAD)));
  assert(outcome.kind === "thread");
  assertEquals(outcome.thread.title, "The scheduler test is flaky");
  assertEquals(outcome.thread.entries.length, 1);
});

test("a pull request's head crosses the wire whole", async () => {
  const head = {
    ref: "7",
    url: "https://github.com/acme/app/pull/7",
    state: "open" as const,
    merged: false,
    headRef: "feat/scheduler",
    headSha: "b".repeat(40),
    authorHeadSha: "b".repeat(40),
    headRepoRef: "acme/app",
    baseRef: "main",
    defaultBranch: "main",
  };
  const withHead = await readThread(() =>
    new Response(JSON.stringify({ ...THREAD, changeRequest: head }))
  );
  assert(withHead.kind === "thread");
  assertEquals(withHead.thread.changeRequest, head);
  // GitLab's answer by project id, which decides fork or not: dropped, a renamed project's own
  // merge request would be read by its paths, and taken for a fork.
  const gitlab = { ...head, ref: "mr-7", headRepoRef: "acme/renamed", sameRepo: true };
  const byId = await readThread(() =>
    new Response(JSON.stringify({ ...THREAD, changeRequest: gitlab }))
  );
  assert(byId.kind === "thread");
  assertEquals(byId.thread.changeRequest, gitlab);
});

test("a half-shaped answer is UNAVAILABLE, never a thread", async () => {
  // The failure this guards: accepted here, a thread missing `body` reaches the prompt
  // composer AFTER the delivery is claimed, where `thread.body.trim()` throws — and the claim
  // then eats the redelivery that would have fixed it. Duck-typing on `title` and `entries`
  // was enough to let every one of these through.
  const broken: unknown[] = [
    { ...THREAD, body: undefined },
    { ...THREAD, entries: [{ kind: "comment", authorLogin: "x" }] }, // an entry missing its text
    { ...THREAD, kind: "discussion" }, // a kind this version does not speak
    { ...THREAD, truncated: "yes" },
    { ...THREAD, changeRequest: undefined }, // the head is said, null or not — never omitted
    { ...THREAD, changeRequest: { number: 7, headRef: "feat/x" } }, // a head missing its repo
    { title: "just enough to fool a duck-type", entries: [] },
  ];
  for (const body of broken) {
    const outcome = await readThread(() => new Response(JSON.stringify(body)));
    assertEquals(
      outcome.kind,
      "unavailable",
      `${JSON.stringify(body).slice(0, 60)} is not a thread`,
    );
  }
});

test("a well-shaped answer about the WRONG thread is refused", async () => {
  // The quiet failure: the task gets composed from another issue's title and words while the
  // progress comment goes back to the thread that was actually commented on, and nothing
  // about the result looks wrong from either end.
  const otherRef = await readThread(() => new Response(JSON.stringify({ ...THREAD, ref: "9" })));
  assertEquals(otherRef.kind, "unavailable");

  const otherKind = await readThread(() =>
    new Response(JSON.stringify({ ...THREAD, kind: "change_request" }))
  );
  assertEquals(otherKind.kind, "unavailable");
});

test("only the forge's own terminal verdict makes a thread gone", async () => {
  const gone = await readThread(() =>
    new Response(JSON.stringify({ error: "no such thread", terminal: true }), { status: 404 })
  );
  assertEquals(gone.kind, "gone");

  // A 404 from something that is not the forge — a proxy, a stray route — says nothing about
  // whether the thread exists. Inventing "gone" from it would drop the command for good.
  const proxy = await readThread(() => new Response("<html>Not Found</html>", { status: 404 }));
  assertEquals(proxy.kind, "unavailable");

  const blip = await readThread(() =>
    new Response(JSON.stringify({ error: "github is down", terminal: false }), { status: 502 })
  );
  assertEquals(blip.kind, "unavailable");
});

test("a forge one version ahead is understood, not refused", async () => {
  // The two deploy separately. A field this orchestrator has not heard of is stripped; a
  // strict schema here would turn a rolling deploy into dropped commands.
  const outcome = await readThread(() =>
    new Response(JSON.stringify({
      ...THREAD,
      reactions: { "+1": 3 },
      entries: [{ ...THREAD.entries[0], resolved: true }],
    }))
  );
  assert(outcome.kind === "thread");
  assertEquals(outcome.thread.entries.at(0)?.body, "Only on CI.");
});

/** Runs one call against a forge whose `fetch` answers from `reply`, socket-free. */
async function withForge<T>(
  reply: () => Response,
  call: (forge: ReturnType<typeof httpForge>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(reply())) as unknown as typeof fetch;
  try {
    return await call(httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    }));
  } finally {
    globalThis.fetch = original;
  }
}

test("an exchanged identity crosses whole, and a half-shaped one is refused", async () => {
  const whole = {
    accountId: "12345",
    login: "ada",
    name: "Ada",
    verifiedEmails: ["ada@example.com", 7, "x@example.com"],
    accessToken: null,
  };
  const identity = await withForge(
    () => Response.json(whole),
    (forge) => forge.exchangeOAuthCode("code"),
  );
  assertEquals(identity, {
    accountId: "12345",
    login: "ada",
    name: "Ada",
    verifiedEmails: ["ada@example.com", "x@example.com"],
    accessToken: null,
  });

  // A forge that answers without the stable id has not answered: a login alone can be reassigned.
  let threw = false;
  try {
    await withForge(
      () => Response.json({ login: "ada", accessToken: null }),
      (forge) => forge.exchangeOAuthCode("code"),
    );
  } catch {
    threw = true;
  }
  assert(threw);
});

test("membership is a value, never a throw", async () => {
  for (
    const [reply, expected] of [
      [() => Response.json({ membership: "member" }), "member"],
      [() => Response.json({ membership: "not-member" }), "not-member"],
      [() => Response.json({ membership: "maybe" }), "unknown"],
      [() => new Response("boom", { status: 502 }), "unknown"],
      [() => {
        throw new Error("network death");
      }, "unknown"],
    ] as const
  ) {
    assertEquals(
      await withForge(reply, (forge) => forge.checkOrgMembership("42", "ada")),
      expected,
    );
  }
});

// ---- the permission verdict cache ----------------------------------------------------
//
// A permission check is not only asked at a gate: `canManage` on GET /v1/workspaces asks one
// per member of every workspace, on every page load, to decide whether a button is drawn.
// Uncached that is dozens of live GitHub round trips per view, which walks the installation
// into its REST quota — and once GitHub refuses, every check answers "unknown", which every
// gate reads as denied. A cosmetic poll would take the whole platform down with it.

/** Runs `body` against a forge whose `fetch` is `reply`, counting what reaches the wire. */
async function countingForge(
  reply: () => Response,
  body: (forge: Forge) => Promise<void>,
  permissionTtlMs?: number,
): Promise<number> {
  const original = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (() => {
    asked++;
    return Promise.resolve(reply());
  }) as unknown as typeof fetch;
  try {
    await body(httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
      ...(permissionTtlMs === undefined ? {} : { permissionTtlMs }),
    }));
  } finally {
    globalThis.fetch = original;
  }
  return asked;
}

const allowed = () => new Response(JSON.stringify({ permission: "allowed" }));

test("a permission verdict is reused briefly: one question, one round trip", async () => {
  const asked = await countingForge(allowed, async (forge) => {
    // The `canManage` fan-out: the same question, once per member of every workspace listed.
    for (let i = 0; i < 20; i++) {
      assertEquals(
        await forge.checkPermission(
          repo("acme/api", "42"),
          { provider: "github", subject: "ada" },
          "admin",
        ),
        "allowed",
      );
    }
  });
  assertEquals(asked, 1, "one live question, not one per member per workspace");
});

test("the cache keys on the WHOLE question: login, repo, installation and threshold", async () => {
  // A verdict about one login says nothing about another, and "write" says nothing about
  // "admin" — collapsing any of these would hand somebody else's access to the caller.
  const asked = await countingForge(allowed, async (forge) => {
    await forge.checkPermission(
      repo("acme/api", "42"),
      { provider: "github", subject: "ada" },
      "admin",
    );
    await forge.checkPermission(
      repo("acme/api", "42"),
      { provider: "github", subject: "grace" },
      "admin",
    );
    await forge.checkPermission(
      repo("acme/web", "42"),
      { provider: "github", subject: "ada" },
      "admin",
    );
    await forge.checkPermission(
      repo("acme/api", "99"),
      { provider: "github", subject: "ada" },
      "admin",
    );
    await forge.checkPermission(
      repo("acme/api", "42"),
      { provider: "github", subject: "ada" },
      "write",
    );
  });
  assertEquals(asked, 5);
});

test("an unanswerable check is never cached: a blip is not a window of denials", async () => {
  // "unknown" is the forge failing to answer, and every gate here reads it as denied. Held
  // for the window, one blip would deny every retry that would have got through.
  let down = true;
  const asked = await countingForge(
    () =>
      down ? new Response(JSON.stringify({ error: "github is down" }), { status: 502 }) : allowed(),
    async (forge) => {
      assertEquals(
        await forge.checkPermission(
          repo("acme/api", "42"),
          { provider: "github", subject: "ada" },
          "admin",
        ),
        "unknown",
      );
      assertEquals(
        await forge.checkPermission(
          repo("acme/api", "42"),
          { provider: "github", subject: "ada" },
          "admin",
        ),
        "unknown",
      );
      down = false;
      assertEquals(
        await forge.checkPermission(
          repo("acme/api", "42"),
          { provider: "github", subject: "ada" },
          "admin",
        ),
        "allowed",
      );
    },
  );
  assertEquals(asked, 3, "every retry asks again");
});

test("a zero ttl turns the cache off: every check is live", async () => {
  const asked = await countingForge(allowed, async (forge) => {
    await forge.checkPermission(
      repo("acme/api", "42"),
      { provider: "github", subject: "ada" },
      "admin",
    );
    await forge.checkPermission(
      repo("acme/api", "42"),
      { provider: "github", subject: "ada" },
      "admin",
    );
  }, 0);
  assertEquals(asked, 2);
});

test("the cache is bounded even when nothing has expired", async () => {
  // Sweeping expired entries is not a bound on its own: a burst of distinct questions inside
  // one TTL window frees nothing, and the map would grow without limit while every later
  // insert re-walked it. Past the cap the oldest are evicted instead — so the question that
  // fell out is asked live again, rather than answered from a map that kept everything.
  const asked = await countingForge(allowed, async (forge) => {
    // The oldest question, then enough distinct ones to push it out. Distinct by login, so
    // nothing here is a cache hit and nothing expires: one burst, one window.
    await forge.checkPermission(
      repo("acme/api", "42"),
      { provider: "github", subject: "login-0" },
      "admin",
    );
    for (let i = 1; i <= 2_000; i++) {
      await forge.checkPermission(repo("acme/api", "42"), {
        provider: "github",
        subject: `login-${i}`,
      }, "admin");
    }
    // The newest is still held...
    await forge.checkPermission(repo("acme/api", "42"), {
      provider: "github",
      subject: "login-2000",
    }, "admin");
    // ...and the oldest was evicted to make room for it, so this one reaches the wire.
    await forge.checkPermission(
      repo("acme/api", "42"),
      { provider: "github", subject: "login-0" },
      "admin",
    );
  });
  assertEquals(asked, 2_002, "2001 distinct questions, then a re-ask of the evicted oldest");
});

/** `withForge`, but the reply sees which route was asked and the request is recorded. */
async function withRecordingForge<T>(
  reply: (path: string, body: unknown) => Response,
  body: (forge: Forge) => Promise<T>,
): Promise<{ result: T; asked: Array<{ path: string; body: unknown }> }> {
  const asked: Array<{ path: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const sent = JSON.parse(String(init?.body ?? "null"));
    asked.push({ path, body: sent });
    return await Promise.resolve(reply(path, sent));
  }) as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    return { result: await body(forge), asked };
  } finally {
    globalThis.fetch = original;
  }
}

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const BLOB = "c".repeat(40);
const URL_ = "https://github.com/acme/app.git";

test("the environment reads cross the wire with the repo, its url and the question", async () => {
  const { result, asked } = await withRecordingForge(
    (path) =>
      new Response(JSON.stringify(
        path.endsWith("ryph-tree")
          ? { commit: SHA, tree: TREE, fullTree: TREE, dockerfile: true, dockerfileBlob: BLOB }
          : path.endsWith("default-branch-head")
          ? { ref: "main", commit: SHA }
          : { kind: "foreign" },
      )),
    async (forge) => [
      await forge.ryphTree(repo("acme/app", "42"), URL_, "main"),
      await forge.defaultBranchHead(repo("acme/app", "42"), URL_),
      await forge.branchKind(repo("acme/app", "42"), URL_, "refs/pull/7/head"),
    ],
  );
  assertEquals(result, [
    { commit: SHA, tree: TREE, fullTree: TREE, dockerfile: true, dockerfileBlob: BLOB },
    { ref: "main", commit: SHA },
    "foreign",
  ]);
  const target = { provider: "github", repoRef: "acme/app", tenantId: "42" };
  assertEquals(asked, [
    { path: "/v1/service/ryph-tree", body: { repo: target, url: URL_, commitOrRef: "main" } },
    { path: "/v1/service/default-branch-head", body: { repo: target, url: URL_ } },
    {
      path: "/v1/service/branch-kind",
      body: { repo: target, url: URL_, ref: "refs/pull/7/head" },
    },
  ]);
});

test("the merge-base read crosses the wire with the head and the base, and is checked", async () => {
  const answer = { base: SHA, mergeBase: BLOB, tree: TREE, changed: [".ryph/setup.yml"] };
  const { result, asked } = await withRecordingForge(
    () => new Response(JSON.stringify(answer)),
    (forge) => forge.ryphBase(repo("acme/app", "42"), URL_, BLOB, "main"),
  );
  assertEquals(result, answer);
  assertEquals(asked, [{
    path: "/v1/service/ryph-base",
    body: {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      url: URL_,
      head: BLOB,
      base: "main",
    },
  }]);
  // A path outside `.ryph/`, or a merge base that is no id, is not an answer.
  for (const bad of [{ ...answer, changed: ["src/main.ts"] }, { ...answer, mergeBase: "HEAD" }]) {
    await assertRejects(
      () =>
        withForge(
          () => new Response(JSON.stringify(bad)),
          (forge) => forge.ryphBase(repo("acme/app", "42"), URL_, BLOB, "main"),
        ),
      Error,
      "malformed",
    );
  }
});

test("a repo with no .ryph directory is a null tree, not an error", async () => {
  const tree = await withForge(
    () =>
      new Response(
        JSON.stringify({
          commit: SHA,
          tree: null,
          fullTree: null,
          dockerfile: false,
          dockerfileBlob: null,
        }),
      ),
    (forge) => forge.ryphTree(repo("acme/app", "42"), URL_, SHA),
  );
  assertEquals(tree, {
    commit: SHA,
    tree: null,
    fullTree: null,
    dockerfile: false,
    dockerfileBlob: null,
  });
});

test("an environment read the forge could not answer, or answered malformed, throws", async () => {
  const cases: Array<[Response, (forge: Forge) => Promise<unknown>, string]> = [
    [
      new Response(JSON.stringify({ error: "main could not be read" }), { status: 502 }),
      (forge) => forge.ryphTree(repo("acme/app", "42"), URL_, "main"),
      "main could not be read",
    ],
    [
      new Response(JSON.stringify({ commit: SHA, tree: "../etc" })),
      (forge) => forge.ryphTree(repo("acme/app", "42"), URL_, "main"),
      "malformed",
    ],
    [
      // A Dockerfile with no id, or an id with no Dockerfile, is not an answer.
      new Response(
        JSON.stringify({
          commit: SHA,
          tree: TREE,
          fullTree: TREE,
          dockerfile: true,
          dockerfileBlob: null,
        }),
      ),
      (forge) => forge.ryphTree(repo("acme/app", "42"), URL_, "main"),
      "malformed",
    ],
    [
      new Response(
        JSON.stringify({
          commit: SHA,
          tree: TREE,
          fullTree: TREE,
          dockerfile: false,
          dockerfileBlob: BLOB,
        }),
      ),
      (forge) => forge.ryphTree(repo("acme/app", "42"), URL_, "main"),
      "malformed",
    ],
    [
      new Response(JSON.stringify({ ref: "-evil", commit: SHA })),
      (forge) => forge.defaultBranchHead(repo("acme/app", "42"), URL_),
      "malformed",
    ],
    [
      new Response(JSON.stringify({ kind: "maybe" })),
      (forge) => forge.branchKind(repo("acme/app", "42"), URL_, "feat/x"),
      "malformed",
    ],
  ];
  for (const [response, ask, words] of cases) {
    const err = await withForge(() => response, ask).then(
      () => null,
      (e: unknown) => e,
    );
    assert(err instanceof Error, `${words}: expected a throw`);
    assert(err.message.includes(words), err.message);
  }
});

/** Reads a checks file with `fetch` answering from `reply`. */
async function readChecks(reply: () => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(reply())) as unknown as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    return await forge.readChecksFile(repo("acme/app", "42"), "https://x.test/a.git", "main");
  } finally {
    globalThis.fetch = original;
  }
}

test("a checks file the forge refuses for good is invalid; anything else is unavailable", async () => {
  const refused = await readChecks(() =>
    Response.json({ error: "no such branch: main", terminal: true }, { status: 400 })
  );
  assertEquals(refused, { kind: "invalid", commit: null, detail: "no such branch: main" });
  const down = await readChecks(() => Response.json({ error: "upstream" }, { status: 502 }));
  assertEquals(down.kind, "unavailable");
  const odd = await readChecks(() => Response.json({ error: "?" }, { status: 400 }));
  assertEquals(odd.kind, "unavailable", "an unnamed refusal is retried");
});

/** Reads a change request's head with `fetch` answering from `reply`. */
async function readHead(reply: () => Response) {
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    asked.push(String(input));
    return Promise.resolve(reply());
  }) as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    return { outcome: await forge.fetchChangeRequestHead(repo("acme/app", "42"), "7"), asked };
  } finally {
    globalThis.fetch = original;
  }
}

const HEAD_STATE = {
  ref: "7",
  state: "open" as const,
  merged: false,
  headSha: "b".repeat(40),
  authorHeadSha: "b".repeat(40),
  baseRef: "main",
  openedByUs: false,
  mergedHeads: [] as string[],
};

test("a change request's head is read lean, checked, and only a terminal 404 is gone", async () => {
  const { outcome, asked } = await readHead(() => new Response(JSON.stringify(HEAD_STATE)));
  assertEquals(outcome, { kind: "head", head: HEAD_STATE });
  assertEquals(asked, ["http://forge.test/v1/service/change-request-head"]);
  // Another change request's head, or half of one: not answered.
  for (const body of [{ ...HEAD_STATE, ref: "8" }, { ...HEAD_STATE, openedByUs: undefined }]) {
    assertEquals(
      (await readHead(() => new Response(JSON.stringify(body)))).outcome,
      { kind: "unavailable" },
    );
  }
  assertEquals(
    (await readHead(() =>
      new Response(JSON.stringify({ error: "no such", terminal: true }), { status: 404 })
    )).outcome,
    { kind: "gone" },
  );
  // A forge without the route, or a proxy's page, is not every change request closed.
  assertEquals(
    (await readHead(() => new Response("not found", { status: 404 }))).outcome,
    { kind: "unavailable" },
  );
  assertEquals(
    (await readHead(() => new Response("{}", { status: 502 }))).outcome,
    { kind: "unavailable" },
  );
});

/** Asks a merge's containment with `fetch` answering from `reply`; answers the outcome and the
 * body that was sent. */
async function askContainment(
  reply: () => Response | Promise<Response>,
  bases: Record<string, string> = {},
  into?: string,
) {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(reply());
  }) as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    const outcome = await forge.mergeContainment(
      repo("acme/app", "42"),
      "https://github.com/acme/app.git",
      [M],
      [A, B],
      bases,
      into,
    );
    return { outcome, sent };
  } finally {
    globalThis.fetch = original;
  }
}

const [M, A, B] = ["c", "a", "b"].map((c) => c.repeat(40));

test("a merge's containment is one question, and only an answer to it is an answer", async () => {
  const answered = await askContainment(() => Response.json({ contained: [A], missed: [B] }));
  assertEquals(answered.outcome, { kind: "answered", contained: [A], missed: [B] });
  assertEquals(answered.sent, [{
    url: "http://forge.test/v1/service/merge-containment",
    body: {
      repo: repo("acme/app", "42"),
      url: "https://github.com/acme/app.git",
      mergedHeads: [M],
      heads: [A, B],
      bases: {},
    },
  }]);

  // Each head's base rides along: the forge judges the head's own work from it. So does the
  // branch the merge went into, where the merge record names one: a merged head's own change is
  // measured from where it left it.
  const based = await askContainment(
    () => Response.json({ contained: [A], missed: [B] }),
    { [A]: "0".repeat(40) },
    "main",
  );
  assertEquals((based.sent[0].body as { bases: unknown }).bases, { [A]: "0".repeat(40) });
  assertEquals((based.sent[0].body as { into: unknown }).into, "main");
  assertEquals(based.outcome, { kind: "answered", contained: [A], missed: [B] });

  // An answer that is not a partition of what was asked is no answer: a head left out, one
  // answered twice, one never asked about.
  for (
    const body of [
      { contained: [A], missed: [] },
      { contained: [A, B], missed: [B] },
      { contained: [A, M], missed: [B] },
      { contained: "all", missed: [] },
    ]
  ) {
    const { outcome } = await askContainment(() => Response.json(body));
    assertEquals(outcome.kind, "unavailable", JSON.stringify(body));
  }

  // The forge's own terminal is a refusal; anything else is worth asking again.
  const missing = await askContainment(() =>
    Response.json({ kind: "missing-merged-head", error: "gone", terminal: true }, { status: 404 })
  );
  assertEquals(missing.outcome, { kind: "refused", message: "gone" });
  const unread = await askContainment(() =>
    Response.json({ error: "bad request", terminal: true }, { status: 400 })
  );
  assertEquals(unread.outcome, { kind: "refused", message: "bad request" });
  for (
    const reply of [
      () => new Response("not found", { status: 404 }),
      () => Response.json({ error: "busy", terminal: false }, { status: 502 }),
      () => {
        throw new TypeError("fetch failed");
      },
    ]
  ) {
    const { outcome } = await askContainment(reply);
    assertEquals(outcome.kind, "unavailable");
  }
});

test("a merge event carries what merged: full commit ids, a branch only where the forge said one", () => {
  const merge = (merged: unknown) =>
    ForgeEventSchema.safeParse({
      deliveryId: "d-1",
      kind: "change_request.merged",
      repo: { provider: "radicle", repoRef: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5", url: "rad:z3" },
      actorLogin: "did:key:z6Mk",
      thread: { kind: "change_request", ref: "a".repeat(40) },
      body: null,
      sourceCommentId: null,
      merged,
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
  const parsed = merge({ heads: [A] });
  assert(parsed.success);
  assertEquals(parsed.data.merged, { heads: [A] });
  assertEquals(merge({ baseRef: "main", heads: [A, B] }).success, true);
  // None named is said, not refused: a 400 would lose the merge itself.
  assertEquals(merge({ heads: [] }).success, true);
  // A head that is not a full commit id is not one.
  assertEquals(merge({ heads: [A.slice(0, 7)] }).success, false);
  // The heads are required.
  assertEquals(merge({ baseRef: "main" }).success, false);
});

/** Stages a check bundle with `fetch` answering from `reply`; answers the outcome and what was
 * sent. */
async function stageBundle(reply: () => Response | Promise<Response>, branchName = "feat") {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; headers: Headers; body: Uint8Array }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: new Uint8Array(await new Response(init?.body).arrayBuffer()),
    });
    return await reply();
  }) as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    const outcome = await forge.stageCheckBundle(
      repo("acme/app", "42"),
      "https://github.com/acme/app.git",
      { connectedRepoId: "cr-1", userId: "u-1", branchName, baseRef: "main" },
      new Blob([new Uint8Array([7, 8, 9])]).stream(),
    );
    return { outcome, sent };
  } finally {
    globalThis.fetch = original;
  }
}

test("a check bundle streams as the body, its ask in one header, and a head comes back", async () => {
  const headSha = "b".repeat(40);
  const { outcome, sent } = await stageBundle(
    () =>
      Response.json({ headSha, bundleKey: `users/u-1/cr-1/${headSha}.bundle` }, { status: 201 }),
    "feat/naïve",
  );
  assertEquals(outcome, { kind: "staged", headSha, bundleKey: `users/u-1/cr-1/${headSha}.bundle` });
  const [{ url, headers, body }] = sent;
  assertEquals(url, "http://forge.test/v1/service/check-bundle");
  assertEquals(headers.get("authorization"), "Bearer t");
  assertEquals([...body], [7, 8, 9]);
  // Past ASCII rides escaped: a header value is Latin-1, and the forge's parse reads it back.
  const raw = headers.get("x-ryph-check-bundle")!;
  assert(/^[\x20-\x7e]*$/.test(raw), raw);
  assertEquals(JSON.parse(raw), {
    repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
    url: "https://github.com/acme/app.git",
    connectedRepoId: "cr-1",
    userId: "u-1",
    branchName: "feat/naïve",
    baseRef: "main",
  });
});

test("only the forge's own terminal word refuses a check bundle; anything else is unavailable", async () => {
  const cases: Array<[() => Response | Promise<Response>, string]> = [
    [
      () => Response.json({ error: "wrong ref", detail: "x", terminal: true }, { status: 400 }),
      "refused:400",
    ],
    [() => Response.json({ error: "too big", terminal: true }, { status: 413 }), "refused:413"],
    [() => Response.json({ error: "?" }, { status: 400 }), "unavailable"],
    [() => Response.json({ error: "base cache unavailable" }, { status: 503 }), "unavailable"],
    [() => Response.json({ headSha: "nope", bundleKey: "k" }, { status: 201 }), "unavailable"],
    [() => Promise.reject(new Error("connection refused")), "unavailable"],
  ];
  for (const [reply, expected] of cases) {
    const { outcome } = await stageBundle(reply);
    const got = outcome.kind === "refused" ? `refused:${outcome.status}` : outcome.kind;
    assertEquals(got, expected);
  }
  const { outcome } = await stageBundle(() =>
    Response.json({ error: "wrong ref", detail: "x", terminal: true }, { status: 400 })
  );
  assertEquals(outcome, { kind: "refused", status: 400, error: "wrong ref", detail: "x" });
});

test("a branch's head is the forge's sha; only its terminal 404 is no such branch", async () => {
  const original = globalThis.fetch;
  const sent: unknown[] = [];
  let reply: () => Response | Promise<Response> = () => new Response();
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return await reply();
  }) as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    const read = (r: () => Response | Promise<Response>) => {
      reply = r;
      return forge.readBranchHead(repo("acme/app", "42"), "https://x.test/a.git", "feat");
    };
    const sha = "c".repeat(40);
    assertEquals(await read(() => Response.json({ sha })), { kind: "head", sha });
    assertEquals(sent[0], {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      url: "https://x.test/a.git",
      branch: "feat",
    });
    assertEquals(
      await read(() => Response.json({ error: "no such branch", terminal: true }, { status: 404 })),
      { kind: "absent" },
    );
    assertEquals(await read(() => new Response(null, { status: 501 })), { kind: "unsupported" });
    for (
      const r of [
        () => Response.json({ error: "upstream" }, { status: 502 }),
        () => Response.json({ error: "not found" }, { status: 404 }),
        () => Response.json({ sha: "nope" }),
        () => Promise.reject(new Error("refused")),
      ]
    ) assertEquals((await read(r)).kind, "unavailable");
  } finally {
    globalThis.fetch = original;
  }
});

/** Reads the skills tree with `fetch` answering from `reply`, recording what was sent. */
async function readSkills(reply: () => Response) {
  const original = globalThis.fetch;
  const sent: unknown[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Promise.resolve(reply());
  }) as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    const read = await forge.readSkillsTree(
      repo("acme/skills", "42"),
      "https://x.test/s.git",
      "main",
      "a".repeat(40),
    );
    return { read, sent };
  } finally {
    globalThis.fetch = original;
  }
}

test("the skills tree: answers parsed, a deleted branch named, everything else unavailable", async () => {
  const tree: SkillsTree = {
    kind: "tree",
    commit: "1".repeat(40),
    tree: "b".repeat(40),
    files: [{ path: "deploy/SKILL.md", mode: "100644", content: "LS0t" }],
  };
  const ok = await readSkills(() => Response.json(tree));
  assertEquals(ok.read, tree);
  assertEquals(ok.sent, [{
    repo: repo("acme/skills", "42"),
    url: "https://x.test/s.git",
    commitOrRef: "main",
    knownTree: "a".repeat(40),
  }]);

  const gone = await readSkills(() =>
    Response.json(
      { kind: "missing-ref", error: "main is not a branch of the repo", terminal: true },
      { status: 404 },
    )
  );
  assertEquals(gone.read, { kind: "missing-ref" });
  const refused = await readSkills(() =>
    Response.json({ error: "not a branch name", terminal: true }, { status: 400 })
  );
  assertEquals(refused.read, { kind: "invalid", commit: null, detail: "not a branch name" });
  const down = await readSkills(() =>
    Response.json({ kind: "unavailable", detail: "main could not be read" }, { status: 502 })
  );
  assertEquals(down.read, { kind: "unavailable", detail: "main could not be read" });
  const odd = await readSkills(() => Response.json({ kind: "tree", commit: "nope" }));
  assertEquals(odd.read.kind, "unavailable", "an answer this does not read is not a version");

  // Every other answer a 200 carries reads as itself.
  const answers: SkillsTree[] = [
    { kind: "unchanged", commit: "1".repeat(40), tree: "a".repeat(40) },
    { kind: "absent", commit: "1".repeat(40) },
    { kind: "invalid", commit: "1".repeat(40), detail: ".agents/skills holds 9 entries" },
  ];
  for (const answer of answers) {
    assertEquals((await readSkills(() => Response.json(answer))).read, answer);
  }
});

test("the skills tree: the largest tree the forge serves is one this reads", () => {
  // The forge's own bounds, so raising one there without here fails this rather than turning
  // every read of a large tree into an outage retried hourly, where the forge's `invalid` answer
  // would have named the bound.
  const content = new Uint8Array(MAX_SKILLS_TREE_BYTES).toBase64();
  const files = Array.from({ length: MAX_SKILLS_TREE_ENTRIES }, (_, i) => ({
    path: `s${i}/SKILL.md`,
    mode: "100644",
    content: i === 0 ? content : "",
  }));
  const largest = { kind: "tree", commit: "1".repeat(40), tree: "b".repeat(40), files };
  assert(SkillsTreeAnswerSchema.safeParse(largest).success);
});

test("the skills tree: an answer past the forge's bound as a whole is not one this reads", () => {
  // Every file within its own cap, the tree over the forge's total: never judged.
  const half = new Uint8Array(MAX_SKILLS_TREE_BYTES / 2 + 1).toBase64();
  const files = ["a/SKILL.md", "b/SKILL.md"].map((path) => ({
    path,
    mode: "100644",
    content: half,
  }));
  const over = { kind: "tree", commit: "1".repeat(40), tree: "b".repeat(40), files };
  assert(!SkillsTreeAnswerSchema.safeParse(over).success);
});

test("the skills tree: many small files at the forge's bound are read, whatever their padding", () => {
  // Each file is encoded on its own, so 1,999 one-byte files carry two padding characters each:
  // the tree is at the forge's bound in bytes, and well past it in base64.
  const files = [
    {
      path: "a/SKILL.md",
      mode: "100644",
      content: new Uint8Array(MAX_SKILLS_TREE_BYTES - 1_999).toBase64(),
    },
    ...Array.from({ length: 1_999 }, (_, i) => ({
      path: `a/f${i}`,
      mode: "100644",
      content: new Uint8Array(1).toBase64(),
    })),
  ];
  const atBound = { kind: "tree", commit: "1".repeat(40), tree: "b".repeat(40), files };
  assert(SkillsTreeAnswerSchema.safeParse(atBound).success);
  files.push({ path: "a/one-more", mode: "100644", content: new Uint8Array(1).toBase64() });
  assert(!SkillsTreeAnswerSchema.safeParse(atBound).success);
});

/** Reads a patch's diff with `fetch` answering from `reply`; returns the outcome and the body
 * the forge was sent. */
async function readDiff(reply: () => Response) {
  const original = globalThis.fetch;
  const sent: unknown[] = [];
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Promise.resolve(reply());
  }) as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    const outcome = await forge.readPatchDiff(repo("acme/app", "42"), "https://x.test/a.git", {
      connectedRepoId: "cr-1",
      bundleKey: "run-1/cr-1/abc.bundle",
      branchName: "ryph/run-1",
      headSha: "a".repeat(40),
      baseSha: null,
      targetRef: "main",
      mode: "live",
    });
    return { outcome, sent };
  } finally {
    globalThis.fetch = original;
  }
}

test("a patch diff crosses whole; a terminal refusal is refused, anything else unavailable", async () => {
  const answer = {
    diff: "diff --git a/x b/x\n",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    truncated: true,
    omitted: ["y"],
    moreOmitted: false,
  };
  const ok = await readDiff(() => Response.json(answer));
  assertEquals(ok.outcome, { kind: "diff", ...answer });
  // The ask rides flat beside the repo coordinates, as the forge's strict schema reads it.
  assertEquals(ok.sent, [{
    repo: repo("acme/app", "42"),
    url: "https://x.test/a.git",
    connectedRepoId: "cr-1",
    bundleKey: "run-1/cr-1/abc.bundle",
    branchName: "ryph/run-1",
    headSha: "a".repeat(40),
    baseSha: null,
    targetRef: "main",
    mode: "live",
  }]);

  const gone = await readDiff(() =>
    Response.json({ error: "no bundle at k", terminal: true }, { status: 410 })
  );
  assertEquals(gone.outcome, { kind: "refused", status: 410, error: "no bundle at k" });
  const down = await readDiff(() => Response.json({ error: "retry" }, { status: 503 }));
  assertEquals(down.outcome, { kind: "unavailable", error: "retry" });
  const odd = await readDiff(() => Response.json({ diff: 1 }));
  assertEquals(odd.outcome.kind, "unavailable", "an answer this cannot read is retried");
  // Held to the forge's own bounds: a base that is no commit id, or a diff past the cap.
  for (const over of [{ baseSha: "main" }, { diff: "x".repeat(4 * 1024 * 1024 + 1) }]) {
    const unbounded = await readDiff(() => Response.json({ ...answer, ...over }));
    assertEquals(unbounded.outcome.kind, "unavailable");
  }
});

test("an image the schema cannot take is an omission, never a thread refused over it", async () => {
  const image = { kind: "image" as const, markup: "<img>", data: "AAAA" };
  const outcome = await readThread(() =>
    new Response(JSON.stringify({
      ...THREAD,
      // A list that is not one.
      bodyImages: "nope",
      entries: [{
        ...THREAD.entries[0],
        // A markup past the bound (what one long alt text used to do to the whole read), an
        // image with no bytes, a kind nobody speaks, and a sound one beside them.
        images: [
          { ...image, markup: `<img alt="${"A".repeat(5_000)}">` },
          { kind: "image", markup: "<img2>" },
          { kind: "hologram", markup: "<img3>" },
          image,
          // Which spelling of its markup it is: kept with the markup, on an image and on an
          // omission alike; one that is no count costs the place too, never the first spelling.
          { ...image, occurrence: 2 },
          { kind: "image", markup: "<img4>", occurrence: 1 },
          { ...image, occurrence: -1 },
          { ...image, occurrence: 1.5 },
          { ...image, occurrence: 100_001 },
        ],
        // And a handle out of bounds: an entry no command is found in, nothing worse.
        id: "9".repeat(301),
      }],
    }))
  );
  assert(outcome.kind === "thread");
  assertEquals(outcome.thread.bodyImages, [{ kind: "omitted", markup: "", reason: "unavailable" }]);
  assertEquals(outcome.thread.entries[0].images, [
    { kind: "omitted", markup: "", reason: "unavailable" },
    { kind: "omitted", markup: "<img2>", reason: "unavailable" },
    { kind: "omitted", markup: "<img3>", reason: "unavailable" },
    image,
    { ...image, occurrence: 2 },
    { kind: "omitted", markup: "<img4>", occurrence: 1, reason: "unavailable" },
    { kind: "omitted", markup: "", reason: "unavailable" },
    { kind: "omitted", markup: "", reason: "unavailable" },
    { kind: "omitted", markup: "", reason: "unavailable" },
  ]);
  assertEquals(outcome.thread.entries[0].id, undefined);
});

test("a thread answer past its cap is unavailable, and is not read whole to find out", async () => {
  let pulled = 0;
  const endless = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
        },
      }),
    );
  // Text only: 32 MiB.
  assertEquals((await readThread(endless)).kind, "unavailable");
  assert(pulled <= 34, `read ${pulled} MiB of a text-only answer`);
  // With images, room for ten of them beside the text — and no more.
  pulled = 0;
  assertEquals((await readThread(endless, { images: { focus: null } })).kind, "unavailable");
  assert(pulled <= 32 + 67 + 2, `read ${pulled} MiB of an answer with images`);
  // A declared length over the cap is refused before a byte.
  pulled = 0;
  const declared = await readThread(() =>
    new Response(endless().body, { headers: { "content-length": String(200 * 1024 * 1024) } })
  );
  assertEquals(declared.kind, "unavailable");
  assertEquals(pulled <= 1, true);
});

test("a comment naming a run's images outlasts the generic deadline; any other does not", async () => {
  const original = globalThis.fetch;
  // The forge takes longer than the generic deadline to answer, as it does when it stores a
  // Radicle comment's embeds first.
  globalThis.fetch =
    ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({ commentId: "c-1" })), 50);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        });
      })) as typeof fetch;
  try {
    const forge = httpForge({
      baseUrl: "http://forge.test",
      forgeToken: "t",
      diag: silentDiagnostics(),
      requestTimeoutMs: 10,
    });
    const repo = {
      provider: "radicle" as const,
      repoRef: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5",
      tenantId: null,
    };
    const shows = "Done. ![after](img-0123456789ab)";
    await forge.updateComment(repo, "c-1", shows, "r-1");
    assertEquals(
      await forge.postComment(repo, { kind: "issue", ref: "1" }, shows, "r-1"),
      { commentId: "c-1" },
    );
    let threw = 0;
    for (
      const call of [
        () => forge.updateComment(repo, "c-1", "Done.", "r-1"),
        () => forge.updateComment(repo, "c-1", shows),
      ]
    ) {
      await call().catch(() => threw++);
    }
    assertEquals(threw, 2, "no images, or no run to resolve them against: the generic deadline");
  } finally {
    globalThis.fetch = original;
  }
});

test("a submission refused because its change request ended says how, and nothing else does", async () => {
  const submit = async (reply: () => Response) => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(reply())) as unknown as typeof fetch;
    try {
      const forge = httpForge({
        baseUrl: "http://forge.test",
        forgeToken: "t",
        diag: silentDiagnostics(),
      });
      return await forge.submitPatch({
        approvedHookPaths: [],
        bundleKey: "r-1/k.bundle",
        branchName: "ryph/ada/r-1",
        headSha: "a".repeat(40),
        repo: { provider: "github", repoRef: "acme/app", tenantId: null },
        repoUrl: "https://github.com/acme/app.git",
        baseBranch: "main",
        title: "t",
        body: "b",
        runId: "r-1",
        changeRequest: "7",
      });
    } finally {
      globalThis.fetch = original;
    }
  };
  const refused = (ended?: unknown) => () =>
    Response.json({ error: "not pushing onto #7", terminal: true, ended }, { status: 422 });
  assertEquals(await submit(refused("merged")), {
    kind: "failed",
    message: "not pushing onto #7",
    terminal: true,
    ended: "merged",
  });
  assertEquals((await submit(refused("closed"))).kind, "failed");
  assertEquals(
    (await submit(refused("closed")) as { ended?: string }).ended,
    "closed",
  );
  for (const odd of [undefined, "open", 1]) {
    assertEquals((await submit(refused(odd)) as { ended?: string }).ended, undefined);
  }
});

// Served, not stubbed: only a FETCHED response with an empty body `.json()`s to `null` under Bun
// (one built in the test rejects, as everywhere else), and every read here must still say what
// the forge answered instead of throwing a TypeError on `null.error`.
test("an empty error answer reads as the forge's status, not a crash", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => res.writeHead(503).end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const { port } = server.address() as { port: number };
    const forge = httpForge({
      baseUrl: `http://127.0.0.1:${port}`,
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    const err = await assertRejects(() => forge.listGithubRepos());
    assertEquals((err as Error).message, "the forge answered 503");
    const rad = await assertRejects(() => forge.describeRadicleRepo("rad:z3"));
    assertEquals((rad as Error).message, "the forge answered 503");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
