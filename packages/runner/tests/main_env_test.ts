// The agent-container contract, exercised for real: the runner booted as a subprocess with only
// the contract env (run id, orchestrator URL, bootstrap token) and no input files anywhere — exactly how
// an orchestrator-launched container starts it. The runner fetches its spec from a stub
// orchestrator on boot, works it, and reports back over the same surface. The stub plays the
// forge's git gateway too, as the contract always names one: the clone reads the fixture origin
// under the gateway's header, and the work leaves as a bundle POSTed to the stub. Complements
// run_e2e_test.ts, which gates the pipeline in-process; this gates the composition root's
// ingestion.

import { test } from "bun:test";
import { command } from "@ryph/process";
import { serve } from "@ryph/service";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { harnessRefusal } from "../src/main.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { ENV_PREFIX } from "../src/core/brand.ts";
import { git } from "../src/helpers/git_exec.ts";
import { makeThrowawayOrigin } from "./fixtures/origin.ts";
import { repoEntry } from "./util.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

async function runMain(
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  // process.execPath, not "bun": these assert on THIS runtime's behaviour, and a PATH lookup
  // could pick a different one (mise, and therefore CI, puts a shim there).
  const { code, stdout, stderr } = await command(process.execPath, {
    args: ["--no-env-file", MAIN, ...args],
    env: { ...env, RYPH_LOG_LEVEL: "warn" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

interface SeenRequest {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

/** A stub orchestrator and git gateway: serves the given /spec body, takes bundles at the
 * gateway's intake, acks everything else, records all traffic. */
async function stubOrchestrator(
  specBody: unknown,
  opts: { credentials?: unknown | "endpoint-missing"; noGateway?: boolean } = {},
): Promise<{
  url: string;
  requests: SeenRequest[];
  /** The bundles the gateway's intake took, by connected repo. */
  bundles: Array<{ repo: string; body: Uint8Array }>;
  shutdown(): Promise<void>;
}> {
  const requests: SeenRequest[] = [];
  const bundles: Array<{ repo: string; body: Uint8Array }> = [];
  const credentials = opts.credentials ?? { env: {} };
  let booted = false;
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const path = new URL(req.url).pathname;
      // The gateway's intake: the run's work, as a bundle. Not JSON, so it is taken before the
      // record below tries to read it as such.
      const intake = path.match(/^\/v1\/patches\/([^/]+)$/);
      if (req.method === "POST" && intake !== null) {
        bundles.push({
          repo: decodeURIComponent(intake[1]),
          body: new Uint8Array(await req.arrayBuffer()),
        });
        return Response.json({ headSha: "…", bundleKey: "b" }, { status: 201 });
      }
      // The gateway's freshness route: a forge without it reads as fresh.
      if (req.method === "GET" && path.endsWith("/base")) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      requests.push({
        method: req.method,
        path,
        auth: req.headers.get("authorization"),
        body: req.method === "POST" ? await req.json().catch(() => null) : null,
      });
      if (req.method === "POST" && path.endsWith("/bootstrap")) {
        if (booted || req.headers.get("authorization") !== "Bearer bootstrap-token") {
          return new Response(null, { status: 401 });
        }
        booted = true;
        // The stub is the git gateway too, so the exchange names it as one.
        return Response.json({
          env: {
            RYPH_RUN_TOKEN: "run-token",
            ...(opts.noGateway
              ? {}
              : { RYPH_GIT_ORIGIN: new URL(req.url).origin, RYPH_GIT_TOKEN: "git-token" }),
          },
        });
      }
      if (req.method === "GET" && path.endsWith("/spec")) return Response.json(specBody);
      if (req.method === "GET" && path.endsWith("/credentials")) {
        // "endpoint-missing" plays an orchestrator predating the credentials route: its router
        // answers 404, and the runner must boot anyway. "issue-failure" plays an orchestrator
        // that cannot mint (e.g. the backing key vanished): 503, a boot failure.
        if (credentials === "endpoint-missing") {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        if (credentials === "issue-failure") {
          return Response.json({ error: "could not issue run credentials" }, { status: 503 });
        }
        return Response.json(credentials);
      }
      // No stored skill: every bundle fetch is told the platform holds no such version.
      if (req.method === "GET" && path.includes("/skills/")) {
        return Response.json({ error: "no stored skill has that digest" }, { status: 404 });
      }
      if (path.endsWith("/result")) return Response.json({ ack: "Accepted" });
      return new Response(null, { status: 204 }); // a heartbeat is acknowledged, never answered
    },
  );
  const addr = server.addr;
  return {
    url: `http://${addr.hostname}:${addr.port}`,
    requests,
    bundles,
    shutdown: () => server.shutdown(),
  };
}

/** Lands a bundle the stub's intake took as `branch` on the origin, as the forge would on
 * approval, so what the run committed can be read back. */
async function landBundle(originUrl: string, body: Uint8Array, branch: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  const path = join(dir, "land.bundle");
  try {
    await writeFile(path, body);
    await git(originUrl, "fetch", "--quiet", path, `refs/heads/${branch}:refs/heads/${branch}`);
  } finally {
    await rm(dir, { recursive: true });
  }
}

function contractEnv(orchestratorUrl: string, runId: string): Record<string, string> {
  return {
    [`${ENV_PREFIX}_RUN_ID`]: runId,
    [`${ENV_PREFIX}_ORCHESTRATOR_URL`]: orchestratorUrl,
    [`${ENV_PREFIX}_BOOTSTRAP_TOKEN`]: "bootstrap-token",
    RUNNER_HEARTBEAT_INTERVAL_MS: "50",
  };
}

test("contract: a fetched spec runs to a shipped bundle, heartbeats, and one result", async () => {
  const origin = await makeThrowawayOrigin();
  const item = {
    id: "wi-boot-0001",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "boot: echo the task", instructions: "Write the task into AGENT_NOTES.md." },
    repos: [
      repoEntry({ url: origin.url, ref: origin.ref, branchNamespace: "runner/ada/wi-boot-0001" }),
    ],
    workspace: null,
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    canOpenPatches: true,
  };
  const orch = await stubOrchestrator({
    workItem: item,
    injectedContext: { systemPrompt: "You are ada." },
  });
  try {
    const { code, stdout, stderr } = await runMain(
      contractEnv(orch.url, item.id),
      [],
    );
    assertEquals(code, 0, `stderr:\n${stderr}`);
    const result = JSON.parse(stdout);
    assertEquals(result.status, "success");
    assertEquals(result.branches[0].name, `${item.repos[0].branchNamespace}/work`);
    // the work really left through the gateway, as a bundle for the run's connected repo — the
    // fetched spec fed the same pipeline as the flags
    assertEquals(orch.bundles.map((b) => b.repo), [item.repos[0].connectedRepoId]);
    assert(orch.bundles[0].body.byteLength > 0);

    const bootstraps = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/bootstrap`);
    assertEquals(bootstraps.length, 1);
    assertEquals(bootstraps[0].auth, "Bearer bootstrap-token");
    assertEquals(orch.requests[0], bootstraps[0], "exchange precedes every authenticated request");
    assert(!stdout.includes("run-token") && !stderr.includes("run-token"));

    // the spec was fetched with the run-scoped bearer, exactly once
    const specFetches = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/spec`);
    assertEquals(specFetches.length, 1);
    assertEquals(specFetches[0].auth, "Bearer run-token");

    // the credentials fetch is the second half of the boot handshake, same bearer
    const credFetches = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/credentials`);
    assertEquals(credFetches.length, 1);
    assertEquals(credFetches[0].auth, "Bearer run-token");

    // beats landed with a monotonic seq, and exactly one result
    const beats = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/heartbeat`);
    assert(beats.length >= 1, "at least one heartbeat must land during a real run");
    for (const [i, beat] of beats.entries()) {
      if (i > 0) assert((beat.body?.seq as number) > (beats[i - 1].body?.seq as number));
    }
    const results = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/result`);
    assertEquals(results.length, 1, "exactly one result must be reported");
    assertEquals(results[0].body?.status, "success");
  } finally {
    await orch.shutdown();
    await origin.cleanup();
  }
});

test("contract: a run launched without the git gateway pair is a reported boot failure", async () => {
  // The control plane always names the gateway: every repo is a connected one. A run without it
  // is a composition bug, refused before anything is fetched or cloned.
  const orch = await stubOrchestrator({ nothing: "fetched" }, { noGateway: true });
  try {
    const env = contractEnv(orch.url, "wi-boot-0011");
    const { code, stderr } = await runMain(env, []);
    assertEquals(code, 2);
    assertStringIncludes(stderr, "forge's git gateway");
    assertEquals(orch.requests.filter((r) => r.path.endsWith("/spec")), []);
    const results = orch.requests.filter((r) => r.path === "/v1/runs/wi-boot-0011/result");
    assertEquals(results.length, 1);
    assertEquals(results[0].body?.during, "booting");
  } finally {
    await orch.shutdown();
  }
});

test("contract: an orchestrator without the credentials endpoint still boots the run", async () => {
  const origin = await makeThrowawayOrigin();
  const item = {
    id: "wi-boot-0006",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "boot: echo the task", instructions: "Write the task into AGENT_NOTES.md." },
    repos: [
      repoEntry({ url: origin.url, ref: origin.ref, branchNamespace: "runner/ada/wi-boot-0006" }),
    ],
    workspace: null,
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    canOpenPatches: true,
  };
  const orch = await stubOrchestrator(
    { workItem: item, injectedContext: null },
    { credentials: "endpoint-missing" },
  );
  try {
    const { code, stdout, stderr } = await runMain(
      contractEnv(orch.url, item.id),
      [],
    );
    assertEquals(code, 0, `stderr:\n${stderr}`);
    assertEquals(JSON.parse(stdout).status, "success");
  } finally {
    await orch.shutdown();
    await origin.cleanup();
  }
});

test("contract: undeliverable credentials are a reported boot failure and exit 2", async () => {
  // 503 is the orchestrator's "could not issue" answer (e.g. the backing key was archived
  // between provision and boot): the run could never call a model, so it must die before
  // cloning anything — and still conclude upstream.
  const item = {
    id: "wi-boot-0007",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "inert", instructions: "never runs" },
    repos: [
      repoEntry({
        url: "file:///nowhere",
        ref: "main",
        branchNamespace: "runner/ada/wi-boot-0007",
      }),
    ],
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    canOpenPatches: true,
  };
  const orch = await stubOrchestrator(
    { workItem: item, injectedContext: null },
    { credentials: "issue-failure" },
  );
  try {
    const { code, stderr } = await runMain(
      contractEnv(orch.url, item.id),
      [],
    );
    assertEquals(code, 2);
    assert(stderr.includes("credentials"), `stderr:\n${stderr}`);
    const results = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/result`);
    assertEquals(results.length, 1);
    assertEquals(results[0].body?.during, "booting");
  } finally {
    await orch.shutdown();
  }
});

