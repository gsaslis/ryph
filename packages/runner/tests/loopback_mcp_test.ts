// The runner's own tool server: bearer-gated, the tools listed and callable, every outcome
// of a submit, a change-request checkout and a wake-up rendered for the model, and "not ready"
// until the core binds its actions.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { LOOPBACK_TOOLS, loopbackTools, startLoopbackMcp } from "../src/adapters/loopback/mcp.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import type {
  BackgroundJobView,
  BackgroundOutputOutcome,
  BackgroundRunArgs,
  BackgroundRunOutcome,
  BackgroundStopOutcome,
  CheckoutChangeRequestOutcome,
  FetchArtifactOutcome,
  OutcomeReport,
  PublishArtifactOutcome,
  RunActions,
  SubagentMessageOutcome,
  SubagentStartOutcome,
  SubagentStopOutcome,
  SubagentView,
  SubmitPatchOutcome,
  UpdateFromBaseOutcome,
  WakeOutcome,
} from "../src/ports/run_actions.ts";
import { startConversation } from "../src/core/conversation.ts";

const TOKEN = "loopback-token-abc";

test("previews: tool is offered only with the capability and returns its URL", async () => {
  assert(!loopbackTools({ checks: false }).some((tool) => tool.name === "expose_port"));
  assert(
    loopbackTools({ checks: false, previews: true }).some((tool) => tool.name === "expose_port"),
  );
  const description = loopbackTools({ checks: false, previews: true })
    .find((tool) => tool.name === "expose_port")!.description as string;
  assert(!description.includes("local Ryph binary"));
  assertStringIncludes(description, "not public");
  assertStringIncludes(description, "until the run ends");
  const calls: unknown[] = [];
  let answer = { url: "http://preview.localhost:1234", audience: "machine" as "machine" | "run" };
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => null,
    diag: noopDiagnostics(),
    previews: {
      expose(port, label) {
        calls.push({ port, label });
        return Promise.resolve(answer);
      },
    },
  });
  try {
    const response = await rpc(server.url, call("expose_port", { port: 5173, label: "App" }));
    const result = await response.json();
    assertEquals(
      result.result.content[0].text,
      "Open preview: http://preview.localhost:1234\n" +
        "Available on the machine running Ryph, until this run ends.",
    );
    assertEquals(calls, [{ port: 5173, label: "App" }]);
    answer = {
      url: "https://0123456789abcdef0123456789abcdef.preview.ryph-previews.example",
      audience: "run",
    };
    const hosted = await rpc(server.url, call("expose_port", { port: 5173, label: "App" }));
    assertEquals(
      (await hosted.json()).result.content[0].text,
      `Open preview: ${answer.url}\nPeople who can see this run can open it, until the run ends.`,
    );
    // Compose serves hosted previews on `*.localhost` too: the audience decides, not the name.
    answer = {
      url: "http://0123456789abcdef0123456789abcdef.preview.localhost:7490",
      audience: "run",
    };
    const compose = await rpc(server.url, call("expose_port", { port: 5173, label: "App" }));
    assertEquals(
      (await compose.json()).result.content[0].text,
      `Open preview: ${answer.url}\nPeople who can see this run can open it, until the run ends.`,
    );
    const invalid = await rpc(server.url, call("expose_port", { port: "5173" }));
    assertEquals((await invalid.json()).result.isError, true);
  } finally {
    await server.shutdown();
  }
  const unavailable = await startLoopbackMcp({
    token: TOKEN,
    actions: () => null,
    diag: noopDiagnostics(),
  });
  try {
    const response = await rpc(unavailable.url, call("expose_port", { port: 5173, label: "App" }));
    const result = (await response.json()).result;
    assertEquals(result.isError, true);
    assertEquals(result.content[0].text, "Previews are not available on this deployment.");
  } finally {
    await unavailable.shutdown();
  }
});

const unusedSubmit = (): SubmitPatchOutcome => ({ kind: "refused", reason: "unused" });

function rpc(url: string, body: unknown, token: string | null = TOKEN) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

/** A scriptable RunActions: records calls, answers what it is told. */
function fakeActions(
  submit: (args: unknown) => SubmitPatchOutcome,
  environmentStatus: () => Promise<string> = () => Promise.resolve("no builds"),
  checkout: (args: unknown) => CheckoutChangeRequestOutcome = () => ({
    kind: "refused",
    reason: "unused",
  }),
  wake: (args: { afterMinutes: number; note?: string }) => WakeOutcome = () => ({
    kind: "refused",
    reason: "unused",
  }),
  update: (args: unknown) => UpdateFromBaseOutcome = () => ({ kind: "refused", reason: "unused" }),
) {
  const finished: OutcomeReport[] = [];
  const reports: Parameters<RunActions["reportOutcome"]>[0][] = [];
  const owed: { count: number | null; waits: boolean; asked: number } = {
    count: 0,
    waits: true,
    asked: 0,
  };
  const submits: unknown[] = [];
  const checked: string[] = [];
  const checkouts: unknown[] = [];
  const updates: unknown[] = [];
  /** What the background tools answer, swapped in by a test; and what they were asked. */
  const background = {
    run: (_: BackgroundRunArgs): BackgroundRunOutcome => ({ kind: "refused", reason: "unused" }),
    output: (_: { id?: string; tailLines?: number }): BackgroundOutputOutcome => ({
      kind: "refused",
      reason: "unused",
    }),
    stop: (_: { id: string }): BackgroundStopOutcome => ({ kind: "refused", reason: "unused" }),
    calls: [] as Array<[string, unknown]>,
  };
  /** What the subagent tools answer, swapped in by a test; and what they were asked. */
  const subagents = {
    start: (_: unknown): SubagentStartOutcome => ({ kind: "refused", reason: "unused" }),
    message: (_: unknown): SubagentMessageOutcome => ({ kind: "refused", reason: "unused" }),
    stop: (_: unknown): SubagentStopOutcome => ({ kind: "refused", reason: "unused" }),
    running: 0,
    calls: [] as Array<[string, unknown]>,
  };
  /** What publish_artifact answers, swapped in by a test; and what it was asked. */
  const artifacts = {
    answer: (_: unknown): PublishArtifactOutcome => ({ kind: "refused", reason: "unused" }),
    fetched: (_: unknown): FetchArtifactOutcome => ({ kind: "refused", reason: "unused" }),
    calls: [] as unknown[],
    fetches: [] as unknown[],
  };
  /** What finish is told was never submitted, set by a test. */
  const unsubmitted = { branches: [] as Array<{ path: string; list: string }> };
  const actions: RunActions = {
    finish: (args) => {
      finished.push(args);
      return true;
    },
    reportOutcome: (args) => {
      reports.push(args);
      return true;
    },
    submitPatch(args) {
      submits.push(args);
      return Promise.resolve(submit(args));
    },
    checkoutChangeRequest(args) {
      checkouts.push(args);
      return Promise.resolve(checkout(args));
    },
    updateFromBase(args) {
      updates.push(args);
      return Promise.resolve(update(args));
    },
    patches: () => [{
      patchId: "p-1",
      path: "repo",
      branch: "ryph/ada/r-1/work",
      generation: 1,
      headSha: "abcdef1234567890",
      state: "submitted",
      forgeUrl: "https://gh/x/pull/7",
      url: "https://ryph.example/patches/p-1",
    }, {
      patchId: "p-3",
      path: "repo",
      branch: "ryph/ada/r-1/work-2",
      generation: 2,
      headSha: "fedcba9876543210",
      state: "pending_approval",
      forgeUrl: null,
      url: "https://ryph.example/patches/p-3",
    }],
    environmentStatus,
    runChecks: () => Promise.resolve({ kind: "refused", reason: "unused" }),
    checkStatus: () => Promise.resolve({ kind: "answered", text: "no checks" }),
    checkLog: () => Promise.resolve({ kind: "refused", reason: "no checks" }),
    checksOwed: () => {
      owed.asked++;
      return Promise.resolve({ owed: owed.count, waits: owed.waits });
    },
    wake,
    backgroundRun(args) {
      background.calls.push(["run", args]);
      return Promise.resolve(background.run(args));
    },
    backgroundOutput(args) {
      background.calls.push(["output", args]);
      return background.output(args);
    },
    backgroundStop(args) {
      background.calls.push(["stop", args]);
      return Promise.resolve(background.stop(args));
    },
    subagentStart(args) {
      subagents.calls.push(["start", args]);
      return Promise.resolve(subagents.start(args));
    },
    subagentMessage(args) {
      subagents.calls.push(["message", args]);
      return Promise.resolve(subagents.message(args));
    },
    subagentStop(args) {
      subagents.calls.push(["stop", args]);
      return Promise.resolve(subagents.stop(args));
    },
    subagentsRunning: () => subagents.running,
    unsubmittedBranches: () => Promise.resolve(unsubmitted.branches),
    publishArtifact(args) {
      artifacts.calls.push(args);
      return Promise.resolve(artifacts.answer(args));
    },
    fetchArtifact(args) {
      artifacts.fetches.push(args);
      return Promise.resolve(artifacts.fetched(args));
    },
    // A ref spelled "bad" names nothing.
    checkImageRefs: (text) => {
      checked.push(text);
      return Promise.resolve(text.includes("img-000000000bad") ? "No image has that ref." : null);
    },
  };
  return {
    actions,
    unsubmitted,
    finished,
    reports,
    submits,
    checkouts,
    updates,
    owed,
    checked,
    background,
    subagents,
    artifacts,
  };
}

