import { describe, expect, it } from "vitest";
import type { Automation } from "$lib/api/types";
import {
  awaitingPaste,
  datadogWebhookName,
  isPresetVerification,
  pastedSecretProblem,
  presetById,
  PRESETS,
  secretIsPasted,
  setupSteps,
} from "$lib/automations/presets";
import {
  applyPreset,
  blankResponse,
  blankTarget,
  blankTrigger,
  composeFormat,
  composeResponse,
  composeTarget,
  composeTrigger,
  defaultResponseChoice,
  firesPerMinuteOf,
  instructionsProblem,
  oneConversationReason,
  presetOf,
  responseChoiceOf,
  responseConflict,
  responseProblem,
  responseToFields,
  secretHint,
  secretToPaste,
  settleResponseChoice,
  sharedConversationNoun,
  targetProblem,
  targetToFields,
  triggerPatch,
  triggerProblem,
  triggerToFields,
  triggerYieldsKeys,
} from "./automation-steps";

const AGENTS = [
  { id: "a-live", archivedAt: null },
  { id: "a-gone", archivedAt: "2026-09-01T00:00:00.000Z" },
];

// A webhook from "something else", at the service's defaults.
const other = () => applyPreset(blankTrigger(), "other");

describe("triggerProblem", () => {
  it("wants a sender picked, then a one-line name", () => {
    expect(triggerProblem("Alerts", blankTrigger())).toMatch(/sends/);
    expect(triggerProblem("", other())).toMatch(/name/);
    expect(triggerProblem("a\nb", other())).toMatch(/one line/);
    expect(triggerProblem("Alerts", other())).toBeNull();
  });

  it("wants a custom mapping that reads something", () => {
    const t = { ...other(), formatKind: "custom" as const };
    expect(triggerProblem("x", t)).toMatch(/field/);
    expect(triggerProblem("x", { ...t, mapping: { ...t.mapping, status: "state" } }))
      .toMatch(/firing or resolved/);
    expect(
      triggerProblem("x", { ...t, mapping: { ...t.mapping, status: "state", firing: "open" } }),
    ).toBeNull();
    expect(triggerProblem("x", { ...t, mapping: { ...t.mapping, key: "id" } })).toBeNull();
  });

  it("holds a webhook to the service's bounds", () => {
    const t = other();
    expect(triggerProblem("x", { ...t, header: "a".repeat(101) })).toMatch(/header/);
    expect(triggerProblem("x", { ...t, prefix: "a".repeat(21) })).toMatch(/prefix/);
    expect(triggerProblem("x", { ...t, verification: "secret-header", prefix: "a".repeat(21) }))
      .toMatch(/prefix/);
    expect(
      triggerProblem("x", { ...t, verification: "standard-webhooks", prefix: "a".repeat(21) }),
    ).toBeNull();
    expect(triggerProblem("x", { ...t, firesPerMinute: 0 })).toMatch(/rate limit/);
    expect(triggerProblem("x", { ...t, firesPerMinute: 1.5 })).toMatch(/rate limit/);
    expect(triggerProblem("x", { ...t, firesPerMinute: 600 })).toBeNull();
  });

  it("wants five cron fields and a real timezone for a schedule", () => {
    const t = { ...blankTrigger(), kind: "schedule" as const, timezone: "Europe/Athens" };
    expect(triggerProblem("x", { ...t, cron: "" })).toMatch(/cron/);
    expect(triggerProblem("x", { ...t, cron: "* * * *" })).toMatch(/five fields/);
    expect(triggerProblem("x", { ...t, cron: "0 9 * * 1-5" })).toBeNull();
    expect(triggerProblem("x", { ...t, timezone: "" })).toMatch(/timezone/);
    expect(triggerProblem("x", { ...t, timezone: "Mars/Olympus" })).toMatch(/not a timezone/);
  });
});

