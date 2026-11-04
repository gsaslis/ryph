// The two checks tools on the runner's own tool server: listed with their contract said where
// the tool is chosen, dispatched to the actions with the repo the agent named, both outcomes of
// a request rendered, a status read that could not happen said in words, and "not ready" before
// the core binds its actions.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { LOOPBACK_TOOLS, loopbackTools, startLoopbackMcp } from "../src/adapters/loopback/mcp.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import type { CheckLogOutcome, RunActions, RunChecksOutcome } from "../src/ports/run_actions.ts";

const TOKEN = "loopback-token-checks";

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

async function rpc(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return await res.json() as {
    result?: { content: Array<{ text: string }>; isError?: boolean };
    error?: { code: number };
  };
}

/** Actions where only the checks methods do anything; everything else is unused here. */
function checksActions(
  runChecks: (args: { path?: string; checks?: string[] }) => Promise<RunChecksOutcome>,
  checkStatus: (args?: { path?: string; commit?: string }) => Promise<string>,
  checkLog: RunActions["checkLog"] = () =>
    Promise.resolve<CheckLogOutcome>({ kind: "refused", reason: "unused" }),
): RunActions {
  const unused = () => {
    throw new Error("unused in this test");
  };
  return {
    finish: unused,
    reportOutcome: unused,
    submitPatch: unused,
    checkoutChangeRequest: unused,
    updateFromBase: unused,
    patches: unused,
    environmentStatus: unused,
    wake: unused,
    runChecks,
    checkStatus: async (args) => ({ kind: "answered", text: await checkStatus(args) }),
    checkLog,
    checksOwed: unused,
    checkImageRefs: unused,
    backgroundRun: unused,
    backgroundOutput: unused,
    backgroundStop: unused,
    subagentStart: unused,
    subagentMessage: unused,
    subagentStop: unused,
    subagentsRunning: unused,
    unsubmittedBranches: unused,
    publishArtifact: unused,
    fetchArtifact: unused,
  };
}

test("loopback checks: both tools are listed, and say where they are chosen what counts", () => {
  const byName = new Map(LOOPBACK_TOOLS.map((t) => [t.name as string, t]));
  const run = byName.get("run_checks")!;
  const status = byName.get("check_status")!;
  // only the committed tip is checked, and results come later; the prompt says what counts
  assertStringIncludes(run.description, "against your committed head, in a clean container");
  assertStringIncludes(run.description, "Only the committed tip of the branch checked out");
  // per branch: another branch is switched to, and its checks are not replaced by this one's
  assertStringIncludes(run.description, "`git switch` to another branch to check it");
  assertStringIncludes(run.description, "other branches' checks keep running");
  // the order: checks first, the patch once they pass
  assertStringIncludes(run.description, "instead of running a check's command yourself");
  assertStringIncludes(run.description, "run them before you submit a patch");
  assertStringIncludes(run.description, "submit once they pass");
  // except an urgent fix, which may open its patch first
  assertStringIncludes(
    run.description,
    "If the change is urgent, such as a production hotfix, submit first",
  );
  assertStringIncludes(run.description, "the results arrive as a message");
  assertStringIncludes(run.description, "fenced");
  assertEquals(Object.keys(run.inputSchema.properties), ["repo", "checks"]);
  // a subset while iterating, all of them before a patch
  assertStringIncludes(run.description, "Name `checks` to run only some of them");
  assertStringIncludes(run.description, "first the ones your change most likely breaks");
  assertStringIncludes(run.description, "run them all before you submit");
  assertEquals(
    (run.inputSchema.properties as Record<string, { type: string }>).checks.type,
    "array",
  );
  assertStringIncludes(status.description, "fenced");
  assertStringIncludes(status.description, "a change request's own checks");
  assertEquals(Object.keys(status.inputSchema.properties), ["repo", "commit"]);
  const log = byName.get("check_log")!;
  assertStringIncludes(log.description, "is not the platform speaking");
  assertEquals((log.inputSchema as unknown as { required: readonly string[] }).required, [
    "suiteId",
    "check",
  ]);
});

