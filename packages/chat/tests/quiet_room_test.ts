// A quiet room: the platform's own bookkeeping lines are dropped — the "is on it" line in a
// conversation that already exists, and the closing line of a run that succeeded — while the
// 👀 on a mention, a response's alert, the opening post of a conversation the platform opens,
// and the closing line of every run that did not succeed are all still said.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { bindRun, makeApi, makeZulipRoom } from "./api.ts";
import { ZULIP_EMAIL, ZULIP_KEY, ZULIP_REALM, zulipMention } from "./fake_transport.ts";

const never = new AbortController().signal;

const closing = (outcome: string) => ({
  outcome,
  summary: "the cache was cold",
  patches: [],
  issues: [],
  runUrl: null,
});

test("a room is made quiet at creation or later, and says so", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    assertEquals(room.quiet, false);
    const hushed = await api.service.updateChatroom(room.id, { quiet: true });
    assertEquals([hushed?.name, hushed?.quiet], ["radicle", true]);
    const renamed = await api.service.updateChatroom(room.id, { name: "radicle org" });
    assertEquals([renamed?.name, renamed?.quiet], ["radicle org", true], "the switch stays");
    assertEquals(await api.service.updateChatroom("chr-none", { quiet: true }), null);
    const born = await api.service.createChatroom({
      kind: "zulip",
      name: "quiet from birth",
      realmUrl: ZULIP_REALM,
      botEmail: ZULIP_EMAIL,
      apiKey: ZULIP_KEY,
      ownerUserId: "u-plain",
      quiet: true,
    });
    assertEquals(born.quiet, true);
  } finally {
    await api.close();
  }
});

test("a mention in a quiet room is seen, bound and answered without the platform's lines", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    await api.service.updateChatroom(room.id, { quiet: true });
    api.sink.answer = (m) => ({
      kind: "verdict",
      verdict: { outcome: "started", reply: null, react: true, runId: "r-1", taskId: m.messageId },
    });
    api.zulip.deliver(ZULIP_KEY, zulipMention(101));
    await api.service.pollOnce(room.id, never);
    // The 👀 still says the bot heard.
    assertEquals(api.zulip.reactions.map((r) => r.messageId), ["101"]);

    // The run binds to the mention's conversation, and nothing announces it.
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "crash on sync" });
    await bindRun(api, room.id, "r-1", "101");
    assertEquals(api.zulip.sent, []);
    // The run's own words still reach the topic.
    await api.service.post("r-1", "Found it: the cache was cold.");
    assertEquals(api.zulip.sent.length, 1);

    // Success is the agent's own posts; the closing line is not said.
    await api.service.closeBinding("r-1", closing("succeeded"));
    assertEquals(api.zulip.sent.length, 1);
    assertEquals((await api.store.getBindingByRun("r-1"))?.state, "closed");

    // Anything else is still told, with the summary — nobody would otherwise learn the run
    // never answered.
    for (const [i, outcome] of ["failed", "errored", "cancelled", "lost"].entries()) {
      const runId = `r-${outcome}`;
      const key = String(200 + i);
      api.zulip.locations.set(key, { channel: { id: "4", name: "bugs" }, topic: outcome });
      await bindRun(api, room.id, runId, key);
      await api.service.closeBinding(runId, closing(outcome));
      const said = api.zulip.sent.at(-1)?.text ?? "";
      assert(said.includes(`finished with status \`${outcome}\``), said);
      assert(said.includes("the cache was cold"), said);
    }
  } finally {
    await api.close();
  }
});

test("a quiet room still shows a response's alert, and still opens a conversation with its line", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    await api.service.updateChatroom(room.id, { quiet: true });
    api.zulip.channels = [{ id: "4", name: "ops", visibility: "private" }];

    // A conversation the platform opens is keyed by its opening post, so the post is said.
    const opened = await bindRun(api, room.id, "r-1", {
      kind: "new",
      channelId: "4",
      topic: "api latency",
    });
    assertEquals(api.zulip.sent.length, 1);
    assertEquals(api.zulip.sent[0].id, opened.threadKey);
    assert(api.zulip.sent[0].text.includes("is on it"));
    await api.service.closeBinding("r-1", closing("succeeded"));
    assertEquals(api.zulip.sent.length, 1);

    // A response continuing that conversation with an alert: the alert only, no "is on it".
    const outcome = await api.service.openBinding({
      runId: "r-2",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "automation: api latency",
      runUrl: null,
      conversation: { kind: "continue", previousRunIds: ["r-1"], channelId: "4", topic: "x" },
      alert: { title: "p99 over 2s", payload: '{"p99":2.4}' },
    });
    assert(outcome.kind === "opened");
    assertEquals(outcome.binding.threadKey, opened.threadKey);
    assertEquals(api.zulip.sent.length, 2);
    const alert = api.zulip.sent.at(-1)!.text;
    assert(alert.startsWith("**p99 over 2s**\n```"), alert);
    assert(!alert.includes("is on it"), alert);

    // ...and without one, nothing at all.
    await api.service.closeBinding("r-2", closing("succeeded"));
    await bindRun(api, room.id, "r-3", {
      kind: "continue",
      previousRunIds: ["r-2"],
      channelId: "4",
      topic: "x",
    });
    assertEquals(api.zulip.sent.length, 2);
  } finally {
    await api.close();
  }
});

test("a run closes as quiet as the room was when it bound, whatever the switch says now", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "a" });
    api.zulip.locations.set("102", { channel: { id: "4", name: "bugs" }, topic: "b" });

    // Bound loud, made quiet mid-run: its agent was never told to post its own answer, so the
    // closing line is still said.
    await bindRun(api, room.id, "r-loud", "101");
    await api.service.updateChatroom(room.id, { quiet: true });
    const before = api.zulip.sent.length;
    await api.service.closeBinding("r-loud", closing("succeeded"));
    assertEquals(api.zulip.sent.length, before + 1);
    assert(api.zulip.sent.at(-1)!.text.includes("the cache was cold"));

    // Bound quiet, made loud mid-run: it was told to answer itself, and did; no line.
    await bindRun(api, room.id, "r-quiet", "102");
    await api.service.updateChatroom(room.id, { quiet: false });
    const then = api.zulip.sent.length;
    await api.service.closeBinding("r-quiet", closing("succeeded"));
    assertEquals(api.zulip.sent.length, then);
  } finally {
    await api.close();
  }
});
