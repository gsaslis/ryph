import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { command } from "@ryph/process";
import { assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { FakeRun } from "../src/runner.ts";

test("scripted submit includes carries in patch and final result branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "playground-runner-test-"));
  const source = join(root, "source");
  const patches: Array<{ branch: Record<string, unknown>; baseSha: string }> = [];
  const results: Array<{ status: string; branches: Record<string, unknown>[] }> = [];
  const bundles: string[] = [];
  const unexpected: string[] = [];
  const repo = {
    connectedRepoId: "repo-test",
    url: source,
    ref: "main",
    path: "repo",
    branchNamespace: "ryph/test",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname;
      switch (`${request.method} ${path}`) {
        case "POST /v1/runs/run-test/bootstrap":
          return Response.json({
            env: {
              RYPH_RUN_TOKEN: "run-token",
              RYPH_GIT_TOKEN: "git-token",
              RYPH_GIT_ORIGIN: server.url.origin,
            },
          });
        case "GET /v1/runs/run-test/spec":
          return Response.json({ workItem: { repos: [repo], spec: null, agent: null } });
        case "GET /v1/runs/run-test/credentials":
          return Response.json({ env: {} });
        case "POST /v1/runs/run-test/heartbeat":
          await request.json();
          return Response.json({ cancel: false });
        case "POST /v1/runs/run-test/events":
          await request.json();
          return new Response(null, { status: 204 });
        case "POST /v1/patches/repo-test":
          bundles.push(await request.text());
          return new Response(null, { status: 204 });
        case "POST /v1/runs/run-test/patches":
          patches.push(await request.json());
          return Response.json({ patchId: "patch-test", state: "pending" });
        case "POST /v1/runs/run-test/result":
          results.push(await request.json());
          return new Response(null, { status: 204 });
        default:
          unexpected.push(`${request.method} ${path}`);
          return new Response("unexpected request", { status: 404 });
      }
    },
  });
  let runner: FakeRun | undefined;
  let concluded = false;
  try {
    const git = async (...args: string[]) => {
      const output = await command("git", { args, stdout: "piped", stderr: "piped" }).output();
      assertEquals(output.success, true, new TextDecoder().decode(output.stderr));
    };
    await git("init", "--quiet", "--initial-branch=main", source);
    await writeFile(join(source, "README.md"), "Before\n");
    await git("-C", source, "add", "README.md");
    await git(
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Initial commit",
    );

    runner = await FakeRun.start(server.url.origin, "run-test", "bootstrap-token", root);
    await runner.checkout();
    await runner.play([
      { write: "README.md", content: "After\n" },
      { submit: { title: "Update readme" } },
    ], 0);
    await runner.conclude({ kind: "success", summary: "Updated readme" });
    concluded = true;

    assertEquals(unexpected, []);
    assertEquals(bundles.length, 1);
    assertMatch(bundles[0], /^# v[23] git bundle\n/);
    assertEquals(patches.length, 1);
    const branch = patches[0].branch;
    assertEquals(branch.connectedRepoId, repo.connectedRepoId);
    assertEquals(branch.generation, 1);
    assertEquals(branch.carries, []);
    assertEquals(results.length, 1);
    assertEquals(results[0].status, "success");
    assertEquals(results[0].branches.length, 1);
    assertEquals(results[0].branches[0].carries, []);
    assertEquals(results[0].branches[0], branch);
  } finally {
    try {
      if (runner && !concluded) await runner.conclude({ kind: "lost" });
    } finally {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }
});
