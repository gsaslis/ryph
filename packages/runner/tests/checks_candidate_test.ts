// `run_checks` on the fake column with real git: the committed tip is uploaded the way a patch
// ships (here, the plain transport's push) and a suite is asked for on exactly that head, branch
// and base; nothing is committed, nothing counts as shipped, so the next submit still ships and
// reports the same tip. Refused — before anything is uploaded or asked — with nothing committed,
// in a rebase, after a landing, and on a run the platform runs no checks for.

import { test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { run } from "../src/core/run.ts";
import { cloneState, defaultLine, makeShipper } from "../src/core/patches.ts";
import {
  type ChecksAnswer,
  type ChecksChannel,
  ChecksRefusedError,
  type ChecksRequest,
  ChecksUnansweredError,
} from "../src/ports/checks.ts";
import type { PatchReport, PatchReporter } from "../src/ports/patch_reporter.ts";
import type {
  CheckLogOutcome,
  CheckStatusOutcome,
  RunActions,
  RunChecksOutcome,
} from "../src/ports/run_actions.ts";
import type { HarnessInput } from "../src/ports/harness.ts";
import { cliGitTransport } from "../src/adapters/git/cli.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { git } from "../src/helpers/git_exec.ts";
import { createBranch, headSha } from "../src/helpers/checkout.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeThrowawayOrigin } from "./fixtures/origin.ts";
import { makeRunFixture, repoEntry } from "./util.ts";

/** A channel that records every request and answers the platform's words: a string is a
 * request the platform took (202), an answer object says so itself. */
function recordingChecks(answer: (req: ChecksRequest) => Promise<string | ChecksAnswer>) {
  const requests: ChecksRequest[] = [];
  const channel: ChecksChannel = {
    async request(req) {
      requests.push(structuredClone(req));
      const said = await answer(req);
      return typeof said === "string" ? { requested: true, text: said } : said;
    },
    status: () => Promise.resolve("Suite cs-1: passed."),
    log: () => Promise.reject(new Error("unused")),
    awaiting: () => Promise.resolve([]),
    declared: () => Promise.resolve({ declared: [], unread: [] }),
  };
  return { channel, requests };
}

function recordingReporter() {
  const reports: PatchReport[] = [];
  const reporter: PatchReporter = {
    reportPatch(report) {
      reports.push(structuredClone(report));
      return Promise.resolve({
        patchId: `p-${reports.length}`,
        state: "pending_approval",
        url: null,
      });
    },
    claimChangeRequest: () => Promise.reject(new Error("unused")),
  };
  return { reporter, reports };
}

async function agentCommit(dir: string, file: string, content: string, subject: string) {
  await writeFile(`${dir}/${file}`, content);
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c",
    "user.name=ada",
    "-c",
    "user.email=ada@runner.local",
    "commit",
    "-m",
    subject,
  );
}

/** A connected fixture whose harness runs `body` with the bound actions. */
async function checksFixture(
  body: (actions: RunActions, dir: string) => Promise<void>,
  opts: { checks?: ChecksChannel } = {},
) {
  const fx = await makeRunFixture(fakeOrchestratorGateway());
  const { reporter, reports } = recordingReporter();
  fx.ctx.patchReporter = reporter;
  if (opts.checks !== undefined) fx.ctx.checks = opts.checks;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  let checksEnabled: boolean | undefined;
  let checksDeclared: HarnessInput["checksDeclared"];
  let told: boolean | undefined;
  // what had been told when the harness started: the loopback lists its tools then
  let toldAtStart: boolean | undefined;
  fx.ctx.onChecksTold = (t) => (told = t);
  fx.ctx.harness = {
    async run(input) {
      toldAtStart = told;
      checksEnabled = input.checksEnabled;
      checksDeclared = input.checksDeclared;
      await body(actions!, `${input.checkoutDir}/repo`);
      actions!.reportOutcome({ outcome: "success" });
      return { summary: "done", interrupted: false };
    },
  };
  return {
    fx,
    reports,
    checksEnabled: () => checksEnabled,
    checksDeclared: () => checksDeclared,
    told: () => told,
    toldAtStart: () => toldAtStart,
  };
}