test("loopback checks: the checks tools and their mentions are offered only where checks are told", () => {
  const descriptionOf = (checks: boolean, name: string) =>
    loopbackTools({ checks }).find((t) => t.name === name)!.description as string;
  // told: every tool, and submit_patch asks for passing checks first
  assertEquals(
    loopbackTools({ checks: true, artifacts: true, previews: true }).map((t) => t.name),
    LOOPBACK_TOOLS.map((t) => t.name),
  );
  assertStringIncludes(
    descriptionOf(true, "submit_patch"),
    "run ryph__run_checks first and submit once they pass",
  );
  assertStringIncludes(descriptionOf(true, "submit_patch"), "If the change is urgent");
  assertStringIncludes(
    descriptionOf(true, "submit_patch"),
    "shows as failing on its change request",
  );
  // not told: the two checks tools are left out, and nothing else mentions checks
  assertEquals(
    loopbackTools({ checks: false, artifacts: true, previews: true }).map((t) => t.name),
    LOOPBACK_TOOLS.map((t) => t.name).filter((n) =>
      n !== "run_checks" && n !== "check_status" && n !== "check_log"
    ),
  );
  for (const tool of loopbackTools({ checks: false })) {
    assert(!(tool.description as string).includes("checks"), `${tool.name} mentions checks`);
  }
});

test("loopback: a run that may not open patches reads checks but runs none", () => {
  const names = loopbackTools({ checks: true, patches: false }).map((t) => t.name);
  assert(names.includes("check_status"));
  assert(names.includes("check_log"));
  assert(!names.includes("run_checks"));
});

test("loopback: a run that may not open patches is offered no patch tools", () => {
  const names = loopbackTools({ checks: false, patches: false }).map((t) => t.name);
  // checkout_change_request stays: it moves the checkout onto a change request to read it.
  assertEquals(names, [
    "checkout_change_request",
    "wake_me",
    "background_run",
    "background_output",
    "background_stop",
    "subagent_start",
    "subagent_message",
    "subagent_stop",
    "report_outcome",
    "finish",
  ]);
  // ...told as a way to read, never pointing at the tools it does not have.
  for (const tool of loopbackTools({ checks: false, patches: false })) {
    assert(!(tool.description as string).includes("submit_patch"), String(tool.name));
    assert(!(tool.description as string).includes("shipped"), String(tool.name));
    assert(!(tool.description as string).includes("ships"), String(tool.name));
  }
});

test("loopback: an unattended run's finish and report_outcome name no review to wait for", () => {
  const described = (opts: Parameters<typeof loopbackTools>[0]) =>
    loopbackTools(opts).filter((t) => t.name === "finish" || t.name === "report_outcome")
      .map((t) => t.description as string);
  for (const text of described({ checks: false })) {
    assert(text.includes("feedback on a change you shipped"), text);
  }
  for (const opts of [{ checks: false }, { checks: false, patches: false }]) {
    for (const text of described({ ...opts, unattended: true })) {
      assert(!text.includes("feedback"), text);
      assert(!text.includes("an answer you need"), text);
      // Without the checks tools, no checks it ran to wait on.
      assert(!text.includes("checks"), text);
    }
  }
  const finish = described({ checks: true, unattended: true })[1];
  assert(finish.includes("like checks you ran or a wake-up you set"), finish);
  // A run that may not open patches runs no checks to wait on, though it may read them.
  const reading = described({ checks: true, patches: false, unattended: true })[1];
  assert(!reading.includes("checks you ran"), reading);
});

test("loopback: an interactive run's finish says answering is not finishing", () => {
  const described = (opts: Parameters<typeof loopbackTools>[0]) =>
    loopbackTools(opts).filter((t) => t.name === "finish" || t.name === "report_outcome")
      .map((t) => t.description as string);
  for (const opts of [{ checks: false }, { checks: true, patches: false }]) {
    const [report, finish] = described({ ...opts, interactive: true });
    assert(!finish.includes("as soon as"), finish);
    assert(finish.includes("answering them is not finishing"), finish);
    assert(finish.includes("only when they say they are done"), finish);
    assert(report.includes("each time you end your turn without finishing"), report);
  }
  // A run that ships nothing is told so here too.
  const [, reading] = described({ checks: false, patches: false, interactive: true });
  assert(!reading.includes("ships"), reading);
});

