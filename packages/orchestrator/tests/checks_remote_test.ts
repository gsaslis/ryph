import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  type RemoteChecks,
  RemoteChecksError,
  type RemoteCheckSnapshot,
} from "../src/ports/remote_checks.ts";
import { requestedText } from "../src/core/check_feedback.ts";
import { checksFile, checksWorld, HEAD, sha } from "./checks_world.ts";

async function remoteWorld() {
  const b = await checksWorld({ policy: { maxConcurrent: 0 } });
  await b.request();
  const upstream = b.onlySuite();
  upstream.image = "receiver-only@sha256:" + sha("f");
  upstream.environmentKey = "image:receiver-only";
  upstream.definition.checks[0].run = "receiver lint";
  let snapshot: RemoteCheckSnapshot = {
    requestId: "remote-request",
    suite: upstream,
    results: await b.checkStore.listResults(upstream.id, upstream.generation),
  };
  let submits = 0;
  const cancelled: string[] = [];
  const remote: RemoteChecks = {
    endpoint: "https://checks.example",
    readChecksFile: () =>
      Promise.resolve(checksFile({ text: "checks:\n  - name: receiver\n    run: receiver\n" })),
    submit: () => {
      submits++;
      return Promise.resolve(structuredClone(snapshot));
    },
    read: () => Promise.resolve(structuredClone(snapshot)),
    cancel: (ref) => {
      cancelled.push(ref.requestId);
      return Promise.resolve();
    },
    log: () => Promise.resolve("receiver log\n"),
  };
  const a = await checksWorld({ remote, noLauncher: true, noEnvironments: true });
  return {
    a,
    b,
    remote,
    cancelled,
    submits: () => submits,
    setSnapshot: (next: RemoteCheckSnapshot) => {
      snapshot = next;
    },
    snapshot: () => snapshot,
  };
}

/** Ends the run that asked for the checks. `saveRun` only inserts, so this goes through a transition. */
async function finishRun(w: Awaited<ReturnType<typeof remoteWorld>>) {
  const live = (await w.a.store.getRun(w.a.run.id))!;
  assert(await w.a.store.saveRunTransition({ ...live, state: "succeeded" }, live));
}

test("sender mirrors receiver definitions/images/results and logs without local forge or launcher", async () => {
  const w = await remoteWorld();
  await w.a.request();
  const suite = w.a.onlySuite();
  assertEquals(suite.commit, HEAD);
  assertEquals(suite.definition.checks[0].run, "receiver lint");
  assertEquals(suite.image, w.b.onlySuite().image);
  assertEquals(suite.remote?.suiteId, w.b.onlySuite().id);
  assertEquals(w.a.reads, []);
  assertEquals(w.a.reports, []);
  const snapshot = w.snapshot();
  w.setSnapshot({
    ...snapshot,
    suite: { ...snapshot.suite!, state: "passed", finishedAt: w.a.clock.now().toISOString() },
    results: snapshot.results.map((r) => ({ ...r, state: "passed", exitCode: 0 })),
  });
  await w.a.service.tick();
  assertEquals(w.a.onlySuite().state, "passed");
  assertEquals(await w.a.service.log(suite.id, 1, "lint"), "receiver log\n");
  assertEquals(w.a.reports, []);
  assertEquals(w.submits(), 1);
});

test("remote transport failure stays pending and never falls back to local resolution", async () => {
  const w = await remoteWorld();
  w.remote.submit = () => Promise.reject(new Error("receiver unavailable"));
  await w.a.request();
  assertEquals(w.a.suites(), []);
  assertEquals(w.a.reads, []);
  const request = [...w.a.checkStore.requests.values()][0];
  assertEquals(request.state, "pending");
  assert(request.note?.startsWith("This ryph instance runs its checks on another ryph instance"));
  assert(request.note?.includes("could not be reached"));
});