async function text(res: Response): Promise<string> {
  const body = await res.json() as {
    result?: { content: Array<{ text: string }>; isError?: boolean };
  };
  return body.result!.content[0].text;
}

test("loopback: unauthenticated requests learn nothing; the wrong path is 404", async () => {
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => null,
    diag: noopDiagnostics(),
  });
  try {
    const missing = await rpc(server.url, call("patches"), null);
    await missing.body?.cancel();
    assertEquals(missing.status, 401);
    const wrong = await rpc(server.url, call("patches"), "not-it");
    await wrong.body?.cancel();
    assertEquals(wrong.status, 401);
    const elsewhere = await rpc(server.url.replace(/\/mcp$/, "/other"), call("patches"));
    await elsewhere.body?.cancel();
    assertEquals(elsewhere.status, 404);
    // no stream is offered; a session end is fine
    const get = await fetch(server.url, { headers: { authorization: `Bearer ${TOKEN}` } });
    await get.body?.cancel();
    assertEquals(get.status, 405);
  } finally {
    await server.shutdown();
  }
});

test("loopback: initialize, ping and tools/list answer the protocol; batches and unknown methods are refused", async () => {
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => null,
    diag: noopDiagnostics(),
  });
  try {
    const init = await rpc(server.url, {
      jsonrpc: "2.0",
      id: "i",
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    const initBody = await init.json();
    assertEquals(initBody.result.protocolVersion, "2025-03-26");
    assertEquals(initBody.result.serverInfo.name, "ryph-run");

    const list = await rpc(server.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (await list.json()).result.tools as Array<{ name: string }>;
    assertEquals(tools.map((t) => t.name), [
      "submit_patch",
      "checkout_change_request",
      "update_from_base",
      "patches",
      "environment_status",
      "wake_me",
      "background_run",
      "background_output",
      "background_stop",
      "subagent_start",
      "subagent_message",
      "subagent_stop",
      "report_outcome",
      "finish",
    ], "no checks told of: the checks tools are left out");
    assertEquals(tools, [...loopbackTools({ checks: false })] as unknown[]);
    // When to call finish is at the point of use too, not only in the system prompt: the same
    // two tests — delivered and complete in itself, or waiting on something that continues
    // this work.
    const finish = (tools as Array<{ name: string; description: string }>)
      .find((t) => t.name === "finish")!;
    assertStringIncludes(finish.description, "delivered and complete in itself");
    assertStringIncludes(finish.description, "waiting on something that continues this work");
    // and failing is a reason to finish too, said where the tool is chosen
    assertStringIncludes(finish.description, "you cannot do it and have said why");
    // An offer to do more waits on its reply.
    assertStringIncludes(finish.description, "An answer that offers to do more");

    // The swap replaces the repository's branch, so the tool says so where it is chosen, not
    // only in the system prompt — and names what it does to the patches that follow.
    const checkout = (tools as Array<{ name: string; description: string }>)
      .find((t) => t.name === "checkout_change_request")!;
    assertStringIncludes(checkout.description, "instead of opening a new one");
    assertStringIncludes(checkout.description, "uncommitted changes");

    // The wake-up names what it replaces where it is chosen: a sleep in a command, during which
    // nothing reaches the agent.
    const wake = (tools as Array<{ name: string; description: string }>)
      .find((t) => t.name === "wake_me")!;
    assertStringIncludes(wake.description, "instead of sleeping or polling in a command");
    assertStringIncludes(wake.description, "calling again replaces the pending one");
    assert(!wake.description.includes("checks"), "no checks told of: none mentioned");

    const ping = await rpc(server.url, { jsonrpc: "2.0", id: 3, method: "ping" });
    assertEquals((await ping.json()).result, {});

    const batch = await rpc(server.url, [call("patches")]);
    assertEquals(batch.status, 400);
    assertEquals((await batch.json()).error.code, -32600);

    const unknown = await rpc(server.url, { jsonrpc: "2.0", id: 4, method: "resources/list" });
    assertEquals((await unknown.json()).error.code, -32601);

    const notification = await rpc(server.url, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await notification.body?.cancel();
    assertEquals(notification.status, 202);
  } finally {
    await server.shutdown();
  }
});

test("loopback: before the core binds its actions, a call is a tool error the model reads", async () => {
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => null,
    diag: noopDiagnostics(),
  });
  try {
    const res = await rpc(server.url, call("finish"));
    const body = await res.json();
    assertEquals(body.result.isError, true);
    assertStringIncludes(body.result.content[0].text, "not ready");
  } finally {
    await server.shutdown();
  }
});

test("loopback: a run that may not open patches refuses every patch tool, called anyway", async () => {
  const { actions, submits, checkouts, updates } = fakeActions(
    () => ({ kind: "submitted", patchId: "p-1", state: "queued" } as never),
  );
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
    patches: false,
  });
  try {
    const listed = await (await rpc(server.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })).json();
    assert(!listed.result.tools.some((t: { name: string }) => t.name === "submit_patch"));
    for (
      const name of [
        "submit_patch",
        "update_from_base",
        "patches",
        "environment_status",
      ]
    ) {
      const body = await (await rpc(server.url, call(name, { changeRequest: "7" }))).json();
      assertEquals(body.result.isError, true, name);
      assertStringIncludes(body.result.content[0].text, "may not open patches");
    }
    assertEquals([submits.length, updates.length], [0, 0]);
    // And finishing says the run ends, never that it ships anything.
    const finished = await text(
      await rpc(server.url, call("finish", { outcome: "success", summary: "done" })),
    );
    assertEquals(finished, "Noted: the run ends after this turn.");
    // Moving onto a change request to read it is still the run's to do.
    await rpc(server.url, call("checkout_change_request", { changeRequest: "7" }));
    assertEquals(checkouts.length, 1);
  } finally {
    await server.shutdown();
  }
});

test("loopback: the artifact tools are hidden and refused unless the run may publish artifacts", async () => {
  const { actions, artifacts } = fakeActions(unusedSubmit);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    const listed = await (await rpc(server.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })).json();
    assert(!listed.result.tools.some((t: { name: string }) => t.name === "publish_artifact"));
    assert(!listed.result.tools.some((t: { name: string }) => t.name === "fetch_artifact"));
    const body = await (await rpc(
      server.url,
      call("publish_artifact", { path: "report.html", title: "Report" }),
    )).json();
    assertEquals(body.result.isError, true);
    assertStringIncludes(body.result.content[0].text, "may not publish artifacts");
    assertEquals(artifacts.calls.length, 0);
    const fetchBody = await (await rpc(
      server.url,
      call("fetch_artifact", { artifact: "art-1" }),
    )).json();
    assertEquals(fetchBody.result.isError, true);
    assertEquals(artifacts.fetches.length, 0);
  } finally {
    await server.shutdown();
  }
});

