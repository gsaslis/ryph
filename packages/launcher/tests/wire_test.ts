// The run side of the seam end to end: the real clients (@ryph/orchestrator's adapters/launcher)
// against a real launcher over HTTP, with the real docker adapters behind it and only the docker
// CLI faked. What the binary does on every boot, and what a compose control plane will do.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CheckSpec,
  DEFAULT_ENVIRONMENTS_CONFIG,
  ImageGone,
  LAUNCHER_ROUTES,
  LauncherError,
} from "@ryph/orchestrator/docker";
import {
  bodyReads,
  fakeDocker,
  raw,
  silent,
  SPEC,
  started,
  storeRun,
  TOKEN,
  TOOLS_TOKEN,
  trickle,
  UNSIZED,
} from "./harness.ts";
import { localImagePrefix } from "@ryph/orchestrator/docker";
import { LAUNCHER_WIRE_REVISION } from "@ryph/mcp-gateway/tool-host";
import { MAX_BODY_READS } from "../src/routes.ts";

/** The repository path of the deployment the tests run as (no network set). */
const LOCAL = localImagePrefix("default");

test("a launch crosses the wire and answers the container's handle", async () => {
  const docker = fakeDocker((args) => args[0] === "run" ? "c0ffee" : "");
  const s = await started({ exec: docker.exec });
  try {
    // A key the port does not have rides the core's object; the client leaves it behind rather
    // than have the strict server refuse the launch over it.
    const spec = { ...SPEC, notAPortField: true } as typeof SPEC;
    assertEquals(await s.clients.provisioner.launch(spec), { handle: "c0ffee" });
    const run = docker.calls.find((c) => c.startsWith("run -d"))!;
    assertStringIncludes(run, "quay.io/ryph/ryph-agent:test");
    assertStringIncludes(run, "RYPH_BOOTSTRAP_TOKEN=single-use-secret");
    assertEquals(s.clients.provisioner.supportsBrowser, true);
  } finally {
    await s.close();
  }
});

test("ImageGone crosses the wire as itself, from a run launch and a check launch", async () => {
  const gone = `sha256:${"c".repeat(64)}`;
  const local = `${LOCAL}repo-abc:baked-env-1`;
  // The run's image judged this deployment's, then gone when docker is asked to run it.
  const docker = fakeDocker((args) => {
    if (args.includes(gone)) {
      return new Error(`docker run failed: Error response from daemon: No such image: ${gone}`);
    }
    if (args[0] === "container") return new Error("No such object");
    if (args[0] === "image") return new Error("No such image");
    // The check's volumes, as made: this record's and this deployment's.
    if (args[0] === "volume" && args[1] === "inspect") return `${CHECK.name}|default`;
    return "";
  }, [{ id: gone, names: [`${LOCAL}repo-abc:env-1`] }]);
  const s = await started({ exec: docker.exec });
  try {
    const run = await assertRejects(() => s.clients.provisioner.launch({ ...SPEC, image: gone }));
    assert(run instanceof ImageGone, `ImageGone, not ${String(run)}`);
    const check = await assertRejects(() =>
      s.clients.checkLauncher.launch({ ...CHECK, image: local })
    );
    assert(check instanceof ImageGone, `ImageGone, not ${String(check)}`);
    assertStringIncludes(check.message, "is not an image of this deployment");
  } finally {
    await s.close();
  }
});

test("any other launch failure carries docker's words, and is not ImageGone", async () => {
  const docker = fakeDocker((args) =>
    args[0] === "run" ? new Error("docker run failed: no space left on device") : ""
  );
  const s = await started({ exec: docker.exec });
  try {
    const err = await assertRejects(() => s.clients.provisioner.launch(SPEC));
    assert(!(err instanceof ImageGone));
    assert(err instanceof LauncherError && err.retryable);
    assertStringIncludes(err.message, "no space left on device");
  } finally {
    await s.close();
  }
});