test("a limit or a refused token on the receiver says so, and the run is told why it waits", async () => {
  for (
    const [status, says] of [
      [429, "has reached that instance's limit"],
      [401, "renews the remote checks token"],
    ] as const
  ) {
    const w = await remoteWorld();
    w.remote.submit = () => Promise.reject(new RemoteChecksError(status, "refused"));
    await w.a.request();
    const request = [...w.a.checkStore.requests.values()][0];
    assertEquals(request.state, "pending");
    assert(request.note?.includes(says), `${status}: ${request.note}`);
    // what the tool answers: the wait as it is, not a checks file that could not be read
    const text = requestedText({ request, suite: null, reused: false, repoRef: "acme/api" });
    assert(text.includes("not started yet"), text);
    assert(text.includes(says), text);
    assert(!text.includes("could not read"), text);
  }
});

for (const status of [403, 404, 409]) {
  for (const pending of [false, true]) {
    test(`remote HTTP ${status} refuses a ${pending ? "pending" : "new"} patch request`, async () => {
      const w = await remoteWorld();
      let calls = 0;
      const reject = () => {
        calls++;
        return Promise.reject(new RemoteChecksError(status, "refused"));
      };
      if (pending) {
        w.setSnapshot({ requestId: "remote-request", suite: null, results: [] });
        w.remote.read = reject;
      } else {
        w.remote.submit = reject;
      }
      const patch = w.a.patchOf({ headSha: HEAD });
      await w.a.store.createPatch(patch);
      await w.a.service.patchOpened(patch);
      await w.a.service.tick();
      if (pending) {
        assertEquals(await w.a.awaiting(), 1);
        w.a.clock.advance(10 * 60_000);
        await w.a.service.tick();
      }
      const request = [...w.a.checkStore.requests.values()][0];
      assertEquals(request.state, "refused");
      assertEquals(request.nextAttemptAt, null);
      assert(request.note?.includes(`HTTP ${status}`));
      const text = requestedText({ request, suite: null, reused: false, repoRef: "acme/api" });
      assert(
        text.includes("This ryph instance is configured to run checks on a remote Ryph instance"),
      );
      assert(text.includes("not be retried automatically or block this run from finishing"));
      assert(text.includes("Explain this verification limitation to the user"));
      const reason = status === 403
        ? "denied access"
        : status === 409
        ? "current configuration"
        : pending
        ? "previously accepted check request"
        : "may not have this repository connected";
      assert(text.includes(reason), text);
      assert(text.includes("Ask the user to have its operator"));
      assert(text.includes("request checks again after the configuration is corrected"));
      if (status === 404 && !pending) assert(text.includes("verify that checks are enabled"));
      if (status === 404 && pending) assert(text.includes("token's identity and access"));
      assertEquals(await w.a.awaiting(), 0);
      w.a.clock.advance(10 * 60_000);
      await w.a.service.tick();
      assertEquals(calls, 1);
      assertEquals(w.a.suites(), []);
      assertEquals(w.a.reads, []);
    });
  }
}

test("remote checks refuse local repositories without submitting or holding finish", async () => {
  const w = await remoteWorld();
  await w.a.store.saveConnectedRepo({ ...w.a.api, provider: "local" });
  await w.a.request();
  const request = [...w.a.checkStore.requests.values()][0];
  assertEquals(request.state, "refused");
  assert(request.note?.includes("local repository"));
  assert(request.note?.includes("configured to run checks on a remote Ryph instance"));
  assert(request.note?.includes("checks need to be run locally"));
  assertEquals(await w.a.awaiting(), 0);
  assertEquals(w.submits(), 0);
  assertEquals(w.a.suites(), []);
});

test("wrong receiver commit cannot become a passing local verdict", async () => {
  const w = await remoteWorld();
  const snapshot = w.snapshot();
  w.setSnapshot({ ...snapshot, suite: { ...snapshot.suite!, commit: sha("e") } });
  await w.a.request();
  assertEquals(w.a.suites(), []);
  assertEquals(w.a.reads, []);
});

test("a pending receiver request is durable and polled instead of submitted twice", async () => {
  const w = await remoteWorld();
  const snapshot = w.snapshot();
  w.setSnapshot({ requestId: snapshot.requestId, suite: null, results: [] });
  await w.a.request();
  assertEquals(w.a.suites(), []);
  assertEquals([...w.a.checkStore.requests.values()][0].remote?.requestId, snapshot.requestId);
  w.setSnapshot(snapshot);
  w.a.clock.advance(10 * 60_000);
  await w.a.service.tick();
  assertEquals(w.a.onlySuite().remote?.suiteId, snapshot.suite!.id);
  assertEquals(w.submits(), 1);
});