test("loopback: publish_artifact is listed where allowed, and says who can see what it published", async () => {
  const { actions, artifacts } = fakeActions(unusedSubmit);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
    artifacts: true,
  });
  try {
    const listed = await (await rpc(server.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })).json();
    const tool = listed.result.tools.find((t: { name: string }) => t.name === "publish_artifact");
    assertStringIncludes(tool.description, "everyone on this instance can open");
    assertEquals(tool.inputSchema.required, ["path", "title"]);

    artifacts.answer = () => ({
      kind: "published",
      id: "art-1",
      version: 1,
      url: "https://ryph.test/artifacts/art-1",
      created: true,
      unchanged: false,
    });
    const first = await text(
      await rpc(server.url, call("publish_artifact", { path: "report.html", title: "Report" })),
    );
    assertStringIncludes(first, "Published artifact art-1");
    assertStringIncludes(first, "https://ryph.test/artifacts/art-1");
    assertStringIncludes(first, "Everyone on this instance can open it");
    assertEquals(artifacts.calls, [{ path: "report.html", title: "Report", artifact: undefined }]);

    artifacts.answer = () => ({
      kind: "published",
      id: "art-1",
      version: 2,
      url: null,
      created: false,
      unchanged: false,
    });
    const second = await text(
      await rpc(
        server.url,
        call("publish_artifact", { path: "report.html", title: "Report", artifact: "art-1" }),
      ),
    );
    assertStringIncludes(second, "Published version 2 of artifact art-1");
    assertStringIncludes(second, "no link to post");
    // Without a link the agent is not asked to post one.
    assert(!second.includes("Post the link"), second);
    assertStringIncludes(first, "Post the link where you were asked");

    artifacts.answer = () => ({
      kind: "refused",
      reason: "no artifact art-9 this agent may update",
    });
    const refused = await (await rpc(
      server.url,
      call("publish_artifact", { path: "report.html", title: "Report", artifact: "art-9" }),
    )).json();
    assertEquals(refused.result.isError, true);
    assertStringIncludes(
      refused.result.content[0].text,
      "Nothing was published: no artifact art-9",
    );

    const missing = await (await rpc(server.url, call("publish_artifact", { path: "x.html" })))
      .json();
    assertEquals(missing.result.isError, true);
    assertEquals(artifacts.calls.length, 3, "a call without a title never reaches the run");

    artifacts.answer = () => ({
      kind: "published",
      id: "art-1",
      version: 2,
      url: "https://ryph.test/artifacts/art-1",
      created: false,
      unchanged: true,
    });
    const same = await text(
      await rpc(
        server.url,
        call("publish_artifact", { path: "report.html", title: "Report", artifact: "art-1" }),
      ),
    );
    assertStringIncludes(same, "Nothing changed: the title and the file are version 2");

    // fetch_artifact: listed beside it, and it says where the file went and what to do next.
    const fetchTool = listed.result.tools.find((t: { name: string }) =>
      t.name === "fetch_artifact"
    );
    assertEquals(fetchTool.inputSchema.required, ["artifact"]);
    artifacts.fetched = () => ({
      kind: "fetched",
      id: "art-1",
      title: "Report",
      version: 2,
      path: "/work/artifact-art-1.html",
    });
    const fetched = await text(
      await rpc(server.url, call("fetch_artifact", { artifact: "art-1" })),
    );
    assertStringIncludes(fetched, "Wrote version 2 of artifact art-1");
    assertStringIncludes(fetched, "/work/artifact-art-1.html");
    assertEquals(artifacts.fetches, [{ artifact: "art-1", path: undefined }]);
    const noId = await (await rpc(server.url, call("fetch_artifact", {}))).json();
    assertEquals(noId.result.isError, true);
    assertEquals(artifacts.fetches.length, 1);
  } finally {
    await server.shutdown();
  }
});

test("loopback: environment_status hands on the control plane's text, and says when it could not ask", async () => {
  let fail = false;
  const { actions } = fakeActions(
    () => ({ kind: "refused", reason: "unused" }),
    () =>
      fail
        ? Promise.reject(new Error("the orchestrator could not say: HTTP 502"))
        : Promise.resolve("Environment builds for this run's patches, oldest first:\n- p-1: ready"),
  );
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    const ok = await (await rpc(server.url, call("environment_status"))).json();
    assertEquals(ok.result.isError, undefined);
    assertStringIncludes(ok.result.content[0].text, "p-1: ready");
    fail = true;
    const down = await (await rpc(server.url, call("environment_status"))).json();
    assertEquals(down.result.isError, true);
    assertStringIncludes(down.result.content[0].text, "could not be asked just now");
    assertStringIncludes(down.result.content[0].text, "HTTP 502");
  } finally {
    await server.shutdown();
  }
});

test("loopback: checkout_change_request reaches the actions, and both outcomes are rendered", async () => {
  let answer: CheckoutChangeRequestOutcome = {
    kind: "checked-out",
    path: "repo",
    changeRequest: "42",
    ref: "feature/x",
    headSha: "fedcba9876543210",
    url: "https://gh/x/pull/42",
  };
  const { actions, checkouts } = fakeActions(
    () => ({ kind: "refused", reason: "unused" }),
    () => Promise.resolve("no builds"),
    () => answer,
  );
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    const ok = await (await rpc(
      server.url,
      call("checkout_change_request", { repo: "repo", changeRequest: "42" }),
    )).json();
    assertEquals(ok.result.isError, undefined);
    assertStringIncludes(ok.result.content[0].text, "repo is now on change request 42");
    assertStringIncludes(ok.result.content[0].text, "https://gh/x/pull/42");
    assertStringIncludes(ok.result.content[0].text, "fedcba9876");
    assertStringIncludes(ok.result.content[0].text, "feature/x");
    assertEquals(checkouts, [{ path: "repo", changeRequest: "42" }]);

    // A refusal is the reason verbatim, flagged as an error — the agent decides what to do.
    answer = { kind: "refused", reason: "repo has uncommitted changes" };
    const refused = await (await rpc(
      server.url,
      call("checkout_change_request", { changeRequest: "42" }),
    )).json();
    assertEquals(refused.result.isError, true);
    assertEquals(refused.result.content[0].text, "repo has uncommitted changes");
    assertEquals(checkouts.at(-1), { path: undefined, changeRequest: "42" });

    // The one argument the tool cannot do without is its own error, never a crash.
    const missing = await rpc(server.url, call("checkout_change_request", { repo: "repo" }));
    assertEquals((await missing.json()).error.code, -32603);
    assertEquals(checkouts.length, 2);
  } finally {
    await server.shutdown();
  }
});

test("loopback: update_from_base reaches the actions, and every outcome is rendered", async () => {
  let answer: UpdateFromBaseOutcome = {
    kind: "merged",
    path: "repo",
    target: "main",
    tip: "1111111111aaaa",
    headSha: "2222222222bbbb",
  };
  const { actions, updates } = fakeActions(
    () => ({ kind: "refused", reason: "unused" }),
    undefined,
    undefined,
    undefined,
    () => answer,
  );
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    const merged = await (await rpc(server.url, call("update_from_base", { repo: "repo" }))).json();
    assertEquals(merged.result.isError, undefined);
    assertStringIncludes(merged.result.content[0].text, "Merged `main` (1111111111)");
    assertStringIncludes(merged.result.content[0].text, "as 2222222222");
    assertStringIncludes(merged.result.content[0].text, "submit_patch");
    assertEquals(updates, [{ path: "repo" }]);

    answer = { kind: "moved", path: "repo", target: "main", tip: "3333333333cccc" };
    assertStringIncludes(
      await text(await rpc(server.url, call("update_from_base"))),
      "held nothing that `main` does not, so it now simply starts at its tip (3333333333)",
    );
    assertEquals(updates.at(-1), { path: undefined });

    answer = { kind: "up-to-date", path: "repo", target: "main", tip: "4444444444dddd" };
    assertStringIncludes(
      await text(await rpc(server.url, call("update_from_base"))),
      "nothing to merge",
    );

    // A conflict is an error the agent acts on: which files, and that submit_patch concludes it.
    answer = { kind: "conflict", path: "repo", target: "main", files: ["a.ts", "b.ts"] };
    const conflict = await (await rpc(server.url, call("update_from_base"))).json();
    assertEquals(conflict.result.isError, true);
    assertStringIncludes(conflict.result.content[0].text, "conflicted in: a.ts, b.ts");
    assertStringIncludes(conflict.result.content[0].text, "call submit_patch");

    answer = { kind: "refused", reason: "repo has uncommitted changes" };
    const refused = await (await rpc(server.url, call("update_from_base"))).json();
    assertEquals(refused.result.isError, true);
    assertEquals(refused.result.content[0].text, "repo has uncommitted changes");
  } finally {
    await server.shutdown();
  }
});

