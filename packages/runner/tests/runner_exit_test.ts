// The runner exits once it has reported and disposed, whatever is still alive beside it. Once a
// background job outlived its run, its child handle held the event loop, and the runner printed
// its result and never exited — its pod lingered until killed by hand. Here the binary's entry
// runs a whole contract run (the spec fetched from a stub orchestrator, the echo harness) in a
// process of its own, next to a stray that ignores every signal.

import { test } from "bun:test";
import { command } from "@ryph/process";
import { serve } from "@ryph/service";
import { assert, assertEquals } from "@std/assert";
import { ENV_PREFIX } from "../src/core/brand.ts";
import { makeThrowawayOrigin } from "./fixtures/origin.ts";
import { repoEntry } from "./util.ts";

const PACKAGE = new URL("..", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/main_stray.ts", import.meta.url).pathname;
/** Far past what an echo run takes; the stray itself lives ten minutes. */
const DEADLINE_MS = 60_000;

/** A stub orchestrator: redeems the bootstrap, serves the spec, acks the result, answers everything else empty. */
async function stubOrchestrator(specBody: unknown) {
  const results: unknown[] = [];
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path.endsWith("/bootstrap")) {
        return Response.json({
          env: {
            [`${ENV_PREFIX}_RUN_TOKEN`]: "run-token",
            [`${ENV_PREFIX}_GIT_ORIGIN`]: new URL(req.url).origin,
            [`${ENV_PREFIX}_GIT_TOKEN`]: "git-token",
          },
        });
      }
      if (req.method === "GET" && path.endsWith("/spec")) return Response.json(specBody);
      if (req.method === "GET" && path.endsWith("/credentials")) return Response.json({ env: {} });
      // It plays the git gateway too: the work leaves as a bundle, and freshness goes unanswered.
      if (req.method === "POST" && path.startsWith("/v1/patches/")) {
        await req.body?.cancel();
        return Response.json({ headSha: "…", bundleKey: "b" }, { status: 201 });
      }
      if (path.endsWith("/result")) {
        results.push(await req.json().catch(() => null));
        return Response.json({ ack: "Accepted" });
      }
      await req.body?.cancel();
      return new Response(null, { status: 204 });
    },
  );
  const addr = server.addr;
  return {
    url: `http://${addr.hostname}:${addr.port}`,
    results,
    shutdown: () => server.shutdown(),
  };
}

test("runner: it exits once the run is reported and disposed, a stray that ignores every signal beside it", async () => {
  const origin = await makeThrowawayOrigin();
  const item = {
    id: "wi-exit-0001",
    agent: { name: "ada", email: "ada@runner.local" },
    spec: { title: "exit: echo the task", instructions: "Write the task into AGENT_NOTES.md." },
    repos: [
      repoEntry({ url: origin.url, ref: origin.ref, branchNamespace: "runner/ada/wi-exit-0001" }),
    ],
    workspace: null,
    harness: { kind: "echo" },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    canOpenPatches: true,
  };
  const orch = await stubOrchestrator({ workItem: item, injectedContext: null });
  const proc = await command(process.execPath, {
    args: ["--no-env-file", FIXTURE],
    cwd: PACKAGE,
    env: {
      [`${ENV_PREFIX}_RUN_ID`]: item.id,
      [`${ENV_PREFIX}_ORCHESTRATOR_URL`]: orch.url,
      [`${ENV_PREFIX}_BOOTSTRAP_TOKEN`]: "bootstrap-token",
      RUNNER_HEARTBEAT_INTERVAL_MS: "50",
      RYPH_LOG_LEVEL: "warn",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = await Promise.race([
    proc.status,
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), DEADLINE_MS))),
  ]);
  clearTimeout(timer);
  if (status === null) proc.kill("SIGKILL");
  const stderr = await err;
  const stdout = await out;
  const stray = /^stray (\d+)$/m.exec(stderr)?.[1];
  try {
    assert(stray !== undefined, `the fixture never started its stray:\n${stderr}`);
    assert(status !== null, `the runner did not exit within ${DEADLINE_MS} ms:\n${stderr}`);
    assertEquals(status.code, 0, `stderr:\n${stderr}`);
    assertEquals(JSON.parse(stdout).status, "success");
    assertEquals(orch.results.length, 1, "exactly one result was reported before the exit");
    // The stray is still there: the runner left it and exited anyway.
    const { code } = await command("bash", {
      args: ["-c", 'kill -0 "$1" 2>/dev/null', "probe", stray],
    }).output();
    assertEquals(code, 0, "the stray outlived the runner");
  } finally {
    if (stray !== undefined) {
      await command("bash", { args: ["-c", 'kill -KILL "$1"', "kill", stray] }).output();
    }
    await orch.shutdown();
    await origin.cleanup();
  }
});
