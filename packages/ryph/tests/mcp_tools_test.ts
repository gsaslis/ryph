// `ryph mcp`'s tool handlers against a stub deployment: what each asks the API, and what it
// answers the model.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ApiError, UsageError } from "../src/api/client.ts";
import { handleMessage } from "../src/mcp/jsonrpc.ts";
import { ryphServer, ryphTools } from "../src/mcp/server.ts";
import type { ToolContext } from "../src/mcp/tool.ts";
import { event, fakeRyph, type Handler, taskDetail } from "./_fake_ryph.ts";

const tools = ryphTools();

function call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
}

const TASK: Record<string, Handler> = { "GET /v1/tasks/t-1": () => taskDetail() };

test("every tool has a description, an object schema and the routes it calls", () => {
  const names = new Set<string>();
  for (const t of tools) {
    assert(!names.has(t.name), `${t.name} twice`);
    names.add(t.name);
    assert(/^[a-z_]+$/.test(t.name), t.name);
    assert(t.description.length > 20, t.name);
    assertEquals((t.inputSchema as { type: string }).type, "object", t.name);
    assert(t.routes.length > 0, t.name);
    assert(t.annotations !== undefined, t.name);
  }
  // Read tools are read-only; none of the excluded instance surfaces is reachable.
  for (const name of ["tasks_list", "task_get", "run_transcript", "agents", "repos", "memory"]) {
    assertEquals(tools.find((t) => t.name === name)!.annotations!.readOnlyHint, true, name);
  }
  const routes = tools.flatMap((t) => t.routes.map(([, p]) => p));
  for (
    const banned of [
      "/v1/auth/users",
      "/v1/auth/tokens",
      "/v1/provider-keys",
      "/v1/egress/refusals",
    ]
  ) {
    assert(!routes.some((p) => p.startsWith(banned)), banned);
  }
});

test("tasks_list sends the filters and pages with the cursor it was given", async () => {
  const f = fakeRyph({
    "GET /v1/tasks": () => ({
      tasks: [{
        id: "t-1",
        title: "Fix the login bug",
        agentId: "a-1",
        agentName: "Coder",
        origin: "user",
        workspaceId: null,
        connectedRepoIds: ["cr-1"],
        lastActivityAt: new Date().toISOString(),
        state: "running",
        phase: "running",
        idleState: "waiting-for-user",
      }],
      nextCursor: "c2",
      hasMore: true,
    }),
  });
  const text = await call(
    "tasks_list",
    { status: ["live", "failed"], agentId: "a-1", mine: true, limit: 5 },
    f.ctx,
  );
  const q = f.seen[0].query;
  assertEquals(q.get("status"), "live,failed");
  assertEquals(q.get("agent"), "a-1");
  assertEquals(q.get("mine"), "true");
  assertEquals(q.get("limit"), "5");
  assertStringIncludes(text, '- t-1 "Fix the login bug" · running/waiting-for-user · Coder (a-1)');
  assertStringIncludes(text, 'tasks_list {cursor: "c2"}');
  assertEquals(f.seen[0].authorization?.startsWith("Bearer "), true);
});

test("task_get reads the run, its result, patches and what to call next", async () => {
  const f = fakeRyph({
    "GET /v1/tasks/t-1": () =>
      taskDetail({
        state: "succeeded",
        result: {
          status: "success",
          summary: "Fixed the null check.",
          branches: [{ path: "api", name: "ryph/fix", headSha: "abcdef1234567890", commits: [{}] }],
        },
        messages: [{
          id: "m-1",
          seq: 1,
          kind: "user",
          sender: { kind: "user", name: "Ada" },
          text: "also add a test",
          createdAt: "2026-10-14T09:01:00Z",
          deliveredAt: "2026-10-14T09:01:01Z",
        }],
      }, {
        patches: [{
          id: "p-1",
          state: "pending_approval",
          runId: "r-1",
          branchName: "ryph/fix",
          forgeUrl: null,
          lastError: null,
          createdAt: "x",
        }],
      }),
  });
  const text = await call("task_get", { taskId: "t-1" }, f.ctx);
  assertStringIncludes(text, 'Task t-1: "Fix the login bug"');
  assertStringIncludes(text, "Page: https://ryph.example/tasks/t-1");
  assertStringIncludes(text, "Result: success: Fixed the null check.");
  assertStringIncludes(text, "branch ryph/fix @abcdef123456 in api, 1 commits");
  assertStringIncludes(text, "user from Ada");
  assertStringIncludes(text, "p-1 pending_approval");
  assertStringIncludes(text, "run_transcript");
});