test("loopback: local submissions describe delivery, never promise merge notifications", async () => {
  let answer: SubmitPatchOutcome = {
    kind: "submitted",
    patchId: "p-local",
    state: "queued",
    path: "local-repo",
    branch: "ryph/ada/r-1/work",
    headSha: "0123456789abcdef",
    generation: 1,
    url: "https://ryph.example/patches/p-local",
  };
  const { actions } = fakeActions(() => answer);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
    repos: [
      { path: "github-repo", provider: "github" },
      { path: "local-repo", provider: "local" },
      { path: "legacy-repo" },
    ],
  });
  try {
    for (const state of ["queued", "pending_approval", "unreported", "future-state"]) {
      answer = { ...answer, state };
      // No repo argument: use the repository the action actually submitted, not the first
      // repository in this mixed run or a guess from the arguments.
      const said = await text(await rpc(server.url, call("submit_patch")));
      assertStringIncludes(said, "Merges in this local repository are not reported to Ryph");
      assertStringIncludes(said, "do not wait for a merged or closed message");
      assertStringIncludes(said, "More work on the branch is simply delivered again");
      assert(!said.includes("reaches you as messages"), said);
      assert(!said.includes("rebased"), said);
      assert(!said.includes("its URL"), said);
      if (state === "queued") {
        assertStringIncludes(said, "wait for the delivery message");
        assertStringIncludes(said, "git hook files is held for a person's approval");
      } else if (state === "pending_approval") {
        assertStringIncludes(said, "https://ryph.example/patches/p-local");
        assertStringIncludes(said, "give them this link to approve it");
        assertStringIncludes(said, "The branch has not been delivered");
      } else if (state === "unreported") {
        assertStringIncludes(said, "The platform was not told");
      }
    }
    for (const path of ["github-repo", "legacy-repo", "unknown-repo"]) {
      answer = { ...answer, state: "queued", path };
      const said = await text(await rpc(server.url, call("submit_patch")));
      assertStringIncludes(said, "Whether it is later merged or closed reaches you as messages");
      assert(!said.includes("Merges in this local repository"), said);
      assertStringIncludes(
        said,
        path === "github-repo" ? "the pull request now" : "the change request now",
      );
    }
  } finally {
    await server.shutdown();
  }
});

