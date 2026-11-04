import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { checksWorld, HEAD } from "./checks_world.ts";
import { remoteChecksClient, RemoteChecksError } from "../src/adapters/remote_checks/http.ts";
import { type CheckRequest, MAX_CHECK_LOG_BYTES, MAX_OWN_PODS } from "../src/core/check_types.ts";
import type { ConnectedRepo } from "../src/core/types.ts";

const endpoint = "https://remote.example/prefix";
const pat = "private-pat-never-reflect";
const bearer = "private-access-never-reflect";
const ref = { endpoint, requestId: "cq-remote", suiteId: "cs-remote" };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const pending = () => ({ requestId: ref.requestId, suite: null, results: [] });
const result = () => ({
  suiteId: ref.suiteId,
  generation: 1,
  name: "unit",
  state: "passed",
  exitCode: 0,
  startedAt: null,
  finishedAt: null,
  logKey: null,
  logTail: null,
  watchedChanged: null,
  forgeRef: null,
  inheritedFrom: null,
});
const snapshot = () => ({
  requestId: ref.requestId,
  results: [result()],
  suite: {
    id: ref.suiteId,
    connectedRepoId: "cr-remote",
    commit: "a".repeat(40),
    checksRef: "main",
    checksCommit: "b".repeat(40),
    checksBlob: "c".repeat(40),
    checksPath: ".ryph/checks.yml",
    definition: {
      setup: [],
      checks: [{ name: "unit", run: "true", timeoutSeconds: null, services: [], watch: [] }],
    },
    environmentKey: "env",
    inputsKey: "inputs",
    networkScope: {},
    environmentId: null,
    image: null,
    services: [],
    source: { branchName: "feature", baseRef: "main" },
    state: "passed",
    generation: 1,
    reason: null,
    attempts: 0,
    ryphChanged: false,
    leaseUntil: null,
    waitingSince: null,
    nextAttemptAt: null,
    launchedAt: null,
    finishedAt: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
});
const request: CheckRequest = {
  id: "cq-local",
  suiteId: null,
  rerunOf: null,
  connectedRepoId: "cr-local",
  commit: "a".repeat(40),
  runId: null,
  patchId: null,
  changeRequest: null,
  userId: "u-local",
  kind: "local",
  state: "pending",
  note: null,
  source: {
    runId: null,
    branchName: "feature",
    baseRef: "main",
    changeRequest: null,
    fetchRef: null,
    url: null,
  },
  checksRef: "main",
  reportedGeneration: null,
  attempts: 0,
  nextAttemptAt: null,
  createdAt: "2026-01-01",
  expiresAt: null,
};
// Only forge coordinates are consumed by this transport; ownership and policy are core concerns.
const repo = { repoRef: "owner/repo" } as ConnectedRepo;
type Call = { url: string; init: RequestInit };
function client(
  handler: (call: Call) => Response | Promise<Response>,
  readBundle = (_key: string): Promise<ReadableStream<Uint8Array> | null> => Promise.resolve(null),
) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    assertEquals(call.init.redirect, "error");
    assertEquals(call.init.signal instanceof AbortSignal, true);
    return await handler(call);
  }) as typeof globalThis.fetch;
  return {
    calls,
    remote: remoteChecksClient({ url: endpoint, token: pat }, { fetch, readBundle }),
  };
}
const isAuth = (call: Call) => call.url.endsWith("/api/v1/auth/token");

test("remote HTTP exchanges PAT only at auth, caches bearer and preserves path prefix", async () => {
  const { remote, calls } = client((call) =>
    isAuth(call) ? json({ accessToken: bearer, expiresIn: 3600 }) : json(pending())
  );
  await remote.read({ ...ref, suiteId: null });
  await remote.read({ ...ref, suiteId: null });
  assertEquals(calls.length, 3);
  assertEquals(JSON.parse(String(calls[0]!.init.body)), { token: pat });
  assertEquals(new Headers(calls[0]!.init.headers).has("authorization"), false);
  for (const call of calls.slice(1)) {
    assertEquals(call.url, `${endpoint}/api/v1/check-delegations/${ref.requestId}`);
    assertEquals(new Headers(call.init.headers).get("authorization"), `Bearer ${bearer}`);
    assertEquals(JSON.stringify(call).includes(pat), false);
  }
});

