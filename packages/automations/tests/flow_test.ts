// The webhook path end to end, no socket and no orchestrator: create a recipe over the CRUD
// surface, fire its URL with a signed request, sweep, and read the fire history — plus the
// switches around it: rate limit, pause, rotation, deletion.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  api,
  apiAs,
  CALLER,
  hmacHex,
  makeService,
  OPERATOR,
  webhookCreateBody,
} from "./harness.ts";

async function createWebhookAutomation(
  svc: Awaited<ReturnType<typeof makeService>>,
  over: Record<string, unknown> = {},
) {
  const res = await api(svc, "POST", "/v1/automations", webhookCreateBody(over));
  assertEquals(res.status, 201);
  const body = await res.json();
  assert(typeof body.secret === "string" && body.secret.length === 64);
  return body as { automation: { id: string; trigger: { path: string } }; secret: string };
}

const fire = (
  svc: Awaited<ReturnType<typeof makeService>>,
  path: string,
  signature: string,
  payload: string,
) =>
  svc.handler(
    new Request(`http://automations.test${path}`, {
      method: "POST",
      headers: { "x-ryph-signature": `sha256=${signature}` },
      body: payload,
    }),
  );

test("a signed fire is accepted, delivered to the sink, and lands in the fire history", async () => {
  const svc = await makeService();
  try {
    const { automation, secret } = await createWebhookAutomation(svc);
    assertEquals(automation.trigger.path, `/v1/hooks/${automation.id}`);

    const payload = '{"alert":"cpu"}';
    const accepted = await fire(
      svc,
      automation.trigger.path,
      await hmacHex(secret, payload),
      payload,
    );
    assertEquals(accepted.status, 202);

    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 1);
    assertEquals(svc.delivered[0].automationId, automation.id);
    assertEquals(svc.delivered[0].ownerUserId, "u-1");
    assertEquals(svc.delivered[0].payload, payload);

    const fires = await (await api(svc, "GET", `/v1/automations/${automation.id}/fires`)).json();
    assertEquals(fires.fires.length, 1);
    assertEquals(fires.fires[0].outcome, "started");
    assertEquals(fires.fires[0].taskId, "t-1");
  } finally {
    await svc.db.close();
  }
});

test("no secret in any read, and an unsigned or missigned fire is refused", async () => {
  const svc = await makeService();
  try {
    const { automation, secret } = await createWebhookAutomation(svc);
    const read = await (await api(svc, "GET", `/v1/automations/${automation.id}`)).json();
    assertEquals(JSON.stringify(read).includes(secret), false);
    // Where the secret came from is all a read says about it.
    assertEquals(read.automation.trigger.verification, {
      kind: "hmac-sha256",
      header: "x-ryph-signature",
      prefix: "sha256=",
      secretSource: "minted",
    });

    const bad = await fire(svc, automation.trigger.path, "0".repeat(64), "{}");
    assertEquals(bad.status, 401);
    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 0);
  } finally {
    await svc.db.close();
  }
});

test("the default rate limit drops the second fire in a minute and records the drop", async () => {
  const svc = await makeService();
  try {
    const { automation, secret } = await createWebhookAutomation(svc);
    const sig = await hmacHex(secret, "{}");
    assertEquals((await fire(svc, automation.trigger.path, sig, "{}")).status, 202);
    assertEquals((await fire(svc, automation.trigger.path, sig, "{}")).status, 429);
    assertEquals(svc.rateLimited, [automation.id]);

    svc.clock.advance(60_001);
    assertEquals((await fire(svc, automation.trigger.path, sig, "{}")).status, 202);

    const fires = await (await api(svc, "GET", `/v1/automations/${automation.id}/fires`)).json();
    const outcomes = fires.fires.map((f: { outcome: string }) => f.outcome).sort();
    assertStringIncludes(outcomes.join(","), "rate-limited");
  } finally {
    await svc.db.close();
  }
});

test("disable pauses the door and freezes the queue; enable drains it again", async () => {
  const svc = await makeService();
  try {
    const { automation, secret } = await createWebhookAutomation(svc, {
      trigger: {
        kind: "webhook",
        verification: { kind: "hmac-sha256" },
        rateLimit: { maxPerWindow: 10, windowMs: 60_000 },
      },
    });
    const sig = await hmacHex(secret, "{}");
    assertEquals((await fire(svc, automation.trigger.path, sig, "{}")).status, 202);

    assertEquals((await api(svc, "POST", `/v1/automations/${automation.id}/disable`)).status, 200);
    assertEquals((await fire(svc, automation.trigger.path, sig, "{}")).status, 404);
    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 0); // the accepted hook is frozen, not delivered

    assertEquals((await api(svc, "POST", `/v1/automations/${automation.id}/enable`)).status, 200);
    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 1); // nothing was lost
  } finally {
    await svc.db.close();
  }
});

