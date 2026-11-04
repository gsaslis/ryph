// A launcher briefly away — recreated by `compose up`, still booting — is waited for, and only
// when the request provably never reached it: a refused connection sent nothing, so asking again
// repeats nothing. A request that may have arrived is never sent twice.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { launcherClients, LauncherError } from "@ryph/orchestrator/docker";
import { serve } from "@ryph/service";
import { fakeDocker, silent, SPEC, started, TOKEN } from "./harness.ts";

const BUILD = {
  environmentId: "env-1",
  subjectKey: "repo-cr1",
  dockerfileFrom: null,
  checkouts: [{ path: "repo", connectedRepoId: "cr-1", ref: "main", commit: "a".repeat(40) }],
  baseImage: "quay.io/ryph/ryph-universal:test",
  harnessImage: "quay.io/ryph/ryph-harness:test",
  defaultBranch: true,
  cacheScope: { read: ["repo-cr1"], write: "repo-cr1" },
  relayerFrom: null,
  warmFrom: null,
  proxyEnv: {},
  clone: { urls: { repo: "http://forge:7412/v1/git/env-1/cr-1/repo.git" }, env: {} },
  timeoutMs: 60_000,
};

/** A loopback port nothing listens on, until something is started on it. */
async function freePort(): Promise<number> {
  const probe = await serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(),
  );
  const port = probe.addr.port;
  await probe.shutdown();
  return port;
}

test("a launch waits out a launcher that is not up yet, and lands once it is", async () => {
  const port = await freePort();
  const clients = launcherClients(
    { url: `http://127.0.0.1:${port}`, token: TOKEN, reachMs: 20_000 },
    silent,
  );
  const docker = fakeDocker((args) => args[0] === "run" ? "c0ffee" : "");
  const launch = clients.provisioner.launch(SPEC);
  await new Promise((r) => setTimeout(r, 700));
  const s = await started({
    exec: docker.exec,
    serve: (handler) => serve({ port, hostname: "127.0.0.1", onListen: () => {} }, handler),
  });
  try {
    assertEquals(await launch, { handle: "c0ffee" });
    // Launched once: the refused attempts never reached it.
    assertEquals(docker.calls.filter((c) => c.startsWith("run -d")).length, 1);
  } finally {
    await s.close();
  }
});

test("a launcher that stays away is given up on after the budget, retryable", async () => {
  const port = await freePort();
  const clients = launcherClients(
    { url: `http://127.0.0.1:${port}`, token: TOKEN, reachMs: 600 },
    silent,
  );
  const at = Date.now();
  const err = await assertRejects(() => clients.provisioner.kill("h", { graceful: false }));
  assert(err instanceof LauncherError && err.retryable && err.unreached, String(err));
  assert(Date.now() - at >= 500, `gave up after ${Date.now() - at} ms`);
  assert(Date.now() - at < 5_000, `took ${Date.now() - at} ms`);
});

test("a request that may have arrived is never sent again", async () => {
  let sent = 0;
  // A connection that took the request and broke before answering: the launcher may have acted.
  const broken: typeof fetch = Object.assign(() => {
    sent++;
    return Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
  }, { preconnect: () => {} });
  const clients = launcherClients(
    { url: "http://launcher.invalid", token: TOKEN, fetch: broken, reachMs: 20_000 },
    silent,
  );
  const err = await assertRejects(() => clients.provisioner.launch(SPEC));
  assert(err instanceof LauncherError && err.retryable && !err.unreached, String(err));
  assertEquals(sent, 1);
});

test("a name that does not resolve is waited for too, and a cancelled build stops waiting", async () => {
  let sent = 0;
  const unresolved: typeof fetch = Object.assign(() => {
    sent++;
    return Promise.reject(
      Object.assign(new Error("getaddrinfo ENOTFOUND launcher"), { code: "ENOTFOUND" }),
    );
  }, { preconnect: () => {} });
  const clients = launcherClients(
    { url: "http://launcher", token: TOKEN, fetch: unresolved, reachMs: 20_000 },
    silent,
  );
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(new Error("cancelled")), 600);
  const result = await clients.environmentBuilder.build(BUILD, { signal: cancel.signal });
  assert(sent >= 2, `asked ${sent} time(s)`);
  assertEquals(!result.ok && result.message, "the build was cancelled");
});