describe("the trigger bridges", () => {
  it("sends a typed header and leaves an empty one to the service", () => {
    const t = other();
    expect(composeTrigger(t)).toEqual({
      kind: "webhook",
      verification: { kind: "hmac-sha256", prefix: "sha256=" },
      format: { kind: "raw" },
      rateLimit: { maxPerWindow: 1, windowMs: 60_000 },
    });
    expect(
      composeTrigger({ ...t, verification: "secret-header", header: " x-token ", prefix: "" }),
    ).toEqual({
      kind: "webhook",
      verification: { kind: "secret-header", header: "x-token" },
      format: { kind: "raw" },
      rateLimit: { maxPerWindow: 1, windowMs: 60_000 },
    });
    expect(composeTrigger({ ...t, kind: "schedule", cron: " 0 9 * * * ", timezone: "UTC" }))
      .toEqual({ kind: "schedule", cron: "0 9 * * *", timezone: "UTC" });
  });

  it("patches only the revisable half", () => {
    const t = applyPreset(blankTrigger(), "grafana");
    expect(triggerPatch({ ...t, firesPerMinute: 30 })).toEqual({
      format: { kind: "grafana" },
      rateLimit: { maxPerWindow: 30, windowMs: 60_000 },
    });
    expect(triggerPatch({ ...t, kind: "schedule", cron: "0 * * * *", timezone: "UTC" })).toEqual({
      cron: "0 * * * *",
      timezone: "UTC",
    });
  });

  it("reads a saved trigger back, whatever window the limit was saved with", () => {
    const webhook: Automation["trigger"] = {
      kind: "webhook",
      verification: { kind: "hmac-sha256", header: "x-sig", prefix: "", secretSource: "minted" },
      format: { kind: "sentry" },
      rateLimit: { maxPerWindow: 10, windowMs: 120_000 },
      path: "/hooks/x",
    };
    expect(triggerToFields(webhook)).toMatchObject({
      kind: "webhook",
      preset: "sentry",
      verification: "hmac-sha256",
      header: "x-sig",
      prefix: "",
      firesPerMinute: 5,
    });
    expect(firesPerMinuteOf({ maxPerWindow: 1, windowMs: 24 * 60 * 60_000 })).toBe(1);
    const custom = triggerToFields({
      ...webhook,
      format: {
        kind: "custom",
        mapping: {
          status: ["a", "b"],
          firing: ["x"],
          resolved: [],
          update: [],
          key: [],
          title: [],
        },
      },
    });
    expect(custom).toMatchObject({
      preset: "other",
      formatKind: "custom",
      mapping: { status: "a, b", firing: "x" },
    });
    expect(composeFormat(custom)).toEqual({
      kind: "custom",
      mapping: { status: ["a", "b"], firing: ["x"], resolved: [], update: [], key: [], title: [] },
    });
    const schedule: Automation["trigger"] = {
      kind: "schedule",
      cron: "0 9 * * 1",
      timezone: "Europe/Athens",
      nextDueAt: null,
      lastFiredAt: null,
    };
    expect(triggerToFields(schedule)).toMatchObject({
      kind: "schedule",
      cron: "0 9 * * 1",
      timezone: "Europe/Athens",
    });
  });

  it("names a preset by its expression, however spaced", () => {
    expect(presetOf("0 9  * * 1-5")).toBe("Weekdays at 09:00");
    expect(presetOf("7 9 * * *")).toBeNull();
  });
});