for (const unresolved of [false, true]) {
  test(`failed remote cancellation retries durably (${unresolved ? "pending" : "suite"})`, async () => {
    const w = await remoteWorld();
    if (unresolved) w.setSnapshot({ requestId: "remote-request", suite: null, results: [] });
    await w.a.request();
    await finishRun(w);
    let attempts = 0;
    w.remote.cancel = () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve();
    };
    await w.a.service.tick();
    const request = [...w.a.checkStore.requests.values()][0];
    assertEquals(request.state, unresolved ? "pending" : "superseded");
    if (unresolved) assertEquals(request.note, "remote delegation withdrawal pending");
    else assertEquals(w.a.onlySuite().state, "queued");
    w.a.clock.advance(10 * 60_000);
    await w.a.service.tick();
    assertEquals([...w.a.checkStore.requests.values()][0].state, "superseded");
    if (!unresolved) assertEquals(w.a.onlySuite().state, "cancelled");
    assert(attempts >= 2);
  });
}

test("in-flight resolution cannot erase a pending withdrawal marker", async () => {
  const w = await remoteWorld();
  let entered!: () => void;
  const submitting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  w.remote.submit = async () => {
    if (++calls === 1) {
      entered();
      await gate;
    }
    return structuredClone(w.snapshot());
  };
  w.remote.cancel = () => Promise.reject(new Error("DELETE offline"));
  const asking = w.a.request();
  await submitting;
  await finishRun(w);
  await w.a.service.tick();
  release();
  await asking;
  const request = [...w.a.checkStore.requests.values()][0];
  assertEquals(request.state, "pending");
  assertEquals(request.note, "remote delegation withdrawal pending");
  assertEquals(request.remote?.requestId, "remote-request");
  w.remote.cancel = () => Promise.resolve();
  w.a.clock.advance(10 * 60_000);
  await w.a.service.tick();
  assertEquals((await w.a.checkStore.getRequest(request.id))?.state, "superseded");
});

test("a late failed poll cannot remove independent cleanup after failed DELETE", async () => {
  const w = await remoteWorld();
  await w.a.request();
  let entered!: () => void;
  const polling = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  w.remote.read = async () => {
    if (++reads === 1) {
      entered();
      await gate;
      return { requestId: "remote-request", suite: null, results: [], refused: true };
    }
    return structuredClone(w.snapshot());
  };
  w.remote.cancel = () => Promise.reject(new Error("DELETE offline"));
  const oldPoll = w.a.service.tick();
  await polling;
  await finishRun(w);
  await w.a.service.tick();
  release();
  await oldPoll;
  const cleanup = [...w.a.checkStore.requests.values()].filter((r) =>
    r.note === "remote delegation withdrawal pending"
  );
  assertEquals(cleanup.length, 1);
  assertEquals(cleanup[0].state, "pending");
  assertEquals(
    w.a.onlySuite().state,
    "queued",
    "late receiver refusal does not settle a withdrawn mirror",
  );
  w.remote.cancel = () => Promise.resolve();
  w.a.clock.advance(10 * 60_000);
  await w.a.service.tick();
  assertEquals((await w.a.checkStore.getRequest(cleanup[0].id))?.state, "superseded");
  assertEquals(w.a.onlySuite().state, "cancelled");
});

test("repeated remote failure and failed terminal persistence share one cleanup row", async () => {
  const w = await remoteWorld();
  await w.a.request();
  const save = w.a.checkStore.saveSuiteIf;
  w.a.checkStore.saveSuiteIf = (suite, expected) =>
    suite.state === "error" ? Promise.resolve(false) : save(suite, expected);
  w.setSnapshot({ requestId: "remote-request", suite: null, results: [], refused: true });
  w.remote.cancel = () => Promise.reject(new Error("DELETE offline"));
  for (let i = 0; i < 3; i++) await w.a.service.tick();
  assertEquals(
    [...w.a.checkStore.requests.values()].filter((r) =>
      r.note === "remote delegation withdrawal pending"
    ).length,
    1,
  );
});

