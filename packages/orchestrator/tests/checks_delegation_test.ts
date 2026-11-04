// Receiver delegation identity is independent of the shared PAT owner and ordinary CLI asks.
// Real checks service and memory stores: no delegation methods are mocked.
import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { LocalChecksInput } from "../src/core/checks.ts";
import { checksWorld, HEAD, sha } from "./checks_world.ts";

const USER = { userId: "receiver-pat-owner", name: "Receiver" };
const OTHER = sha("e");

async function receiver(maxLocalPerUser = 10) {
  const w = await checksWorld({ policy: { maxConcurrent: 0, maxLocalPerUser } });
  const heads = new Map<string, string>();
  w.forge.readBranchHead = (_repo, _url, branch) =>
    Promise.resolve(
      heads.has(branch) ? { kind: "head", sha: heads.get(branch)! } : { kind: "absent" },
    );
  const ask = async (delegationId?: string, over: Partial<LocalChecksInput> = {}) => {
    const input: LocalChecksInput = {
      user: USER,
      repo: w.api,
      commit: HEAD,
      branch: "shared-branch",
      bundled: false,
      delegationId,
      ...over,
    };
    heads.set(input.branch, input.commit);
    return await w.service.requestLocal(input);
  };
  const requested = async (delegationId?: string, over: Partial<LocalChecksInput> = {}) => {
    const answer = await ask(delegationId, over);
    assert(answer.kind === "requested");
    assert(answer.suite !== null);
    return answer;
  };
  const state = async (id: string) => (await w.checkStore.getRequest(id))?.state;
  return { ...w, ask, requested, state };
}

test("shared PAT delegations on the same branch remain independent from each other and CLI asks", async () => {
  const w = await receiver();
  const cli = await w.requested();
  w.clock.advance(1_000);
  const first = await w.requested("instance-a:run-1");
  w.clock.advance(1_000);
  const second = await w.requested("instance-a:run-2");
  assertEquals(new Set([cli.request.id, first.request.id, second.request.id]).size, 3);
  assertEquals(await w.state(cli.request.id), "active");
  assertEquals(await w.state(first.request.id), "active");
  assertEquals(await w.state(second.request.id), "active");
  assertEquals(first.suite!.id, second.suite!.id, "identical work still shares a suite");

  w.clock.advance(1_000);
  const replacement = await w.requested("instance-a:run-1", { commit: OTHER });
  assertEquals(await w.state(first.request.id), "superseded");
  assertEquals(await w.state(replacement.request.id), "active");
  assertEquals(await w.state(second.request.id), "active");
  assertEquals(await w.state(cli.request.id), "active");

  w.clock.advance(1_000);
  await w.requested(undefined, { commit: OTHER });
  assertEquals(await w.state(cli.request.id), "superseded");
  assertEquals(await w.state(second.request.id), "active");
  assertEquals(await w.state(replacement.request.id), "active");
});

test("same delegation identity retries return its request for pushed and bundled heads", async () => {
  for (const bundled of [false, true]) {
    const w = await receiver();
    const first = await w.requested("instance-a:run-1", { bundled });
    w.clock.advance(1_000);
    const second = await w.requested("instance-a:run-2", { bundled });
    w.clock.advance(1_000);
    const retry = await w.requested("instance-a:run-1", { bundled });
    assertEquals(retry.request.id, first.request.id);
    assertEquals(retry.suite!.id, first.suite!.id);
    assertEquals(await w.state(second.request.id), "active");
    assertEquals(w.checkStore.requests.size, 2);
  }
});

test("delegation cancellation only withdraws its owner's request and preserves a shared suite", async () => {
  const w = await receiver();
  const first = await w.requested("instance-a:run-1");
  const second = await w.requested("instance-a:run-2");
  const cli = await w.requested();
  assertEquals(first.suite!.id, second.suite!.id);
  assertEquals(first.suite!.id, cli.suite!.id);
  assertEquals(await w.service.cancelDelegation(first.request.id, "another-user"), false);
  assertEquals(await w.service.cancelDelegation("missing", USER.userId), false);
  assertEquals(await w.service.cancelDelegation(cli.request.id, USER.userId), false);
  assertEquals(await w.state(first.request.id), "active");
  assertEquals(await w.service.cancelDelegation(first.request.id, USER.userId), true);
  assertEquals(await w.service.cancelDelegation(first.request.id, USER.userId), true);
  assertEquals(await w.state(first.request.id), "superseded");
  assertEquals(await w.state(second.request.id), "active");
  assertEquals(await w.state(cli.request.id), "active");
  assertEquals((await w.checkStore.getSuite(first.suite!.id))!.state, "queued");
});