test("contract: an invalid spec is a reported boot failure and exit 2", async () => {
  const orch = await stubOrchestrator({ nothing: "of use" });
  try {
    const { code, stderr } = await runMain(
      contractEnv(orch.url, "wi-boot-0002"),
      [],
    );
    assertEquals(code, 2);
    assert(stderr.includes("the fetched run spec"), `stderr:\n${stderr}`);
    // reported if reporting is possible: the failure concluded the run upstream immediately
    const results = orch.requests.filter((r) => r.path === "/v1/runs/wi-boot-0002/result");
    assertEquals(results.length, 1);
    assertEquals(results[0].body?.status, "error");
    assertEquals(results[0].body?.during, "booting");
  } finally {
    await orch.shutdown();
  }
});

test("contract: a spec for the wrong run is a reported boot failure and exit 2", async () => {
  const orch = await stubOrchestrator({
    workItem: {
      id: "wi-somebody-else",
      agent: { name: "ada", email: "ada@runner.local" },
      spec: { title: "inert", instructions: "never runs" },
      repos: [
        repoEntry({
          url: "file:///nowhere",
          ref: "main",
          branchNamespace: "runner/ada/wi-somebody-else",
        }),
      ],
      harness: { kind: "echo" },
      lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
      canOpenPatches: true,
    },
    injectedContext: null,
  });
  try {
    const { code, stderr } = await runMain(
      contractEnv(orch.url, "wi-boot-0003"),
      [],
    );
    assertEquals(code, 2);
    assert(stderr.includes("wi-somebody-else"), `stderr:\n${stderr}`);
    const results = orch.requests.filter((r) => r.path === "/v1/runs/wi-boot-0003/result");
    assertEquals(results.length, 1);
    assertEquals(results[0].body?.during, "booting");
  } finally {
    await orch.shutdown();
  }
});

