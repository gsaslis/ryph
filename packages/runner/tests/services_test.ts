// The run's half of service containers: the wait, the refusal, and the block the repo cannot
// remove from the agent's prompt.

import { test } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { REPO_CONFIG_DIR } from "../src/core/brand.ts";
import { run } from "../src/core/run.ts";
import type { RunService } from "../src/core/types.ts";
import type { Harness } from "../src/ports/harness.ts";
import {
  composeEnvironment,
  describeServices,
  shadowedAddress,
  tcpProbe,
  waitForServices,
} from "../src/helpers/services.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeRunFixture } from "./util.ts";

const DB: RunService = { name: "db", port: 5433, image: "postgres:18@sha256:abc" };
const REDIS: RunService = { name: "redis", port: 6382, image: "redis:8@sha256:def" };
const silent = { debug() {} };

/** A probe that answers false `misses` times per service, then true. */
function flakyProbe(misses: number) {
  const seen = new Map<string, number>();
  return (service: RunService) => {
    const n = (seen.get(service.name) ?? 0) + 1;
    seen.set(service.name, n);
    return Promise.resolve(n > misses);
  };
}

/** A clock and a sleep that advance together, so the tests are instant and deterministic. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

test("the wait ends when every service answers, in declaration order", async () => {
  const time = fakeTime();
  const narrated: string[] = [];
  await waitForServices([DB, REDIS], {
    signal: new AbortController().signal,
    diag: silent,
    probe: flakyProbe(3),
    onWait: (s, ms) => narrated.push(`${s.name}:${s.port} (${Math.round(ms / 1000)}s)`),
    ...time,
  });
  // Narration is once a second at most, and names the ADDRESS — which is what the user needs
  // when a run sits in setting-up for a minute.
  assert(narrated.some((n) => n.startsWith("db:5433")));
  assert(narrated.some((n) => n.startsWith("redis:6382")));
});

test("a service that never answers fails the run, naming it and its address", async () => {
  const time = fakeTime();
  const err = await assertRejects(
    () =>
      waitForServices([DB], {
        signal: new AbortController().signal,
        diag: silent,
        probe: () => Promise.resolve(false),
        timeoutMs: 10_000,
        ...time,
      }),
    Error,
  );
  // Not a quiet give-up: the failure this whole feature removes is a suite that hangs, and a
  // health gate that shrugged would put it straight back.
  assertStringIncludes(err.message, '"db"');
  assertStringIncludes(err.message, "db:5433");
  assertStringIncludes(err.message, "postgres:18@sha256:abc");
});

test("an abort mid-wait returns promptly, and is not a failure", async () => {
  const controller = new AbortController();
  const time = fakeTime();
  await waitForServices([DB], {
    signal: controller.signal,
    diag: silent,
    probe: () => {
      controller.abort();
      return Promise.resolve(false);
    },
    ...time,
  });
});

test("the budget is per service, so a slow first one cannot spend the second's", () => {
  // A single shared deadline made the error message a lie — "redis never answered within 120s"
  // when postgres had already spent 110 of them — and gave the second service no chance.
  const time = fakeTime();
  const slowThenFast = (service: RunService) =>
    Promise.resolve(service.name === "db" ? time.now() >= 9_000 : true);
  return waitForServices([DB, REDIS], {
    signal: new AbortController().signal,
    diag: silent,
    probe: slowThenFast,
    timeoutMs: 10_000,
    ...time,
  });
});

test("tcpProbe bounds its own dial, rather than waiting out the OS connect timeout", async () => {
  // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): routed nowhere, so the SYNs are dropped rather than
  // refused — the same shape as a sidecar whose pod IP is up and whose process is wedged.
  // Without its own budget the dial would block 75-130s.
  const started = performance.now();
  const answer = await tcpProbe(
    { name: "192.0.2.1", port: 5433 },
    new AbortController().signal,
  );
  const elapsed = performance.now() - started;
  assertEquals(answer, false);
  assert(elapsed < 10_000, `the dial took ${Math.round(elapsed)}ms; its own budget is 2s`);
});

test("an abort mid-dial is answered at once, not after the connect timeout", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const probing = tcpProbe(
    { name: "192.0.2.1", port: 5433 },
    controller.signal,
  );
  controller.abort();
  assertEquals(await probing, false);
  assert(performance.now() - started < 1_000, "an abort must not wait out the dial");
});

test("a dial that hangs gives up on its own budget, and an abort is not ignored", async () => {
  // Without the bound, a black-holed address (name resolves, SYNs dropped —
  // a sidecar whose pod is up and whose process is wedged) would otherwise block for the OS
  // connect timeout, 75-130s, with neither the deadline nor the abort consulted until after.
  const controller = new AbortController();
  const started = performance.now();
  const hung = Promise.withResolvers<boolean>(); // never resolves on its own
  const probe = () => hung.promise;
  const waiting = waitForServices([DB], {
    signal: controller.signal,
    diag: silent,
    probe: (_service, signal) => {
      signal.addEventListener("abort", () => hung.resolve(false), { once: true });
      return probe();
    },
    timeoutMs: 60_000,
  });
  controller.abort();
  await waiting;
  assert(
    performance.now() - started < 5_000,
    "an abort mid-dial must not wait out the connect timeout",
  );
});

test("the generated block leads with the addresses, and says not to use localhost", () => {
  const block = describeServices([DB, REDIS], false);
  assertStringIncludes(block, "`db:5433`");
  assertStringIncludes(block, "`redis:6382`");
  assertStringIncludes(block, "localhost");
  assertEquals(block.includes("could not be refreshed"), false);
});

test("a stale declaration says so, where the agent will actually read it", () => {
  assertStringIncludes(describeServices([DB], true), "could not be refreshed");
});

test("the repo's prose follows the true list and cannot replace it", () => {
  const composed = composeEnvironment([DB], false, "We use Postgres on localhost:5432.")!;
  assert(composed.indexOf("db:5433") < composed.indexOf("We use Postgres"));
  // Nothing to prepend, nothing prepended: a run with no services reads exactly as before.
  assertEquals(composeEnvironment([], false, "Just prose."), "Just prose.");
  assertEquals(composeEnvironment([], false, null), undefined);
});

test("e2e: a checkout that declares services it did not get fails during setting-up", async () => {
  // Every way this happens — the operator's switch off, a local-repo run, a declaration on
  // another ref — ends in a suite waiting forever on a database nobody started. Refused here,
  // where the message can name the cause.
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    repoFiles: {
      [`${REPO_CONFIG_DIR}/services.yml`]: "services:\n  db:\n    uses: postgres@18\n" +
        "    port: 5433\n",
    },
  });
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "error");
    assert(result.status === "error");
    assertEquals(result.during, "setting-up");
    assertStringIncludes(result.reason, "no service containers were provisioned");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a placeholder services.yml is not an ask, and does not fail the run", async () => {
  // The file exists and declares nothing — which the control plane reads as "no services", so
  // the run correctly arrives with none. Keying the refusal off the file's EXISTENCE made this
  // legitimate placeholder fail every run, blaming an operator switch that was not the cause.
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    repoFiles: {
      [`${REPO_CONFIG_DIR}/services.yml`]: "# services go here once the suite needs them\n",
    },
  });
  try {
    assertEquals((await run(fx.item, fx.ctx)).status, "success");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: the refusal names the services the checkout asked for", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    repoFiles: {
      [`${REPO_CONFIG_DIR}/services.yml`]:
        "services:\n  db:\n    uses: postgres@18\n    port: 5433\n" +
        "  cache:\n    uses: redis@8\n    port: 6382\n",
    },
  });
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "error");
    assertStringIncludes(result.reason, "db, cache");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: one declared service missing is refused, not only all of them", async () => {
  // The control plane resolved `db` before the clone; the checkout, a push later, also wants
  // `cache`. A run short one hostname hangs exactly as well as a run short all of them.
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    repoFiles: {
      [`${REPO_CONFIG_DIR}/services.yml`]:
        "services:\n  db:\n    uses: postgres@18\n    port: 5433\n" +
        "  cache:\n    uses: redis@8\n    port: 6382\n",
    },
  });
  try {
    const result = await run(fx.item, { ...fx.ctx, services: { list: [DB], stale: false } });
    assert(result.status === "error");
    assertEquals(result.during, "setting-up");
    assertStringIncludes(result.reason, "declares cache, but this run was provisioned only db");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a declared service on another port than it was provisioned on is refused", async () => {
  // The same push-in-between under an unchanged name: the checkout moved `db` to 5434, the run
  // got it on 5433, and the suite would dial a port nothing listens on.
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    repoFiles: {
      [`${REPO_CONFIG_DIR}/services.yml`]:
        "services:\n  db:\n    uses: postgres@18\n    port: 5434\n",
    },
  });
  try {
    const result = await run(fx.item, { ...fx.ctx, services: { list: [DB], stale: false } });
    assert(result.status === "error");
    assertEquals(result.during, "setting-up");
    assertStringIncludes(result.reason, "declares db:5434, but this run was provisioned db:5433");
  } finally {
    await fx.cleanup();
  }
});

test("a service named after the host of an address the run dials is refused", () => {
  const reason = shadowedAddress([DB, { ...REDIS, name: "llm" }], {
    ANTHROPIC_API_KEY: "sk-not-an-address",
    ANTHROPIC_BASE_URL: "http://llm:7420/anthropic",
    RYPH_HISTORY_URL: undefined,
  });
  assert(reason !== null);
  assertStringIncludes(reason, 'service "llm"');
  assertStringIncludes(reason, "reaches ANTHROPIC_BASE_URL at (http://llm:7420/anthropic)");
  // Any address the run dials counts, whatever labels it — an MCP server included.
  assertStringIncludes(
    shadowedAddress([{ ...REDIS, name: "tools" }], {
      'MCP server "github"': "http://tools:7430/servers/github/mcp",
    }) ?? "",
    'reaches MCP server "github" at (http://tools:7430/servers/github/mcp)',
  );
  // No service, or no address whose host is one: nothing to refuse.
  assertEquals(shadowedAddress([], { ANTHROPIC_BASE_URL: "http://llm:7420" }), null);
  assertEquals(shadowedAddress([DB], { ANTHROPIC_BASE_URL: "http://llm:7420" }), null);
});

test("e2e: a reachable service gates the harness, and the agent is told the truth", async () => {
  // A real listener, because this path deliberately has no injectable probe: `run` dials what
  // it was handed. The name is an address rather than a label only because this test has no
  // DNS — the ban on `localhost` is the control plane's parse-time rule, not this layer's. The
  // checkout declares it under that same name, because the runner checks names one by one.
  const listener = createServer((conn) => conn.destroy());
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as AddressInfo).port;
  const accepting = new Promise((resolve) => listener.once("close", resolve));

  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    repoFiles: {
      [`${REPO_CONFIG_DIR}/services.yml`]: 'services:\n  "127.0.0.1":\n    uses: postgres@18\n' +
        `    port: ${port}\n`,
      [`${REPO_CONFIG_DIR}/environment.md`]: "Run the suite with ./scripts/run-tests.sh.\n",
    },
  });
  let seen: string | undefined;
  const capturing: Harness = {
    run(input, io) {
      seen = input.environment;
      io.onTranscript({ kind: "assistant", text: "ok" });
      return Promise.resolve({ summary: "looked at the environment", interrupted: false });
    },
  };
  try {
    const result = await run(fx.item, {
      ...fx.ctx,
      harness: capturing,
      services: {
        list: [{ name: "127.0.0.1", port, image: "postgres:18@sha256:abc" }],
        stale: false,
      },
    });
    // No changes: the capturing harness writes nothing, which is a "failure" outcome — what
    // matters here is that it RAN, i.e. the gate opened.
    assertEquals(result.status, "failure");
    assert(seen !== undefined, "the harness must receive an environment description");
    assertStringIncludes(seen, `127.0.0.1:${port}`);
    assertStringIncludes(seen, "./scripts/run-tests.sh");
    // The generated list comes first, and the repo's prose after it.
    assert(seen.indexOf("Services running") < seen.indexOf("./scripts/run-tests.sh"));

    const waiting = orchestrator.progressReports.filter((p) => p.phase === "setting-up");
    assert(waiting.length >= 1);
  } finally {
    listener.close();
    await accepting.catch(() => {});
    await fx.cleanup();
  }
});
