import { describe, expect, it } from "vitest";
import { composeResponsePolicy, createAutomation, rotateAutomationSecret } from "./automations";
import { createChatroom, getChatrooms } from "./chatrooms";
import { postRunMessage } from "./messages";
import { closeResponse, getResponse, getResponses } from "./responses";
import {
  automationSchema,
  messageSenderSchema,
  responseSchema,
  runMessageSchema,
  taskDetailSchema,
} from "./types";

// The shapes the response surfaces answer, pinned at the client: a response with what
// the list shows beside it, a response's page with its inbox, a chatroom with its token absent,
// and a message as the run page posts and reads it.

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

const response = {
  id: "resp-1",
  automationId: "auto-1",
  taskId: "t-1",
  runId: "r-1",
  chatroomId: "chr-1",
  state: "attended",
  key: "PGR0VU2",
  title: "A little bump in the road",
  alerts: 3,
  openedAt: "2026-09-15T10:00:00.000Z",
  lastAlertAt: "2026-09-15T10:05:00.000Z",
  lastActivityAt: "2026-09-15T10:06:00.000Z",
  closedAt: null,
  closedReason: null,
};

const message = {
  id: "rm-1",
  runId: "r-1",
  seq: 0,
  kind: "chat",
  sender: { kind: "chat", name: "Ada", id: "12345" },
  text: "look at the cache first",
  payload: null,
  createdAt: "2026-09-15T10:06:00.000Z",
  deliveredAt: null,
};

describe("responses", () => {
  it("lists responses with the task, the agent and the run's state beside each", async () => {
    const fetch = respond(200, {
      responses: [{
        ...response,
        taskTitle: "automation: cpu",
        agentName: "Ada",
        runState: "running",
      }],
    }) as unknown as typeof globalThis.fetch;
    const listed = await getResponses(fetch);
    expect(listed[0].taskTitle).toBe("automation: cpu");
    expect(listed[0].runState).toBe("running");
    expect(listed[0].alerts).toBe(3);
    expect(listed[0].key).toBe("PGR0VU2");
    expect(listed[0].title).toBe("A little bump in the road");
  });

  it("reads a response with no key or title as the automation-wide slot", () => {
    const { key: _key, title: _title, ...bare } = response;
    expect(responseSchema.parse(bare)).toMatchObject({ key: "", title: null });
  });

  it("parses a response's page: the response, its task and run, and the inbox", async () => {
    const fetch = respond(200, {
      response,
      task: {
        id: "t-1",
        agentId: "a-1",
        spec: { title: "automation: cpu", instructions: "triage" },
        repos: [],
        origin: "automation",
        createdAt: "2026-09-15T10:00:00.000Z",
      },
      agent: null,
      run: null,
      messages: [message, {
        ...message,
        id: "rm-2",
        seq: 1,
        kind: "alert",
        sender: { kind: "automation", fireId: "hook-2" },
      }],
    }) as unknown as typeof globalThis.fetch;
    const detail = await getResponse(fetch, "resp-1");
    expect(detail.task?.id).toBe("t-1");
    expect(detail.messages.map((m) => m.kind)).toEqual(["chat", "alert"]);
  });

  it("closes a response by POSTing to its close action", async () => {
    const asked: [string, string | undefined][] = [];
    const fetch = ((url: string, init?: RequestInit) => {
      asked.push([url, init?.method]);
      return respond(202, { runId: "r-1" })();
    }) as unknown as typeof globalThis.fetch;
    await closeResponse(fetch, "resp-1");
    expect(asked).toEqual([["/api/v1/responses/resp-1/close", "POST"]]);
  });
});