test("contract: an orchestrator URL without a bootstrap token is bad config", async () => {
  const { code, stderr } = await runMain({
    [`${ENV_PREFIX}_ORCHESTRATOR_URL`]: "http://127.0.0.1:1",
  }, []);
  assertEquals(code, 2);
  assert(stderr.includes(`${ENV_PREFIX}_ORCHESTRATOR_URL`), `stderr:\n${stderr}`);
  assert(stderr.includes(`${ENV_PREFIX}_BOOTSTRAP_TOKEN`), `stderr:\n${stderr}`);
});

test("contract: a refused bootstrap ends the boot cleanly, before any other request", async () => {
  const orch = await stubOrchestrator({});
  try {
    const { code, stderr } = await runMain({
      ...contractEnv(orch.url, "wi-boot-0011"),
      [`${ENV_PREFIX}_BOOTSTRAP_TOKEN`]: "spent-token",
      // The launch contract before bootstrap: a run bearer in the environment is not honoured.
      [`${ENV_PREFIX}_RUN_TOKEN`]: "run-token",
    }, []);
    assertEquals(code, 2);
    assert(stderr.includes("bootstrap") && stderr.includes("401"), `stderr:\n${stderr}`);
    assertEquals(orch.requests.map((r) => r.path), ["/v1/runs/wi-boot-0011/bootstrap"]);
  } finally {
    await orch.shutdown();
  }
});