test("run_checks: the committed tip is uploaded and asked for; the next submit still ships it", async () => {
  const { channel, requests } = recordingChecks(() =>
    Promise.resolve("Suite cs-1 queued: lint, test.")
  );
  let outcome: RunChecksOutcome | null = null;
  let tip = "";
  let base = "";
  const { fx, reports, checksEnabled } = await checksFixture(async (actions, dir) => {
    base = await headSha(git, dir);
    await agentCommit(dir, "a.txt", "a\n", "add a");
    tip = await headSha(git, dir);
    outcome = await actions.runChecks({});
    // the candidate is not a patch: the submit still has the tip to ship, and reports it
    const submitted = await actions.submitPatch({});
    assertEquals(submitted.kind, "submitted", JSON.stringify(submitted));
  }, { checks: channel });
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(checksEnabled(), true);
    const got = outcome as RunChecksOutcome | null;
    assert(got?.kind === "requested", JSON.stringify(got));
    assertStringIncludes(got.text, `at ${tip.slice(0, 10)}`);
    assertStringIncludes(got.text, "Suite cs-1 queued: lint, test.");
    assertEquals(requests, [{ path: "repo", headSha: tip, branch: fx.branchName, baseSha: base }]);
    // the plain transport's upload is a push: the origin holds the branch at the tip
    assertEquals(await git(fx.originUrl, "rev-parse", `refs/heads/${fx.branchName}`), tip);
    assertEquals(reports.length, 1);
    assertEquals(reports[0].branch.headSha, tip);
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: named checks ride the request, and the declared list reaches the harness", async () => {
  const { channel, requests } = recordingChecks(() => Promise.resolve("Suite cs-1 queued: lint."));
  const declared = [{
    path: "repo",
    repoRef: "acme/repo",
    checksRef: "main",
    setup: [],
    checks: [{ name: "lint", run: "npm run lint", timeoutSeconds: 600, services: [] }],
  }];
  // a repo that declares no checks is dropped from the list the harness gets
  const bare = { ...declared[0], path: "other", checks: [] };
  channel.declared = () => Promise.resolve({ declared: [...declared, bare], unread: [] });
  const { fx, checksDeclared, told, toldAtStart } = await checksFixture(async (actions, dir) => {
    await agentCommit(dir, "a.txt", "a\n", "add a");
    await actions.runChecks({ checks: ["lint"] });
    // an empty list is all of them: nothing named on the wire
    await actions.runChecks({ checks: [] });
  }, { checks: channel });
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(requests.map((r) => r.checks), [["lint"], undefined]);
    assertEquals(checksDeclared(), { declared, unread: [] });
    assertEquals(told(), true);
    assertEquals(toldAtStart(), true, "told before the harness started");
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: where no repo declares checks, the agent is not told of them", async () => {
  const { channel } = recordingChecks(() => Promise.resolve("queued"));
  channel.declared = () =>
    Promise.resolve({
      declared: [{
        path: "repo",
        repoRef: "acme/repo",
        checksRef: "main",
        setup: [],
        checks: [],
      }],
      unread: [],
    });
  const { fx, checksEnabled, checksDeclared, told, toldAtStart } = await checksFixture(
    () => Promise.resolve(),
    { checks: channel },
  );
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(checksEnabled(), true, "the tools still work");
    assertEquals(checksDeclared(), { declared: [], unread: [] });
    assertEquals(told(), false);
    assertEquals(toldAtStart(), false, "settled before the harness started");
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: a checks file the platform could not read is not known, never none", async () => {
  const declared = [{
    path: "repo",
    repoRef: "acme/repo",
    checksRef: "main",
    setup: [],
    checks: [{ name: "lint", run: "npm run lint", timeoutSeconds: 600, services: [] }],
  }];
  for (
    const [answer, expected] of [
      // some read, some not: the agent is told
      [{ declared, unread: ["web"] }, true],
      // none declares any, but one could not be read: still told, cautiously
      [{ declared: [], unread: ["repo"] }, true],
      // the whole read failed
      [{ declared: [], unread: ["*"] }, true],
      // everything read, nothing declared
      [{ declared: [], unread: [] }, false],
    ] as const
  ) {
    const { channel } = recordingChecks(() => Promise.resolve("queued"));
    channel.declared = () =>
      Promise.resolve({ declared: [...answer.declared], unread: [...answer.unread] });
    const { fx, checksDeclared, told, toldAtStart } = await checksFixture(
      () => Promise.resolve(),
      { checks: channel },
    );
    try {
      const result = await run(fx.item, fx.ctx);
      assertEquals(result.status, "success", JSON.stringify(result));
      assertEquals(checksDeclared(), {
        declared: [...answer.declared],
        unread: [...answer.unread],
      });
      assertEquals(told(), expected, JSON.stringify(answer));
      assertEquals(toldAtStart(), expected, "settled before the harness started");
    } finally {
      await fx.cleanup();
    }
  }
});