test("remote HTTP renews bearer once on 401 and uses fresh credentials", async () => {
  let auth = 0, reads = 0;
  const { remote } = client((call) => {
    if (isAuth(call)) return json({ accessToken: `access-${++auth}`, expiresIn: 3600 });
    assertEquals(new Headers(call.init.headers).get("authorization"), `Bearer access-${auth}`);
    return ++reads === 1 ? new Response("expired", { status: 401 }) : json(pending());
  });
  await remote.read({ ...ref, suiteId: null });
  assertEquals([auth, reads], [2, 2]);
});

test("remote HTTP does not retry an unauthorized request forever", async () => {
  let auth = 0;
  const { remote, calls } = client((call) =>
    isAuth(call)
      ? json({ accessToken: `access-${++auth}`, expiresIn: 3600 })
      : new Response(pat, { status: 401 })
  );
  const error = await assertRejects(() => remote.read(ref), RemoteChecksError);
  assertEquals(calls.length, 4);
  assertEquals(error.message.includes(pat), false);
});

test("remote HTTP renews near-expiry access without waiting for 401", async () => {
  let auth = 0;
  const { remote } = client((call) =>
    isAuth(call) ? json({ accessToken: `access-${++auth}`, expiresIn: 1 }) : json(pending())
  );
  await remote.read({ ...ref, suiteId: null });
  await remote.read({ ...ref, suiteId: null });
  assertEquals(auth, 2);
});

test("remote HTTP reopens and streams bundles on retry without sending PAT or local keys", async () => {
  let opened = 0, submitted = 0;
  const streams: BodyInit[] = [];
  const { remote } = client(async (call) => {
    if (isAuth(call)) return json({ accessToken: bearer, expiresIn: 3600 });
    if (call.init.method === "GET") return json(pending());
    assertEquals(call.url.includes("/api/v1/check-delegations/bundle?"), true);
    assertEquals(call.url.includes("private-bundle-key"), false);
    assertEquals(call.url.includes(pat), false);
    assertEquals(new Headers(call.init.headers).get("content-type"), "application/octet-stream");
    assertEquals(call.init.body instanceof ReadableStream, true);
    streams.push(call.init.body!);
    assertEquals(await new Response(call.init.body).text(), "bundle-bytes");
    return ++submitted === 1
      ? new Response(null, { status: 401 })
      : json({ request: { id: ref.requestId } });
  }, (key) => {
    assertEquals(key, "private-bundle-key");
    opened++;
    return Promise.resolve(new Response("bundle-bytes").body!);
  });
  await remote.submit({
    repo,
    request: {
      ...request,
      source: {
        runId: "r-local",
        path: "api",
        branchName: "feature",
        baseRef: "main",
        bundleKey: "private-bundle-key",
      },
    },
  });
  assertEquals([opened, submitted], [2, 2]);
  assertEquals(streams[0] === streams[1], false);
});

test("remote HTTP refuses redirects and redacts transport and response errors", async () => {
  for (const mode of ["throw", "redirect", "status", "json"] as const) {
    const { remote } = client((call) => {
      if (isAuth(call)) return json({ accessToken: bearer, expiresIn: 3600 });
      if (mode === "throw") throw new Error(`${pat} ${bearer}`);
      if (mode === "redirect") {
        return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
      }
      return new Response(`${pat} ${bearer}`, { status: mode === "status" ? 500 : 200 });
    });
    const error = await assertRejects(() => remote.read(ref), RemoteChecksError);
    assertEquals(error.message.includes(pat), false);
    assertEquals(error.message.includes(bearer), false);
  }
});

test("remote HTTP redacts log response stream failures", async () => {
  const { remote } = client((call) => {
    if (isAuth(call)) return json({ accessToken: bearer, expiresIn: 3600 });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(`${pat} ${bearer}`));
        },
      }),
    );
  });
  const error = await assertRejects(() => remote.log(ref, 1, "unit"), RemoteChecksError);
  assertEquals(error.message.includes(pat), false);
  assertEquals(error.message.includes(bearer), false);
});