test("contract: a malformed bootstrap answer fails the boot without echoing it", async () => {
  // Truncated mid-credential: the parser's own message would quote it.
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response('{"env":{"RYPH_RUN_TOKEN":"leaky-secret-value'),
  );
  try {
    const addr = server.addr;
    const { code, stderr } = await runMain(
      contractEnv(`http://${addr.hostname}:${addr.port}`, "wi-boot-0012"),
      [],
    );
    assertEquals(code, 2);
    assert(stderr.includes("the run bootstrap: not JSON"), `stderr:\n${stderr}`);
    assert(!stderr.includes("leaky-secret"), `stderr:\n${stderr}`);
  } finally {
    await server.shutdown();
  }
});

test("contract: no work-item flag and no contract env is bad usage, both paths named", async () => {
  const { code, stderr } = await runMain({}, []);
  assertEquals(code, 2);
  assert(stderr.includes("--work-item"), `stderr:\n${stderr}`);
  assert(stderr.includes(`${ENV_PREFIX}_RUN_ID`), `stderr:\n${stderr}`);
});

test("contract: a malformed heartbeat interval is bad config, the knob named", async () => {
  // A syntactically valid work item on disk gets past ingestion; the run must then exit on the
  // bad knob before the pipeline ever touches the (nonexistent) repo.
  const itemDir = await mkdtemp(join(tmpdir(), "ryph-"));
  const itemPath = join(itemDir, "item.json");
  await writeFile(
    itemPath,
    JSON.stringify({
      id: "wi-boot-0004",
      agent: { name: "ada", email: "ada@runner.local" },
      spec: { title: "inert", instructions: "never runs" },
      repos: [
        repoEntry({
          url: "file:///nowhere",
          ref: "main",
          branchNamespace: "runner/ada/wi-boot-0004",
        }),
      ],
      harness: { kind: "echo" },
      lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
      canOpenPatches: true,
    }),
  );
  // The knob is read only once the run is wired to report, which takes a redeemed bootstrap.
  const orch = await stubOrchestrator({});
  try {
    const { code, stderr } = await runMain({
      ...contractEnv(orch.url, "wi-boot-0004"),
      RUNNER_HEARTBEAT_INTERVAL_MS: "soon",
    }, ["--work-item", itemPath]);
    assertEquals(code, 2);
    assert(stderr.includes("RUNNER_HEARTBEAT_INTERVAL_MS"), `stderr:\n${stderr}`);
  } finally {
    await orch.shutdown();
    await rm(itemDir, { recursive: true });
  }
});