test("each token opens its own routes and nothing else", async () => {
  const docker = fakeDocker();
  const s = await started({ exec: docker.exec });
  try {
    const launch = { spec: SPEC };
    for (const token of [TOOLS_TOKEN, null, "wrong", `${TOKEN}x`]) {
      const res = await raw(s.launcher, "POST", LAUNCHER_ROUTES.launch, token, launch);
      assertEquals(res.status, 401, `launch with ${token}`);
      await res.body?.cancel();
    }
    assertEquals(docker.calls.filter((c) => c.startsWith("run")), []);
    // The run token on the tool host's routes, and on a hosting-less launcher's too: a 401
    // either way, never a hint at which token it was.
    for (const token of [TOKEN, null]) {
      const res = await raw(s.launcher, "GET", "/v1/tools/list", token);
      assertEquals(res.status, 401);
      await res.body?.cancel();
    }
    // The clients themselves, with the wrong token: a terminal refusal, not a retry.
    const { launcherClients } = await import("@ryph/orchestrator/docker");
    const wrong = launcherClients({ url: s.launcher.url, token: TOOLS_TOKEN }, silent);
    const err = await assertRejects(() => wrong.provisioner.launch(SPEC));
    assert(err instanceof LauncherError && !err.retryable && err.status === 401, String(err));
  } finally {
    await s.close();
  }
});

test("the strict schemas refuse what the core would never send, before docker hears of it", async () => {
  const docker = fakeDocker();
  const s = await started({ exec: docker.exec });
  try {
    const refused = [
      { spec: SPEC, extra: 1 },
      { spec: { ...SPEC, image: "--privileged" } },
      {
        spec: {
          ...SPEC,
          services: [{
            name: "db",
            image: "postgres",
            env: {},
            port: 5432,
            security: { capabilities: ["SYS_ADMIN"], allowPrivilegeEscalation: false },
            resources: { cpus: "1", memory: "1g" },
          }],
        },
      },
      // A NUL no argv or env can hold: the spawn's refusal would quote the value back.
      { spec: { ...SPEC, env: { ...SPEC.env, RYPH_X: "single-use-secret\0" } } },
    ];
    for (const body of refused) {
      const res = await raw(s.launcher, "POST", LAUNCHER_ROUTES.launch, TOKEN, body);
      assertEquals(res.status, 400, JSON.stringify(body));
      const answer = await res.json();
      // The refusal names the field and never echoes the spec back.
      assert(!JSON.stringify(answer).includes("single-use-secret"));
    }
    // A build whose clone credential is anything but the one extraheader would configure the git
    // that clones in the launcher's own process.
    const res = await raw(s.launcher, "POST", LAUNCHER_ROUTES.checksLaunch, TOKEN, {
      spec: {
        ...CHECK,
        clone: {
          ...CHECK.clone,
          env: {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.sshCommand",
            GIT_CONFIG_VALUE_0: "sh",
          },
        },
      },
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
    for (const spec of [{ ...CHECK, setup: [{ run: "make\0" }] }, { ...CHECK, keep: ["a\0"] }]) {
      const nul = await raw(s.launcher, "POST", LAUNCHER_ROUTES.checksLaunch, TOKEN, { spec });
      assertEquals(nul.status, 400);
      assertStringIncludes((await nul.json()).message, "NUL");
    }
    // Only readiness's own probe, never a word of any of the specs.
    assertEquals(docker.calls.filter((c) => !c.startsWith("version")), []);
  } finally {
    await s.close();
  }
});

test("kill stops this deployment's runs and refuses any other container", async () => {
  const docker = fakeDocker((args) => {
    if (args[0] === "inspect" && args.includes("theirs")) return "|";
    if (args[0] === "inspect" && args.includes("ours")) return "r-1|default";
    return "";
  });
  const s = await started({ exec: docker.exec });
  try {
    const err = await assertRejects(() => s.clients.provisioner.kill("theirs", { graceful: true }));
    assert(err instanceof LauncherError && !err.retryable && err.status === 403, String(err));
    assertEquals(docker.calls.some((c) => c.startsWith("stop")), false);
    await s.clients.provisioner.kill("ours", { graceful: true });
    assert(docker.calls.includes("stop -t 30 ours"), docker.calls.join("\n"));
  } finally {
    await s.close();
  }
});

test("the reconcile lists first, reads the store second, and reclaims only what it listed", async () => {
  const order: string[] = [];
  let created = false;
  const docker = fakeDocker((args) => {
    if (args[0] === "ps") {
      order.push("list containers");
      return [
        "c-done\tr-done\t\texited",
        "c-late\tr-late\t\texited",
        ...(created ? ["c-new\tr-new\t\texited"] : []),
      ].join("\n");
    }
    if (args[0] === "network" && args[1] === "ls") {
      order.push("list networks");
      return "n-done\tr-done\nn-late\tr-late";
    }
    if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) order.push(args.join(" "));
    return "";
  });
  const s = await started({ exec: docker.exec });
  try {
    await s.clients.reconcile(() => {
      order.push("store");
      // Between the listing and the reclaim: r-late's run went active (its row was written
      // before its launch made anything), and a launch made c-new for a run not yet active.
      created = true;
      return Promise.resolve(["r-late"]);
    });
    assertEquals(order, [
      "list containers",
      "list networks",
      "store",
      "rm -fv c-done",
      "network rm n-done",
    ]);

    // A reclaim the launcher never listed removes nothing.
    const forged = await raw(s.launcher, "POST", LAUNCHER_ROUTES.reconcileReclaim, TOKEN, {
      listing: "not-a-listing",
      active: [],
    });
    // A 409, which a caller answers by listing again — not a 404's "no such route".
    assertEquals(forged.status, 409);
    await forged.body?.cancel();
    assertEquals(order.filter((o) => o.includes("c-new")), []);
  } finally {
    await s.close();
  }
});

test("a cancelled build stops on the launcher, not only in the client", async () => {
  let cloneStarted!: () => void;
  const started_ = new Promise<void>((r) => (cloneStarted = r));
  let aborted!: () => void;
  const stopped = new Promise<void>((r) => (aborted = r));
  const docker = fakeDocker();
  const s = await started({
    exec: docker.exec,
    environments: { ...DEFAULT_ENVIRONMENTS_CONFIG, enabled: true, builder: "docker" },
    // Unconfined, which only the daemon's one tenant may build (the binary's launcher).
    soleTenant: true,
    env: () => undefined,
    run: storeRun((cmd, _args, { signal }) => {
      if (cmd !== "bash") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      cloneStarted();
      // The clone hangs until the build is stopped — which only the launcher's request signal,
      // fired by the client's closed connection, can do.
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted();
          reject(new Error("killed"));
        }, { once: true })
      );
    }),
  });
  try {
    const cancel = new AbortController();
    const result = s.clients.environmentBuilder.build(BUILD, { signal: cancel.signal });
    await started_;
    cancel.abort();
    const answer = await result;
    assertEquals(answer.ok, false);
    assertEquals(!answer.ok && answer.message, "the build was cancelled");
    await stopped; // the launcher's build heard it
  } finally {
    await s.close();
  }
});