describe("targetProblem", () => {
  it("wants a live agent and something to check out", () => {
    const f = blankTarget();
    expect(targetProblem(f, AGENTS)).toMatch(/agent/);
    expect(targetProblem({ ...f, agentId: "a-gone" }, AGENTS)).toMatch(/archived/);
    expect(targetProblem({ ...f, agentId: "a-live" }, AGENTS)).toMatch(/repository/);
    expect(targetProblem({ ...f, agentId: "a-live", connectedRepoId: "r1" }, AGENTS)).toBeNull();
    expect(targetProblem({ ...f, agentId: "a-live", kind: "workspace" }, AGENTS)).toMatch(
      /workspace/,
    );
    expect(targetProblem({ ...f, agentId: "a-live", kind: "workspace", workspaceId: "w1" }, AGENTS))
      .toBeNull();
  });

  it("refuses the ref names the service refuses", () => {
    const f = { ...blankTarget(), agentId: "a-live", connectedRepoId: "r1" };
    for (const ref of ["-x", "a b", "a..b", "a/", "a.lock", "a@{1}", "a:b"]) {
      expect(targetProblem({ ...f, ref }, AGENTS)).toMatch(/ref/);
    }
    expect(targetProblem({ ...f, ref: "release/2026-09" }, AGENTS)).toBeNull();
  });

  it("bridges both ways", () => {
    const f = { ...blankTarget(), agentId: "a-live", connectedRepoId: "r1", ref: " main " };
    expect(composeTarget(f)).toEqual({ kind: "repo", connectedRepoId: "r1", ref: "main" });
    expect(composeTarget({ ...f, ref: "" })).toEqual({
      kind: "repo",
      connectedRepoId: "r1",
      ref: null,
    });
    expect(composeTarget({ ...f, kind: "workspace", workspaceId: "w1" })).toEqual({
      kind: "workspace",
      workspaceId: "w1",
    });
    const automation = {
      agentId: "a-live",
      target: { kind: "repo", connectedRepoId: "r1", ref: null },
    } as Automation;
    expect(targetToFields(automation)).toEqual({ ...f, ref: "" });
  });
});

describe("instructionsProblem", () => {
  it("wants something to do", () => {
    expect(instructionsProblem("  ")).toMatch(/should do/);
    expect(instructionsProblem("Triage the alert.")).toBeNull();
  });
});

describe("responseProblem", () => {
  const grafana = applyPreset(blankTrigger(), "grafana");

  it("has nothing to say about a plain run", () => {
    expect(responseProblem({ ...blankResponse(), choice: "run" }, grafana, [], true)).toBeNull();
  });

  it("takes the room fields' verdict and bounds the clocks", () => {
    const f = { ...blankResponse(), choice: "automation" as const };
    expect(responseProblem(f, grafana, [], true)).toMatch(/room/);
    expect(responseProblem(f, grafana, [], false)).toBeNull();
    expect(responseProblem({ ...f, idleMinutes: 0 }, grafana, [], false)).toMatch(/minutes/);
    expect(responseProblem({ ...f, attendedIdleMinutes: 1441 }, grafana, [], false)).toMatch(
      /minutes/,
    );
  });

  it("starts a new conversation on thirty minutes of quiet, sixty once someone replies", () => {
    expect(blankResponse()).toMatchObject({ idleMinutes: 30, attendedIdleMinutes: 60 });
  });

  it("reads a saved policy back in minutes, and no policy as a plain run", () => {
    expect(responseToFields(null)).toEqual({ ...blankResponse(), choice: "run" });
    expect(
      responseToFields({
        chatroomId: "c1",
        channelId: "42",
        correlation: "key",
        idleMs: 600_000,
        attendedIdleMs: 3_600_000,
        postAlert: true,
        conversation: "per-response",
      }),
    ).toEqual({
      choice: "key",
      chatroomId: "c1",
      channelId: "42",
      idleMinutes: 10,
      attendedIdleMinutes: 60,
      postAlert: true,
      conversation: "per-response",
    });
    expect(
      responseToFields({
        chatroomId: "c1",
        channelId: "42",
        correlation: "automation",
        idleMs: 600_000,
        attendedIdleMs: 3_600_000,
        postAlert: false,
        conversation: "shared",
      }).conversation,
    ).toBe("shared");
  });

  it("check a pasted secret before it is sent", () => {
    const hmac = { kind: "hmac-sha256" as const };
    expect(pastedSecretProblem("", hmac, "PagerDuty")).toMatch(/PagerDuty/);
    expect(pastedSecretProblem("short", hmac, "PagerDuty")).toMatch(/short/);
    expect(pastedSecretProblem("a".repeat(513), hmac, "PagerDuty")).toMatch(/longer/);
    expect(pastedSecretProblem("é".repeat(20), hmac, "PagerDuty")).toMatch(/characters/);
    expect(pastedSecretProblem("0123456789abcdef", hmac, "PagerDuty")).toBeNull();
    const sw = { kind: "standard-webhooks" as const };
    expect(pastedSecretProblem("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", sw, "incident.io"))
      .toBeNull();
    expect(pastedSecretProblem("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", sw, "incident.io")).toBeNull();
    expect(pastedSecretProblem("whsec_not base64 at all!!", sw, "incident.io")).toMatch(/whole/);
  });
});