describe("the run inbox", () => {
  it("posts a message and reads the row back", async () => {
    let sent: unknown = null;
    const fetch = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return respond(201, {
        message: {
          ...message,
          kind: "user",
          sender: { kind: "user", userId: "u-1", name: "Ada" },
        },
      })();
    }) as unknown as typeof globalThis.fetch;
    const posted = await postRunMessage(fetch, "r-1", "look at the cache first");
    expect(sent).toEqual({ text: "look at the cache first", attachmentIds: [] });
    expect(posted.sender).toEqual({ kind: "user", userId: "u-1", name: "Ada" });
    expect(posted.attachments).toEqual([]);
  });

  it("tells a person nobody could name apart from a former member", () => {
    // Absent: no directory, a failed lookup, or an older control plane — the page says "A person".
    expect(messageSenderSchema.parse({ kind: "user", userId: "u-2" })).toEqual({
      kind: "user",
      userId: "u-2",
    });
    // Null: the directory said they are no longer a member.
    expect(messageSenderSchema.parse({ kind: "user", userId: "u-3", name: null })).toEqual({
      kind: "user",
      userId: "u-3",
      name: null,
    });
  });

  it("sends a message's images by id, and reads their refs back", async () => {
    let sent: unknown = null;
    const fetch = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return respond(201, {
        message: {
          ...message,
          kind: "user",
          text: "",
          sender: { kind: "user", userId: "u-1" },
          attachments: [{ id: "a-1", mime: "image/png" }],
        },
      })();
    }) as unknown as typeof globalThis.fetch;
    const posted = await postRunMessage(fetch, "r-1", "", ["a-1"]);
    expect(sent).toEqual({ text: "", attachmentIds: ["a-1"] });
    expect(posted.attachments).toEqual([{ id: "a-1", mime: "image/png" }]);
  });

  it("carries a platform message's patch payload, and defaults what an older row lacks", () => {
    const parsed = runMessageSchema.parse({
      ...message,
      kind: "system",
      sender: { kind: "platform" },
      payload: {
        kind: "patch",
        patchId: "p-1",
        path: "app",
        headSha: "abc",
        generation: 2,
        state: "merged",
        forgeUrl: "https://gh/acme/app/pull/7",
        reason: null,
      },
      deliveredAt: undefined,
    });
    expect(parsed.payload?.state).toBe("merged");
    expect(parsed.deliveredAt).toBeNull();
  });

  it("a task detail carries each run's inbox, attended flag and the response it answers", () => {
    const detail = taskDetailSchema.parse({
      task: {
        id: "t-1",
        agentId: "a-1",
        spec: { title: "x", instructions: "y" },
        repos: [],
        origin: "chat",
        createdAt: "2026-09-15T10:00:00.000Z",
      },
      agent: null,
      runs: [{
        id: "r-1",
        state: "running",
        phase: "running",
        branchNamespace: "ryph/ada/r-1",
        image: null,
        result: null,
        attended: true,
        idleDeadlineAt: "2026-09-15T10:36:00.000Z",
        createdAt: "2026-09-15T10:00:00.000Z",
        updatedAt: "2026-09-15T10:06:00.000Z",
        events: [],
        messages: [message],
      }],
      response,
    });
    expect(detail.task.origin).toBe("chat");
    expect(detail.runs[0].originChatroomId).toBeNull();
    expect(detail.runs[0].attended).toBe(true);
    expect(detail.runs[0].messages[0].sender).toEqual({ kind: "chat", name: "Ada", id: "12345" });
    expect(detail.response?.state).toBe("attended");
  });
});

describe("chatrooms", () => {
  it("lists rooms without ever seeing a token, and creates one with the token sent once", async () => {
    const room = {
      id: "chr-1",
      name: "#incidents",
      kind: "telegram",
      botUsername: "ryph_bot",
      linked: false,
      chatTitle: null,
      linkCode: "link-1",
      realmUrl: null,
      botEmail: null,
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:00:00.000Z",
      archivedAt: null,
    };
    const listed = await getChatrooms(
      respond(200, { chatrooms: [room] }) as unknown as typeof globalThis.fetch,
    );
    expect(listed[0].botUsername).toBe("ryph_bot");
    expect("botToken" in listed[0]).toBe(false);

    let sent: unknown = null;
    const fetch = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return respond(201, { chatroom: room })();
    }) as unknown as typeof globalThis.fetch;
    await createChatroom(fetch, { kind: "telegram", name: "#incidents", botToken: "123:abc" });
    expect(sent).toEqual({ kind: "telegram", name: "#incidents", botToken: "123:abc" });
  });
});