test("loopback: the tools reach the actions, and every submit outcome is rendered", async () => {
  let answer: SubmitPatchOutcome = {
    kind: "submitted",
    patchId: "p-2",
    state: "pending_approval",
    path: "repo",
    branch: "ryph/ada/r-1/work-2",
    headSha: "0123456789abcdef",
    generation: 2,
    url: "https://ryph.example/patches/p-2",
  };
  const { actions, finished, reports, submits, owed } = fakeActions(() => answer);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
    // On GitLab: its change requests are merge requests, and nothing names GitHub's.
    repos: [{ path: "repo", provider: "gitlab" }],
  });
  try {
    const tools =
      (await (await rpc(server.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as {
        result: { tools: Array<{ name: string; description: string }> };
      };
    const describe = (name: string) => tools.result.tools.find((t) => t.name === name)!.description;
    assertStringIncludes(describe("submit_patch"), "patch — a merge request on GitLab — while");
    assertStringIncludes(
      describe("checkout_change_request"),
      "change request — a merge request on GitLab — so",
    );
    assert(
      !tools.result.tools.some((t) => t.description.includes("on GitHub")),
      "names GitHub",
    );
    assertStringIncludes(
      await text(await rpc(server.url, call("finish", { outcome: "success", summary: "done" }))),
      "the run ends after this turn",
    );
    // still owed a check verdict: the finish says the run waits for it
    owed.count = 2;
    const held = await text(await rpc(server.url, call("finish", { outcome: "success" })));
    assertStringIncludes(held, "Checks are still running for your work.");
    assertStringIncludes(held, "hands them to you as the next message");
    // not knowing: it says so, and what happens either way
    owed.count = null;
    const unsure = await text(await rpc(server.url, call("finish", { outcome: "success" })));
    assertStringIncludes(unsure, "could not say whether checks are still running");
    assertStringIncludes(unsure, "If not, it ends after this turn.");
    // once a hold gave up on them, the finish says the run no longer waits
    owed.waits = false;
    owed.count = 2;
    const unheld = await text(await rpc(server.url, call("finish", { outcome: "success" })));
    assertStringIncludes(unheld, "stopped waiting for them");
    assertStringIncludes(unheld, "ends after this turn without their results");
    assert(!unheld.includes("hands them to you"), unheld);
    owed.count = null;
    const unsureUnheld = await text(await rpc(server.url, call("finish", { outcome: "success" })));
    assertStringIncludes(unsureUnheld, "could not say whether checks are still running");
    assertStringIncludes(unsureUnheld, "ends after this turn either way");
    owed.waits = true;
    owed.count = 0;
    finished.splice(1);
    assertEquals(finished, [{ outcome: "success", summary: "done" }]);
    // the agent's say on the status comment crosses with the summary and the outcome
    await rpc(
      server.url,
      call("finish", { outcome: "failed", summary: "could not", comment: "minimal" }),
    );
    assertEquals(finished.at(-1), {
      outcome: "failed",
      summary: "could not",
      statusComment: "minimal",
    });

    const listed = await text(await rpc(server.url, call("patches")));
    assertStringIncludes(
      listed,
      "p-1 · repo · ryph/ada/r-1/work · generation 1 · abcdef1234 · submitted · https://gh/x/pull/7\n",
    );
    // A patch waiting on a person lists the page they approve it on; an opened one does not.
    assertStringIncludes(
      listed,
      "p-3 · repo · ryph/ada/r-1/work-2 · generation 2 · fedcba9876 · pending_approval · " +
        "https://ryph.example/patches/p-3",
    );

    const submitted = await text(
      await rpc(
        server.url,
        call("submit_patch", { repo: "repo", title: "Fix", description: "why" }),
      ),
    );
    assertStringIncludes(
      submitted,
      "Submitted patch p-2 for repo at 0123456789 as `ryph/ada/r-1/work-2` (generation 2)",
    );
    assertStringIncludes(submitted, "pending_approval");
    // Submitting is not opening: the answer says what the state means, so the agent does not
    // announce a pull request that does not exist yet.
    assertStringIncludes(submitted, "No merge request exists yet");
    assertStringIncludes(submitted, "approve the patch in Ryph first");
    // ...and hands the agent the page a person approves it on, to pass on.
    assertStringIncludes(submitted, "https://ryph.example/patches/p-2");
    assertStringIncludes(submitted, "give them this link");
    // A missed or released note is no free pass: the next submit needs the rebase first.
    assertStringIncludes(
      submitted,
      "After a merge, a missed or a release, that next submit needs the branch rebased onto what " +
        "merged first",
    );
    assertEquals(submits, [{ path: "repo", title: "Fix", description: "why" }]);
    // A branch named is the branch submitted; none named is the one the checkout is on.
    await rpc(server.url, call("submit_patch", { repo: "repo", branch: "fix-login" }));
    assertEquals((submits[1] as { branch?: string }).branch, "fix-login");
    submits.splice(1);
    // nothing owed: no word about checks
    assert(!submitted.includes("may not have reported"));
    assert(!submitted.includes("could not say whether checks"));
    // a verdict still owed: submitting is allowed, and the answer says the checks may not have
    // reported, so the agent does not tell anyone they passed
    owed.count = 1;
    const early = await text(await rpc(server.url, call("submit_patch")));
    assertStringIncludes(early, "Submitted patch p-2");
    assertStringIncludes(early, "may not have reported yet");
    assertStringIncludes(early, "do not say anywhere that the checks pass");
    // not knowing: it says so, and still warns off the claim
    owed.count = null;
    const unsureSubmit = await text(await rpc(server.url, call("submit_patch")));
    assertStringIncludes(unsureSubmit, "could not say whether checks of this run's work");
    assertStringIncludes(unsureSubmit, "do not say anywhere that the checks pass");

    // A first submission opens a request; a later submission names the existing one
    // without describing the update's confirmation as a new opening.
    answer = { ...answer, state: "queued" };
    const opening = await text(await rpc(server.url, call("submit_patch")));
    assertStringIncludes(opening, "platform is opening the merge request now");
    assertStringIncludes(opening, "wait for that before announcing it");
    answer = { ...answer, forgeUrl: "https://gitlab.example/team/repo/-/merge_requests/7" };
    const updating = await text(await rpc(server.url, call("submit_patch")));
    assertStringIncludes(updating, "updates the existing merge request");
    assertStringIncludes(updating, "https://gitlab.example/team/repo/-/merge_requests/7");
    assertStringIncludes(updating, "a message confirms when this submission reaches the forge");
    assertStringIncludes(updating, "not yet confirmed applied");
    assertStringIncludes(updating, "do not say anywhere that the checks pass");
    assert(!updating.includes("platform is opening"));
    assert(!updating.includes("does not exist until"));
    answer = { ...answer, state: "pending_approval" };
    const heldUpdate = await text(await rpc(server.url, call("submit_patch")));
    assertStringIncludes(heldUpdate, "update requires a person's approval");
    assertStringIncludes(heldUpdate, "https://ryph.example/patches/p-2");
    assert(!heldUpdate.includes("No merge request exists"));
    assert(!heldUpdate.includes("update is queued"));
    answer = { ...answer, state: "submitted" };
    const appliedUpdate = await text(await rpc(server.url, call("submit_patch")));
    assertStringIncludes(appliedUpdate, "This submission has reached the forge");
    assert(!appliedUpdate.includes("not yet confirmed"));
    answer = { ...answer, state: "queued", forgeRef: "7", forgeUrl: null };
    const unlinkedUpdate = await text(await rpc(server.url, call("submit_patch")));
    assertStringIncludes(unlinkedUpdate, "updates the existing merge request: 7");
    assert(!unlinkedUpdate.includes("platform is opening"));
    for (const state of ["held", "failed"]) {
      answer = { ...answer, state };
      const stalled = await text(await rpc(server.url, call("submit_patch")));
      assertStringIncludes(stalled, `update's state is ${state}`);
      assert(!stalled.includes("update is queued"));
    }
    // A new generation without a request still uses the opening guidance.
    answer = { ...answer, state: "queued", generation: 3, forgeUrl: null, forgeRef: null };
    const nextGeneration = await text(await rpc(server.url, call("submit_patch")));
    assertStringIncludes(nextGeneration, "platform is opening the merge request now");

    // only a submit that shipped asks what is owed: a refusal has nothing to warn about
    owed.count = 1;
    const asked = owed.asked;
    answer = { kind: "nothing-to-submit", path: "repo" };
    const nothing = await rpc(server.url, call("submit_patch"));
    const nothingBody = await nothing.json();
    assertEquals(nothingBody.result.isError, true);
    assertStringIncludes(nothingBody.result.content[0].text, "nothing to submit");
    // a commit sent alongside the call may not have landed yet: the refusal says to call again
    assertStringIncludes(nothingBody.result.content[0].text, "sent in the same turn");
    assert(!nothingBody.result.content[0].text.includes("checks pass"));
    assertEquals(owed.asked, asked);
    owed.count = 0;
    // an absent repo is an absent path, not the string "undefined"
    assertEquals(submits.at(-1), { path: undefined, title: undefined, description: undefined });

    // A merge update_from_base left is still conflicted: resolve and stage, no rebase command.
    answer = { kind: "conflict", step: "merge", path: "repo", files: ["src/a.ts"] };
    const merging = await text(await rpc(server.url, call("submit_patch")));
    assertStringIncludes(merging, "merge in progress with conflicts in: src/a.ts");
    assert(!merging.includes("rebase"));

    answer = { kind: "refused", reason: "the run is finalizing" };
    const refused = await rpc(server.url, call("submit_patch"));
    const refusedBody = await refused.json();
    assertEquals(refusedBody.result.isError, true);
    assertEquals(refusedBody.result.content[0].text, "the run is finalizing");

    // an unknown tool is -32601, like the gateway's allowlist
    const unknown = await rpc(server.url, call("delete_everything"));
    assertEquals((await unknown.json()).error.code, -32601);
    // a mistyped argument is the tool's own error, never a crash
    const badArg = await rpc(server.url, call("finish", { outcome: "success", summary: 42 }));
    assertEquals((await badArg.json()).error.code, -32603);
    const badComment = await rpc(
      server.url,
      call("finish", { outcome: "success", comment: "loud" }),
    );
    assertEquals((await badComment.json()).error.code, -32603);
    // the outcome is required, and only the three values: a call that does not say how it
    // went is refused in words the model reads, and nothing is recorded or ended
    for (const tool of ["finish", "report_outcome"]) {
      for (const bad of [{ summary: "done" }, { outcome: "partial" }, { outcome: 1 }]) {
        const res = (await (await rpc(server.url, call(tool, bad))).json()).result;
        assertEquals(res.isError, true);
        assertStringIncludes(res.content[0].text, "Nothing was recorded");
        assertStringIncludes(res.content[0].text, `ryph__${tool} again`);
      }
    }

    // report_outcome records without ending: its own action, and an answer that says the run
    // stays open
    const reportedText = await text(
      await rpc(server.url, call("report_outcome", { outcome: "no-changes", comment: "minimal" })),
    );
    assertStringIncludes(reportedText, "The run stays open");
    assertEquals(reports, [{ outcome: "no-changes", statusComment: "minimal" }]);
    assert(finished.length === 2);
    assert(reports.length === 1);
    await rpc(server.url, call("report_outcome", { outcome: "success", awaitingUserTurn: true }));
    assertEquals(reports.at(-1), { outcome: "success", awaitingUserTurn: true });
    await rpc(server.url, call("report_outcome", { outcome: "success", awaitingUserTurn: false }));
    assertEquals(reports.at(-1), { outcome: "success", awaitingUserTurn: false });
    const invalidInput = await rpc(
      server.url,
      call("report_outcome", { outcome: "success", awaitingUserTurn: "true" }),
    );
    assertEquals((await invalidInput.json()).error.code, -32603);
    assertEquals(reports.length, 3);
  } finally {
    await server.shutdown();
  }
});

test("loopback: report_outcome takes in-progress and keeps the run open; finish refuses it and records nothing", async () => {
  const { actions, finished, reports } = fakeActions(unusedSubmit);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    // The schemas say it where the tool is chosen: report_outcome takes the work still going
    // on, finish only a final word.
    const list = await rpc(server.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (await list.json()).result.tools as Array<{
      name: string;
      inputSchema: {
        properties: {
          outcome: { enum: string[]; description: string };
          awaitingUserTurn?: { type: string; description: string; default: boolean };
          summary: { type: string; description: string };
        };
        required: string[];
      };
    }>;
    const schema = (name: string) => tools.find((t) => t.name === name)!.inputSchema;
    assertEquals(schema("report_outcome").properties.outcome.enum, [
      "in-progress",
      "success",
      "no-changes",
      "failed",
    ]);
    assertEquals(schema("report_outcome").required, ["outcome"]);
    const summary = schema("report_outcome").properties.summary;
    assertEquals(summary.type, "string");
    assertStringIncludes(summary.description, "Optional: omit it");
    assertStringIncludes(
      summary.description,
      "except when moving from in-progress to a final outcome",
    );
    assertStringIncludes(summary.description, "full replacement, not an incremental update");
    const handoff = schema("report_outcome").properties.awaitingUserTurn!;
    assertEquals(handoff.type, "boolean");
    assertEquals(handoff.default, false);
    assertStringIncludes(handoff.description, "ordinary conversational handoff, optional feedback");
    assertStringIncludes(
      handoff.description,
      "Leave false when waiting on checks, builds, subagents",
    );
    assertStringIncludes(handoff.description, "Your turn");
    assertEquals(schema("finish").properties.awaitingUserTurn, undefined);
    assertEquals(schema("finish").properties.outcome.enum, ["success", "no-changes", "failed"]);
    assertStringIncludes(schema("report_outcome").properties.outcome.description, "in-progress:");
    assertStringIncludes(
      schema("finish").properties.outcome.description,
      "report it with ryph__report_outcome instead",
    );

    // in-progress is recorded as reported, and the answer says the run stays open and what an
    // idle end would make of it.
    const res = (await (await rpc(
      server.url,
      call("report_outcome", { outcome: "in-progress", summary: "checks running" }),
    )).json()).result;
    assert(res.isError !== true, res.content[0].text);
    assertStringIncludes(res.content[0].text, "Noted: in-progress. The run stays open.");
    assertStringIncludes(res.content[0].text, "it ends unfinished");
    assertEquals(reports, [{ outcome: "in-progress", summary: "checks running" }]);
    // ...with or without handing the conversation back to the person.
    await rpc(
      server.url,
      call("report_outcome", { outcome: "in-progress", awaitingUserTurn: true }),
    );
    assertEquals(reports.at(-1), { outcome: "in-progress", awaitingUserTurn: true });
    await rpc(
      server.url,
      call("report_outcome", { outcome: "in-progress", awaitingUserTurn: false }),
    );
    assertEquals(reports.at(-1), { outcome: "in-progress", awaitingUserTurn: false });
    assertEquals(finished, []);

    // finish with in-progress is refused as a tool error: nothing recorded, nothing ended, and
    // the answer says where it goes instead.
    const before = reports.length;
    const refused = (await (await rpc(
      server.url,
      call("finish", { outcome: "in-progress", summary: "still going" }),
    )).json()).result;
    assertEquals(refused.isError, true);
    assertStringIncludes(refused.content[0].text, "Nothing was recorded and the run goes on");
    assertStringIncludes(refused.content[0].text, "ryph__report_outcome");
    assertEquals(finished, []);
    assertEquals(reports.length, before);

    // The final words still work, on both tools, and a terminal report says so.
    const terminal = await text(
      await rpc(server.url, call("report_outcome", { outcome: "success", summary: "done" })),
    );
    assertStringIncludes(terminal, "Noted: success. The run stays open");
    assert(!terminal.includes("unfinished"), terminal);
    assertEquals(reports.at(-1), { outcome: "success", summary: "done" });
    for (const outcome of ["success", "no-changes", "failed"] as const) {
      const done = (await (await rpc(server.url, call("finish", { outcome }))).json()).result;
      assert(done.isError !== true, done.content[0].text);
      assertEquals(finished.at(-1), { outcome });
    }
    assertEquals(finished.length, 3);
  } finally {
    await server.shutdown();
  }
});

test("loopback: a report after the agent's own finish is refused in words, as a tool error", async () => {
  const { actions } = fakeActions(unusedSubmit);
  const asked: unknown[] = [];
  const finishedRun: RunActions = {
    ...actions,
    reportOutcome: (args) => {
      asked.push(args);
      return "finished";
    },
  };
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => finishedRun,
    diag: noopDiagnostics(),
  });
  try {
    for (const outcome of ["in-progress", "success"]) {
      const res = (await (await rpc(
        server.url,
        call("report_outcome", { outcome, summary: "later" }),
      )).json()).result;
      assertEquals(res.isError, true);
      assertStringIncludes(
        res.content[0].text,
        "Nothing was recorded: you already called ryph__finish",
      );
      assertStringIncludes(res.content[0].text, "Call ryph__finish again to change its outcome");
      // Never the answer of a report that kept the run open.
      assert(!res.content[0].text.includes("stays open"), res.content[0].text);
    }
    assertEquals(asked.length, 2);
    // A run that is finalizing is still told so, not that it finished.
    const finalizing: RunActions = { ...actions, reportOutcome: () => false };
    const late = await startLoopbackMcp({
      token: TOKEN,
      actions: () => finalizing,
      diag: noopDiagnostics(),
    });
    try {
      const res = (await (await rpc(late.url, call("report_outcome", { outcome: "success" })))
        .json()).result;
      assertEquals(res.isError, true);
      assertEquals(res.content[0].text, "the run is finalizing");
    } finally {
      await late.shutdown();
    }
  } finally {
    await server.shutdown();
  }
});