test("a build that finishes answers its result through the beats", async () => {
  const docker = fakeDocker();
  const s = await started({
    exec: docker.exec,
    environments: { ...DEFAULT_ENVIRONMENTS_CONFIG, enabled: true, builder: "docker" },
    // Unconfined, which only the daemon's one tenant may build (the binary's launcher).
    soleTenant: true,
    env: () => undefined,
    run: storeRun(async (cmd) => {
      // Slower than a few beats, then a clone that fails: the answer is the adapter's own.
      if (cmd === "bash") await new Promise((r) => setTimeout(r, 200));
      return { code: cmd === "bash" ? 1 : 0, stdout: "", stderr: "fatal: repository not found" };
    }),
  });
  try {
    const answer = await s.clients.environmentBuilder.build(BUILD, {
      signal: new AbortController().signal,
    });
    assertEquals(answer.ok, false);
    assertStringIncludes(!answer.ok ? answer.message : "", "cloning the repositories failed");
    assertEquals(await s.clients.environmentBuilder.liveLog(BUILD), null);
  } finally {
    await s.close();
  }
});

test("prefetch status is the launcher's, asked fresh", async () => {
  const stored = new Set<string>();
  const docker = fakeDocker((args) => {
    if (args[0] === "image") {
      return stored.has(args.at(-1)!) ? "sha256:abc" : new Error("No such image");
    }
    if (args[0] === "pull") stored.add(args.at(-1)!);
    return "";
  });
  const image = "quay.io/ryph/ryph-agent:test";
  const s = await started({ exec: docker.exec, prefetch: [{ name: "agent", image }] });
  try {
    // Started by the launcher itself at boot: nobody asked, and the image arrives.
    for (let i = 0; i < 50 && !stored.has(image); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(await s.clients.imagePrefetch.status(), [
      { name: "agent", image, state: "present", error: null },
    ]);
    // A caller's start is a retry: the image is looked at again, and still present.
    await s.clients.imagePrefetch.start();
    await new Promise((r) => setTimeout(r, 20));
    assertEquals((await s.clients.imagePrefetch.status()).map((i) => i.state), ["present"]);
    assertEquals(docker.calls.filter((c) => c.startsWith("pull")).length, 1);
  } finally {
    await s.close();
  }
});

test("info says what the launcher is configured with, and a lost launcher is retryable", async () => {
  const docker = fakeDocker((args) =>
    args[0] === "info"
      ? "29.4.0|linux|Docker Desktop"
      : args[0] === "network"
      ? "true|isolated|isolated"
      : ""
  );
  const s = await started({
    exec: docker.exec,
    docker: {
      network: "ryph-test",
      runNetwork: "ryph-test-runs",
      gate: {
        image: "ryph-run-gate:test",
        routes: [{ listen: 7411, target: "host.docker.internal", port: 7411 }],
        owner: "test",
      },
    },
  });
  const info = await s.clients.info();
  // The revision both ends were built with: a caller of another refuses to boot on it.
  assertEquals(info.wire, LAUNCHER_WIRE_REVISION);
  assertEquals(info.gate, "ryph-gate-ryph-test");
  assertEquals(info.runNetwork, "ryph-test-runs");
  assertEquals(info.routes, [{ listen: 7411, target: "host.docker.internal", port: 7411 }]);
  assertEquals(info.engine?.vm, true);
  await s.close();
  // Gone: the never-throwing reads answer "could not ask", the throwing ones say retryable.
  assertEquals(await s.clients.provisioner.inspect("c"), "unknown");
  assertEquals((await s.clients.checkLauncher.poll(CHECK.name)).kind, "unknown");
  assertEquals(await s.clients.checkLauncher.prepare!([CHECK.image], "x"), { kind: "pulling" });
  const err = await assertRejects(() => s.clients.checkLauncher.list());
  assert(err instanceof LauncherError && err.retryable);
});

const CHECK: CheckSpec = {
  suiteId: "cs-0123456789",
  generation: 1,
  name: "ryph-check-cs-0123456789-g1",
  image: "registry.test/envs/repo:e-1",
  clone: {
    url: "http://forge:7412/v1/git/cs-0123456789/cr-1/repo.git",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.http://forge:7412/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic Z2l0LWtleQ==",
    },
    commit: "a".repeat(40),
    baseCommit: "b".repeat(40),
  },
  bakedCheckout: null,
  keep: ["node_modules"],
  setup: [{ run: "npm ci" }],
  checks: [{ name: "lint", run: "npm run lint", timeoutSeconds: 300 }],
  services: [],
  size: { ...UNSIZED, name: "standard", cpu: "4", memory: "8Gi" },
  proxyEnv: { HTTPS_PROXY: "http://cs:claim@egress-proxy:7460", NO_PROXY: "localhost" },
  deadlineSeconds: 1500,
};

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