describe("a response policy", () => {
  const rooms = [{ id: "chr-tg", kind: "telegram" as const }, {
    id: "chr-z",
    kind: "zulip" as const,
  }];
  const fields = {
    chatroomId: "",
    channelId: "",
    correlation: "key" as const,
    idleMinutes: 5,
    attendedIdleMinutes: 30,
    postAlert: true,
    conversation: "per-response" as const,
  };

  it("names a channel for a Zulip room, and null for a Telegram room or no room", () => {
    expect(composeResponsePolicy({ ...fields, chatroomId: "chr-z", channelId: "7" }, rooms))
      .toEqual({
        chatroomId: "chr-z",
        channelId: "7",
        correlation: "key",
        idleMs: 300_000,
        attendedIdleMs: 1_800_000,
        postAlert: true,
        conversation: "per-response",
      });
    // A channel left over from an earlier pick never reaches a Telegram room, and the
    // correlation goes as picked: the form reports a mismatch, it never rewrites it.
    expect(composeResponsePolicy({ ...fields, chatroomId: "chr-tg", channelId: "7" }, rooms))
      .toMatchObject({ chatroomId: "chr-tg", channelId: null, correlation: "key" });
    // No room hears an opening message, so there is no alert to post.
    expect(composeResponsePolicy({ ...fields, channelId: "7" }, rooms))
      .toMatchObject({ chatroomId: null, channelId: null, postAlert: false });
    expect(composeResponsePolicy({ ...fields, chatroomId: "chr-z" }, rooms).channelId).toBeNull();
  });

  it("shares one conversation only where there is a channel to hold it", () => {
    const shared = {
      ...fields,
      correlation: "automation" as const,
      conversation: "shared" as const,
    };
    expect(composeResponsePolicy({ ...shared, chatroomId: "chr-z", channelId: "7" }, rooms))
      .toMatchObject({ channelId: "7", correlation: "automation", conversation: "shared" });
    expect(composeResponsePolicy({ ...shared, chatroomId: "chr-z" }, rooms).conversation)
      .toBe("per-response");
    expect(composeResponsePolicy({ ...shared, chatroomId: "chr-tg", channelId: "7" }, rooms))
      .toMatchObject({ conversation: "per-response" });
    expect(composeResponsePolicy(shared, rooms).conversation).toBe("per-response");
  });

  it("is sent on create with the channel, and read back with it", async () => {
    const automation = {
      id: "auto-1",
      name: "cpu",
      enabled: true,
      trigger: {
        kind: "schedule",
        cron: "*/5 * * * *",
        timezone: "UTC",
        nextDueAt: null,
        lastFiredAt: null,
      },
      agentId: "a-1",
      target: { kind: "repo", connectedRepoId: "cr-1", ref: null },
      instructions: "triage",
      response: { chatroomId: "chr-z", channelId: "7", idleMs: 300_000, attendedIdleMs: 1_800_000 },
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:00:00.000Z",
    };
    let sent: { response?: unknown } = {};
    const fetch = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return respond(201, { automation, secret: null })();
    }) as unknown as typeof globalThis.fetch;
    const input = {
      name: "cpu",
      trigger: { kind: "schedule" as const, cron: "*/5 * * * *" },
      agentId: "a-1",
      target: { kind: "repo" as const, connectedRepoId: "cr-1", ref: null },
      instructions: "triage",
    };
    const created = await createAutomation(fetch, {
      ...input,
      response: composeResponsePolicy({ ...fields, chatroomId: "chr-z", channelId: "7" }, rooms),
    });
    expect(sent.response).toMatchObject({ chatroomId: "chr-z", channelId: "7" });
    expect(created.automation.response?.channelId).toBe("7");

    await createAutomation(fetch, {
      ...input,
      response: composeResponsePolicy({ ...fields, chatroomId: "chr-tg" }, rooms),
    });
    expect(sent.response).toMatchObject({ chatroomId: "chr-tg", channelId: null });
  });
});