test("contract: a credentials answer with an mcp half boots the run and reaches the harness", async () => {
  const origin = await makeThrowawayOrigin();
  const item = {
    id: "wi-boot-0010",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "boot: echo the task", instructions: "Write the task into AGENT_NOTES.md." },
    repos: [
      repoEntry({ url: origin.url, ref: origin.ref, branchNamespace: "runner/ada/wi-boot-0010" }),
    ],
    workspace: null,
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    canOpenPatches: true,
  };
  const orch = await stubOrchestrator(
    { workItem: item, injectedContext: null },
    {
      credentials: {
        env: {},
        mcp: {
          token: "ryph-mcp-virtual",
          servers: [{ slug: "linear", name: "Linear", url: "http://gw.test/v1/mcp/r/linear" }],
        },
      },
    },
  );
  try {
    const { code, stdout, stderr } = await runMain(
      contractEnv(orch.url, item.id),
      [],
    );
    assertEquals(code, 0, `stderr:\n${stderr}`);
    assertEquals(JSON.parse(stdout).status, "success");
    // echo has no MCP client, but it records the servers it was offered — proof the composition
    // root carried the mcp half from the fetch through the core to the harness
    await landBundle(origin.url, orch.bundles[0].body, `${item.repos[0].branchNamespace}/work`);
    const notes = await git(
      origin.url,
      "show",
      `refs/heads/${item.repos[0].branchNamespace}/work:AGENT_NOTES.md`,
    );
    assert(notes.includes("Tool servers offered: linear"), notes);
  } finally {
    await orch.shutdown();
    await origin.cleanup();
  }
});

// The composition root carries the spec's frozen skills into the core: each is fetched by its
// digest, and one the platform cannot serve is reported as a drop while the run goes on.
test("contract: a frozen skill is fetched by digest, and one the platform lacks is reported", async () => {
  const origin = await makeThrowawayOrigin();
  const item = {
    id: "wi-boot-0020",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "boot: echo the task", instructions: "Write the task into AGENT_NOTES.md." },
    repos: [
      repoEntry({ url: origin.url, ref: origin.ref, branchNamespace: "runner/ada/wi-boot-0020" }),
    ],
    workspace: null,
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  const digest = `sha256:${"c".repeat(64)}`;
  const orch = await stubOrchestrator({
    workItem: item,
    injectedContext: null,
    skills: {
      skills: [{
        name: "ryph-checks",
        description: "How checks work.",
        source: "catalogue",
        digest,
      }],
      workingRepos: true,
      budget: { skills: 31, listingBytes: 16_000 },
    },
  });
  try {
    const { code, stdout, stderr } = await runMain(
      contractEnv(orch.url, item.id),
      [],
    );
    assertEquals(code, 0, `stderr:\n${stderr}`);
    assertEquals(JSON.parse(stdout).status, "success");
    const fetches = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/skills/${digest}`);
    assertEquals(fetches.length, 1);
    assertEquals(fetches[0].auth, "Bearer run-token");
    const reports = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/skills/report`);
    assertEquals(reports.length, 1);
    assertEquals(reports[0].body, {
      root: null,
      loaded: [],
      dropped: [{
        source: "catalogue",
        name: "ryph-checks",
        reason: "unavailable",
        detail: "the platform holds no such version",
      }],
    });
  } finally {
    await orch.shutdown();
    await origin.cleanup();
  }
});