test("inspect and kill reach only this deployment's runs, and a stop waits on an unknown owner", async () => {
  let daemonDown = false;
  const docker = fakeDocker((args) => {
    const owner = args[0] === "inspect" && args.includes("--type");
    if (owner && daemonDown) return new Error("Cannot connect to the Docker daemon");
    if (owner && args.includes("theirs")) return "r-1|other-deployment";
    if (owner && args.includes("gone")) return new Error("Error: No such container: gone");
    if (owner) return "r-1|default";
    if (args[0] === "inspect") return "running";
    return "";
  });
  const s = await started({ exec: docker.exec });
  try {
    const inspect = await raw(s.launcher, "POST", LAUNCHER_ROUTES.inspect, TOKEN, {
      handle: "theirs",
    });
    assertEquals(inspect.status, 403);
    await inspect.body?.cancel();
    assertEquals(await s.clients.provisioner.inspect("gone"), "exited");
    assertEquals(await s.clients.provisioner.inspect("ours"), "running");
    // Nothing there is the outcome a stop wants: it goes ahead, and docker says so.
    await s.clients.provisioner.kill("gone", { graceful: false });
    daemonDown = true;
    const err = await assertRejects(() => s.clients.provisioner.kill("ours", { graceful: true }));
    assert(err instanceof LauncherError && err.retryable && err.status === 503, String(err));
    assertEquals(docker.calls.some((c) => c.startsWith("stop")), false);
  } finally {
    await s.close();
  }
});

