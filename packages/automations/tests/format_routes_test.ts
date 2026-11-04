// Formats, pasted secrets and correlation over the CRUD surface, end to end through the real
// mailroom: a pasted secret verifies and is never echoed, rotate takes one, a format is stored,
// revisable and read into every delivered event's signal, and a response's correlation is
// defaulted by trigger and refused where it cannot mean anything.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { api, hmacHex, makeService, webhookCreateBody } from "./harness.ts";

type Service = Awaited<ReturnType<typeof makeService>>;

const PASTED = "pd-signing-secret-0123456789abcdef";

const create = async (svc: Service, over: Record<string, unknown>) => {
  const res = await api(svc, "POST", "/v1/automations", webhookCreateBody(over));
  return { status: res.status, body: await res.json() };
};

const postHook = (svc: Service, id: string, headers: Record<string, string>, body: string) =>
  svc.handler(
    new Request(`http://automations.test/v1/hooks/${id}`, { method: "POST", headers, body }),
  );

const ALERTMANAGER_FIRING = JSON.stringify({
  status: "firing",
  groupKey: '{}:{alertname="Disk"}',
  commonLabels: { alertname: "Disk" },
});

test("a pasted hmac secret verifies, is never echoed, and its source is public", async () => {
  const svc = await makeService();
  try {
    const { status, body } = await create(svc, {
      trigger: {
        kind: "webhook",
        format: { kind: "pagerduty" },
        verification: {
          kind: "hmac-sha256",
          header: "x-pagerduty-signature",
          prefix: "v1=",
          secret: PASTED,
        },
      },
    });
    assertEquals(status, 201);
    assertEquals("secret" in body, false);
    assertEquals(JSON.stringify(body).includes(PASTED), false);
    assertEquals(body.automation.trigger.format, { kind: "pagerduty" });
    assertEquals(body.automation.trigger.verification, {
      kind: "hmac-sha256",
      header: "x-pagerduty-signature",
      prefix: "v1=",
      secretSource: "pasted",
    });

    // PagerDuty mid-rotation: two signatures in one header, ours second.
    const payload = JSON.stringify({
      event: {
        event_type: "incident.acknowledged",
        data: { id: "PGR0VU2", title: "A little bump in the road" },
      },
    });
    const sig = await hmacHex(PASTED, payload);
    const res = await postHook(svc, body.automation.id, {
      "x-pagerduty-signature": `v1=${"0".repeat(64)},v1=${sig}`,
    }, payload);
    assertEquals(res.status, 202);
    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 1);
    assertEquals(svc.delivered[0].signal, {
      status: "update",
      key: "PGR0VU2",
      title: "A little bump in the road",
    });
  } finally {
    await svc.db.close();
  }
});

test("a vendor-secret preset created without its secret holds a placeholder until it is pasted", async () => {
  const svc = await makeService();
  try {
    const { status, body } = await create(svc, {
      trigger: {
        kind: "webhook",
        format: { kind: "sentry" },
        verification: { kind: "hmac-sha256", header: "sentry-hook-signature", prefix: "" },
      },
    });
    assertEquals(status, 201);
    // Nobody is shown the placeholder: Sentry would never take it.
    assertEquals("secret" in body, false);
    assertEquals(body.automation.trigger.verification.secretSource, "minted");
    const id = body.automation.id;

    const payload = JSON.stringify({
      action: "resolved",
      data: { issue: { id: "9", title: "t" } },
    });
    const signed = async (secret: string) =>
      postHook(svc, id, {
        "sentry-hook-signature": await hmacHex(secret, payload),
        "sentry-hook-resource": "issue",
      }, payload);
    assertEquals((await signed(PASTED)).status, 401);

    const rotated = await api(svc, "POST", `/v1/automations/${id}/rotate-secret`, {
      secret: PASTED,
    });
    assertEquals(rotated.status, 200);
    assertEquals(await rotated.json(), {}); // a pasted secret is never echoed
    const read = await (await api(svc, "GET", `/v1/automations/${id}`)).json();
    assertEquals(read.automation.trigger.verification.secretSource, "pasted");

    assertEquals((await signed(PASTED)).status, 202);
    await svc.webhooks.sweep();
    // The resource header survives the mailroom (only credentials are dropped) and decides.
    assertEquals(svc.delivered[0].signal, { status: "resolved", key: "9", title: "t" });

    // A bare rotate mints again, shows it once, and the pasted one stops verifying.
    const minted = await api(svc, "POST", `/v1/automations/${id}/rotate-secret`);
    assertEquals(minted.status, 200);
    const { secret } = await minted.json();
    assert(typeof secret === "string" && secret.length === 64);
    assertEquals((await signed(PASTED)).status, 401);
    svc.clock.advance(60_000); // past the default one-per-minute rate limit
    assertEquals((await signed(secret)).status, 202);
    const after = await (await api(svc, "GET", `/v1/automations/${id}`)).json();
    assertEquals(after.automation.trigger.verification.secretSource, "minted");
  } finally {
    await svc.db.close();
  }
});