// The wake-up through the real conversation, so the bounds and the replacing are the core's own
// and the tool only renders them. A minute is stretched far past the test so nothing fires.
test("loopback: wake_me is bounded, replaces a pending wake-up, and tells the agent to stop", async () => {
  const cancel = new AbortController();
  const conversation = startConversation({
    inbox: {
      poll: (_after, { signal }) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve([]))),
    },
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
    diag: noopDiagnostics(),
    onTranscript: () => {},
    onIdleDeadline: () => {},
    onPatchCue: () => Promise.resolve(true),
    signal: cancel.signal,
  });
  const woken: unknown[] = [];
  const { actions } = fakeActions(unusedSubmit, undefined, undefined, (args) => {
    woken.push(args);
    return conversation.wake(args.afterMinutes, args.note);
  });
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  const answer = async (args: Record<string, unknown>) => {
    const body = await (await rpc(server.url, call("wake_me", args))).json();
    return {
      text: body.result.content[0].text as string,
      isError: body.result.isError === true,
    };
  };
  try {
    for (const afterMinutes of [0, 61, 2.5, -1]) {
      const refused = await answer({ afterMinutes });
      assert(refused.isError, `${afterMinutes} is refused`);
      assertStringIncludes(refused.text, "from 1 to 60");
    }
    // A string is not a number the conversation could bound: the same refusal, not a crash.
    const stringy = await answer({ afterMinutes: "10" });
    assert(stringy.isError);
    assertStringIncludes(stringy.text, "from 1 to 60");
    assertEquals(woken.length, 4, "a non-number never reaches the actions");

    const set = await answer({ afterMinutes: 10, note: "check the error rate" });
    assert(!set.isError, set.text);
    assert(
      /^Wake-up set for \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC, in 10 minutes\./.test(set.text),
      set.text,
    );
    assertStringIncludes(set.text, "Stop working now and let the run wait");
    assertStringIncludes(set.text, "Calling again replaces this wake-up.");
    assert(!set.text.includes("It replaces"), "nothing was pending to replace");
    assertEquals(woken.at(-1), { afterMinutes: 10, note: "check the error rate" });

    const again = await answer({ afterMinutes: 1 });
    assertStringIncludes(again.text, "in 1 minute.");
    assertStringIncludes(again.text, "It replaces the wake-up that was set for");
  } finally {
    conversation.stop();
    cancel.abort();
    await server.shutdown();
  }
});

test("loopback: a wake-up the run refuses says so as a tool error", async () => {
  const { actions } = fakeActions(unusedSubmit, undefined, undefined, () => ({
    kind: "refused",
    reason: "the run is finalizing",
  }));
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    const body = await (await rpc(server.url, call("wake_me", { afterMinutes: 5 }))).json();
    assertEquals(body.result.isError, true);
    assertEquals(body.result.content[0].text, "the run is finalizing");
  } finally {
    await server.shutdown();
  }
});

test("loopback: a summary or description showing an image the run does not have is refused first", async () => {
  const { actions, finished, reports, submits, checked } = fakeActions(
    () => ({ kind: "submitted", patchId: "p-1", state: "queued" } as never),
  );
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    const bad = "![after](img-000000000bad)";
    for (const name of ["finish", "report_outcome"]) {
      const body = await (await rpc(server.url, call(name, { outcome: "success", summary: bad })))
        .json();
      assertEquals(body.result.isError, true, name);
      assertEquals(body.result.content[0].text, "Nothing was recorded: No image has that ref.");
    }
    assertEquals([finished.length, reports.length], [0, 0]);
    const refused = await (await rpc(server.url, call("submit_patch", { description: bad })))
      .json();
    assertEquals(refused.result.isError, true);
    assertEquals(refused.result.content[0].text, "Nothing was submitted: No image has that ref.");
    assertEquals(submits.length, 0);

    // A good one goes on, checked as written.
    const good = "![after](img-0123456789ab)";
    await rpc(server.url, call("finish", { outcome: "success", summary: good }));
    assertEquals(finished.map((f) => f.summary), [good]);
    assertEquals(checked.at(-1), good);
  } finally {
    await server.shutdown();
  }
});