describe("a webhook automation", () => {
  const base = {
    id: "auto-2",
    name: "PagerDuty incidents",
    enabled: true,
    agentId: "a-1",
    target: { kind: "repo", connectedRepoId: "cr-1", ref: null },
    instructions: "triage",
    response: null,
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
  };

  it("reads its format, its verification's secret source, and a policy's correlation", () => {
    const parsed = automationSchema.parse({
      ...base,
      trigger: {
        kind: "webhook",
        format: { kind: "pagerduty" },
        verification: {
          kind: "hmac-sha256",
          header: "x-pagerduty-signature",
          prefix: "v1=",
          secretSource: "pasted",
        },
        rateLimit: { maxPerWindow: 1, windowMs: 60_000 },
        path: "/hooks/auto-2",
      },
      response: {
        chatroomId: null,
        channelId: null,
        correlation: "key",
        idleMs: 1,
        attendedIdleMs: 1,
      },
    });
    expect(parsed.trigger.kind === "webhook" && parsed.trigger.format).toEqual({
      kind: "pagerduty",
    });
    expect(parsed.response?.correlation).toBe("key");
  });

  it("reads a custom mapping, Standard Webhooks, and a header secret's prefix", () => {
    const mapping = {
      status: ["state"],
      firing: ["open"],
      resolved: ["closed"],
      update: [],
      key: ["id"],
      title: ["name"],
    };
    const parsed = automationSchema.parse({
      ...base,
      trigger: {
        kind: "webhook",
        format: { kind: "custom", mapping },
        verification: { kind: "standard-webhooks", secretSource: "pasted" },
        rateLimit: { maxPerWindow: 1, windowMs: 60_000 },
        path: "/hooks/auto-2",
      },
    });
    expect(parsed.trigger.kind === "webhook" && parsed.trigger.format).toEqual({
      kind: "custom",
      mapping,
    });
    const header = automationSchema.parse({
      ...base,
      trigger: {
        kind: "webhook",
        format: { kind: "alertmanager" },
        verification: {
          kind: "secret-header",
          header: "authorization",
          prefix: "Bearer ",
          secretSource: "minted",
        },
        rateLimit: { maxPerWindow: 1, windowMs: 60_000 },
        path: "/hooks/auto-2",
      },
    });
    expect(header.trigger.kind === "webhook" && header.trigger.verification).toMatchObject({
      prefix: "Bearer ",
    });
  });

  it("rotates to a minted secret it shows, or to a pasted one it doesn't", async () => {
    let sent: unknown = null;
    const minted = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return respond(200, { secret: "s3cret" })();
    }) as unknown as typeof globalThis.fetch;
    expect(await rotateAutomationSecret(minted, "auto-2")).toBe("s3cret");
    expect(sent).toEqual({});
    const pasted = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return respond(200, {})();
    }) as unknown as typeof globalThis.fetch;
    expect(await rotateAutomationSecret(pasted, "auto-2", "pd-secret-0123456789")).toBeNull();
    expect(sent).toEqual({ secret: "pd-secret-0123456789" });
  });

  it("reads a create with no secret to show", async () => {
    const fetch = respond(201, {
      automation: {
        ...base,
        trigger: {
          kind: "schedule",
          cron: "0 * * * *",
          timezone: "UTC",
          nextDueAt: null,
          lastFiredAt: null,
        },
      },
    }) as unknown as typeof globalThis.fetch;
    const created = await createAutomation(fetch, {
      name: "x",
      trigger: { kind: "schedule", cron: "0 * * * *" },
      agentId: "a-1",
      target: { kind: "repo", connectedRepoId: "cr-1", ref: null },
      instructions: "triage",
    });
    expect(created.secret).toBeNull();
  });
});