test("concurrent independent delegations sharing a PAT and branch cannot supersede each other", async () => {
  const w = await receiver();
  const list = w.checkStore.listLiveLocalRequests;
  let initialReads = 0;
  // Both calls observe the pre-insert snapshot; post-insert checks see the real store.
  w.checkStore.listLiveLocalRequests = async (userId) => {
    const rows = await list(userId);
    return ++initialReads <= 2 ? [] : rows;
  };
  const answers = await Promise.all([
    w.ask("instance-a:run-1", { bundled: true }),
    w.ask("instance-a:run-2", { bundled: true }),
  ]);
  w.checkStore.listLiveLocalRequests = list;
  for (const answer of answers) {
    assert(answer.kind === "requested");
    assertEquals(await w.state(answer.request.id), "active");
  }
  assertEquals((await list(USER.userId)).length, 2);
});

test("concurrent retries of one delegation identity leave one standing request", async () => {
  const w = await receiver();
  const list = w.checkStore.listLiveLocalRequests;
  let initialReads = 0;
  w.checkStore.listLiveLocalRequests = async (userId) => {
    const rows = await list(userId);
    return ++initialReads <= 2 ? [] : rows;
  };
  await Promise.all([
    w.ask("instance-a:run-1", { bundled: true }),
    w.ask("instance-a:run-1", { bundled: true }),
  ]);
  w.checkStore.listLiveLocalRequests = list;
  const live = await list(USER.userId);
  assertEquals(live.length, 1);
  const retry = await w.requested("instance-a:run-1", { bundled: true });
  assertEquals(retry.request.id, live[0].id);
});

test("concurrent distinct identities on one branch cannot bypass the shared owner's quota", async () => {
  const w = await receiver(2);
  const standing = await w.requested("instance-a:standing");
  const list = w.checkStore.listLiveLocalRequests;
  let initialReads = 0;
  w.checkStore.listLiveLocalRequests = async (userId) => {
    const rows = await list(userId);
    return ++initialReads <= 2 ? rows.filter((r) => r.id === standing.request.id) : rows;
  };
  const answers = await Promise.all([
    w.ask("instance-a:run-1", { bundled: true }),
    w.ask("instance-a:run-2", { bundled: true }),
  ]);
  w.checkStore.listLiveLocalRequests = list;
  assert(answers.some((answer) => answer.kind === "quota"));
  assert((await list(USER.userId)).length <= 2);
  assertEquals(
    await w.state(standing.request.id),
    "active",
    "quota refusals never replace the standing identity",
  );
});

test("independent delegations count against the shared owner's cap; only own identity is replaceable", async () => {
  const w = await receiver(1);
  const first = await w.requested("instance-a:run-1");
  assertEquals(
    await w.service.localQuota(USER.userId, w.api.id, "shared-branch", "instance-a:run-1"),
    { live: 0, max: 1 },
  );
  assertEquals(
    await w.service.localQuota(USER.userId, w.api.id, "shared-branch", "instance-a:run-2"),
    { live: 1, max: 1 },
  );
  assertEquals(await w.service.localQuota(USER.userId, w.api.id, "shared-branch"), {
    live: 1,
    max: 1,
  });
  assertEquals((await w.ask("instance-a:run-2")).kind, "quota");
  assertEquals(
    (await w.ask()).kind,
    "quota",
    "CLI cannot exclude a delegated ask on the same branch",
  );
  const retry = await w.requested("instance-a:run-1");
  assertEquals(retry.request.id, first.request.id);
  w.clock.advance(1_000);
  const replacement = await w.requested("instance-a:run-1", { commit: OTHER });
  assertEquals(await w.state(first.request.id), "superseded");
  assertEquals(await w.state(replacement.request.id), "active");
  assertEquals(await w.service.cancelDelegation(replacement.request.id, USER.userId), true);
  assertEquals((await w.ask("instance-a:run-2")).kind, "requested", "withdrawal releases quota");
});