test("a body past the cap is a 413, by its length and while it streams", async () => {
  const s = await started({ exec: fakeDocker().exec });
  try {
    const big = JSON.stringify({ spec: { ...SPEC, env: { X: "x".repeat(17 * 1024 * 1024) } } });
    const res = await fetch(`${s.launcher.url}${LAUNCHER_ROUTES.launch}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: big,
    });
    assertEquals(res.status, 413);
    await res.body?.cancel();
    // Chunked, with no length to refuse up front.
    const bytes = new TextEncoder().encode(big);
    const streamed = await fetch(`${s.launcher.url}${LAUNCHER_ROUTES.launch}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          for (let at = 0; at < bytes.length; at += 1024 * 1024) {
            controller.enqueue(bytes.slice(at, at + 1024 * 1024));
          }
          controller.close();
        },
      }),
      duplex: "half",
    });
    assertEquals(streamed.status, 413);
    await streamed.body?.cancel();
  } finally {
    await s.close();
  }
});

test("a body that trickles past the read deadline is a 408, and docker never hears of it", async () => {
  const docker = fakeDocker();
  const s = await started({ exec: docker.exec, bodyReadMs: 200 });
  try {
    const body = trickle();
    const res = await fetch(`${s.launcher.url}${LAUNCHER_ROUTES.launch}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body.body,
      duplex: "half",
    } as RequestInit);
    body.stop();
    assertEquals(res.status, 408);
    await res.body?.cancel();
    assertEquals(docker.calls.filter((c) => !c.startsWith("version")), []);
  } finally {
    await s.close();
  }
});

test("info answers without the engine when docker hangs, and readiness follows docker", async () => {
  let answers = false;
  const docker = fakeDocker((args) => {
    if (args[0] === "info") return new Promise<string>(() => {}); // a daemon holding the socket
    if (args[0] === "version") {
      return answers ? "29.4.0" : new Error("docker version failed: Cannot connect to the daemon");
    }
    return "";
  });
  const s = await started({ exec: docker.exec });
  try {
    const at = Date.now();
    const info = await s.clients.info();
    assertEquals(info.engine, null);
    assert(Date.now() - at < 6_000, "bounded, not waiting on docker");
    const down = await fetch(`${s.launcher.url}/readyz`);
    assertEquals(down.status, 503);
    await down.body?.cancel();
    answers = true;
    const up = await fetch(`${s.launcher.url}/readyz`);
    assertEquals(up.status, 200);
    await up.body?.cancel();
  } finally {
    await s.close();
  }
});

test("close lets go of a docker call still in flight", async () => {
  let started_!: () => void;
  const inFlight = new Promise<void>((r) => (started_ = r));
  const docker = fakeDocker((args) => {
    if (args[0] !== "run") return "";
    started_();
    return new Promise<string>(() => {}); // a pull that never ends
  });
  const s = await started({ exec: docker.exec, closeMs: 200 });
  const launch = s.clients.provisioner.launch(SPEC).catch(() => "lost");
  await inFlight;
  const at = Date.now();
  await s.close();
  assert(Date.now() - at < 2_000, `close took ${Date.now() - at} ms`);
  void launch;
});

test("under a sandboxed runtime a launcher builds nothing unless told to trust the branch", async () => {
  const build = async (trustDefaultBranch: boolean | undefined) => {
    const s = await started({
      exec: fakeDocker().exec,
      docker: { runtime: "runsc" },
      environments: { ...DEFAULT_ENVIRONMENTS_CONFIG, enabled: true, builder: "docker" },
      // Unconfined, so the daemon's one tenant, or it would refuse every build for that alone.
      soleTenant: true,
      env: () => undefined,
      run: storeRun((cmd) =>
        Promise.resolve({ code: cmd === "bash" ? 1 : 0, stdout: "", stderr: "clone failed" })
      ),
      ...(trustDefaultBranch === undefined ? {} : { trustDefaultBranch }),
    });
    try {
      const info = await s.clients.info();
      const result = await s.clients.environmentBuilder.build(BUILD, {
        signal: new AbortController().signal,
      });
      return { info, result };
    } finally {
      await s.close();
    }
  };
  // A default-branch build on the caller's word: refused, before a clone — and said in /v1/info,
  // so a caller with builds on refuses to boot rather than fail every build.
  const refused = await build(undefined);
  assertStringIncludes(
    !refused.result.ok ? refused.result.message : "",
    "does not take a caller's word",
  );
  assertStringIncludes(refused.info.buildsRefused ?? "", "RYPH_ENV_TRUST_DEFAULT_BRANCH");
  // Told to trust it (the binary's embedded launcher), the build goes as far as its clone.
  const trusted = await build(true);
  assertStringIncludes(
    !trusted.result.ok ? trusted.result.message : "",
    "cloning the repositories failed",
  );
  assertEquals(trusted.info.buildsRefused, null);
});

test("an unconfined standalone launcher builds nothing, and says why in /v1/info", async () => {
  const docker = fakeDocker();
  const ran: string[] = [];
  const s = await started({
    exec: docker.exec,
    environments: { ...DEFAULT_ENVIRONMENTS_CONFIG, enabled: true, builder: "docker" },
    env: () => undefined,
    run: storeRun((cmd, args) => {
      ran.push([cmd, ...args].join(" "));
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }),
  });
  try {
    const info = await s.clients.info();
    assertStringIncludes(info.buildsRefused ?? "", "RYPH_DOCKER_RUN_NETWORK");
    const result = await s.clients.environmentBuilder.build(BUILD, {
      signal: new AbortController().signal,
    });
    // Refused before a clone, so nothing touched the daemon's universal tags.
    assertStringIncludes(!result.ok ? result.message : "", "public names");
    assertEquals(ran, []);
  } finally {
    await s.close();
  }
});

test("a launcher that serves no checks answers a poll terminally, so the suite is let go", async () => {
  const s = await started({ exec: fakeDocker().exec, checks: false });
  try {
    const seen = await s.clients.checkLauncher.poll(CHECK.name);
    assertEquals(seen.kind, "unschedulable");
    assertStringIncludes(seen.kind === "unschedulable" ? seen.why ?? "" : "", "runs no checks");
  } finally {
    await s.close();
  }
});

test("launches past the run scope's body reads wait for a slot instead of failing", async () => {
  const docker = fakeDocker((args) => args[0] === "run" ? "c0ffee" : "");
  const reads = bodyReads();
  const s = await started({ exec: docker.exec, bodyReadMs: 5_000, serve: reads.serve });
  // Every run-scope read slot held by a body that trickles in.
  const held = Array.from({ length: MAX_BODY_READS }, () => {
    const controller = new AbortController();
    const body = trickle();
    const res = fetch(`${s.launcher.url}${LAUNCHER_ROUTES.kill}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body.body,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit).catch(() => null);
    return { res, body, abort: () => controller.abort() };
  });
  try {
    await reads.reading(MAX_BODY_READS);
    let settled = 0;
    const launches = Array.from(
      { length: 4 },
      (_, i) =>
        s.clients.provisioner.launch({ ...SPEC, runId: `${SPEC.runId}${i}` }).finally(() =>
          settled++
        ),
    );
    // No slot frees before the aborts below, so this can only miss a launch that should wait.
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(settled, 0, "the launches wait while every slot is held");
    for (const h of held) h.abort();
    // Each one goes through once a slot frees: no 503, so no run fails on a burst.
    assertEquals(await Promise.all(launches), launches.map(() => ({ handle: "c0ffee" })));
    await Promise.all(held.map((h) => h.res));
  } finally {
    for (const h of held) h.body.stop();
    await s.close();
  }
});