test("task_start holds the request to the control plane's schema before sending it", async () => {
  const f = fakeRyph({
    "POST /v1/tasks": () => ({ taskId: "t-9", runId: "r-9", state: "starting" }),
  });
  await assertRejects(
    () => call("task_start", { agentId: "a-1", repoId: "cr-1", workspaceId: "w-1" }, f.ctx),
    UsageError,
    "exactly one of repoId and workspaceId",
  );
  // A title without instructions is the control plane's refusal, made here.
  await assertRejects(
    () => call("task_start", { agentId: "a-1", repoId: "cr-1", title: "x" }, f.ctx),
    UsageError,
    "a title goes with instructions",
  );
  assertEquals(f.seen.length, 0);
  const text = await call(
    "task_start",
    { agentId: "a-1", repoId: "cr-1", instructions: "Fix it", changeRequest: "42" },
    f.ctx,
  );
  assertEquals(f.seen[0].body, {
    agentId: "a-1",
    spec: { instructions: "Fix it" },
    connectedRepoId: "cr-1",
    targetChangeRequest: { connectedRepoId: "cr-1", thread: "42" },
  });
  assertStringIncludes(text, "Started task t-9, run r-9 (starting).");
});

test("run_message finds the task's latest run and posts to it", async () => {
  const f = fakeRyph({
    ...TASK,
    "POST /v1/runs/r-1/messages": () => ({ message: { id: "m-2", seq: 2 } }),
  });
  const text = await call("run_message", { taskId: "t-1", text: "use the v2 API" }, f.ctx);
  assertEquals(f.seen[1].body, { text: "use the v2 API" });
  assertStringIncludes(text, "Sent as message m-2 to run r-1");
  await assertRejects(
    () => call("run_message", { taskId: "t-1", runId: "r-0", text: "x" }, f.ctx),
    UsageError,
    "not one of task t-1's runs",
  );
});