test("loopback: report_outcome names only the waits this run can have, and asks for in-progress meanwhile", () => {
  const report = (opts: Parameters<typeof loopbackTools>[0]) =>
    loopbackTools(opts).find((t) => t.name === "report_outcome")!.description as string;
  const every: Parameters<typeof loopbackTools>[0][] = [];
  for (const checks of [false, true]) {
    for (const patches of [false, true]) {
      for (const unattended of [false, true]) {
        for (const interactive of [false, true]) {
          every.push({ checks, patches, unattended, interactive });
        }
      }
    }
  }
  // Whatever the run, a report is what is true now, and reporting does not end it.
  for (const opts of every) {
    const text = report(opts);
    assertStringIncludes(text, '"in-progress" while required work or verification remains');
    assertStringIncludes(text, "a final outcome only once what you were asked for is complete");
    assertStringIncludes(text, "Reporting does not end the run");
    assertStringIncludes(
      text,
      "The summary is optional; omit it unless the run record needs an update",
    );
    assertStringIncludes(text, "Still report the outcome and awaitingUserTurn at each handoff");
    assertStringIncludes(text, "work still in progress then ends unfinished");
    assertStringIncludes(text, "a subagent");
    assertStringIncludes(text, "a wake-up");
    // A run that may not open patches has nothing shipped to wait on, nor checks it ran.
    if (opts.patches === false) {
      assert(!text.includes("shipped"), `${JSON.stringify(opts)}: ${text}`);
      assert(!text.includes("checks you ran"), `${JSON.stringify(opts)}: ${text}`);
    }
    // Interactive or not decides the suffix, nothing else does.
    assertEquals(
      text.includes("each time you end your turn without finishing"),
      opts.interactive === true,
      `${JSON.stringify(opts)}: ${text}`,
    );
  }

  // Unattended without checks: nobody to answer, nobody to give feedback, no checks it ran.
  for (const patches of [false, true]) {
    const lone = report({ checks: false, patches, unattended: true });
    assert(!lone.includes("checks"), lone);
    assert(!lone.includes("feedback"), lone);
    assert(!lone.includes("an answer you asked for"), lone);
  }
  // Unattended with checks: the checks it ran are worth waiting on, still no person.
  const checked = report({ checks: true, unattended: true });
  assertStringIncludes(checked, "checks you ran");
  assert(!checked.includes("feedback"), checked);
  assert(!checked.includes("an answer you asked for"), checked);

  // Attended with patches and checks: every wait there is, in order.
  const attended = report({ checks: true, patches: true });
  assertStringIncludes(
    attended,
    "for checks you ran, a subagent, an answer you asked for, feedback on a change you " +
      "shipped, a wake-up —",
  );
  assertStringIncludes(attended, "This tool records metadata, not your reply to the person.");
  assertStringIncludes(
    attended,
    "call it before your single user-facing answer or progress update",
  );
  assertStringIncludes(
    attended,
    "If you already gave that update, in a reply or a post, end the turn after this call " +
      "without repeating it.",
  );
  // ...and as listed by default.
  assertEquals(
    LOOPBACK_TOOLS.find((t) => t.name === "report_outcome")!.description,
    attended,
  );
  // Attended but shipping nothing: an answer, no feedback on a shipped change.
  const reading = report({ checks: true, patches: false });
  assertStringIncludes(reading, "for a subagent, an answer you asked for, a wake-up —");
  // Interactive: told to report at every turn's end.
  const talking = report({ checks: true, patches: true, interactive: true });
  assert(talking.startsWith(attended), talking);
  assert(talking.endsWith(" In this run, call it each time you end your turn without finishing."));
});