test("image removal crosses the wire under this deployment's prefix, and off removes nothing", async () => {
  const remove = async (removal: string | undefined) => {
    const ran: string[] = [];
    const s = await started({
      exec: fakeDocker().exec,
      environments: { ...DEFAULT_ENVIRONMENTS_CONFIG, enabled: true, builder: "docker" },
      soleTenant: true,
      env: (name) => (name === "RYPH_ENV_IMAGE_REMOVAL" ? removal : undefined),
      run: storeRun((cmd, args) => {
        ran.push([cmd, ...args].join(" "));
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }),
    });
    try {
      const removed = await s.clients.environmentBuilder.removeImages!({
        environmentId: "env-1",
        subjectKey: "repo-abc",
        defaultBranch: true,
        // A build no row recorded: its own baked tag goes too — this deployment's, by name.
        recorded: false,
        image: null,
        machineImage: null,
        // Another deployment's tag on the caller's word: never untagged.
        bakedImage: "ryph-env/0123456789ab/repo-abc:baked-env-0",
      });
      return { removed, ran };
    } finally {
      await s.close();
    }
  };
  const on = await remove(undefined);
  assert(on.removed);
  assertEquals(on.ran, [
    `docker image rm ${LOCAL}repo-abc:env-1`,
    `docker image rm ${LOCAL}repo-abc:baked-env-1`,
  ]);
  // The stop: not done, so the caller leaves the row for when removal is on again.
  const off = await remove("off");
  assertEquals(off.removed, false);
  assertEquals(off.ran, []);
});