const bgJob = (over: Partial<BackgroundJobView> = {}): BackgroundJobView => ({
  id: "bg-1",
  label: "unit tests",
  command: "deno task test",
  cwd: "/work",
  service: false,
  logPath: "/tmp/ryph-background-x/bg-1.log",
  startedAt: "2026-10-06T10:00:00.000Z",
  timeoutAt: "2026-10-06T10:30:00.000Z",
  ended: null,
  durationMs: 62_000,
  ...over,
});

test("loopback: the background tools say when to use them, and that finishing stops them", () => {
  const byName = new Map(loopbackTools({ checks: false }).map((t) => [t.name as string, t]));
  const run = byName.get("background_run")!.description as string;
  assertStringIncludes(run, "instead of running it with your bash tool and waiting");
  assertStringIncludes(run, "`&`, `nohup`");
  assertStringIncludes(run, "Never poll it in a loop.");
  assertStringIncludes(run, "a service");
  assertStringIncludes(
    byName.get("finish")!.description as string,
    "Background commands and subagents still",
  );
});

test("loopback: background_run options can be omitted or null in model transports", () => {
  const tool = loopbackTools({ checks: false }).find((t) => t.name === "background_run")!;
  const schema = tool.inputSchema as {
    required: string[];
    properties: Record<string, { type: string | string[]; description: string }>;
  };
  assertEquals(schema.required, ["command", "label"]);
  for (
    const [name, type] of Object.entries({
      cwd: "string",
      timeoutMinutes: "integer",
      readyWhen: "string",
      service: "boolean",
    })
  ) {
    assertEquals(schema.properties[name]!.type, [type, "null"]);
    assertStringIncludes(schema.properties[name]!.description, "null");
  }
});

test("loopback: background_run reaches the actions with what was given, and both outcomes are rendered", async () => {
  const fake = fakeActions(unusedSubmit);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => fake.actions,
    diag: noopDiagnostics(),
  });
  const answer = async (args: Record<string, unknown>) => {
    const body = await (await rpc(server.url, call("background_run", args))).json();
    return {
      text: body.result.content[0].text as string,
      isError: body.result.isError === true,
    };
  };
  try {
    fake.background.run = () => ({ kind: "started", job: bgJob() });
    const started = await answer({
      command: "deno task test",
      label: "unit tests",
      cwd: "repo",
      timeoutMinutes: 30,
    });
    assertEquals(started.isError, false);
    assertEquals(fake.background.calls.at(-1), ["run", {
      command: "deno task test",
      label: "unit tests",
      cwd: "repo",
      timeoutMinutes: 30,
    }]);
    assertStringIncludes(started.text, 'Started bg-1 ("unit tests") in /work');
    assertStringIncludes(started.text, "timeout of 30 minutes");
    assertStringIncludes(started.text, "/tmp/ryph-background-x/bg-1.log");
    assertStringIncludes(started.text, "end your turn without calling ryph__finish");
    assertStringIncludes(started.text, "2026-10-06 10:30 UTC");
    assertStringIncludes(started.text, "Do not poll it");

    // Strict transports may require every property: null must behave just like omission,
    // and explicit service:false must still start an ordinary one-shot command.
    for (
      const options of [
        {},
        { service: false },
        { cwd: null, timeoutMinutes: null, service: false, readyWhen: null },
        { cwd: null, timeoutMinutes: null, service: null, readyWhen: null },
      ]
    ) {
      const oneShot = await answer({ command: "printf done", label: "one-shot", ...options });
      assertEquals(oneShot.isError, false);
      assertEquals(fake.background.calls.at(-1), ["run", {
        command: "printf done",
        label: "one-shot",
      }]);
      assertEquals(oneShot.text.includes("one-time readiness message"), false);
      assertEquals(oneShot.text.includes("if it ends before the run does"), false);
    }

    fake.background.run = () => ({ kind: "started", job: bgJob({ service: true }) });
    const service = await answer({ command: "npm run dev", label: "dev", service: true });
    assertStringIncludes(service.text, "if it ends before the run does");

    fake.background.run = () => ({ kind: "started", job: bgJob({ service: true, readyAt: null }) });
    const ready = await answer({
      command: "npm run dev",
      label: "dev",
      service: true,
      readyWhen: "READY",
    });
    assertEquals(fake.background.calls.at(-1), ["run", {
      command: "npm run dev",
      label: "dev",
      service: true,
      readyWhen: "READY",
    }]);
    assertStringIncludes(ready.text, "one-time readiness message");

    fake.background.run = () => ({ kind: "refused", reason: "This run cannot run commands." });
    const refused = await answer({ command: "x", label: "y" });
    assertEquals(refused, { text: "This run cannot run commands.", isError: true });

    // Wrong types are answered in words, and reach nothing.
    const calls = fake.background.calls.length;
    for (
      const bad of [
        { label: "y" },
        { command: "x", label: 3 },
        { command: "x", label: "y", cwd: 1 },
        { command: "x", label: "y", timeoutMinutes: "10" },
        { command: "x", label: "y", service: "yes" },
        { command: "x", label: "y", service: true, readyWhen: 42 },
      ]
    ) {
      assertEquals((await answer(bad)).isError, true, JSON.stringify(bad));
    }
    assertEquals(fake.background.calls.length, calls);
  } finally {
    await server.shutdown();
  }
});

test("loopback: background_output renders a job, the list, and refusals; background_stop the end", async () => {
  const fake = fakeActions(unusedSubmit);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => fake.actions,
    diag: noopDiagnostics(),
  });
  const answer = async (name: string, args: Record<string, unknown>) => {
    const body = await (await rpc(server.url, call(name, args))).json();
    return {
      text: body.result.content[0].text as string,
      isError: body.result.isError === true,
    };
  };
  try {
    fake.background.output = () => ({ kind: "job", job: bgJob(), tail: "ok 1\nok 2", lines: 2 });
    const job = await answer("background_output", { id: "bg-1", tailLines: 2 });
    assertEquals(fake.background.calls.at(-1), ["output", { id: "bg-1", tailLines: 2 }]);
    assertStringIncludes(job.text, 'bg-1 ("unit tests") running for 1m 2s.');
    assertStringIncludes(job.text, "$ deno task test");
    assertStringIncludes(job.text, "Its last 2 lines:\n\nok 1\nok 2");

    fake.background.output = () => ({ kind: "list", jobs: [] });
    assertEquals(
      (await answer("background_output", {})).text,
      "No background commands have been started in this run.",
    );
    fake.background.output = () => ({
      kind: "list",
      jobs: [
        bgJob({
          ended: { at: "2026-10-06T10:04:12.000Z", reason: "exited", exitCode: 1, signal: null },
          durationMs: 252_000,
        }),
        bgJob({ id: "bg-2", label: "dev", service: true }),
        bgJob({
          id: "bg-3",
          ended: { at: "x", reason: "exited", exitCode: null, signal: "SIGSEGV" },
          durationMs: 5_000,
        }),
        bgJob({
          id: "bg-4",
          ended: { at: "x", reason: "timeout", exitCode: null, signal: "SIGTERM" },
          durationMs: 1_800_000,
        }),
      ],
    });
    assertEquals(
      (await answer("background_output", {})).text,
      [
        'bg-1 ("unit tests") · exited with code 1 after 4m 12s',
        'bg-2 ("dev") · service · running for 1m 2s',
        'bg-3 ("unit tests") · was killed by SIGSEGV after 5s',
        'bg-4 ("unit tests") · timed out and was stopped after 30m 0s',
      ].join("\n"),
    );
    assertEquals((await answer("background_output", { id: 7 })).isError, true);

    fake.background.stop = () => ({
      kind: "stopped",
      job: bgJob({
        ended: { at: "x", reason: "stopped", exitCode: null, signal: "SIGTERM" },
        durationMs: 3_000,
      }),
      already: false,
    });
    assertEquals(
      (await answer("background_stop", { id: "bg-1" })).text,
      'bg-1 ("unit tests") was stopped after 3s.',
    );
    fake.background.stop = () => ({
      kind: "stopped",
      job: bgJob({
        ended: { at: "x", reason: "exited", exitCode: 0, signal: null },
        durationMs: 3_000,
      }),
      already: true,
    });
    assertEquals(
      (await answer("background_stop", { id: "bg-1" })).text,
      'bg-1 ("unit tests") had already ended: it exited with code 0 after 3s.',
    );
    assertEquals((await answer("background_stop", {})).isError, true);
  } finally {
    await server.shutdown();
  }
});