test("a pause in the table alone stops delivery — the consumer checks fresh", async () => {
  const svc = await makeService();
  try {
    const { automation, secret } = await createWebhookAutomation(svc);
    const sig = await hmacHex(secret, "{}");
    assertEquals((await fire(svc, automation.trigger.path, sig, "{}")).status, 202);

    // The pause lands in the table but the mailbox stays seated — the drifted-replica shape.
    // The consumer's own reload is the defense: the fire waits instead of running the recipe.
    const stored = await svc.store.getAutomation(automation.id);
    assert(stored !== null);
    await svc.store.saveAutomation({ ...stored, enabled: false });
    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 0);

    await svc.store.saveAutomation({ ...stored, enabled: true });
    svc.clock.advance(10 * 60_000); // past the failed attempt's retry clock
    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 1); // frozen, never lost
  } finally {
    await svc.db.close();
  }
});

test("rotation makes the old secret stop verifying immediately", async () => {
  const svc = await makeService();
  try {
    const { automation, secret } = await createWebhookAutomation(svc, {
      trigger: {
        kind: "webhook",
        verification: { kind: "secret-header" },
        rateLimit: { maxPerWindow: 10, windowMs: 60_000 },
      },
    });
    const send = (s: string) =>
      svc.handler(
        new Request(`http://automations.test${automation.trigger.path}`, {
          method: "POST",
          headers: { authorization: s },
          body: "{}",
        }),
      );
    assertEquals((await send(secret)).status, 202);

    const rotated = await (await api(svc, "POST", `/v1/automations/${automation.id}/rotate-secret`))
      .json();
    assertEquals((await send(secret)).status, 401);
    assertEquals((await send(rotated.secret)).status, 202);
  } finally {
    await svc.db.close();
  }
});

test("PATCH revises the recipe and the next fire runs the new one", async () => {
  const svc = await makeService();
  try {
    const { automation, secret } = await createWebhookAutomation(svc, {
      trigger: {
        kind: "webhook",
        verification: { kind: "hmac-sha256" },
        rateLimit: { maxPerWindow: 10, windowMs: 60_000 },
      },
    });

    const patched = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      name: "renamed",
      instructions: "summarize the alert instead",
      rateLimit: { maxPerWindow: 3, windowMs: 60_000 },
    });
    assertEquals(patched.status, 200);
    const read = await (await api(svc, "GET", `/v1/automations/${automation.id}`)).json();
    assertEquals(read.automation.name, "renamed");
    assertEquals(read.automation.trigger.rateLimit.maxPerWindow, 3);

    // A schedule knob on a webhook automation is a refused category error, not a merge.
    const wrongKind = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      cron: "0 9 * * *",
    });
    assertEquals(wrongKind.status, 422);

    // The consumer loads the automation fresh per delivery, so a fire accepted after the
    // PATCH carries the revised instructions — the recipe in force at hand-over.
    const sig = await hmacHex(secret, "{}");
    assertEquals((await fire(svc, automation.trigger.path, sig, "{}")).status, 202);
    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 1);
    assertEquals(svc.delivered[0].instructions, "summarize the alert instead");
    assertEquals(svc.delivered[0].name, "renamed");
  } finally {
    await svc.db.close();
  }
});

test(
  "an operator reaches a foreign automation through manage-all, but PATCHing or " +
    "rotating its secret takes over ownership — a fire is never left running as an owner " +
    "who no longer set what it does",
  async () => {
    const svc = await makeService();
    try {
      const { automation } = await createWebhookAutomation(svc);

      // A plain member elsewhere cannot reach it at all.
      const foreign = await apiAs(
        svc.handlerAs(OPERATOR),
        "GET",
        `/v1/automations/${automation.id}`,
      );
      assertEquals(foreign.status, 200, "manage-all sees CALLER's row");

      const patched = await apiAs(
        svc.handlerAs(OPERATOR),
        "PATCH",
        `/v1/automations/${automation.id}`,
        { name: "renamed by the operator" },
      );
      assertEquals(patched.status, 200);
      assertEquals((await patched.json()).automation.name, "renamed by the operator");

      // The row is now the operator's: CALLER, who created it, no longer reaches it plainly —
      // manage-all is a one-way door here, same as `putRoom`'s take-over for command rooms.
      const byOriginalOwner = await api(svc, "GET", `/v1/automations/${automation.id}`);
      assertEquals(byOriginalOwner.status, 404);
      const byOperator = await apiAs(
        svc.handlerAs(OPERATOR),
        "GET",
        `/v1/automations/${automation.id}`,
      );
      assertEquals(byOperator.status, 200);

      // Rotating the secret transfers ownership the same way, for the same reason: whoever
      // now holds the fresh secret is who fires the automation, and a fire runs as the owner's
      // forge identity.
      const { automation: second, secret } = await createWebhookAutomation(svc, {
        name: "second",
      });
      const rotated = await apiAs(
        svc.handlerAs(OPERATOR),
        "POST",
        `/v1/automations/${second.id}/rotate-secret`,
      );
      assertEquals(rotated.status, 200);
      assert((await rotated.json()).secret !== secret);
      assertEquals((await api(svc, "GET", `/v1/automations/${second.id}`)).status, 404);
    } finally {
      await svc.db.close();
    }
  },
);