describe("the response choice", () => {
  const grafana = applyPreset(blankTrigger(), "grafana");
  const raw = applyPreset(blankTrigger(), "other");
  const schedule = { ...blankTrigger(), kind: "schedule" as const };
  const telegram = [{ id: "chr-tg", kind: "telegram" as const }, {
    id: "chr-z",
    kind: "zulip" as const,
  }];

  it("follows the trigger's default while the step is untouched", () => {
    const f = blankResponse();
    expect(defaultResponseChoice(blankTrigger())).toBe("run");
    expect(responseChoiceOf(f, grafana)).toBe("key");
    expect(responseChoiceOf(f, raw)).toBe("run");
    expect(responseChoiceOf(f, schedule)).toBe("fire");
    // Nothing to report: the default always fits its trigger.
    for (const t of [grafana, raw, schedule]) expect(responseConflict(f, t, [])).toBeNull();
  });

  it("is kept once the step has been seen, whatever the trigger does next", () => {
    const f = settleResponseChoice(blankResponse(), grafana);
    expect(f.choice).toBe("key");
    expect(settleResponseChoice(f, raw)).toBe(f);
    expect(responseChoiceOf(f, raw)).toBe("key");
    expect(responseChoiceOf({ ...f, choice: "automation" }, grafana)).toBe("automation");
  });

  it("reports a keyed choice the trigger no longer reads keys for, and keeps it", () => {
    const f = { ...blankResponse(), choice: "key" as const };
    expect(responseConflict(f, grafana, [])).toBeNull();
    expect(responseConflict(f, raw, [])).toMatch(/nothing to group/);
    expect(responseConflict(f, schedule, [])).toMatch(/schedule/);
    const custom = { ...raw, formatKind: "custom" as const };
    expect(responseConflict(f, custom, [])).toMatch(/ID field/);
    expect(responseProblem(f, raw, [], false)).toMatch(/Pick another option/);
    expect(f.choice).toBe("key");
    // Still sent as picked: a form with a problem is never sent, and nothing swaps it.
    expect(composeResponse(f, raw, [])).toMatchObject({ correlation: "key" });
  });

  it("reports choices that keep several conversations open in a Telegram group", () => {
    const f = { ...blankResponse(), chatroomId: "chr-tg" };
    expect(responseConflict({ ...f, choice: "key" }, grafana, telegram)).toMatch(/Telegram/);
    expect(responseConflict({ ...f, choice: "fire" }, grafana, telegram)).toMatch(/Telegram/);
    expect(responseConflict({ ...f, choice: "automation" }, grafana, telegram)).toBeNull();
    expect(responseConflict({ ...f, choice: "run" }, grafana, telegram)).toBeNull();
    expect(responseConflict({ ...f, chatroomId: "chr-z", choice: "key" }, grafana, telegram))
      .toBeNull();
    expect(composeResponse({ ...f, choice: "fire" }, grafana, telegram)).toMatchObject({
      correlation: "fire",
    });
  });

  it("holds one conversation at a time when every one shares a topic or thread", () => {
    const rooms = [...telegram, { id: "chr-s", kind: "slack" as const }];
    const f = {
      ...blankResponse(),
      chatroomId: "chr-z",
      channelId: "7",
      conversation: "shared" as const,
    };
    expect(sharedConversationNoun(f, rooms)).toBe("topic");
    expect(sharedConversationNoun({ ...f, chatroomId: "chr-s" }, rooms)).toBe("thread");
    // Shared needs a channel in a room that has them: without one each opens its own.
    expect(sharedConversationNoun({ ...f, channelId: "" }, rooms)).toBeNull();
    expect(sharedConversationNoun({ ...f, chatroomId: "chr-tg" }, rooms)).toBeNull();
    expect(sharedConversationNoun({ ...f, conversation: "per-response" }, rooms)).toBeNull();
    expect(oneConversationReason(f, rooms)).toMatch(/Every response posts in one topic/);
    expect(oneConversationReason({ ...f, chatroomId: "chr-tg" }, rooms)).toMatch(/Telegram/);
    expect(oneConversationReason({ ...f, conversation: "per-response" }, rooms)).toBeNull();

    expect(responseConflict({ ...f, choice: "key" }, grafana, rooms)).toMatch(/one topic/);
    expect(responseConflict({ ...f, choice: "fire" }, grafana, rooms)).toMatch(/one topic/);
    // A room archived since hides the choice, and a hidden choice raises no conflict.
    const archived = rooms.map((r) => ({ ...r, archivedAt: "2026-10-01T00:00:00.000Z" }));
    expect(sharedConversationNoun(f, archived)).toBeNull();
    expect(responseConflict({ ...f, choice: "fire" }, grafana, archived)).toBeNull();
    expect(responseConflict({ ...f, choice: "automation" }, grafana, rooms)).toBeNull();
    expect(composeResponse({ ...f, choice: "automation" }, grafana, rooms)).toMatchObject({
      correlation: "automation",
      conversation: "shared",
    });
  });

  it("sends no policy for a plain run", () => {
    expect(composeResponse({ ...blankResponse(), choice: "run" }, grafana, [])).toBeNull();
    expect(composeResponse(blankResponse(), raw, [])).toBeNull();
    expect(composeResponse(blankResponse(), grafana, [])).toMatchObject({ correlation: "key" });
  });
});