const saView = (over: Partial<SubagentView> = {}): SubagentView => ({
  id: "sa-1",
  label: "find the retry logic",
  mode: "explore",
  stretches: 1,
  startedAt: "2026-10-12T10:00:00.000Z",
  ended: null,
  timeoutMinutes: 15,
  durationMs: 62_000,
  ...over,
});

test("loopback: the subagent tools say what a subagent is for, sees and shares, and how it ends", () => {
  const byName = new Map(loopbackTools({ checks: false }).map((t) => [t.name as string, t]));
  const start = byName.get("subagent_start")!;
  const described = start.description as string;
  assertStringIncludes(described, "sees only the task you give it");
  assertStringIncludes(described, "it sees nothing of this conversation");
  assertStringIncludes(described, "shares the checkout with you and with every other subagent");
  assertStringIncludes(described, "none of the ryph__ tools");
  assertStringIncludes(described, "At most 4 run at once, and 16 in a run.");
  assertEquals((start.inputSchema as { required: string[] }).required, ["task", "label", "mode"]);
  // Waiting is ending the turn, and the agent stays reachable meanwhile.
  assertStringIncludes(described, "To wait for it, end your turn without calling ryph__finish");
  assertStringIncludes(described, "each subagent's answer arrives as a message");
  assertStringIncludes(described, "people's messages still reach you meanwhile");
  assert(!byName.has("subagent_wait"));
  assertStringIncludes(byName.get("subagent_message")!.description as string, "it is continued");
  assertStringIncludes(byName.get("subagent_stop")!.description as string, "everything it started");
});

test("loopback: subagent_start's answer opens with the bare id; the other two reach the actions", async () => {
  const fake = fakeActions(unusedSubmit);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => fake.actions,
    diag: noopDiagnostics(),
  });
  const answer = async (name: string, args: Record<string, unknown>) => {
    const body = await (await rpc(server.url, call(name, args))).json();
    return {
      text: body.result.content[0].text as string,
      isError: body.result.isError === true,
      structured: body.result.structuredContent as unknown,
    };
  };
  try {
    fake.subagents.start = () => ({ kind: "started", subagent: saView() });
    const started = await answer("subagent_start", {
      task: "where is the retry logic?",
      label: "find the retry logic",
      mode: "explore",
    });
    assertEquals(started.isError, false);
    // The run page links the call to its lane by this line.
    assertEquals(started.text.split("\n")[0], "sa-1");
    assertEquals(started.structured, { id: "sa-1" });
    assertStringIncludes(started.text, "in explore mode, with a timeout of 15 minutes");
    assertEquals(fake.subagents.calls.at(-1), ["start", {
      task: "where is the retry logic?",
      label: "find the retry logic",
      mode: "explore",
    }]);
    // A bad mode never reaches the actions.
    const calls = fake.subagents.calls.length;
    assertEquals(
      (await answer("subagent_start", { task: "t", label: "l", mode: "x" })).isError,
      true,
    );
    assertEquals(fake.subagents.calls.length, calls);
    fake.subagents.start = () => ({ kind: "refused", reason: "4 subagents are already running" });
    const full = await answer("subagent_start", { task: "t", label: "l", mode: "work" });
    assertEquals(full.isError, true);
    assertEquals(full.text, "4 subagents are already running");

    fake.subagents.message = () => ({ kind: "steered", subagent: saView() });
    const steered = await answer("subagent_message", { id: "sa-1", text: "look in utils" });
    assertEquals(fake.subagents.calls.at(-1), ["message", { id: "sa-1", text: "look in utils" }]);
    assertStringIncludes(steered.text, "it reads it after its current tool call");
    fake.subagents.message = () => ({ kind: "continued", subagent: saView({ stretches: 2 }) });
    const continued = await answer("subagent_message", { id: "sa-1", text: "and tests" });
    assertStringIncludes(continued.text, "had ended, so it is continued");

    fake.subagents.stop = () => ({
      kind: "stopped",
      already: false,
      answer: null,
      subagent: saView({
        ended: { at: "2026-10-12T10:01:02.000Z", reason: "stopped", tool: "bash", error: null },
      }),
    });
    const stopped = await answer("subagent_stop", { id: "sa-1" });
    assertEquals(
      stopped.text,
      'sa-1 ("find the retry logic") was stopped while running `bash` after 1m 2s.',
    );
    // One that answered as the stop came: the stop's answer carries it, since no message will.
    fake.subagents.stop = () => ({
      kind: "stopped",
      already: true,
      answer: { text: "retry.ts:12", chars: 11, truncated: false },
      subagent: saView({
        ended: { at: "2026-10-12T10:01:02.000Z", reason: "answered", tool: null, error: null },
      }),
    });
    const late = await answer("subagent_stop", { id: "sa-1" });
    assertEquals(
      late.text,
      'sa-1 ("find the retry logic") had already ended: it answered after 1m 2s. Its answer:\n\n' +
        "retry.ts:12",
    );
  } finally {
    await server.shutdown();
  }
});

test("loopback: a finish says how many running subagents it stopped", async () => {
  const fake = fakeActions(unusedSubmit);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => fake.actions,
    diag: noopDiagnostics(),
  });
  try {
    fake.subagents.running = 2;
    const body = await (await rpc(server.url, call("finish", { outcome: "success" }))).json();
    assertEquals(
      body.result.content[0].text,
      "Noted: the run ends after this turn, shipping what is still unshipped on its own " +
        "branch and on the branches you submitted. It stopped 2 running subagents; no answer " +
        "comes from them.",
    );
  } finally {
    await server.shutdown();
  }
});

test("loopback: a finish names the branches that were never submitted, while they still can be", async () => {
  const fake = fakeActions(unusedSubmit);
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => fake.actions,
    diag: noopDiagnostics(),
  });
  try {
    fake.unsubmitted.branches = [{ path: "app", list: "`at-finish` (1 commit)" }];
    const body = await (await rpc(server.url, call("finish", { outcome: "success" }))).json();
    const said = body.result.content[0].text as string;
    assertStringIncludes(
      said,
      "Not shipped when the run ends, because never submitted: in `app`, `at-finish` (1 commit).",
    );
    assertStringIncludes(said, "submit it with ryph__submit_patch now, in this turn");
    // the description says the same before anyone calls it
    const finish = LOOPBACK_TOOLS.find((t) => t.name === "finish")!;
    assertStringIncludes(finish.description, "a branch you never submitted does not ship");
    assert(!finish.description.includes("whatever is still unshipped"));
  } finally {
    await server.shutdown();
  }
});

test("loopback: after a merge the agent rebases, and update_from_base is a way to get there", () => {
  const described = (name: string) => LOOPBACK_TOOLS.find((t) => t.name === name)!.description;
  const submit = described("submit_patch");
  assertStringIncludes(submit, "rebase onto origin/<branch> first");
  assertStringIncludes(submit, "a branch not on it is refused");
  // Missed and released work too: the next submit needs the rebase first.
  assertStringIncludes(submit, "After a change request of yours merged, missed or was released");
  assert(!submit.includes("moved onto the merged base"), submit);
  const update = described("update_from_base");
  assertStringIncludes(update, "After a change request of yours merged, it merges the branch");
  assert(!update.includes("has landed"), update);
});