test("loopback checks: the listing asks whether the agent is told of checks, each time", async () => {
  let told = false;
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => null,
    diag: noopDiagnostics(),
    checks: () => told,
  });
  const listed = async () =>
    (await rpc(server.url, { jsonrpc: "2.0", id: 1, method: "tools/list" }) as {
      result?: { tools: Array<{ name: string; description: string }> };
    }).result!.tools;
  const submit = async () => (await listed()).find((t) => t.name === "submit_patch")!.description;
  try {
    // no repo declares checks: the checks tools are not listed, and submit_patch does not
    // mention them
    assert(!(await submit()).includes("ryph__run_checks"));
    assert(
      !(await listed()).some((t) =>
        t.name === "run_checks" || t.name === "check_status" || t.name === "check_log"
      ),
    );
    told = true;
    assertStringIncludes(await submit(), "run ryph__run_checks first");
    assert((await listed()).some((t) => t.name === "run_checks"));
    assert((await listed()).some((t) => t.name === "check_status"));
    assert((await listed()).some((t) => t.name === "check_log"));
  } finally {
    await server.shutdown();
  }
});

test("loopback checks: a call to an unlisted checks tool still answers", async () => {
  const actions = checksActions(
    () => Promise.resolve({ kind: "refused", reason: "no checks file in repo" }),
    () => Promise.resolve("No check suites have run for this run."),
  );
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
    checks: () => false,
  });
  try {
    const ran = await rpc(server.url, call("run_checks"));
    assertEquals(ran.error, undefined);
    assertEquals(ran.result?.isError, true);
    assertStringIncludes(ran.result!.content[0].text, "no checks file in repo");
    const status = await rpc(server.url, call("check_status"));
    assertEquals(status.error, undefined);
    assertStringIncludes(status.result!.content[0].text, "No check suites have run");
  } finally {
    await server.shutdown();
  }
});

test("loopback checks: run_checks passes the repo through and renders a request or a refusal", async () => {
  const asked: Array<{ path?: string; checks?: string[] }> = [];
  let answer: RunChecksOutcome = {
    kind: "requested",
    text: "Checks requested for repo at 0123456789.\n\nSuite cs-1: 2 checks queued.",
  };
  const actions = checksActions((args) => {
    asked.push(args);
    return Promise.resolve(answer);
  }, () => Promise.resolve("unused"));
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    const ok = await rpc(server.url, call("run_checks", { repo: "web" }));
    assertEquals(ok.result?.isError, undefined);
    assertStringIncludes(ok.result!.content[0].text, "Suite cs-1: 2 checks queued.");
    assertEquals(asked, [{ path: "web", checks: undefined }]);

    // no repo named: the actions pick (or refuse), not the tool
    answer = { kind: "refused", reason: "the run holds 2 repos; name one with `repo`: a, b" };
    const refused = await rpc(server.url, call("run_checks"));
    assertEquals(refused.result?.isError, true);
    assertStringIncludes(refused.result!.content[0].text, "name one with `repo`");
    assertEquals(asked[1], { path: undefined, checks: undefined });

    // named checks pass through lowercased, duplicates and blanks dropped
    answer = { kind: "requested", text: "Checks requested." };
    await rpc(
      server.url,
      call("run_checks", { repo: "web", checks: ["lint", "Lint", " ", "TEST"] }),
    );
    assertEquals(asked[2], { path: "web", checks: ["lint", "test"] });
    const notList = await rpc(server.url, call("run_checks", { checks: "lint" }));
    assertEquals(notList.error?.code, -32603);

    // a repo that is not a string is the model's mistake, answered as a call error
    const bad = await rpc(server.url, call("run_checks", { repo: 7 }));
    assertEquals(bad.error?.code, -32603);
  } finally {
    await server.shutdown();
  }
});