// A skills section this runner's restated rules refuse (a newer control plane's looser limit,
// say) costs the run its skills, never the run: nothing is fetched, the drop is reported, and the
// work still lands.
test("contract: a skills section the runner cannot read is a reported drop, not a boot failure", async () => {
  const origin = await makeThrowawayOrigin();
  const item = {
    id: "wi-boot-0021",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "boot: echo the task", instructions: "Write the task into AGENT_NOTES.md." },
    repos: [
      repoEntry({ url: origin.url, ref: origin.ref, branchNamespace: "runner/ada/wi-boot-0021" }),
    ],
    workspace: null,
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  const orch = await stubOrchestrator({
    workItem: item,
    injectedContext: null,
    skills: {
      skills: [{
        name: "ryph-checks",
        description: "x".repeat(2_000),
        source: "catalogue",
        digest: `sha256:${"c".repeat(64)}`,
      }],
      workingRepos: true,
      budget: { skills: 31, listingBytes: 16_000 },
    },
  });
  try {
    const { code, stdout, stderr } = await runMain(
      contractEnv(orch.url, item.id),
      [],
    );
    assertEquals(code, 0, `stderr:\n${stderr}`);
    assertEquals(JSON.parse(stdout).status, "success");
    assert(stderr.includes("skills.spec_refused"), `stderr:\n${stderr}`);
    assert(!orch.requests.some((r) => r.method === "GET" && r.path.includes("/skills/")));
    const reports = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/skills/report`);
    assertEquals(reports.length, 1);
    const dropped = reports[0].body?.dropped as Array<Record<string, unknown>>;
    assertEquals(dropped.map((d) => [d.source, d.name, d.reason]), [
      ["catalogue", "ryph-checks", "invalid"],
    ]);
    assertStringIncludes(String(dropped[0].detail), "the run's skills could not be read");
  } finally {
    await orch.shutdown();
    await origin.cleanup();
  }
});

test("contract: a malformed mcp half is a reported boot failure and exit 2", async () => {
  const item = {
    id: "wi-boot-0011",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "inert", instructions: "never runs" },
    repos: [
      repoEntry({
        url: "file:///nowhere",
        ref: "main",
        branchNamespace: "runner/ada/wi-boot-0011",
      }),
    ],
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    canOpenPatches: true,
  };
  const orch = await stubOrchestrator(
    { workItem: item, injectedContext: null },
    // a token-less half: the run could never authenticate to the gateway, so it must not start
    {
      credentials: {
        env: {},
        mcp: { servers: [{ slug: "linear", name: "L", url: "http://g/x" }] },
      },
    },
  );
  try {
    const { code, stderr } = await runMain(
      contractEnv(orch.url, item.id),
      [],
    );
    assertEquals(code, 2);
    assert(stderr.includes("mcp.token"), `stderr:\n${stderr}`);
    const results = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/result`);
    assertEquals(results.length, 1);
    assertEquals(results[0].body?.during, "booting");
  } finally {
    await orch.shutdown();
  }
});

test("contract: a harness kind the image's layer does not carry is a reported boot failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-manifest-test-"));
  const manifest = `${dir}/harness.json`;
  await writeFile(
    manifest,
    JSON.stringify({ runner: "abc123", harnessKinds: ["pi"], builtAt: "2026-09-18T00:00:00Z" }),
  );
  const item = {
    id: "wi-boot-0009",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "boot: echo the task", instructions: "Write the task into AGENT_NOTES.md." },
    repos: [repoEntry({ url: "https://example.invalid/r.git", branchNamespace: "runner/ada/x" })],
    workspace: null,
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    canOpenPatches: true,
  };
  const orch = await stubOrchestrator({ workItem: item, injectedContext: {} });
  try {
    const { code, stderr } = await runMain(
      { ...contractEnv(orch.url, item.id), RUNNER_HARNESS_MANIFEST: manifest },
      [],
    );
    assertEquals(code, 2, `stderr:\n${stderr}`);
    assert(stderr.includes(`carries "pi", not "echo"`), `stderr:\n${stderr}`);
    // refused before the credentials fetch: nothing is minted for a run that cannot start
    assertEquals(orch.requests.filter((r) => r.path.endsWith("/credentials")).length, 0);
    const results = orch.requests.filter((r) => r.path === `/v1/runs/${item.id}/result`);
    assertEquals(results.length, 1);
    assertEquals(results[0].body?.status, "error");
    assertEquals(results[0].body?.during, "booting");
  } finally {
    await orch.shutdown();
    await rm(dir, { recursive: true });
  }
});

