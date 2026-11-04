import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { exchangeBootstrap } from "../src/adapters/orchestrator/http.ts";
import { RunBootstrapSchema } from "../src/schema.ts";
import { runtimeCredentials } from "../src/helpers/runtime_credentials.ts";
import { runChildEnv } from "../src/helpers/environment.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";

const SECRETS = {
  RYPH_RUN_TOKEN: "bootstrap-test-run-secret",
  RYPH_CONTROL_TOKEN: "bootstrap-test-control-secret",
  RYPH_GIT_TOKEN: "bootstrap-test-git-secret",
  RYPH_EGRESS_TOKEN: "bootstrap-test-egress-secret",
  RYPH_EGRESS_PROXY: "http://proxy.test:7460",
  RYPH_RUN_ID: "r-bootstrap-test",
};

/** Answers each exchange attempt with the next response; a thrown Error is a network failure. */
function stubFetch(answers: Array<Response | Error>) {
  const original = globalThis.fetch;
  const seen: RequestInit[] = [];
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {});
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected extra request");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = original) };
}

const exchange = () =>
  exchangeBootstrap({
    baseUrl: "http://orchestrator.test",
    bootstrapToken: "one-shot",
    runId: "r-bootstrap-test",
    retryPauseMs: 0,
    diag: noopDiagnostics(),
  });

test("bootstrap credentials stay in memory; child env carries only deliberate grants", async () => {
  const stub = stubFetch([Response.json({ env: SECRETS })]);
  const extra = {
    RYPH_MCP_TOKEN: "bootstrap-test-mcp-secret",
    RYPH_LOOPBACK_TOKEN: "bootstrap-test-loopback-secret",
    ANTHROPIC_API_KEY: "bootstrap-test-model-secret",
  };
  try {
    const { env } = RunBootstrapSchema.parse(JSON.parse(await exchange()));
    assertEquals(stub.seen[0].method, "POST");
    assertEquals(new Headers(stub.seen[0].headers).get("authorization"), "Bearer one-shot");
    assertEquals(stub.seen[0].redirect, "error");
    const granted: Record<string, string> = { ...env, ...extra };
    for (const [name, value] of Object.entries(granted)) {
      runtimeCredentials.set(name, value);
    }
    for (const [name, value] of Object.entries({ ...SECRETS, ...extra })) {
      assertEquals(runtimeCredentials.get(name), value);
      assert(process.env[name] !== value);
    }
    const child = runChildEnv();
    assertEquals(child.ANTHROPIC_API_KEY, "bootstrap-test-model-secret");
    assert(child.HTTPS_PROXY.includes("bootstrap-test-egress-secret"));
    for (const name of Object.keys(child)) assert(!name.startsWith("RYPH_"));
    const childText = JSON.stringify(child);
    for (const secret of ["run", "control", "git", "direct", "mcp", "loopback"]) {
      assert(!childText.includes(`bootstrap-test-${secret}-secret`));
    }
    if (process.platform === "linux") {
      // Only the assertion's result, never the environment itself.
      const environment = await readFile(`/proc/${process.pid}/environ`, "utf8");
      assert(!environment.includes("bootstrap-test-"), "credential in runner environ");
    }
  } finally {
    stub.restore();
    for (const name of Object.keys({ ...SECRETS, ...extra })) runtimeCredentials.delete(name);
  }
});

test("bootstrap exchange retries what left the token unspent, never a refusal", async () => {
  const flaky = stubFetch([
    new TypeError("connection refused"),
    new Response("down", { status: 503 }),
    Response.json({ env: SECRETS }),
  ]);
  try {
    assertEquals(JSON.parse(await exchange()).env.RYPH_RUN_TOKEN, SECRETS.RYPH_RUN_TOKEN);
    assertEquals(flaky.seen.length, 3);
  } finally {
    flaky.restore();
  }

  // A 401 is a spent, expired or foreign token: retrying it can only be refused again.
  const spent = stubFetch([new Response(null, { status: 401 })]);
  try {
    await assertRejects(exchange, Error, "401");
    assertEquals(spent.seen.length, 1);
  } finally {
    spent.restore();
  }
});

test("a brand-scoped credential in the process environment is not honoured", () => {
  process.env.RYPH_RUN_TOKEN = "launched-on-another-contract";
  process.env.BOOTSTRAP_TEST_PROVIDER_KEY = "hand-run-provider-key";
  try {
    assertEquals(runtimeCredentials.get("RYPH_RUN_TOKEN"), undefined);
    assertEquals(runtimeCredentials.toObject().RYPH_RUN_TOKEN, undefined);
    // Names outside the contract still fall back: a hand-run work item brings its own keys.
    assertEquals(runtimeCredentials.get("BOOTSTRAP_TEST_PROVIDER_KEY"), "hand-run-provider-key");
  } finally {
    delete process.env.RYPH_RUN_TOKEN;
    delete process.env.BOOTSTRAP_TEST_PROVIDER_KEY;
  }
});

test("the bootstrap answer is the runner's own contract and carries the run bearer", () => {
  assertThrows(() => RunBootstrapSchema.parse({ env: { RYPH_RUN_ID: "r-1" } }));
  assertThrows(() => RunBootstrapSchema.parse({ env: { RYPH_RUN_TOKEN: "t", PATH: "/tmp/evil" } }));
  assertThrows(() => RunBootstrapSchema.parse({ env: { RYPH_RUN_TOKEN: "t", NODE_OPTIONS: "x" } }));
  assertEquals(
    RunBootstrapSchema.parse({ env: { RYPH_RUN_TOKEN: "t", RYPH_RUN_ID: "r-1" } }).env.RYPH_RUN_ID,
    "r-1",
  );
});