test("a minted-secret preset still shows its secret once, and a secret header compares with its prefix", async () => {
  const svc = await makeService();
  try {
    const { status, body } = await create(svc, {
      trigger: {
        kind: "webhook",
        format: { kind: "alertmanager" },
        verification: { kind: "secret-header", header: "authorization", prefix: "Bearer " },
      },
    });
    assertEquals(status, 201);
    assert(typeof body.secret === "string" && body.secret.length === 64);
    assertEquals(body.automation.trigger.verification, {
      kind: "secret-header",
      header: "authorization",
      prefix: "Bearer ",
      secretSource: "minted",
    });
    const id = body.automation.id;
    assertEquals(
      (await postHook(svc, id, { authorization: body.secret }, ALERTMANAGER_FIRING)).status,
      401,
    );
    assertEquals(
      (await postHook(svc, id, { authorization: `Bearer ${body.secret}` }, ALERTMANAGER_FIRING))
        .status,
      202,
    );
    await svc.webhooks.sweep();
    assertEquals(svc.delivered[0].signal, {
      status: "firing",
      key: '{}:{alertname="Disk"}',
      title: "Disk",
    });
  } finally {
    await svc.db.close();
  }
});

test("standard-webhooks: a pasted whsec_ verifies; a bad one, or a bare rotate, is refused", async () => {
  const svc = await makeService();
  try {
    const key = Buffer.from("incident-io-signing-key-bytes");
    const whsec = `whsec_${key.toString("base64")}`;
    const bad = await create(svc, {
      trigger: {
        kind: "webhook",
        format: { kind: "incident-io" },
        verification: { kind: "standard-webhooks", secret: "not base64 at all!!" },
      },
    });
    assertEquals(bad.status, 422);

    const { status, body } = await create(svc, {
      trigger: {
        kind: "webhook",
        format: { kind: "incident-io" },
        verification: { kind: "standard-webhooks", secret: whsec },
      },
    });
    assertEquals(status, 201);
    assertEquals("secret" in body, false);
    assertEquals(body.automation.trigger.verification, {
      kind: "standard-webhooks",
      secretSource: "pasted",
    });
    // A keyed preset: the response's correlation defaults to per key.
    const id = body.automation.id;

    const payload = JSON.stringify({
      event_type: "public_incident.incident_created_v2",
      "public_incident.incident_created_v2": {
        id: "01FDAG",
        name: "Our database is sad",
        incident_status: { category: "live" },
      },
    });
    const ts = Math.floor(svc.clock.now().getTime() / 1000);
    const sig = createHmac("sha256", key).update(`msg_1.${ts}.${payload}`).digest("base64");
    const res = await postHook(svc, id, {
      "webhook-id": "msg_1",
      "webhook-timestamp": String(ts),
      "webhook-signature": `v1,${sig}`,
    }, payload);
    assertEquals(res.status, 202);
    await svc.webhooks.sweep();
    assertEquals(svc.delivered[0].signal, {
      status: "firing",
      key: "01FDAG",
      title: "Our database is sad",
    });

    const bare = await api(svc, "POST", `/v1/automations/${id}/rotate-secret`);
    assertEquals(bare.status, 422);
    const garbage = await api(svc, "POST", `/v1/automations/${id}/rotate-secret`, {
      secret: "this is no base64 secret",
    });
    assertEquals(garbage.status, 422);
  } finally {
    await svc.db.close();
  }
});

test("pasted secrets are bounded: 16–512 printable ASCII", async () => {
  const svc = await makeService();
  try {
    for (
      const secret of ["short", "x".repeat(513), "tab\there-and-more-chars", "ünïcödé-secret-value"]
    ) {
      const { status } = await create(svc, {
        trigger: { kind: "webhook", verification: { kind: "hmac-sha256", secret } },
      });
      assertEquals(status, 400, secret);
    }
  } finally {
    await svc.db.close();
  }
});