test("harnessRefusal: absent is a checkout's runner, carried runs, anything else refuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-manifest-test-"));
  const path = `${dir}/harness.json`;
  const diag = noopDiagnostics();
  try {
    assertEquals(await harnessRefusal("pi", diag, path), null);

    await writeFile(
      path,
      JSON.stringify({ runner: "abc", harnessKinds: ["pi", "echo"], builtAt: "now", pi: "0.85.1" }),
    );
    assertEquals(await harnessRefusal("pi", diag, path), null);
    assertEquals(await harnessRefusal("echo", diag, path), null);
    assertStringIncludes((await harnessRefusal("claude", diag, path))!, `not "claude"`);

    await writeFile(path, "{ not json");
    assertStringIncludes((await harnessRefusal("pi", diag, path))!, path);

    await writeFile(path, JSON.stringify({ runner: "abc", harnessKinds: [] }));
    assertStringIncludes((await harnessRefusal("pi", diag, path))!, "harnessKinds");
  } finally {
    await rm(dir, { recursive: true });
  }
});

/** The spec's environment for a run on a baked image. */
const BAKED = {
  id: "env-1",
  image: "registry.test/ryph-envs/repo-1@sha256:abc",
  baked: true,
  commits: {},
  builtAt: "2026-09-18T00:00:00Z",
  toolchains: {},
  ref: "main",
};

test("contract: a baked environment is worked in the image's root, adopted, and left in place", async () => {
  const origin = await makeThrowawayOrigin();
  const work = await mkdtemp(join(tmpdir(), "runner-work-root-"));
  const item = {
    id: "wi-boot-0010",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "boot: echo the task", instructions: "Write the task into AGENT_NOTES.md." },
    repos: [
      repoEntry({ url: origin.url, ref: origin.ref, branchNamespace: "runner/ada/wi-boot-0010" }),
    ],
    workspace: null,
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    canOpenPatches: true,
  };
  const orch = await stubOrchestrator({ workItem: item, injectedContext: {}, environment: BAKED });
  try {
    // What the build left: the repo cloned at its path, with a warm (ignored) output in it.
    await git(work, "clone", "-q", "--", origin.url, "repo");
    await writeFile(`${work}/repo/.git/info/exclude`, "warm/\n");
    await mkdir(`${work}/repo/warm`);
    await writeFile(`${work}/repo/warm/cache`, "built\n");

    const { code, stdout, stderr } = await runMain(
      { ...contractEnv(orch.url, item.id), RUNNER_WORK_ROOT: work },
      [],
    );
    assertEquals(code, 0, `stderr:\n${stderr}`);
    assertEquals(JSON.parse(stdout).status, "success");
    // The run worked in the image's checkout, and nothing disposed of the root afterwards.
    assertEquals(await readFile(`${work}/repo/warm/cache`, "utf8"), "built\n");
    assertEquals(
      await git(`${work}/repo`, "symbolic-ref", "--short", "HEAD"),
      `${item.repos[0].branchNamespace}/work`,
    );
  } finally {
    await orch.shutdown();
    await origin.cleanup();
    await rm(work, { recursive: true });
  }
});

test("contract: a baked spec on an image with no work root clones into a temp dir instead", async () => {
  const origin = await makeThrowawayOrigin();
  const item = {
    id: "wi-boot-0011",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "boot: echo the task", instructions: "Write the task into AGENT_NOTES.md." },
    repos: [
      repoEntry({ url: origin.url, ref: origin.ref, branchNamespace: "runner/ada/wi-boot-0011" }),
    ],
    workspace: null,
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    canOpenPatches: true,
  };
  const orch = await stubOrchestrator({ workItem: item, injectedContext: {}, environment: BAKED });
  try {
    const { code, stdout, stderr } = await runMain(
      { ...contractEnv(orch.url, item.id), RUNNER_WORK_ROOT: `${origin.dir}/no-such-root` },
      [],
    );
    assertEquals(code, 0, `stderr:\n${stderr}`);
    assertEquals(JSON.parse(stdout).status, "success");
    assertStringIncludes(stderr, "checkout.baked_root_missing");
  } finally {
    await orch.shutdown();
    await origin.cleanup();
  }
});