test("run_checks: the declared list is asked for at the start, and none is no failure", async () => {
  // Asked for before the clone and awaited as the harness starts: a slow answer still lands.
  const slow = recordingChecks(() => Promise.resolve("queued"));
  let askedAt = 0;
  const declared = [{
    path: "repo",
    repoRef: "acme/repo",
    checksRef: "main",
    setup: [],
    checks: [{ name: "lint", run: "npm run lint", timeoutSeconds: 600, services: [] }],
  }];
  slow.channel.declared = async () => {
    askedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { declared, unread: [] };
  };
  let startedAt = 0;
  const late = await checksFixture(() => {
    startedAt = Date.now();
    return Promise.resolve();
  }, { checks: slow.channel });
  try {
    const result = await run(late.fx.item, late.fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(late.checksDeclared(), { declared, unread: [] });
    assertEquals(late.toldAtStart(), true, "told before the harness started");
    assert(askedAt > 0 && askedAt <= startedAt, "asked before the harness started");
  } finally {
    await late.fx.cleanup();
  }

  // A platform that cannot say: the run goes on, without the list.
  const failing = recordingChecks(() => Promise.resolve("queued"));
  failing.channel.declared = () => Promise.reject(new Error("the orchestrator answered 504"));
  const none = await checksFixture(() => Promise.resolve(), { checks: failing.channel });
  try {
    const result = await run(none.fx.item, none.fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(none.checksEnabled(), true);
    assertEquals(none.checksDeclared(), null, "not known");
    assertEquals(none.told(), true, "the agent is told checks may exist");
    assertEquals(none.toldAtStart(), true, "told before the harness started");
  } finally {
    await none.fx.cleanup();
  }
});

test("run_checks: a run that fails before its harness leaves no declared request open", async () => {
  const { channel } = recordingChecks(() => Promise.resolve("queued"));
  let asked: AbortSignal | undefined;
  channel.declared = (signal) => {
    asked = signal;
    return new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    );
  };
  const { fx } = await checksFixture(() => Promise.resolve(), { checks: channel });
  fx.item = {
    ...fx.item,
    repos: fx.item.repos.map((r) => ({ ...r, url: `${fx.originUrl}-missing` })),
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "error", JSON.stringify(result));
    assert(asked?.aborted, "the request ends with the run");
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: uncommitted changes are named, not committed, and not checked", async () => {
  const { channel, requests } = recordingChecks(() => Promise.resolve("queued"));
  let outcome: RunChecksOutcome | null = null;
  let tip = "";
  let dirtyAfter = "";
  const { fx } = await checksFixture(async (actions, dir) => {
    await agentCommit(dir, "a.txt", "a\n", "add a");
    tip = await headSha(git, dir);
    await writeFile(`${dir}/b.txt`, "work in progress\n");
    outcome = await actions.runChecks({ path: "repo" });
    dirtyAfter = await git(dir, "status", "--porcelain");
    assertEquals(await headSha(git, dir), tip, "nothing was committed");
  }, { checks: channel });
  try {
    await run(fx.item, fx.ctx);
    const got = outcome as RunChecksOutcome | null;
    assert(got?.kind === "requested", JSON.stringify(got));
    assertStringIncludes(got.text, "Uncommitted changes in the tree are not part of it");
    assertEquals(requests[0].headSha, tip);
    assertStringIncludes(dirtyAfter, "b.txt");
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: nothing committed or a rebase in progress is refused before any upload", async () => {
  const { channel, requests } = recordingChecks(() => Promise.resolve("unused"));
  const outcomes: RunChecksOutcome[] = [];
  const { fx } = await checksFixture(async (actions, dir) => {
    outcomes.push(await actions.runChecks({}));
    // a rebase stopped on a conflict
    const branch = (await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).trim();
    await git(dir, "checkout", "-q", "-b", "side");
    await agentCommit(dir, "a.txt", "side\n", "side a");
    await git(dir, "checkout", "-q", branch);
    await agentCommit(dir, "a.txt", "ours\n", "our a");
    await git(dir, "rebase", "side").catch(() => {});
    outcomes.push(await actions.runChecks({}));
    await git(dir, "rebase", "--abort");
    // a repo the run does not hold
    outcomes.push(await actions.runChecks({ path: "elsewhere" }));
  }, { checks: channel });
  try {
    await run(fx.item, fx.ctx);
    assertEquals(outcomes.map((o) => o.kind), ["refused", "refused", "refused"]);
    assert(outcomes[0].kind === "refused" && outcomes[1].kind === "refused");
    assertStringIncludes(outcomes[0].reason, "nothing committed since its base");
    assertStringIncludes(outcomes[0].reason, "sent in the same turn");
    assertStringIncludes(outcomes[1].reason, "rebase in progress");
    assert(outcomes[2].kind === "refused");
    assertStringIncludes(outcomes[2].reason, "no repo of this run is at `elsewhere`");
    assertEquals(requests, []);
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: a run the platform runs no checks for says so, uploads nothing, and is not told about checks", async () => {
  let outcome: RunChecksOutcome | null = null;
  let status: CheckStatusOutcome | null = null;
  const { fx, checksEnabled, told } = await checksFixture(async (actions, dir) => {
    await agentCommit(dir, "a.txt", "a\n", "add a");
    outcome = await actions.runChecks({});
    status = await actions.checkStatus();
  });
  try {
    await run(fx.item, fx.ctx);
    assertEquals(checksEnabled(), false);
    assertEquals(told(), false);
    const got = outcome as RunChecksOutcome | null;
    assert(got?.kind === "refused");
    assertStringIncludes(got.reason, "does not run checks for this run");
    const said = status as CheckStatusOutcome | null;
    assert(said?.kind === "answered");
    assertStringIncludes(said.text, "does not run checks for this run");
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: a platform refusal comes back as the platform's reason", async () => {
  const { channel } = recordingChecks(() =>
    Promise.reject(new Error("this run already requested 20 check suites"))
  );
  let outcome: RunChecksOutcome | null = null;
  const { fx } = await checksFixture(async (actions, dir) => {
    await agentCommit(dir, "a.txt", "a\n", "add a");
    outcome = await actions.runChecks({});
  }, { checks: channel });
  try {
    await run(fx.item, fx.ctx);
    const got = outcome as RunChecksOutcome | null;
    assert(got?.kind === "refused");
    assertEquals(got.reason, "repo: this run already requested 20 check suites");
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: a platform that started nothing is heard in its own words, not as a request", async () => {
  const said = "The base branch defines no checks for repo, so nothing was started.";
  const { channel } = recordingChecks(() => Promise.resolve({ requested: false, text: said }));
  let outcome: RunChecksOutcome | null = null;
  const { fx } = await checksFixture(async (actions, dir) => {
    await agentCommit(dir, "a.txt", "a\n", "add a");
    outcome = await actions.runChecks({});
  }, { checks: channel });
  try {
    await run(fx.item, fx.ctx);
    assertEquals(outcome, { kind: "answered", text: said });
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: no answer in time may still be a request, and points at check_status", async () => {
  const { channel } = recordingChecks(() => Promise.reject(new ChecksUnansweredError()));
  let outcome: RunChecksOutcome | null = null;
  const { fx } = await checksFixture(async (actions, dir) => {
    await agentCommit(dir, "a.txt", "a\n", "add a");
    outcome = await actions.runChecks({});
  }, { checks: channel });
  try {
    await run(fx.item, fx.ctx);
    const got = outcome as RunChecksOutcome | null;
    assert(got?.kind === "answered", JSON.stringify(got));
    assertStringIncludes(got.text, "may still be going through");
    assertStringIncludes(got.text, "ryph__check_status");
  } finally {
    await fx.cleanup();
  }
});

test("pushCandidate: a landed generation whose merged-into tip was never fetched fetches it, and is refused only when that fails", async () => {
  const origin = await makeThrowawayOrigin();
  const root = await mkdtemp(join(tmpdir(), "runner-candidate-"));
  try {
    const real = cliGitTransport(noopDiagnostics());
    let failFetch = false;
    const transport: typeof real = {
      ...real,
      fetchBase: (from, repo, ref) =>
        failFetch
          ? Promise.reject(new Error("the gateway answered 502"))
          : real.fetchBase(from, repo, ref),
    };
    const repo = repoEntry({ url: origin.url, ref: origin.ref, connectedRepoId: "cr-1" });
    const checkout = await transport.clone(repo, `${root}/repo`);
    await createBranch(git, checkout.dir, `${repo.branchNamespace}/work`);
    const base = await headSha(git, checkout.dir);
    await agentCommit(checkout.dir, "a.txt", "a\n", "add a");
    const clone = defaultLine(cloneState(repo, checkout, base));
    const shipper = makeShipper({
      git: transport,
      gitExec: git,
      diag: noopDiagnostics(),
      runId: "wi-test",
      subject: () => "unused",
    });
    const tip = await headSha(git, checkout.dir);
    const pushed = await shipper.pushCandidate(clone);
    assertEquals(pushed, {
      headSha: tip,
      branch: `${repo.branchNamespace}/work`,
      baseSha: base,
      dirty: false,
    });
    assertEquals(clone.shippedHead, null, "a candidate is not a shipped patch");

    // A generation that ended with nothing merged lands at its base.
    clone.landedHead = base;
    clone.landing = { onto: "main", at: 0, inferred: false };
    failFetch = true;
    const refused = await shipper.pushCandidate(clone);
    assert("refused" in refused, JSON.stringify(refused));
    assertStringIncludes(
      refused.refused,
      "`origin/main` could not be fetched (the gateway answered 502); try again",
    );
    // As a submit does, the check fetches the merged-into branch itself, and files the
    // candidate under the next generation.
    failFetch = false;
    const fetched = await shipper.pushCandidate(clone);
    assert(!("refused" in fetched), JSON.stringify(fetched));
    assertEquals(clone.landedTip, base);
    assertEquals(fetched.branch, `${repo.branchNamespace}/work-2`);
  } finally {
    await origin.cleanup();
    await rm(root, { recursive: true });
  }
});

test("pushCandidate: an unchanged tip is not uploaded again, until a submit or a new commit", async () => {
  const origin = await makeThrowawayOrigin();
  const root = await mkdtemp(join(tmpdir(), "runner-candidate-"));
  try {
    const plain = cliGitTransport(noopDiagnostics());
    let pushes = 0;
    const transport: typeof plain = {
      ...plain,
      push(...args) {
        pushes++;
        return plain.push(...args);
      },
    };
    const repo = repoEntry({ url: origin.url, ref: origin.ref, connectedRepoId: "cr-1" });
    const checkout = await transport.clone(repo, `${root}/repo`);
    await createBranch(git, checkout.dir, `${repo.branchNamespace}/work`);
    const base = await headSha(git, checkout.dir);
    await agentCommit(checkout.dir, "a.txt", "a\n", "add a");
    const clone = defaultLine(cloneState(repo, checkout, base));
    const { reporter } = recordingReporter();
    const shipper = makeShipper({
      git: transport,
      gitExec: git,
      diag: noopDiagnostics(),
      runId: "wi-test",
      subject: () => "unused",
      patchReporter: reporter,
    });
    const first = await shipper.pushCandidate(clone);
    const again = await shipper.pushCandidate(clone);
    assertEquals(again, first, "the same candidate, answered the same");
    assertEquals(pushes, 1, "uploaded once");

    await agentCommit(checkout.dir, "b.txt", "b\n", "add b");
    await shipper.pushCandidate(clone);
    assertEquals(pushes, 2, "a new tip is uploaded");

    // A submit pushes the branch itself, and is forgotten after: the next candidate goes again.
    assertEquals((await shipper.submit(clone)).kind, "submitted");
    assertEquals(pushes, 3);
    await shipper.pushCandidate(clone);
    assertEquals(pushes, 4);
  } finally {
    await origin.cleanup();
    await rm(root, { recursive: true });
  }
});

test("run_checks: a hold that gave up stops waiting for its checks, and a new ask holds again", async () => {
  // One check never reports: the first hold gives up on it, a finish then says the run no longer
  // waits, and a fresh run_checks is held for its own verdict.
  const owed = { count: 0 };
  const { channel } = recordingChecks(() => {
    owed.count++;
    return Promise.resolve("Suite queued: test.");
  });
  channel.awaiting = () =>
    Promise.resolve(
      Array.from({ length: owed.count }, (_, i) => ({ id: `cs-${i}@1`, requests: [`cq-${i}`] })),
    );
  const fx = await makeRunFixture(fakeOrchestratorGateway());
  fx.item = { ...fx.item, repos: fx.item.repos.map((r) => ({ ...r, connectedRepoId: "cr-1" })) };
  fx.ctx.patchReporter = recordingReporter().reporter;
  fx.ctx.checks = channel;
  fx.ctx.checksHold = { maxWaitMs: 80, checkEveryMs: 10 };
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const heard: string[] = [];
  const owedSeen: unknown[] = [];
  fx.ctx.harness = {
    async run(input, io) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      assertEquals((await actions!.runChecks({})).kind, "requested");
      owedSeen.push(await actions!.checksOwed());
      io.conversation!.onSettled();
      for await (const message of io.conversation!.messages) {
        heard.push(message.text);
        if (heard.length === 1) {
          // The hold gave up: the check is still owed, and a stop no longer waits for it.
          owedSeen.push(await actions!.checksOwed());
          await agentCommit(dir, "b.txt", "b\n", "add b");
          assertEquals((await actions!.runChecks({})).kind, "requested");
          // A new ask: its verdict is waited on; the stuck one is still owed, but not held for.
          owedSeen.push(await actions!.checksOwed());
        } else {
          actions!.finish({ outcome: "success", summary: "done" });
        }
        io.conversation!.onSettled();
      }
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(owedSeen, [
      { owed: 1, waits: true },
      { owed: 1, waits: false },
      { owed: 2, waits: true },
    ]);
    // Each hold gave up at its bound with its own late note: the second ask was held again.
    assertEquals(heard.length, 2);
    for (const note of heard) assertStringIncludes(note, "did not report a verdict in time");
  } finally {
    await fx.cleanup();
  }
});

test("check_status: the checked-out head rides along, and a named revision resolves in the checkout", async () => {
  const asked: Array<Parameters<ChecksChannel["status"]>[0]> = [];
  const { channel } = recordingChecks(() => Promise.resolve("unused"));
  channel.status = (at) => {
    asked.push(structuredClone(at));
    return Promise.resolve("Checks on repo.");
  };
  let head = "";
  let base = "";
  const said: CheckStatusOutcome[] = [];
  const { fx } = await checksFixture(async (actions, dir) => {
    base = await headSha(git, dir);
    await agentCommit(dir, "a.txt", "a\n", "add a");
    head = await headSha(git, dir);
    said.push(await actions.checkStatus());
    said.push(await actions.checkStatus({ commit: "HEAD~1" }));
    // a full SHA the checkout does not have is still asked about
    said.push(await actions.checkStatus({ commit: "f".repeat(40) }));
    said.push(await actions.checkStatus({ commit: "no-such-branch" }));
    said.push(await actions.checkStatus({ commit: "--output=/tmp/x" }));
    said.push(await actions.checkStatus({ path: "elsewhere" }));
  }, { checks: channel });
  try {
    await run(fx.item, fx.ctx);
    assertEquals(asked, [
      { commits: [{ path: "repo", commit: head }], named: false },
      { commits: [{ path: "repo", commit: base }], named: true },
      { commits: [{ path: "repo", commit: "f".repeat(40) }], named: true },
    ]);
    assertEquals(said.slice(0, 3).map((s) => s.kind), ["answered", "answered", "answered"]);
    const [, , , missing, option, elsewhere] = said;
    assert(missing.kind === "refused");
    assertStringIncludes(missing.reason, "has no commit");
    assert(option.kind === "refused");
    assertStringIncludes(option.reason, "commit: a revision");
    assert(elsewhere.kind === "refused");
    assertStringIncludes(elsewhere.reason, "no repo of this run is at");
  } finally {
    await fx.cleanup();
  }
});

test("check_log: the log is saved outside the clone, named by the platform's ids, and gone after the run", async () => {
  const { channel } = recordingChecks(() => Promise.resolve("unused"));
  const asked: Array<Parameters<ChecksChannel["log"]>[0]> = [];
  let answer: () => Promise<{ bytes: Uint8Array; generation: number }> = () =>
    Promise.resolve({ bytes: new TextEncoder().encode("one\ntwo\nthree"), generation: 2 });
  channel.log = (args) => {
    asked.push(structuredClone(args));
    return answer();
  };
  const outcomes: CheckLogOutcome[] = [];
  let content = "";
  let checkout = "";
  const { fx } = await checksFixture(async (actions, dir) => {
    checkout = dir;
    outcomes.push(await actions.checkLog({ suiteId: "cs-0123456789", check: "test" }));
    const saved = outcomes[0];
    if (saved.kind === "saved") content = await readFile(saved.path, "utf8");
    // again: the same name, replaced
    answer = () => Promise.resolve({ bytes: new TextEncoder().encode("new\n"), generation: 2 });
    outcomes.push(await actions.checkLog({ suiteId: "cs-0123456789", check: "test" }));
    // names the platform never mints go nowhere
    outcomes.push(await actions.checkLog({ suiteId: "../../etc", check: "test" }));
    outcomes.push(await actions.checkLog({ suiteId: "cs-0123456789", check: "a/b" }));
    answer = () => Promise.reject(new ChecksRefusedError("suite cs-0123456789 runs no check"));
    outcomes.push(await actions.checkLog({ suiteId: "cs-0123456789", check: "nope" }));
    answer = () => Promise.reject(new Error("the orchestrator answered 502"));
    outcomes.push(await actions.checkLog({ suiteId: "cs-0123456789", check: "test" }));
    // a UUIDv7 suite id, as check_status names it today
    answer = () => Promise.resolve({ bytes: new TextEncoder().encode("rest\n"), generation: 1 });
    outcomes.push(
      await actions.checkLog({ suiteId: "cs-01m4r5dasvernbfp25a77wb8f4", check: "rest" }),
    );
  }, { checks: channel });
  try {
    await run(fx.item, fx.ctx);
    const [first, second, badSuite, badCheck, refused, down, sortable] = outcomes;
    assert(first.kind === "saved", JSON.stringify(first));
    assertEquals([first.lines, first.bytes, first.generation], [3, 13, 2]);
    assertEquals(content, "one\ntwo\nthree");
    assert(first.path.endsWith("/1-cs-0123456789-g2-test.log"), first.path);
    assert(!first.path.startsWith(checkout), "outside the clone");
    assert(second.kind === "saved");
    // a fresh name each time: no file is opened by path again
    assert(second.path.endsWith("/2-cs-0123456789-g2-test.log"), second.path);
    assertEquals(second.lines, 1);
    assert(badSuite.kind === "refused" && badSuite.reason.startsWith("suiteId:"));
    assert(badCheck.kind === "refused" && badCheck.reason.startsWith("check:"));
    assert(refused.kind === "refused");
    assertEquals(refused.reason, "suite cs-0123456789 runs no check");
    assert(down.kind === "refused");
    assertStringIncludes(down.reason, "could not be asked just now");
    assert(sortable.kind === "saved", JSON.stringify(sortable));
    assert(sortable.path.endsWith("/3-cs-01m4r5dasvernbfp25a77wb8f4-g1-rest.log"), sortable.path);
    assertEquals(asked.length, 5, "the malformed asks never reached the platform");
    assertEquals(asked[4], { suiteId: "cs-01m4r5dasvernbfp25a77wb8f4", check: "rest" });
    // the harness is done: the directory went with it
    assertEquals(await stat(first.path).then(() => "present", (e) => e.code), "ENOENT");
  } finally {
    await fx.cleanup();
  }
});

test("run_checks: a run that may not open patches uploads nothing and is refused", async () => {
  const { channel, requests } = recordingChecks(() => Promise.resolve("unused"));
  let outcome: RunChecksOutcome | null = null;
  let status: CheckStatusOutcome | null = null;
  const { fx } = await checksFixture(async (actions, dir) => {
    await agentCommit(dir, "a.txt", "a\n", "add a");
    outcome = await actions.runChecks({});
    status = await actions.checkStatus();
  }, { checks: channel });
  fx.item = { ...fx.item, canOpenPatches: false };
  try {
    await run(fx.item, fx.ctx);
    const got = outcome as RunChecksOutcome | null;
    assert(got?.kind === "refused");
    assertStringIncludes(got.reason, "may not open patches");
    assertEquals(requests, []);
    // and still reads them
    assertEquals((status as CheckStatusOutcome | null)?.kind, "answered");
  } finally {
    await fx.cleanup();
  }
});
