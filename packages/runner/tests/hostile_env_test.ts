// The runner and the baker refuse to start under an environment that changes what Bun does
// around them (the rule is @ryph/shared/env).

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "@ryph/process";
import { serve } from "@ryph/service";

for (const entry of ["main.ts", "bake.ts"]) {
  test(`${entry} exits 2 before doing anything when one is set`, async () => {
    const envs: Record<string, string>[] = [
      { BUN_OPTIONS: "--smol" },
      { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      { BUN_INSPECT: "127.0.0.1:0" },
      { BUN_CONFIG_VERBOSE_FETCH: "1" },
    ];
    for (const env of envs) {
      const out = await command(process.execPath, {
        args: ["--no-env-file", new URL(`../src/${entry}`, import.meta.url).pathname],
        env: { PATH: process.env.PATH ?? "", ...env },
        clearEnv: true,
        stdin: "null",
      }).output();
      const said = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 2, said);
      assertStringIncludes(said, "refusing to start");
      assertStringIncludes(said, Object.keys(env)[0]);
    }
  });
}

/** A stub orchestrator that redeems any bootstrap and records every request. */
async function stubOrchestrator() {
  const requests: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const path = new URL(req.url).pathname;
      const text = await req.text();
      requests.push({
        method: req.method,
        path,
        auth: req.headers.get("authorization"),
        body: text === "" ? null : JSON.parse(text),
      });
      if (path.endsWith("/bootstrap")) {
        return Response.json({ env: { RYPH_RUN_TOKEN: "run-token" } });
      }
      return new Response(null, { status: 204 });
    },
  );
  return { url: `http://127.0.0.1:${server.addr.port}`, requests, server };
}

async function launch(url: string, env: Record<string, string>) {
  const out = await command(process.execPath, {
    args: ["--no-env-file", new URL("../src/main.ts", import.meta.url).pathname],
    env: {
      PATH: process.env.PATH ?? "",
      RYPH_ORCHESTRATOR_URL: url,
      RYPH_RUN_ID: "run-1",
      RYPH_BOOTSTRAP_TOKEN: "boot-token",
      ...env,
    },
    clearEnv: true,
    stdin: "null",
  }).output();
  return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
}

// An environment image's ENV reaches the runner: an image built for a TLS-intercepting proxy
// often sets NODE_TLS_REJECT_UNAUTHORIZED=0. The runner still refuses, but says why on the run,
// over a verifying fetch: the variable is dropped before the bootstrap is redeemed.
test("a run launched under NODE_TLS_REJECT_UNAUTHORIZED=0 reports why it refused", async () => {
  const stub = await stubOrchestrator();
  try {
    const { code, stderr } = await launch(stub.url, { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assertEquals(code, 2, stderr);
    assertStringIncludes(stderr, "refusing to start");
    const result = stub.requests.find((r) => r.path === "/v1/runs/run-1/result");
    assert(result, JSON.stringify(stub.requests));
    assertEquals(result.auth, "Bearer run-token");
    const body = result.body as { status: string; during: string; reason: string };
    assertEquals([body.status, body.during], ["error", "booting"]);
    assertStringIncludes(body.reason, "NODE_TLS_REJECT_UNAUTHORIZED=0");
    assertStringIncludes(body.reason, "environment image");
    assertStringIncludes(body.reason, "NODE_EXTRA_CA_CERTS");
  } finally {
    await stub.server.shutdown();
  }
});

// Under the others the process is already changed (a preload ran, a debugger listens, headers
// are being logged): it redeems nothing, and the reaper concludes the run.
test("a run launched under a Bun variable reports nothing and redeems nothing", async () => {
  const stub = await stubOrchestrator();
  try {
    const envs: Record<string, string>[] = [
      { BUN_OPTIONS: "--smol" },
      { BUN_CONFIG_VERBOSE_FETCH: "1" },
      { BUN_OPTIONS: "--smol", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    ];
    for (const env of envs) {
      const { code, stderr } = await launch(stub.url, env);
      assertEquals(code, 2, stderr);
      assertStringIncludes(stderr, "environment image");
    }
    assertEquals(stub.requests, []);
  } finally {
    await stub.server.shutdown();
  }
});