describe("secretHint", () => {
  it("says when the secret comes, by who makes it", () => {
    expect(secretHint(blankTrigger())).toBeNull();
    expect(secretHint(applyPreset(blankTrigger(), "grafana"))).toMatch(/URL and secret.*Grafana/);
    expect(secretHint(applyPreset(blankTrigger(), "pagerduty"))).toMatch(/paste.*PagerDuty/);
    expect(secretHint(applyPreset(blankTrigger(), "other"))).toMatch(/connecting the sender/);
  });
});

describe("presets", () => {
  it("fill the verification and format the service expects", () => {
    expect(composeTrigger(applyPreset(blankTrigger(), "pagerduty"))).toEqual({
      kind: "webhook",
      verification: { kind: "hmac-sha256", header: "x-pagerduty-signature", prefix: "v1=" },
      format: { kind: "pagerduty" },
      rateLimit: { maxPerWindow: 10, windowMs: 60_000 },
    });
    expect(composeTrigger(applyPreset(blankTrigger(), "alertmanager"))).toMatchObject({
      verification: { kind: "secret-header", header: "authorization", prefix: "Bearer " },
      format: { kind: "alertmanager" },
    });
    expect(composeTrigger(applyPreset(blankTrigger(), "incident-io"))).toMatchObject({
      verification: { kind: "standard-webhooks" },
      format: { kind: "incident-io" },
    });
    expect(composeTrigger(applyPreset(blankTrigger(), "datadog"))).toMatchObject({
      verification: { kind: "secret-header", header: "x-ryph-secret" },
      format: { kind: "datadog" },
    });
  });

  it("know whose secret it is", () => {
    for (const id of ["pagerduty", "sentry", "incident-io"] as const) {
      expect(secretToPaste(applyPreset(blankTrigger(), id))).toBe(true);
    }
    for (
      const id of [
        "grafana",
        "alertmanager",
        "grafana-irm",
        "datadog",
        "opsgenie",
        "other",
      ] as const
    ) {
      expect(secretToPaste(applyPreset(blankTrigger(), id))).toBe(false);
    }
    // PagerDuty switched to a header in Advanced: the secret is minted here instead.
    const header = {
      ...applyPreset(blankTrigger(), "pagerduty"),
      verification: "secret-header" as const,
    };
    expect(secretToPaste(header)).toBe(false);
  });

  it("read keys, except raw and a mapping without a key path", () => {
    expect(triggerYieldsKeys(applyPreset(blankTrigger(), "grafana"))).toBe(true);
    expect(triggerYieldsKeys(other())).toBe(false);
    const custom = { ...other(), formatKind: "custom" as const };
    expect(triggerYieldsKeys(custom)).toBe(false);
    expect(triggerYieldsKeys({ ...custom, mapping: { ...custom.mapping, key: "id" } })).toBe(true);
    expect(triggerYieldsKeys({ ...applyPreset(blankTrigger(), "grafana"), kind: "schedule" }))
      .toBe(false);
  });

  it("say a saved pasted secret is waiting until it is pasted", () => {
    const pd = { kind: "hmac-sha256" as const, header: "x-pagerduty-signature", prefix: "v1=" };
    expect(awaitingPaste({ ...pd, secretSource: "minted" }, { kind: "pagerduty" })).toBe(true);
    expect(awaitingPaste({ ...pd, secretSource: "pasted" }, { kind: "pagerduty" })).toBe(false);
    expect(secretIsPasted({ ...pd, secretSource: "pasted" }, { kind: "pagerduty" })).toBe(true);
    expect(
      secretIsPasted({ kind: "secret-header", header: "x", prefix: "", secretSource: "minted" }, {
        kind: "pagerduty",
      }),
    ).toBe(false);
    expect(awaitingPaste({ ...pd, secretSource: "minted" }, { kind: "grafana" })).toBe(false);
  });

  it("each give steps with the URL, and the minted secret where it is minted", () => {
    const url = "https://hooks.example/h/1";
    for (const preset of PRESETS) {
      const ctx = {
        url,
        secret: "s3cret-s3cret-s3cret",
        verification: preset.verification,
        name: "X",
      };
      const steps = setupSteps(preset.id, ctx);
      const values = steps.flatMap((step) => step.values ?? []).map((v) => v.value).join("\n");
      expect(values).toContain(url);
      expect(isPresetVerification(preset, preset.verification)).toBe(true);
      if (preset.secretSource === "minted") expect(values).toContain("s3cret-s3cret-s3cret");
    }
  });

  it("fill vendor values in exactly", () => {
    const am = presetById("alertmanager");
    const yaml = setupSteps("alertmanager", {
      url: "https://h/1",
      secret: "abc",
      verification: am.verification,
      name: "x",
    })[0].values?.[0].value;
    expect(yaml).toContain("credentials: abc");
    expect(yaml).toContain("type: Bearer");

    const dd = setupSteps("datadog", {
      url: "https://h/1",
      secret: "abc",
      verification: presetById("datadog").verification,
      name: "Datadog monitors!",
    });
    const all = dd.flatMap((step) => step.values ?? []);
    expect(all.find((v) => v.label === "Mention")?.value).toBe("@webhook-datadog-monitors");
    expect(all.find((v) => v.label === "Custom headers")?.value).toBe(
      '{"X-Ryph-Secret": "abc"}',
    );
    expect(all.find((v) => v.label === "Payload")?.value).toContain(
      '"transition": "$ALERT_TRANSITION"',
    );
    expect(datadogWebhookName("---")).toBe("ryph");
  });

  it("mark a secret that is gone, and say a changed verification generically", () => {
    const steps = setupSteps("opsgenie", {
      url: "https://h/1",
      secret: null,
      verification: presetById("opsgenie").verification,
      name: "x",
    });
    expect(steps.flatMap((s) => s.values ?? []).find((v) => v.label === "Value")?.missing)
      .toBe(true);
    const changed = setupSteps("grafana", {
      url: "https://h/1",
      secret: "abc",
      verification: { kind: "secret-header", header: "authorization", prefix: "Bearer " },
      name: "x",
    });
    expect(changed.flatMap((s) => s.values ?? []).find((v) => v.label === "Value")?.value)
      .toBe("Bearer abc");
  });
});