test("loopback checks: check_status hands on the platform's text, and says when it could not ask", async () => {
  let fail = false;
  const actions = checksActions(
    () => Promise.resolve({ kind: "refused", reason: "unused" }),
    () =>
      fail
        ? Promise.reject(new Error("the orchestrator answered 502"))
        : Promise.resolve("Suite cs-1 at 0123456789: passed (lint, test)."),
  );
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    const ok = await rpc(server.url, call("check_status"));
    assertEquals(ok.result?.isError, undefined);
    assertEquals(ok.result!.content[0].text, "Suite cs-1 at 0123456789: passed (lint, test).");
    fail = true;
    const down = await rpc(server.url, call("check_status"));
    assertEquals(down.result?.isError, true);
    assertStringIncludes(down.result!.content[0].text, "could not be asked just now");
    assertStringIncludes(down.result!.content[0].text, "answered 502");
  } finally {
    await server.shutdown();
  }
});

test("loopback checks: before the core binds its actions, both tools are refused in words", async () => {
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => null,
    diag: noopDiagnostics(),
  });
  try {
    for (const name of ["run_checks", "check_status", "check_log"]) {
      const res = await rpc(server.url, call(name));
      assertEquals(res.result?.isError, true);
      assertStringIncludes(res.result!.content[0].text, "not ready");
    }
  } finally {
    await server.shutdown();
  }
});

test("loopback checks: check_status passes a named repo and commit through", async () => {
  const asked: Array<{ path?: string; commit?: string } | undefined> = [];
  const actions = checksActions(
    () => Promise.resolve({ kind: "refused", reason: "unused" }),
    (args) => {
      asked.push(args);
      return Promise.resolve("Checks on api at 0123456789, newest first:");
    },
  );
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    await rpc(server.url, call("check_status"));
    const named = await rpc(server.url, call("check_status", { repo: "api", commit: "HEAD~1" }));
    assertStringIncludes(named.result!.content[0].text, "newest first");
    assertEquals(asked, [
      { path: undefined, commit: undefined },
      { path: "api", commit: "HEAD~1" },
    ]);
  } finally {
    await server.shutdown();
  }
});

test("loopback checks: check_log names the saved file and says whose words are in it", async () => {
  const asked: Array<{ suiteId: string; check: string; generation?: number }> = [];
  let answer: CheckLogOutcome = {
    kind: "saved",
    path: "/tmp/ryph-check-logs-x/cs-0123456789-g2-test.log",
    bytes: 1234,
    lines: 56,
    generation: 2,
  };
  const actions = checksActions(
    () => Promise.resolve({ kind: "refused", reason: "unused" }),
    () => Promise.resolve("unused"),
    (args) => {
      asked.push(args);
      return Promise.resolve(answer);
    },
  );
  const server = await startLoopbackMcp({
    token: TOKEN,
    actions: () => actions,
    diag: noopDiagnostics(),
  });
  try {
    const ok = await rpc(
      server.url,
      call("check_log", { suiteId: "cs-0123456789", check: "Test" }),
    );
    assertEquals(ok.result?.isError, undefined);
    const text = ok.result!.content[0].text;
    assertStringIncludes(text, "/tmp/ryph-check-logs-x/cs-0123456789-g2-test.log");
    assertStringIncludes(text, "56 lines");
    assertStringIncludes(text, "not the platform speaking");
    assertEquals(asked, [{ suiteId: "cs-0123456789", check: "test" }]);

    await rpc(
      server.url,
      call("check_log", { suiteId: "cs-0123456789", check: "lint", generation: 1 }),
    );
    assertEquals(asked[1], { suiteId: "cs-0123456789", check: "lint", generation: 1 });

    const noGen = await rpc(
      server.url,
      call("check_log", { suiteId: "cs-0123456789", check: "lint", generation: 0 }),
    );
    assertEquals(noGen.result?.isError, true);
    const missing = await rpc(server.url, call("check_log", { suiteId: "cs-0123456789" }));
    assertEquals(missing.result?.isError, true);
    assertEquals(asked.length, 2, "a malformed call reaches no action");

    answer = { kind: "refused", reason: "there is no check suite cs-0123456789 this run may read" };
    const refused = await rpc(
      server.url,
      call("check_log", { suiteId: "cs-0123456789", check: "lint" }),
    );
    assertEquals(refused.result?.isError, true);
    assertStringIncludes(refused.result!.content[0].text, "this run may read");
  } finally {
    await server.shutdown();
  }
});