test("run_transcript folds each call into its result, hides thinking, and says how to page", async () => {
  const f = fakeRyph({
    ...TASK,
    "GET /v1/runs/r-1/events": (req) => {
      assertEquals(req.query.get("grant"), "hg");
      if (req.query.get("after") === "11") {
        return {
          events: [
            event(12, "tool_use", {
              payload: { toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
            }),
            event(13, "tool_result", {
              payload: {
                toolCallId: "c1",
                result: { content: [{ type: "text", text: "FULL OUTPUT ".repeat(50) }] },
              },
            }),
          ],
          firstSeq: 12,
          lastSeq: 13,
          hasMore: false,
        };
      }
      assertEquals(req.query.get("lane"), "sa-1");
      return {
        events: [
          event(10, "thinking", { text: "hmm" }),
          event(11, "assistant", { text: "Running the tests." }),
          event(12, "tool_use", {
            payload: { toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
          }),
          event(13, "tool_result", {
            payload: {
              toolCallId: "c1",
              isError: true,
              result: { content: [{ type: "text", text: "1 failing" }] },
            },
          }),
          event(14, "tool_use", {
            payload: { toolCallId: "c2", toolName: "memory__search", args: { q: "login" } },
          }),
          event(15, "heartbeat", { voice: "diag", text: "alive" }),
        ],
        firstSeq: 10,
        lastSeq: 15,
        hasMore: true,
      };
    },
  });
  const text = await call("run_transcript", { taskId: "t-1", lane: "sa-1" }, f.ctx);
  assertStringIncludes(text, "#11 assistant: Running the tests.");
  assertStringIncludes(text, "#12 bash npm test → ERROR: 1 failing");
  assertStringIncludes(text, '#14 memory__search {"q":"login"} → (no result in this page');
  assert(!text.includes("#13"), "the result is folded into its call");
  assert(!text.includes("hmm"), "thinking is hidden by default");
  assertStringIncludes(text, "(1 thinking, 1 diag hidden)");
  assertStringIncludes(text, "Older: run_transcript {before: 10}");

  const one = await call("run_transcript", { taskId: "t-1", seq: 12 }, f.ctx);
  assertStringIncludes(one, "Tool: bash");
  assertStringIncludes(one, '"command": "npm test"');
  assertStringIncludes(one, "Result (#13)");
  assertEquals(one.split("FULL OUTPUT").length - 1, 50, "the whole output");
});

test("run_subagents lists each lane and whether it still works", async () => {
  const f = fakeRyph({
    ...TASK,
    "GET /v1/runs/r-1/lanes": () => ({
      lanes: [
        {
          lane: "sa-1",
          start: event(1, "subagent.start", {
            lane: "sa-1",
            payload: { id: "sa-1", label: "Find callers", mode: "explore", task: "grep it" },
          }),
          resume: null,
          end: event(9, "subagent.end", { lane: "sa-1", payload: { reason: "answered" } }),
          ranMs: 65_000,
        },
        {
          lane: "sa-2",
          start: event(1, "subagent.start", { lane: "sa-2", payload: { label: "Write tests" } }),
          resume: null,
          end: null,
          ranMs: 0,
        },
      ],
    }),
  });
  const text = await call("run_subagents", { taskId: "t-1" }, f.ctx);
  assertStringIncludes(text, '- sa-1 "Find callers" (explore) · ended (answered) · ran 1m 5s');
  assertStringIncludes(text, "task: grep it");
  assertStringIncludes(text, '- sa-2 "Write tests" · working');
});

test("run_background reads an ended command's log, and a running one's live output", async () => {
  const jobs = [
    {
      id: "bg-1",
      label: "build",
      command: "make",
      cwd: "/w",
      service: false,
      startedAt: "2026-10-14T09:00:00Z",
      endedAt: "2026-10-14T09:01:00Z",
      reason: "exited",
      exitCode: 2,
      signal: null,
      logBytes: 10,
      logTail: null,
      hasLog: true,
    },
    {
      id: "bg-2",
      label: "dev server",
      command: "npm run dev",
      cwd: "/w",
      service: true,
      startedAt: "2026-10-14T09:00:00Z",
      endedAt: null,
      reason: null,
      exitCode: null,
      signal: null,
      logBytes: 0,
      logTail: null,
      hasLog: false,
    },
  ];
  const f = fakeRyph({
    ...TASK,
    "GET /v1/runs/r-1/background": () => ({ jobs }),
    "GET /v1/runs/r-1/background/bg-1/log": () =>
      new Response(Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n")),
    "GET /v1/runs/r-1/live/commands/stream": (req) => {
      assertEquals(req.query.get("grant"), "hg");
      const frames = ": open\n\n" +
        `event: snapshot\ndata: ${
          JSON.stringify({ jobs: [{ id: "bg-2", status: "running", tail: "ready on :3000\n" }] })
        }\n\n`;
      // A stream that stays open after the snapshot, as the real one does.
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(frames));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const list = await call("run_background", { taskId: "t-1" }, f.ctx);
  assertStringIncludes(list, '- bg-1 "build" · exited (exit 2)');
  assertStringIncludes(list, '- bg-2 "dev server" [service] · running');
  const log = await call("run_background", { taskId: "t-1", jobId: "bg-1", tailLines: 5 }, f.ctx);
  assertStringIncludes(log, "line 300");
  assert(!log.includes("line 295\n"), "only the last 5 lines");
  assertStringIncludes(log, "295 earlier not shown");
  const live = await call("run_background", { taskId: "t-1", jobId: "bg-2" }, f.ctx);
  assertStringIncludes(live, "ready on :3000");
  assertStringIncludes(live, "live output");
});

/** A running background command whose live stream is `body`, kept open after it. */
function liveStream(body: (c: ReadableStreamDefaultController<Uint8Array>) => void) {
  const job = {
    id: "bg-2",
    label: "dev server",
    command: "npm run dev",
    cwd: "/w",
    service: true,
    startedAt: "2026-10-14T09:00:00Z",
    endedAt: null,
    reason: null,
    exitCode: null,
    signal: null,
    logBytes: 0,
    logTail: null,
    hasLog: false,
  };
  const stream = { cancelled: false };
  const f = fakeRyph({
    ...TASK,
    "GET /v1/runs/r-1/background": () => ({ jobs: [job] }),
    "GET /v1/runs/r-1/live/commands/stream": () =>
      new Response(
        new ReadableStream({
          start: body,
          cancel() {
            stream.cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  return { f, stream };
}

test("run_background gives up on a live stream past 1 MiB without a snapshot", async () => {
  const { f, stream } = liveStream((c) => {
    // One frame that never ends, a chunk at a time, and the stream left open.
    const chunk = new TextEncoder().encode(`data: ${"x".repeat(64 * 1024)}`);
    for (let i = 0; i < 20; i++) c.enqueue(chunk);
  });
  const started = Date.now();
  const text = await call("run_background", { taskId: "t-1", jobId: "bg-2" }, f.ctx);
  assertStringIncludes(text, "No output to show yet.");
  // Well before the 5 s read timeout: the cap, not the clock, ended it.
  assert(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
  assert(stream.cancelled, "the stream is hung up");
});

test("run_background reads a snapshot that is not JSON as no snapshot", async () => {
  const { f } = liveStream((c) => {
    c.enqueue(new TextEncoder().encode("event: snapshot\ndata: {not json\n\n"));
  });
  const text = await call("run_background", { taskId: "t-1", jobId: "bg-2" }, f.ctx);
  assertStringIncludes(text, "No output to show yet.");
});

test("run_activity gathers forge writes, memory, tool calls and usage, and survives a missing one", async () => {
  const f = fakeRyph({
    "GET /v1/tasks/t-1": () =>
      taskDetail({
        forgeActions: [{
          id: "fa-1",
          tool: "add_comment",
          repoRef: "acme/api",
          threadRef: "12",
          state: "done",
          url: "https://github.com/acme/api/pull/12#c1",
          createdThreadRef: null,
          detail: null,
          createdAt: "x",
        }],
        injectedContext: { brief: { text: "…", memoryIds: ["mem-1", "mem-2"] } },
      }),
    "GET /v1/runs/r-1/events": () => ({
      events: [
        event(3, "tool_use", {
          payload: { toolCallId: "c1", toolName: "memory__propose", args: { text: "Use v2" } },
        }),
        event(4, "tool_result", { payload: { toolCallId: "c1", result: {} } }),
      ],
      firstSeq: 3,
      lastSeq: 4,
      hasMore: false,
    }),
    "GET /v1/mcp-usage/r-1": (req) => {
      assertEquals(req.query.get("grant"), "tg");
      return {
        usage: [
          {
            serverId: "gh",
            method: "tools/call",
            tool: "search",
            status: "ok",
            durationMs: 5,
            at: "",
          },
          {
            serverId: "gh",
            method: "tools/call",
            tool: "search",
            status: "error",
            durationMs: 5,
            at: "",
          },
          { serverId: "gh", method: "tools/list", tool: null, status: "ok", durationMs: 5, at: "" },
        ],
        hasMore: false,
      };
    },
    "GET /v1/model-usage/runs/r-1": () =>
      Response.json({ error: "model access is off" }, { status: 503 }),
  });
  const text = await call("run_activity", { taskId: "t-1" }, f.ctx);
  assertStringIncludes(
    text,
    "add_comment on acme/api#12 · done · https://github.com/acme/api/pull/12#c1",
  );
  assertStringIncludes(text, "Memory brief: 2 memories (mem-1, mem-2)");
  assertStringIncludes(text, '#3 wrote memory__propose: {"text":"Use v2"}');
  assertStringIncludes(text, "gh:search ×2 (1 not ok)");
  assertStringIncludes(text, "Model usage: unavailable (503: model access is off)");
});

test("run_wait returns once the run settles, and gives up at its timeout", async () => {
  let reads = 0;
  const f = fakeRyph({
    "GET /v1/tasks/t-1": () =>
      ++reads < 3 ? taskDetail() : taskDetail({
        state: "succeeded",
        result: { status: "success", summary: "Done." },
      }),
  });
  const text = await call("run_wait", { taskId: "t-1" }, f.ctx);
  assertStringIncludes(text, "Run r-1: succeeded.");
  assertStringIncludes(text, "Result: success: Done.");
  assertEquals(f.progress.length, 2);

  const still = fakeRyph(TASK);
  const late = await call("run_wait", { taskId: "t-1", timeoutSeconds: 1 }, {
    ...still.ctx,
    intervalMs: 200,
  });
  // A phase that says the same as the state is not said twice.
  assertStringIncludes(late, "Still running after 1s");
});

test("patches diff hands out the basis patch_review sends back", async () => {
  const f = fakeRyph({
    "GET /v1/patches/p-1/diff": () => ({
      diff: "--- a/x\n+++ b/x\n",
      baseSha: "1111111111111111111111111111111111111111",
      headSha: "2222222222222222222222222222222222222222",
      truncated: false,
      omitted: [],
      moreOmitted: false,
      mode: "live",
      targetRef: "main",
      sincePatchId: null,
    }),
    "POST /v1/patches/p-1/approve": () => ({ patch: { id: "p-1", state: "queued" } }),
    "POST /v1/patches/p-1/reject": () => ({ patch: { id: "p-1", state: "rejected" } }),
  });
  const diff = await call("patches", { action: "diff", patchId: "p-1" }, f.ctx);
  assertStringIncludes(diff, "+++ b/x");
  const basis = JSON.parse(/basis: (\{.*\})\}/.exec(diff)![1]);
  const approved = await call("patch_review", { patchId: "p-1", action: "approve", basis }, f.ctx);
  const posted = () => f.seen.filter((r) => r.method === "POST");
  assertEquals(posted()[0].body, { diffBasis: basis });
  assertStringIncludes(approved, "Patch p-1 is now queued.");
  await call("patch_review", { patchId: "p-1", action: "reject" }, f.ctx);
  assertEquals(posted()[1].body, null, "a rejection sends no body");
});

test("a truncated diff sends a person to the app, hands out its basis only as data, and does not say the hooks are above", async () => {
  const f = fakeRyph({
    "GET /v1/patches/p-1": () => ({
      patch: {
        id: "p-1",
        state: "pending_approval",
        hookCheck: { touched: [".husky/pre-push"], hooksPaths: [".husky"], more: false },
      },
    }),
    "GET /v1/patches/p-1/diff": () => ({
      diff: "--- a/x\n+++ b/x\n",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      truncated: true,
      omitted: [".husky/pre-push"],
      moreOmitted: true,
      mode: "live",
      targetRef: "main",
      sincePatchId: null,
    }),
  });
  const diff = await call("patches", { action: "diff", patchId: "p-1" }, f.ctx);
  assertStringIncludes(diff, "This diff was truncated");
  assertStringIncludes(diff, "and more than this list names");
  assert(!diff.includes("Read them above"), diff);
  assertStringIncludes(diff, "may be in the part not shown");
  assertStringIncludes(
    diff,
    "a person should review and approve the patch in the app, https://ryph.example/patches/p-1",
  );
  // No ready-made approval: the lines nobody here read would be approved with it.
  assert(!diff.includes("patch_review {"), diff);
  assert(!diff.includes("went unread"), diff);
  const basis = JSON.parse(/pass basis (\{.*?\})/.exec(diff)![1]);
  assertEquals(basis, {
    mode: "live",
    targetRef: "main",
    sincePatchId: null,
    baseSha: "1".repeat(40),
  });
  // The hook files may be in the part not shown: they are named only by whoever read them.
  assert(!diff.includes("hookPaths: ["), diff);
  assertStringIncludes(diff, "and hookPaths naming each hook file they read in the app");
});

test("a diff longer than an answer carries is treated as truncated", async () => {
  const f = fakeRyph({
    "GET /v1/patches/p-1": () => ({ patch: { id: "p-1", state: "pending_approval" } }),
    "GET /v1/patches/p-1/diff": () => ({
      diff: "+".repeat(130_000),
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      truncated: false,
      omitted: [],
      moreOmitted: false,
      mode: "live",
      targetRef: "main",
      sincePatchId: null,
    }),
  });
  const diff = await call("patches", { action: "diff", patchId: "p-1" }, f.ctx);
  assertStringIncludes(diff, "This diff was truncated");
  assert(!diff.includes("patch_review {"), diff);
  assert(!diff.includes("hookPaths"), diff);
  assertStringIncludes(diff, "pass basis {");
});

for (const status of [403, 500]) {
  test(`approving refuses when the patch's hook check answers ${status}, and sends nothing`, async () => {
    const f = fakeRyph({
      "GET /v1/patches/p-1": () => Response.json({ error: "no can do" }, { status }),
      "POST /v1/patches/p-1/approve": () => ({ patch: { id: "p-1", state: "queued" } }),
    });
    await assertRejects(
      () => call("patch_review", { patchId: "p-1", action: "approve" }, f.ctx),
      ApiError,
      "git hook check could not be read",
    );
    assert(!f.seen.some((r) => r.method === "POST"), "nothing was approved");
  });
}

test("a diff of a patch that is not pending approval offers no approval", async () => {
  const f = fakeRyph({
    "GET /v1/patches/p-1": () => ({ patch: { id: "p-1", state: "submitted" } }),
    "GET /v1/patches/p-1/diff": () => ({
      diff: "--- a/x\n+++ b/x\n",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      truncated: false,
      omitted: [],
      moreOmitted: false,
      mode: "record",
      targetRef: "main",
      sincePatchId: null,
    }),
  });
  const diff = await call("patches", { action: "diff", patchId: "p-1" }, f.ctx);
  assertStringIncludes(diff, "record: settled, so measured from where the run cut it");
  assertStringIncludes(
    diff,
    "p-1 is submitted, not pending_approval: there is nothing to approve.",
  );
  assert(!diff.includes("patch_review"), diff);
});

test("a resource tool fills its path, checks the body against the service's schema, and describes it", async () => {
  const f = fakeRyph({
    "GET /v1/agents": () => ({
      agents: [{
        id: "a-1",
        name: "Coder",
        handle: "coder",
        harnessKind: "pi",
        archivedAt: null,
        modelPolicy: { provider: "anthropic", defaultModel: "claude" },
        toolPolicy: null,
      }],
    }),
    "PATCH /v1/agents/a%2F1": (req) => ({ id: "a/1", name: (req.body as { name: string }).name }),
    "DELETE /v1/connected-repos/cr-1/command-allowlist/did%3Akey%3Az6": () =>
      Response.json({ entries: [] }),
    "GET /v1/environments/e-1/log": () => new Response("a\nb\nc\nd\n"),
    "GET /v1/environments": () => ({ builds: [], nextCursor: null }),
  });
  assertStringIncludes(
    await call("agents", { action: "list" }, f.ctx),
    "- a-1 Coder (@coder) · pi · anthropic/claude",
  );
  // An id is one segment, whatever it holds.
  await call(
    "agents_manage",
    { action: "update", agentId: "a/1", body: { name: "Coder 2" } },
    f.ctx,
  );
  assertEquals(f.seen.at(-1)!.path, "/v1/agents/a%2F1");
  await call(
    "repos_manage",
    { action: "disallow_command", repoId: "cr-1", subject: "did:key:z6" },
    f.ctx,
  );
  // Refused against the orchestrator's own schema, before anything is sent.
  const before = f.seen.length;
  await assertRejects(
    () => call("agents_manage", { action: "create", body: { name: "x" } }, f.ctx),
    UsageError,
    "body:",
  );
  await assertRejects(
    () => call("agents_manage", { action: "create" }, f.ctx),
    UsageError,
    "describe",
  );
  assertEquals(f.seen.length, before);
  const schema = JSON.parse(
    await call("agents_manage", { action: "describe", of: "create" }, f.ctx),
  );
  assert(schema.required.includes("harnessKind"));
  assertStringIncludes(
    await call("environments", { action: "log", environmentId: "e-1", tail: 2 }, f.ctx),
    "[2 earlier lines; pass a larger tail for more]\nc\nd",
  );
  await call("environments", { action: "list", state: "failed", subject: "repo:cr-1" }, f.ctx);
  assertEquals(f.seen.at(-1)!.query.get("subject"), "repo:cr-1");
  await assertRejects(() => call("agents", { action: "nope" }, f.ctx), UsageError, "action:");
});

test("automations_manage checks a create against the automations service's schema", async () => {
  const f = fakeRyph({
    "POST /v1/automations": (req) => ({
      automation: { id: "au-1", ...(req.body as object) },
      secret: "s3cret",
    }),
  });
  await assertRejects(
    () =>
      call("automations_manage", {
        action: "create",
        body: { name: "x", trigger: { kind: "schedule" }, agentId: "a-1" },
      }, f.ctx),
    UsageError,
  );
  const made = await call("automations_manage", {
    action: "create",
    body: {
      name: "Nightly",
      trigger: { kind: "schedule", cron: "0 3 * * *" },
      agentId: "a-1",
      target: { kind: "repo", connectedRepoId: "cr-1" },
      instructions: "Update deps",
    },
  }, f.ctx);
  assertStringIncludes(made, '"secret":"s3cret"');
  // The body goes as written: the server applies its own defaults.
  assertEquals((f.seen[0].body as { trigger: Record<string, unknown> }).trigger, {
    kind: "schedule",
    cron: "0 3 * * *",
  });
});

test("whoami names the deployment, the person and the tools the token's capabilities reach", async () => {
  const f = fakeRyph({
    "GET /v1/auth/me": () => ({ email: "ada@example.com", name: "Ada", role: "member" }),
  }, { caps: ["tasks:read", "checks:request"] });
  const text = await call("whoami", {}, f.ctx);
  assertStringIncludes(text, "Deployment: https://ryph.example");
  assertStringIncludes(text, "Ada <ada@example.com>, role member");
  assertStringIncludes(text, "Token capabilities: tasks:read, checks:request");
  assertStringIncludes(text, "Tools it can use: tasks_list, task_get");
  assertStringIncludes(text, "agents_manage (needs agents:write or agents:policy)");
});

test("a refusal is a tool error naming the capability; a dropped bearer says why", async () => {
  const f = fakeRyph({
    "GET /v1/agents": () =>
      Response.json({ error: "requires agents:read", code: "forbidden" }, { status: 403 }),
    "GET /v1/patches": () => Response.json({ error: "unauthorized" }, { status: 401 }),
  });
  const server = ryphServer();
  const ask = (name: string, args: Record<string, unknown>) =>
    handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      server,
      f.ctx,
    ) as Promise<{ result: { content: Array<{ text: string }>; isError?: boolean } }>;
  const refused = (await ask("agents", { action: "list" })).result;
  assertEquals(refused.isError, true);
  assertStringIncludes(refused.content[0].text, "403: requires agents:read. Mint a token holding");
  const dropped = (await ask("patches", { action: "list" })).result;
  assertStringIncludes(dropped.content[0].text, "did not pass it on");
  const bad = (await ask("task_get", {})).result;
  assertEquals(bad.isError, true);
  assertStringIncludes(bad.content[0].text, "taskId: required");
});