test("a terminal sink refusal is recorded as undeliverable and never retried", async () => {
  const svc = await makeService({
    answer: () => ({ kind: "failed", message: "the event can never be accepted", terminal: true }),
  });
  try {
    const { automation, secret } = await createWebhookAutomation(svc);
    const sig = await hmacHex(secret, "{}");
    assertEquals((await fire(svc, automation.trigger.path, sig, "{}")).status, 202);

    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 1);
    const fires = await (await api(svc, "GET", `/v1/automations/${automation.id}/fires`)).json();
    assertEquals(fires.fires.length, 1);
    assertEquals(fires.fires[0].outcome, "undeliverable");
    assertEquals(fires.fires[0].detail, "the event can never be accepted");

    // Terminal means terminal: the hook is exhausted, so another sweep redelivers nothing.
    svc.clock.advance(10 * 60_000);
    await svc.webhooks.sweep();
    assertEquals(svc.delivered.length, 1);
  } finally {
    await svc.db.close();
  }
});

test("a foreign id and a deleted automation are the same 404", async () => {
  const svc = await makeService();
  try {
    const { automation, secret } = await createWebhookAutomation(svc);
    assertEquals((await api(svc, "GET", "/v1/automations/amnobody")).status, 404);

    // A hook accepted but never delivered: the delete must take it too — "removed for good"
    // includes the queued mail, not just the recipe.
    const sig = await hmacHex(secret, "{}");
    const accepted = await fire(svc, automation.trigger.path, sig, "{}");
    assertEquals(accepted.status, 202);
    const { id: hookId } = await accepted.json();

    assertEquals((await api(svc, "DELETE", `/v1/automations/${automation.id}`)).status, 204);
    assertEquals((await api(svc, "GET", `/v1/automations/${automation.id}`)).status, 404);
    assertEquals(await svc.hookStore.getHook(hookId), null);
    const gone = await svc.handler(
      new Request(`http://automations.test${automation.trigger.path}`, {
        method: "POST",
        body: "{}",
      }),
    );
    assertEquals(gone.status, 404);
  } finally {
    await svc.db.close();
  }
});

test("a credential without tasks:create cannot leave behind an automation that starts tasks", async () => {
  const svc = await makeService();
  try {
    const { automation } = await createWebhookAutomation(svc);
    // The owner's own API token, narrowed to managing automations: an automation fires as its
    // owner, so every verb that leaves one able to fire is a delegation the token cannot make.
    const narrow = svc.handlerAs({ ...CALLER, via: "token", caps: ["automations:manage"] });
    const path = `/v1/automations/${automation.id}`;
    const refusals = [
      await apiAs(narrow, "POST", "/v1/automations", webhookCreateBody()),
      await apiAs(narrow, "PATCH", path, { instructions: "something else" }),
      await apiAs(narrow, "POST", `${path}/enable`),
      await apiAs(narrow, "POST", `${path}/rotate-secret`),
    ];
    for (const res of refusals) {
      assertEquals(res.status, 403);
      assertEquals((await res.json()).capability, "tasks:create");
    }
    const listed = await (await api(svc, "GET", "/v1/automations")).json();
    assertEquals(listed.automations.length, 1, "nothing was created");
    assertEquals(listed.automations[0].instructions, "triage the alert", "nor edited");
    // What starts nothing stays open to it: reading, pausing, removing.
    assertEquals((await apiAs(narrow, "GET", path)).status, 200);
    assertEquals((await apiAs(narrow, "POST", `${path}/disable`)).status, 200);
    assertEquals((await apiAs(narrow, "DELETE", path)).status, 204);
  } finally {
    await svc.db.close();
  }
});

test("an automation's target is a branch: a pull request head is refused at creation", async () => {
  const svc = await makeService();
  try {
    for (
      const ref of ["refs/pull/42/head", "pull/42/head", "refs/heads/pull/42/head", "refs/tags/v1"]
    ) {
      const res = await api(
        svc,
        "POST",
        "/v1/automations",
        webhookCreateBody({ target: { kind: "repo", connectedRepoId: "repo-1", ref } }),
      );
      assertEquals(res.status, 400, ref);
      assertStringIncludes((await res.json()).error, "pull request ref");
    }
    const branch = await api(
      svc,
      "POST",
      "/v1/automations",
      webhookCreateBody({ target: { kind: "repo", connectedRepoId: "repo-1", ref: "release" } }),
    );
    assertEquals(branch.status, 201);
  } finally {
    await svc.db.close();
  }
});