test("a format is stored, defaults to raw, is revisable by PATCH, and is refused on a schedule", async () => {
  const svc = await makeService();
  try {
    const { body } = await create(svc, {});
    assertEquals(body.automation.trigger.format, { kind: "raw" });
    const { id } = body.automation;
    const secret = body.secret as string;
    const fire = async () => {
      const res = await postHook(svc, id, {
        "x-ryph-signature": `sha256=${await hmacHex(secret, ALERTMANAGER_FIRING)}`,
      }, ALERTMANAGER_FIRING);
      assertEquals(res.status, 202);
      await svc.webhooks.sweep();
    };
    await fire();
    assertEquals(svc.delivered[0].signal, { status: "unknown", key: null, title: null });

    const mapping = {
      status: ["status"],
      firing: ["firing"],
      key: ["commonLabels.alertname"],
    };
    const patched = await api(svc, "PATCH", `/v1/automations/${id}`, {
      format: { kind: "custom", mapping },
    });
    assertEquals(patched.status, 200);
    // The mapping's omitted lists are stored empty, so a read shows the whole of it.
    assertEquals((await patched.json()).automation.trigger.format, {
      kind: "custom",
      mapping: { ...mapping, resolved: [], update: [], title: [] },
    });
    // The secret still verifies: a format never touches the door.
    svc.clock.advance(60_000);
    await fire();
    assertEquals(svc.delivered[1].signal, { status: "firing", key: "Disk", title: null });

    // A malformed path and an over-long list are refused at the door of the API.
    for (
      const format of [
        { kind: "custom", mapping: { status: ["a..b"] } },
        { kind: "custom", mapping: { key: Array.from({ length: 11 }, (_, i) => `k${i}`) } },
        { kind: "custom", mapping: { firing: ["x".repeat(101)] } },
        { kind: "nagios" },
      ]
    ) {
      const res = await api(svc, "PATCH", `/v1/automations/${id}`, { format });
      assertEquals(res.status, 400, JSON.stringify(format));
    }

    const schedule = await api(svc, "POST", "/v1/automations", {
      ...webhookCreateBody(),
      trigger: { kind: "schedule", cron: "0 9 * * *" },
    });
    const sid = (await schedule.json()).automation.id;
    const refused = await api(svc, "PATCH", `/v1/automations/${sid}`, {
      format: { kind: "grafana" },
    });
    assertEquals(refused.status, 422);
  } finally {
    await svc.db.close();
  }
});

test("correlation defaults by trigger and format, and key is refused on a schedule", async () => {
  const svc = await makeService();
  try {
    const response = { chatroomId: null };
    const correlationOf = async (over: Record<string, unknown>) => {
      const res = await api(svc, "POST", "/v1/automations", webhookCreateBody(over));
      const body = await res.json();
      return { status: res.status, correlation: body.automation?.response?.correlation, body };
    };
    const webhook = (format: unknown) => ({
      kind: "webhook",
      format,
      verification: { kind: "secret-header" },
    });

    assertEquals((await correlationOf({ response })).correlation, "automation"); // raw
    assertEquals(
      (await correlationOf({ response, trigger: webhook({ kind: "grafana" }) })).correlation,
      "key",
    );
    assertEquals(
      (await correlationOf({
        response,
        trigger: webhook({ kind: "custom", mapping: { status: ["s"] } }),
      })).correlation,
      "automation",
    );
    assertEquals(
      (await correlationOf({
        response,
        trigger: webhook({ kind: "custom", mapping: { key: ["id"] } }),
      })).correlation,
      "key",
    );
    // Named explicitly, it is kept — even key on a raw webhook, which then shares one slot.
    assertEquals(
      (await correlationOf({ response: { ...response, correlation: "fire" } })).correlation,
      "fire",
    );
    assertEquals(
      (await correlationOf({ response: { ...response, correlation: "key" } })).correlation,
      "key",
    );

    const schedule = { kind: "schedule", cron: "0 9 * * *" };
    assertEquals((await correlationOf({ response, trigger: schedule })).correlation, "fire");
    const refused = await correlationOf({
      response: { ...response, correlation: "key" },
      trigger: schedule,
    });
    assertEquals(refused.status, 422);
    assertStringIncludes(refused.body.error, "correlation");

    // On PATCH the default follows the trigger as revised in the same request.
    const { body } = await correlationOf({});
    const id = body.automation.id;
    const patched = await api(svc, "PATCH", `/v1/automations/${id}`, {
      format: { kind: "opsgenie" },
      response,
    });
    assertEquals((await patched.json()).automation.response.correlation, "key");
    // A schedule refuses key on PATCH too.
    const sched = await correlationOf({ trigger: schedule });
    const keyed = await api(svc, "PATCH", `/v1/automations/${sched.body.automation.id}`, {
      response: { ...response, correlation: "key" },
    });
    assertEquals(keyed.status, 422);
  } finally {
    await svc.db.close();
  }
});

test("an ignored verdict lands in the fire history as ignored", async () => {
  const svc = await makeService({
    answer: () => ({ kind: "ok", outcome: "ignored", taskId: null, runId: null }),
  });
  try {
    const { body } = await create(svc, {});
    const res = await postHook(svc, body.automation.id, {
      "x-ryph-signature": `sha256=${await hmacHex(body.secret, "{}")}`,
    }, "{}");
    assertEquals(res.status, 202);
    await svc.webhooks.sweep();
    const fires = await (await api(svc, "GET", `/v1/automations/${body.automation.id}/fires`))
      .json();
    assertEquals(fires.fires[0].outcome, "ignored");
  } finally {
    await svc.db.close();
  }
});
