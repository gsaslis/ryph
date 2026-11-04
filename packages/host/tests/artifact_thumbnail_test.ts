import { setDefaultTimeout, test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dockerArtifactThumbnail,
  localArtifactThumbnail,
  type ManagedThumbnailRenderer,
} from "../src/artifact_thumbnail.ts";
import profile from "../src/thumbnail_seccomp.json" with { type: "json" };

// The fake docker is a Bun script, and a cold Bun start on a loaded runner (CI checks share a
// gVisor pod, and bun test runs files side by side) can take seconds. Every wait on something
// that does arrive gets this ceiling, not a measurement of how long it usually takes.
const ARRIVES_MS = 20_000;
// Above every ceiling a test waits on, so a slow runner fails on the condition, not the clock.
setDefaultTimeout(60_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (path: string) => access(path).then(() => true, () => false);

async function until(what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ARRIVES_MS;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen`);
    await sleep(10);
  }
}

/** Retries while the image warms: inspect and pull are cold starts of the fake as well. */
async function afterWarming(renderer: ManagedThumbnailRenderer): Promise<Uint8Array> {
  const deadline = Date.now() + ARRIVES_MS;
  for (;;) {
    try {
      return await renderer.render("hi");
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("warming")) throw err;
      if (Date.now() > deadline) throw new Error("image warming did not complete");
      await sleep(10);
    }
  }
}

async function fake(
  mode: "ok" | "fail" | "hang" | "large" | "cleanup-hang" | "cold" | "delayed" | "prune",
) {
  const dir = await mkdtemp(join(tmpdir(), "thumbnail-test-"));
  const log = join(dir, "calls");
  const exe = join(dir, "docker");
  await writeFile(
    exe,
    `#!${process.execPath}
import { appendFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const marker = ${JSON.stringify(join(dir, "marker"))};
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'rm') {
  if (mode === 'cleanup-hang') setInterval(() => {}, 1000);
  if (mode === 'delayed') {
    if (!existsSync(marker)) {
      writeFileSync(${JSON.stringify(join(dir, "missed"))}, 'missed');
      process.exit(1);
    }
    unlinkSync(marker);
    writeFileSync(${JSON.stringify(join(dir, "removed"))}, 'removed');
  }
} else if (args[0] === 'image') {
  process.exit(mode === 'cold' || (mode === 'prune' && existsSync(marker)) ? 1 : 0);
} else if (args[0] === 'pull') {
  await new Promise(r => setTimeout(r, 100));
  if (mode === 'prune' && existsSync(marker)) unlinkSync(marker);
  process.exit(0);
} else {
  const html = await new Response(Bun.stdin.stream()).text();
  writeFileSync(${JSON.stringify(join(dir, "html"))}, html);
  if (mode === 'prune' && existsSync(marker)) process.exit(125);
  if (mode === 'hang' || mode === 'delayed') setInterval(() => {}, 1000);
  else if (mode === 'fail') process.exit(7);
  else if (mode === 'large') process.stdout.write(new Uint8Array(4 * 1024 * 1024 + 1));
  else process.stdout.write(new Uint8Array([137,80,78,71,13,10,26,10]));
}
`,
  );
  await chmod(exe, 0o700);
  return {
    dir,
    exe,
    async calls(): Promise<string[][]> {
      try {
        return (await readFile(log, "utf8")).trim().split("\n").map((s) => JSON.parse(s));
      } catch {
        return [];
      }
    },
    started(): Promise<void> {
      return until(
        "fake docker start",
        async () => (await this.calls()).some((c) => c[0] === "run"),
      );
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

for (const mode of ["ok", "fail", "large", "cleanup-hang"] as const) {
  test(`Docker thumbnail ${mode}: bounded pipes and explicit cleanup`, async () => {
    const f = await fake(mode);
    const renderer = dockerArtifactThumbnail({
      image: "browser:test",
      docker: f.exe,
      prefetch: false,
      // Only cleanup-hang waits the bound out; it must still outlast the `rm`'s cold start, or
      // the kill lands before the call is logged. The others end when their `rm` exits.
      cleanupMs: mode === "cleanup-hang" ? 2_000 : ARRIVES_MS,
    });
    try {
      if (mode === "fail") {
        await assertRejects(() => renderer.render("secret"), Error, "exited 7");
      } else if (mode === "large") {
        await assertRejects(
          () => renderer.render("secret"),
          Error,
          "byte limit",
        );
      } else assertEquals((await renderer.render("secret")).length, 8);
      const calls = await f.calls();
      const run = calls.find((c) => c[0] === "run")!;
      const name = run[run.indexOf("--name") + 1];
      assert(calls.some((c) => c.join(" ") === `rm --force ${name}`));
      assertEquals(await readFile(join(f.dir, "html"), "utf8"), "secret");
      assert(!run.includes("secret"));
      for (const proxy of ["HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY"]) {
        for (const key of [proxy, proxy.toLowerCase()]) {
          const at = run.indexOf(`${key}=`);
          assert(at > 0 && run[at - 1] === "--env");
        }
      }
      for (
        const flag of [
          "--read-only",
          "ALL",
          "none",
          "1994:1994",
          "no-new-privileges",
          "--no-env-file",
          "RYPH_THUMBNAIL_SANDBOX=required",
        ]
      ) assert(run.includes(flag));
      assertEquals(run.slice(-4), [
        "bun",
        "browser:test",
        "--no-env-file",
        "src/thumbnail_cli.ts",
      ]);
      const seccompPath = run.find((v) => v.startsWith("seccomp="))!.slice(8);
      await assertRejects(() => readFile(seccompPath));
    } finally {
      await renderer.shutdown();
      await f.cleanup();
    }
  });
}

for (const stop of ["abort", "timeout", "shutdown"] as const) {
  test(`Docker thumbnail ${stop} removes the container, not just the client`, async () => {
    const f = await fake("hang");
    const renderer = dockerArtifactThumbnail({
      image: "browser:test",
      docker: f.exe,
      prefetch: false,
      // The deadline counts from the request, so it can expire before the fake has started:
      // the container is removed by its unique name either way, and that is what is checked.
      timeoutMs: stop === "timeout" ? 300 : ARRIVES_MS,
      cleanupMs: ARRIVES_MS,
    });
    const abort = new AbortController();
    const rendered = renderer.render("hi", abort.signal);
    const failed = stop === "timeout"
      ? assertRejects(() => rendered, Error, "timed out")
      : assertRejects(() => rendered);
    try {
      if (stop !== "timeout") await f.started();
      if (stop === "abort") abort.abort(new Error("cancelled"));
      if (stop === "shutdown") await renderer.shutdown();
      await failed;
      assert(
        (await f.calls()).some((c) => c[0] === "rm" && c[1] === "--force"),
      );
      await renderer.shutdown();
      await assertRejects(() => renderer.render("no"), Error, "shut down");
    } finally {
      await renderer.shutdown();
      await f.cleanup();
    }
  });
}

test("Docker thumbnail refuses oversized input and already aborted work without spawning", async () => {
  const f = await fake("ok");
  const renderer = dockerArtifactThumbnail({
    image: "test",
    docker: f.exe,
    prefetch: false,
  });
  try {
    await assertRejects(
      () => renderer.render("x".repeat(24 * 1024 * 1024 + 1)),
      Error,
      "24 MiB",
    );
    await assertRejects(() => renderer.render("x", AbortSignal.abort(new Error("abort"))));
    assertEquals(await f.calls(), []);
  } finally {
    await renderer.shutdown();
    await f.cleanup();
  }
});

test("local selection: explicit endpoint wins, manual/source remain off, binary selects browser", async () => {
  const env = (values: Record<string, string>) => (key: string) => values[key];
  assertEquals(
    localArtifactThumbnail(env({}), "manual", "browser:sha").renderer,
    null,
  );
  assertEquals(localArtifactThumbnail(env({}), "docker", null).renderer, null);
  assertEquals(
    localArtifactThumbnail(
      env({ RYPH_ARTIFACT_THUMBNAIL_IMAGE: "off" }),
      "docker",
      "browser:sha",
    ).renderer,
    null,
  );
  const endpoint = localArtifactThumbnail(
    env({ RYPH_ARTIFACT_THUMBNAIL_URL: "http://renderer:7491" }),
    "docker",
    "browser:sha",
  );
  assert(endpoint.renderer);
  assert(!("shutdown" in endpoint.renderer));
  const automatic = localArtifactThumbnail(
    env({ RYPH_BROWSER_IMAGE: "off" }),
    "docker",
    "browser:sha",
  );
  assert(automatic.renderer);
  assert("shutdown" in automatic.renderer);
  await automatic.shutdown();
});

for (const mode of ["ok", "cold"] as const) {
  test(`image warming ${mode}: inspect first, pull only absent, render does not wait for pull`, async () => {
    const f = await fake(mode);
    const renderer = dockerArtifactThumbnail({
      image: "browser:test",
      docker: f.exe,
    });
    try {
      await assertRejects(() => renderer.render("hi"), Error, "warming");
      assert(!(await f.calls()).some((c) => c[0] === "run"));
      assertEquals((await afterWarming(renderer)).length, 8);
      const calls = await f.calls();
      assertEquals(calls[0], ["image", "inspect", "browser:test"]);
      assertEquals(calls.some((c) => c[0] === "pull"), mode === "cold");
      assert(calls.some((c) => c[0] === "run"));
    } finally {
      await renderer.shutdown();
      await f.cleanup();
    }
  });
}

test("cancellation reconciles a daemon creation arriving after the first not-found removal", async () => {
  const f = await fake("delayed");
  const renderer = dockerArtifactThumbnail({
    image: "test",
    docker: f.exe,
    prefetch: false,
    // Reconciling ends at the first removal that finds the late container; the window only
    // has to outlast a few cold starts of the fake docker.
    cleanupMs: ARRIVES_MS,
  });
  const abort = new AbortController();
  const task = renderer.render("hi", abort.signal);
  const failed = assertRejects(() => task);
  try {
    await f.started();
    abort.abort(new Error("cancel"));
    // The daemon's create request outlives the killed attach CLI and its first rm response:
    // the container appears only once a removal has already answered not-found.
    await until("a not-found removal", () => exists(join(f.dir, "missed")));
    await writeFile(join(f.dir, "marker"), "late container");
    await failed;
    assertEquals(await readFile(join(f.dir, "removed"), "utf8"), "removed");
    await assertRejects(() => readFile(join(f.dir, "marker")));
    assert((await f.calls()).filter((c) => c[0] === "rm").length >= 2);
  } finally {
    await renderer.shutdown();
    await f.cleanup();
  }
});

test("a pruned warmed image is reinspected and repulled outside render deadlines", async () => {
  const f = await fake("prune");
  const renderer = dockerArtifactThumbnail({ image: "test", docker: f.exe });
  try {
    await afterWarming(renderer);
    await writeFile(join(f.dir, "marker"), "image pruned");
    await assertRejects(() => renderer.render("hi"), Error, "exited 125");
    await afterWarming(renderer);
    const calls = await f.calls();
    assertEquals(calls.filter((c) => c[0] === "image").length, 2);
    assertEquals(calls.filter((c) => c[0] === "pull").length, 1);
  } finally {
    await renderer.shutdown();
    await f.cleanup();
  }
});

test("seccomp is deny-by-default with user namespaces and clone3 fallback, never unconfined", () => {
  assertEquals(profile.defaultAction, "SCMP_ACT_ERRNO");
  assert(
    profile.syscalls.some((s) => s.names.includes("unshare") && s.action === "SCMP_ACT_ALLOW"),
  );
  const clone3 = profile.syscalls.find((s) => s.names.includes("clone3"));
  assertEquals(clone3?.action, "SCMP_ACT_ERRNO");
  assertEquals(clone3?.errnoRet, 38);
  assert(
    profile.syscalls.some((s) =>
      s.names.includes("chroot") && s.action === "SCMP_ACT_ALLOW" &&
      !("includes" in s)
    ),
  );
  assertStringIncludes(JSON.stringify(profile), "SCMP_ARCH_AARCH64");
});