for (const ambiguous of [false, true]) {
  test(`pending remote outage preserves cleanup after a day (${ambiguous ? "uncertain submit" : "known reference"})`, async () => {
    const w = await remoteWorld();
    const submitted: string[] = [];
    let recovered = false;
    w.remote.submit = ({ request }) => {
      submitted.push(request.id);
      if (ambiguous && !recovered) return Promise.reject(new Error("response lost"));
      return Promise.resolve({ requestId: "remote-request", suite: null, results: [] });
    };
    w.remote.read = () => Promise.reject(new Error("offline"));
    w.remote.cancel = () => recovered ? Promise.resolve() : Promise.reject(new Error("offline"));
    await w.a.request();
    const original = [...w.a.checkStore.requests.values()][0];
    w.a.clock.advance(25 * 60 * 60_000);
    await w.a.service.tick();
    assertEquals((await w.a.checkStore.getRequest(original.id))?.state, "refused");
    const cleanup = [...w.a.checkStore.requests.values()].find((r) =>
      r.note === "remote delegation withdrawal pending"
    );
    assert(cleanup !== undefined);
    assertEquals(cleanup.state, "pending");
    assertEquals(cleanup.source.remoteCleanupSubmissionId, original.id);
    recovered = true;
    w.a.clock.advance(10 * 60_000);
    await w.a.service.tick();
    assertEquals((await w.a.checkStore.getRequest(cleanup.id))?.state, "superseded");
    assert(
      submitted.every((id) => id === original.id),
      "cleanup must not mint a second submission identity",
    );
    assertEquals((await w.a.checkStore.getRequest(original.id))?.state, "refused");
  });
}

test("receiver delegation retries after cancellation and expiry never create fresh execution", async () => {
  for (const expired of [false, true]) {
    const w = await checksWorld({ policy: { maxConcurrent: 0 } });
    const input = {
      user: { userId: "receiver-owner", name: "Owner" },
      repo: w.api,
      commit: HEAD,
      branch: "delegated",
      bundled: true,
      delegationId: "stable-submission",
    };
    const first = await w.service.requestLocal(input);
    assert(first.kind === "requested");
    if (expired) {
      w.clock.advance(25 * 60 * 60_000);
      await w.service.tick();
    } else {
      await w.service.cancelDelegation(first.request.id, input.user.userId);
    }
    assertEquals((await w.checkStore.getRequest(first.request.id))?.state, "superseded");
    const retry = await w.service.requestLocal(input);
    assert(retry.kind === "requested");
    assertEquals(retry.request.id, first.request.id);
    assertEquals(retry.request.state, "superseded");
    assertEquals(w.checkStore.requests.size, 1);
    assertEquals(w.suites().length, 1);
    assertEquals(w.onlySuite().generation, 1);
    assertEquals(w.onlySuite().state, "cancelled");
  }
});

test("active remote outages back off and fail after a day without resetting the deadline", async () => {
  const w = await remoteWorld();
  await w.a.request();
  let reads = 0;
  w.remote.read = () => {
    reads++;
    return Promise.reject(new Error("offline"));
  };
  const observedAt = w.a.onlySuite().updatedAt;
  await w.a.service.tick();
  assertEquals(w.a.onlySuite().updatedAt, observedAt);
  assert(w.a.onlySuite().nextAttemptAt !== null);
  await w.a.service.tick();
  assertEquals(reads, 1, "backoff avoids an immediate second read");
  w.a.clock.advance(25 * 60 * 60_000);
  await w.a.service.tick();
  assertEquals(w.a.onlySuite().state, "error");
  assert(w.a.onlySuite().reason?.includes("unavailable for a day"));
});

test("active remote refusal settles instead of hanging indefinitely", async () => {
  const w = await remoteWorld();
  await w.a.request();
  w.setSnapshot({
    requestId: "remote-request",
    suite: null,
    results: [],
    refused: true,
    note: "receiver withdrew",
  });
  await w.a.service.tick();
  assertEquals(w.a.onlySuite().state, "error");
  assertEquals(w.a.onlySuite().reason, "receiver withdrew");
});

