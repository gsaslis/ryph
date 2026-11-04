// The schedule path: a cron recipe fires through the same queue a webhook fire rides, its
// clock advances from now (missed slots are skipped, never made up), and the floor refuses
// an expression that would fire too often.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { api, fakeClock, makeService } from "./harness.ts";

const scheduleBody = (cron: string, over: Record<string, unknown> = {}) => ({
  name: "nightly triage",
  trigger: { kind: "schedule", cron, timezone: "UTC" },
  agentId: "agent-1",
  target: { kind: "repo", connectedRepoId: "repo-1", ref: null },
  instructions: "summarize the night",
  ...over,
});

test("a due schedule enqueues one fire, delivers it, and advances its clock", async () => {
  const clock = fakeClock(Date.parse("2026-01-01T08:59:00.000Z"));
  const svc = await makeService({ clock });
  try {
    const created = await api(svc, "POST", "/v1/automations", scheduleBody("0 9 * * *"));
    assertEquals(created.status, 201);
    const { automation, secret } = await created.json();
    assertEquals(secret, undefined); // a schedule has no sender, so nothing to paste anywhere
    assertEquals(automation.trigger.nextDueAt, "2026-01-01T09:00:00.000Z");

    assertEquals(await svc.automations.schedulerTick(), 0); // not due yet

    clock.advance(2 * 60_000); // 09:01
    assertEquals(await svc.automations.schedulerTick(), 1);
    assertEquals(await svc.automations.schedulerTick(), 0); // the clock advanced

    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 1);
    assertEquals(svc.delivered[0].automationId, automation.id);
    assert(svc.delivered[0].payload.includes("firedAt"));
    // A schedule's body is our own, not a sender's report: nothing for a format to read.
    assertEquals(svc.delivered[0].signal, { status: "unknown", key: null, title: null });

    const read = await (await api(svc, "GET", `/v1/automations/${automation.id}`)).json();
    assertEquals(read.automation.trigger.nextDueAt, "2026-01-02T09:00:00.000Z");
    assertEquals(read.automation.trigger.lastFiredAt, "2026-01-01T09:01:00.000Z");
  } finally {
    await svc.db.close();
  }
});

test("slots that pass while nothing ticks are skipped, not replayed", async () => {
  const clock = fakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const svc = await makeService({ clock });
  try {
    const { automation } = await (await api(
      svc,
      "POST",
      "/v1/automations",
      scheduleBody("0 * * * *"), // hourly
    )).json();

    clock.advance(5 * 60 * 60_000); // five slots pass unticked
    assertEquals(await svc.automations.schedulerTick(), 1); // one fire, not five

    const read = await (await api(svc, "GET", `/v1/automations/${automation.id}`)).json();
    assertEquals(read.automation.trigger.nextDueAt, "2026-01-01T06:00:00.000Z");
  } finally {
    await svc.db.close();
  }
});

test("the floor and the field count are enforced at creation with a 422", async () => {
  const svc = await makeService();
  try {
    assertEquals(
      (await api(svc, "POST", "/v1/automations", scheduleBody("* * * * *"))).status,
      422,
    );
    assertEquals(
      (await api(svc, "POST", "/v1/automations", scheduleBody("0 0 9 * * 1"))).status,
      422,
    );
  } finally {
    await svc.db.close();
  }
});

test("a due schedule whose mailbox drifted away is re-seated and still fires", async () => {
  const clock = fakeClock(Date.parse("2026-01-01T08:59:00.000Z"));
  const svc = await makeService({ clock });
  try {
    const { automation } = await (await api(
      svc,
      "POST",
      "/v1/automations",
      scheduleBody("0 9 * * *"),
    )).json();

    // The drifted-registry shape: the table says enabled, the mailroom has no mailbox. The
    // tick must re-seat it from the fresh row rather than throw and dam the queue behind it.
    svc.webhooks.unregister(automation.id);
    clock.advance(2 * 60_000); // 09:01 — due
    assertEquals(await svc.automations.schedulerTick(), 1);

    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 1);
    assertEquals(svc.delivered[0].automationId, automation.id);
  } finally {
    await svc.db.close();
  }
});

test("re-enabling a paused schedule restarts its clock from now", async () => {
  const clock = fakeClock(Date.parse("2026-01-01T00:30:00.000Z"));
  const svc = await makeService({ clock });
  try {
    const { automation } = await (await api(
      svc,
      "POST",
      "/v1/automations",
      scheduleBody("0 * * * *"),
    )).json();
    await api(svc, "POST", `/v1/automations/${automation.id}/disable`);

    clock.advance(4 * 60 * 60_000); // paused across four slots
    assertEquals(await svc.automations.schedulerTick(), 0); // disabled fires nothing

    await api(svc, "POST", `/v1/automations/${automation.id}/enable`);
    const read = await (await api(svc, "GET", `/v1/automations/${automation.id}`)).json();
    assertEquals(read.automation.trigger.nextDueAt, "2026-01-01T05:00:00.000Z");
  } finally {
    await svc.db.close();
  }
});

test("the keep-warm tick asks once per owner and target, and skips paused automations", async () => {
  const svc = await makeService();
  try {
    await api(svc, "POST", "/v1/automations", scheduleBody("0 9 * * *"));
    await api(svc, "POST", "/v1/automations", scheduleBody("0 21 * * *", { name: "evening" }));
    const { automation: other } = await (await api(
      svc,
      "POST",
      "/v1/automations",
      scheduleBody("0 9 * * *", {
        target: { kind: "repo", connectedRepoId: "repo-2", ref: null },
      }),
    )).json();

    assertEquals(await svc.automations.accessTick(), 2);
    assertEquals(
      svc.probes.map((p) => p.target.kind === "repo" ? p.target.connectedRepoId : null).sort(),
      ["repo-1", "repo-2"],
    );

    const stored = await svc.store.getAutomation(other.id);
    assert(stored !== null);
    await svc.store.saveAutomation({ ...stored, enabled: false });
    assertEquals(await svc.automations.accessTick(), 1);
  } finally {
    await svc.db.close();
  }
});