test("remote HTTP bounds snapshot and log bodies and cancels oversized streams", async () => {
  for (const log of [false, true]) {
    let cancelled = false;
    const { remote } = client((call) => {
      if (isAuth(call)) return json({ accessToken: bearer, expiresIn: 3600 });
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array((log ? MAX_CHECK_LOG_BYTES : 2 * 1024 * 1024) + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    await assertRejects(
      () => log ? remote.log(ref, 1, "unit") : remote.read(ref),
      RemoteChecksError,
    );
    assertEquals(cancelled, true);
  }
});

test("remote HTTP validates request identity and result suite, generation, uniqueness and names", async () => {
  const invalid = [
    { ...snapshot(), requestId: "cq-other" },
    { ...snapshot(), results: [{ ...result(), suiteId: "cs-other" }] },
    { ...snapshot(), results: [{ ...result(), generation: 2 }] },
    { ...snapshot(), results: [result(), result()] },
    { ...snapshot(), results: [{ ...result(), name: "unknown" }] },
    { ...pending(), results: [result()] },
  ];
  for (const value of invalid) {
    const { remote } = client((call) =>
      isAuth(call) ? json({ accessToken: bearer, expiresIn: 3600 }) : json(value)
    );
    await assertRejects(() => remote.read(ref), RemoteChecksError);
  }
  const { remote } = client((call) =>
    isAuth(call) ? json({ accessToken: bearer, expiresIn: 3600 }) : json(snapshot())
  );
  assertEquals((await remote.read(ref)).suite?.id, ref.suiteId);
});

test("remote HTTP refuses a size without pod: own, and more own pods than a file may have", async () => {
  const check = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    run: "true",
    timeoutSeconds: null,
    services: [],
    watch: [],
    ...extra,
  });
  const withChecks = (checks: unknown[]) => {
    const value = snapshot();
    value.suite.definition.checks = checks as typeof value.suite.definition.checks;
    return value;
  };
  const owns = (n: number) =>
    Array.from({ length: n }, (_, i) => check(i === 0 ? "unit" : `own${i}`, { pod: "own" }));
  const read = (value: unknown) =>
    client((call) => isAuth(call) ? json({ accessToken: bearer, expiresIn: 3600 }) : json(value))
      .remote.read(ref);
  await assertRejects(
    () => read(withChecks([check("unit", { size: "large" })])),
    RemoteChecksError,
  );
  await assertRejects(() => read(withChecks(owns(MAX_OWN_PODS + 1))), RemoteChecksError);
  assertEquals(
    (await read(withChecks([check("unit", { pod: "own", size: "large" })]))).suite?.id,
    ref.suiteId,
  );
  assertEquals((await read(withChecks(owns(MAX_OWN_PODS)))).suite?.id, ref.suiteId);
});

test("remote HTTP rejects malformed submit identity before fetching snapshot", async () => {
  const { remote, calls } = client((call) =>
    isAuth(call)
      ? json({ accessToken: bearer, expiresIn: 3600 })
      : json({ request: { id: "../../escape" } })
  );
  await assertRejects(() => remote.submit({ request, repo }), RemoteChecksError);
  assertEquals(calls.length, 2);
});

test("remote HTTP cancellation 404 is idempotent and missing logs return null", async () => {
  const { remote } = client((call) =>
    isAuth(call)
      ? json({ accessToken: bearer, expiresIn: 3600 })
      : new Response(null, { status: 404 })
  );
  await remote.cancel(ref);
  await remote.cancel(ref);
  assertEquals(await remote.log(ref, 1, "unit"), null);
});

test("remote HTTP refuses endpoint mismatch before any authentication or request", async () => {
  const { remote, calls } = client(() => {
    throw new Error("must not fetch");
  });
  const other = { ...ref, endpoint: "https://other.example" };
  await assertRejects(() => remote.read(other), RemoteChecksError);
  await assertRejects(() => remote.cancel(other), RemoteChecksError);
  await assertRejects(() => remote.log(other, 1, "unit"), RemoteChecksError);
  assertEquals(calls.length, 0);
});

test("remote HTTP declaration failures are unavailable, never absent", async () => {
  for (const status of [401, 403, 404, 500]) {
    const { remote } = client((call) =>
      isAuth(call) ? json({ accessToken: bearer, expiresIn: 3600 }) : new Response(pat, { status })
    );
    const file = await remote.readChecksFile(repo, "main");
    assertEquals(file.kind, "unavailable");
    assertEquals(JSON.stringify(file).includes(pat), false);
  }
  for (
    const body of [{}, { kind: "absent", commit: "a".repeat(40) }, {
      kind: "unavailable",
      detail: "offline",
    }]
  ) {
    const { remote } = client((call) =>
      isAuth(call) ? json({ accessToken: bearer, expiresIn: 3600 }) : json(body)
    );
    const file = await remote.readChecksFile(repo, "main");
    assertEquals(file.kind, body.kind === "absent" ? "absent" : "unavailable");
  }
});

test("remote HTTP accepts actual receiver service suite and result shapes", async () => {
  const w = await checksWorld({ policy: { maxConcurrent: 0 } });
  w.forge.readBranchHead = () => Promise.resolve({ kind: "head", sha: HEAD });
  const answer = await w.service.requestLocal({
    user: { userId: "receiver-pat-owner", name: "Receiver" },
    repo: w.api,
    commit: HEAD,
    branch: "feature",
    bundled: false,
    delegationId: "instance-a:run-1",
  });
  assert(answer.kind === "requested");
  assert(answer.suite !== null);
  const value = {
    requestId: answer.request.id,
    suite: answer.suite,
    results: await w.checkStore.listResults(answer.suite.id, answer.suite.generation),
  };
  const { remote } = client((call) =>
    isAuth(call) ? json({ accessToken: bearer, expiresIn: 3600 }) : json(value)
  );
  const received = await remote.read({
    endpoint,
    requestId: answer.request.id,
    suiteId: answer.suite.id,
  });
  assertEquals(received.suite?.id, answer.suite.id);
  assertEquals(received.suite?.definition, answer.suite.definition);
  assertEquals(received.results, value.results);
});

test("remote HTTP names the repo's forge host on every ask, as ryph check does", async () => {
  const github = {
    provider: "github",
    repoRef: "acme/api",
    url: "https://github.com/acme/api.git",
  };
  const gitlab = {
    provider: "gitlab",
    repoRef: "acme/api",
    url: "https://GitLab.example.com:8443/acme/api.git",
  };
  const radicle = { provider: "radicle", repoRef: "rad:z3x", url: "rad://z3x" };
  for (
    const [r, host] of [[github, "github.com"], [gitlab, "gitlab.example.com:8443"], [
      radicle,
      null,
    ]] as const
  ) {
    const { calls, remote } = client((call) => {
      if (isAuth(call)) return json({ accessToken: bearer, expiresIn: 3600 });
      if (call.init.method === "GET" && call.url.includes("/declaration?")) {
        return json({ kind: "absent", commit: "a".repeat(40) });
      }
      if (call.init.method === "GET") return json(pending());
      return json({ request: { id: ref.requestId } });
    }, () => Promise.resolve(new Response("bundle-bytes").body!));
    const asRepo = r as unknown as ConnectedRepo;
    await remote.readChecksFile(asRepo, "main");
    await remote.submit({ repo: asRepo, request });
    await remote.submit({
      repo: asRepo,
      request: { ...request, source: { ...request.source, bundleKey: "k" } as never },
    });
    const asks = calls.filter((c) => !isAuth(c) && !c.url.includes(`/${ref.requestId}`));
    assertEquals(
      asks.map((c) => new URL(c.url).pathname.replace(/^.*\/v1\//, "")),
      ["check-delegations/declaration", "check-delegations", "check-delegations/bundle"],
    );
    for (const call of asks) {
      assertEquals(new URL(call.url).searchParams.get("host"), host, call.url);
    }
  }
});

test("remote HTTP asks for a failed suite's retry only for a run's or a person's ask", async () => {
  for (
    const [kind, retries] of [
      ["tool", true],
      ["local", true],
      ["patch", false],
      [
        "push",
        false,
      ],
      ["rerun", false],
      ["forge", false],
    ] as const
  ) {
    const { calls, remote } = client((call) => {
      if (isAuth(call)) return json({ accessToken: bearer, expiresIn: 3600 });
      if (call.init.method === "GET") return json(pending());
      return json({ request: { id: ref.requestId } });
    }, () => Promise.resolve(new Response("bundle-bytes").body!));
    await remote.submit({ repo, request: { ...request, kind } });
    await remote.submit({
      repo,
      request: { ...request, kind, source: { ...request.source, bundleKey: "k" } as never },
    });
    const [pushed, bundled] = calls.filter((c) => c.init.method === "POST" && !isAuth(c));
    assertEquals(
      JSON.parse(String(pushed.init.body)).retryFailed,
      retries ? true : undefined,
      kind,
    );
    assertEquals(
      new URL(bundled.url).searchParams.get("retryFailed"),
      retries ? "true" : null,
      kind,
    );
  }
});