test("remote failure cannot synthesize a pass and cleanup retries after the error verdict", async () => {
  const w = await remoteWorld();
  const snapshot = w.snapshot();
  w.setSnapshot({
    ...snapshot,
    suite: { ...snapshot.suite!, state: "running" },
    results: snapshot.results.map((r) => ({ ...r, state: "passed", exitCode: 0 })),
  });
  await w.a.request();
  w.setSnapshot({ requestId: "remote-request", suite: null, results: [], refused: true });
  let reachable = false;
  let cancelled = 0;
  w.remote.cancel = () => {
    if (!reachable) return Promise.reject(new Error("offline"));
    cancelled++;
    return Promise.resolve();
  };
  await w.a.service.tick();
  assertEquals(
    w.a.onlySuite().state,
    "error",
    "per-check passes do not prove B's terminal verdict",
  );
  const cleanup = [...w.a.checkStore.requests.values()].find((r) =>
    r.note === "remote delegation withdrawal pending"
  );
  assert(cleanup !== undefined);
  assertEquals(cleanup.state, "pending");
  reachable = true;
  w.a.clock.advance(10 * 60_000);
  await w.a.service.tick();
  assertEquals((await w.a.checkStore.getRequest(cleanup.id))?.state, "superseded");
  assertEquals(cancelled, 1);
  assertEquals(w.a.onlySuite().state, "error");
});

test("failed initial results write never publishes a terminal mirror", async () => {
  const w = await remoteWorld();
  const snapshot = w.snapshot();
  w.setSnapshot({
    ...snapshot,
    suite: { ...snapshot.suite!, state: "passed" },
    results: snapshot.results.map((r) => ({ ...r, state: "passed", exitCode: 0 })),
  });
  const original = w.a.checkStore.upsertResults;
  w.a.checkStore.upsertResults = () => Promise.reject(new Error("write failed"));
  await w.a.request();
  assertEquals(w.a.onlySuite().state, "queued");
  assertEquals([...w.a.checkStore.requests.values()][0].state, "pending");
  w.a.checkStore.upsertResults = original;
  w.a.clock.advance(10 * 60_000);
  await w.a.service.tick();
  assertEquals(w.a.onlySuite().state, "passed");
});

test("returning to local execution never inherits a remote pass", async () => {
  const w = await checksWorld({ policy: { maxConcurrent: 0 } });
  await w.request();
  const remoteSuite = w.onlySuite();
  remoteSuite.remote = {
    endpoint: "https://old.example",
    requestId: "old-request",
    suiteId: "old-suite",
  };
  remoteSuite.inputsKey = "remote-old";
  remoteSuite.state = "passed";
  await w.checkStore.upsertResults(
    (await w.checkStore.listResults(remoteSuite.id, 1)).map((r) => ({
      ...r,
      state: "passed",
      exitCode: 0,
    })),
  );
  await w.request();
  const local = w.suites().find((s) => s.remote == null)!;
  assert(local !== undefined);
  const results = await w.checkStore.listResults(local.id, local.generation);
  assertEquals(results.map((r) => r.state), ["queued", "queued"]);
  assertEquals(results.map((r) => r.inheritedFrom), [null, null]);
});

test("remote polling advances beyond the first page even while earlier suites keep failing", async () => {
  const w = await remoteWorld();
  await w.a.request();
  const template = w.a.onlySuite();
  const request = [...w.a.checkStore.requests.values()][0];
  const seen = new Set<string>();
  w.a.checkStore.suites.clear();
  w.a.checkStore.requests.clear();
  for (let i = 0; i < 55; i++) {
    const id = `suite-${String(i).padStart(3, "0")}`;
    const remote = {
      endpoint: w.remote.endpoint,
      requestId: `request-${i}`,
      suiteId: `receiver-${i}`,
    };
    w.a.checkStore.suites.set(id, { ...template, id, remote });
    w.a.checkStore.requests.set(`request-${i}`, {
      ...request,
      id: `request-${i}`,
      suiteId: id,
      remote,
    });
  }
  w.remote.read = (remote) => {
    seen.add(remote.requestId);
    return Promise.reject(new Error("offline"));
  };
  await w.a.service.tick();
  await w.a.service.tick();
  assertEquals(seen.size, 55);
});
