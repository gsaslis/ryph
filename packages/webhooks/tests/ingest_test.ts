// The ingestion door driven with plain Requests — real HMAC, real store, no socket.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { setup, type WebhooksSetup } from "../src/setup.ts";
import { makeRouter } from "@ryph/shared/http";
import { drizzleHookStore } from "../src/adapters/store/drizzle.ts";
import { hmacSha256Hex } from "@ryph/sealed";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import {
  deriveScopedSecret,
  type VerificationConfig,
  VERIFIED_GENERATION_HEADER,
  VERIFIED_SCOPE_HEADER,
} from "../src/core/types.ts";
import type { HookStore } from "../src/ports/hook_store.ts";
import type { WebhookRegistrationInput } from "../src/core/types.ts";
import * as schema from "../src/adapters/store/db/schema.ts";
import type { WebhooksDbHandle } from "../src/adapters/store/db/db.ts";
import { makeTestDb } from "./db.ts";

const SECRET = "it's a secret to everybody";
const silent = { debug: () => {}, warn: () => {} };

async function makeDoor(onIngested?: () => void): Promise<{
  handle: WebhooksDbHandle;
  store: HookStore;
  webhooks: WebhooksSetup;
  door: (req: Request) => Promise<Response>;
}> {
  const handle = await makeTestDb();
  const store = drizzleHookStore(handle.db);
  const webhooks = setup({ store, diag: silent, now: () => new Date(), onIngested });
  webhooks.register({
    id: "github",
    verification: {
      kind: "hmac-sha256",
      header: "x-hub-signature-256",
      prefix: "sha256=",
      secret: SECRET,
    },
    maxBodyBytes: 1024,
    consumer: () => Promise.resolve({ kind: "ok" }),
  });
  return { handle, store, webhooks, door: makeRouter(webhooks.routes) };
}

async function signedRequest(body: string, secret = SECRET): Promise<Request> {
  const signature = await hmacSha256Hex(secret, new TextEncoder().encode(body));
  return new Request("http://forge/v1/hooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": `sha256=${signature}`,
      "x-github-event": "issue_comment",
    },
    body,
  });
}

test("a correctly signed hook is persisted raw and answered 202 before any consumer runs", async () => {
  const { handle, store, door } = await makeDoor();
  try {
    const body = '{"action":"created"}';
    const res = await door(await signedRequest(body));
    assertEquals(res.status, 202);
    const { id } = await res.json();

    const hook = await store.getHook(id);
    assert(hook !== null);
    assertEquals(hook.state, "pending");
    assertEquals(hook.body, body);
    assertEquals(hook.headers["x-github-event"], "issue_comment");
  } finally {
    await handle.close();
  }
});

test("an uppercase configured prefix still verifies", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const webhooks = setup({ store, diag: silent, now: () => new Date() });
    webhooks.register({
      id: "shouty",
      verification: { kind: "hmac-sha256", header: "x-sig", prefix: "SHA256=", secret: SECRET },
      maxBodyBytes: 1024,
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const door = makeRouter(webhooks.routes);
    const body = '{"loud":true}';
    const signature = await hmacSha256Hex(SECRET, new TextEncoder().encode(body));
    const res = await door(
      new Request("http://forge/v1/hooks/shouty", {
        method: "POST",
        headers: { "x-sig": `SHA256=${signature}` },
        body,
      }),
    );
    assertEquals(res.status, 202);
  } finally {
    await handle.close();
  }
});

test("a wrong signature and a missing one both answer 401, and nothing is persisted", async () => {
  const { handle, store, door } = await makeDoor();
  try {
    const wrongKey = await door(await signedRequest("{}", "not the secret"));
    assertEquals(wrongKey.status, 401);

    const unsigned = await door(
      new Request("http://forge/v1/hooks/github", { method: "POST", body: "{}" }),
    );
    assertEquals(unsigned.status, 401);

    assertEquals(await store.getHeadHook("github"), null);
  } finally {
    await handle.close();
  }
});

test("a tampered body fails the signature it was not signed with", async () => {
  const { handle, door } = await makeDoor();
  try {
    const signed = await signedRequest('{"action":"created"}');
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: '{"action":"deleted"}',
    });
    assertEquals((await door(tampered)).status, 401);
  } finally {
    await handle.close();
  }
});

test("an unknown registration id is the same 404 as an unknown path", async () => {
  const { handle, door } = await makeDoor();
  try {
    const res = await door(
      new Request("http://forge/v1/hooks/nobody", { method: "POST", body: "{}" }),
    );
    assertEquals(res.status, 404);
    assertEquals(await res.json(), { error: "not found" });
  } finally {
    await handle.close();
  }
});

test("a body over the registration's cap is refused with 413", async () => {
  const { handle, door } = await makeDoor();
  try {
    const res = await door(await signedRequest("x".repeat(2048)));
    assertEquals(res.status, 413);
  } finally {
    await handle.close();
  }
});

test("ingestion kicks onIngested after the row is durable", async () => {
  let kicked = 0;
  const { handle, door } = await makeDoor(() => kicked++);
  try {
    await door(await signedRequest("{}"));
    assertEquals(kicked, 1);
  } finally {
    await handle.close();
  }
});

test("secret-header verification accepts the secret and refuses everything else", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const webhooks = setup({ store, diag: silent, now: () => new Date() });
    webhooks.register({
      id: "grafana",
      verification: { kind: "secret-header", header: "authorization", secret: SECRET },
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const door = makeRouter(webhooks.routes);
    const request = (headers: Record<string, string>) =>
      new Request("http://automations/v1/hooks/grafana", { method: "POST", headers, body: "{}" });

    assertEquals((await door(request({ authorization: SECRET }))).status, 202);
    assertEquals((await door(request({ authorization: "not the secret" }))).status, 401);
    assertEquals((await door(request({}))).status, 401);
  } finally {
    await handle.close();
  }
});

test("derived-secret-header accepts only the secret derived for the named scope", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const webhooks = setup({ store, diag: silent, now: () => new Date() });
    webhooks.register({
      id: "gitlab",
      verification: {
        kind: "derived-secret-header",
        header: "x-gitlab-token",
        master: SECRET,
        label: "gitlab-hook:",
        scopeParam: "project",
      },
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const door = makeRouter(webhooks.routes);
    const request = (query: string, headers: Record<string, string>) =>
      new Request(`http://forge/v1/hooks/gitlab${query}`, { method: "POST", headers, body: "{}" });
    // The derivation, spelled out rather than imported: the contract a connect page shows.
    const for42 = await hmacSha256Hex(SECRET, "gitlab-hook:42");
    assertEquals(await deriveScopedSecret(SECRET, "gitlab-hook:", "42"), for42);

    assertEquals((await door(request("?project=42", { "x-gitlab-token": for42 }))).status, 202);
    // Project 43's hook cannot vouch for project 42, nor 42's for 43.
    const for43 = await hmacSha256Hex(SECRET, "gitlab-hook:43");
    assertEquals((await door(request("?project=42", { "x-gitlab-token": for43 }))).status, 401);
    assertEquals((await door(request("?project=43", { "x-gitlab-token": for42 }))).status, 401);
    // The master itself is not a token, and nor is nothing.
    assertEquals((await door(request("?project=42", { "x-gitlab-token": SECRET }))).status, 401);
    assertEquals((await door(request("?project=42", {}))).status, 401);
    // The scope is digits, exactly once.
    for (const query of ["", "?project=", "?project=4a2", "?project=42&project=42", "?p=42"]) {
      assertEquals(
        (await door(request(query, { "x-gitlab-token": for42 }))).status,
        401,
        `query ${JSON.stringify(query)}`,
      );
    }
    const leading = await hmacSha256Hex(SECRET, "gitlab-hook:042");
    assertEquals((await door(request("?project=042", { "x-gitlab-token": leading }))).status, 202);
  } finally {
    await handle.close();
  }
});

test("a derived-secret-header row carries the verified scope and never the token", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const webhooks = setup({ store, diag: silent, now: () => new Date() });
    webhooks.register({
      id: "gitlab",
      verification: {
        kind: "derived-secret-header",
        header: "x-gitlab-token",
        master: SECRET,
        label: "gitlab-hook:",
        scopeParam: "project",
      },
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const door = makeRouter(webhooks.routes);
    const token = await deriveScopedSecret(SECRET, "gitlab-hook:", "7");
    const res = await door(
      new Request("http://forge/v1/hooks/gitlab?project=7", {
        method: "POST",
        headers: {
          "x-gitlab-token": token,
          "x-gitlab-event": "Note Hook",
          // A sender's own claim to a scope is dropped: only the door writes this header.
          [VERIFIED_SCOPE_HEADER]: "8",
        },
        body: '{"object_kind":"note"}',
      }),
    );
    assertEquals(res.status, 202);
    const { id } = await res.json();
    const hook = await store.getHook(id);
    assert(hook !== null);
    assert(!JSON.stringify(hook).includes(token));
    assertEquals(hook.headers["x-gitlab-token"], undefined);
    assertEquals(hook.headers[VERIFIED_SCOPE_HEADER], "7");
    assertEquals(hook.headers["x-gitlab-event"], "Note Hook");
    // The verified scope is also the row's queue; a registration without generations writes none.
    assertEquals(hook.scope, "7");
    assertEquals(hook.headers[VERIFIED_GENERATION_HEADER], undefined);
  } finally {
    await handle.close();
  }
});

/** A `derived-secret-header` mailbox whose tokens carry a generation, and a request maker. */
async function makeGenerationDoor() {
  const handle = await makeTestDb();
  const store = drizzleHookStore(handle.db);
  const webhooks = setup({ store, diag: silent, now: () => new Date() });
  webhooks.register({
    id: "gitlab",
    verification: {
      kind: "derived-secret-header",
      header: "x-gitlab-token",
      master: SECRET,
      label: "gitlab-hook:",
      scopeParam: "project",
      generationParam: "generation",
    },
    consumer: () => Promise.resolve({ kind: "ok" }),
  });
  const door = makeRouter(webhooks.routes);
  const request = (query: string, headers: Record<string, string>) =>
    new Request(`http://forge/v1/hooks/gitlab${query}`, { method: "POST", headers, body: "{}" });
  return { handle, store, door, request };
}

test("derived-secret-header with generations accepts only the token minted for the URL's generation", async () => {
  const { handle, store, door, request } = await makeGenerationDoor();
  try {
    // The derivation, spelled out: label + scope + ":" + generation.
    const gen1 = await hmacSha256Hex(SECRET, "gitlab-hook:42:1");
    const gen2 = await hmacSha256Hex(SECRET, "gitlab-hook:42:2");
    assertEquals(await deriveScopedSecret(SECRET, "gitlab-hook:", "42", "1"), gen1);
    assertEquals(await deriveScopedSecret(SECRET, "gitlab-hook:", "42", "2"), gen2);

    assertEquals(
      (await door(request("?project=42&generation=1", { "x-gitlab-token": gen1 }))).status,
      202,
    );
    assertEquals(
      (await door(request("?project=42&generation=2", { "x-gitlab-token": gen2 }))).status,
      202,
    );
    // A generation-1 token under a URL naming 2 is refused, and the other way round.
    assertEquals(
      (await door(request("?project=42&generation=2", { "x-gitlab-token": gen1 }))).status,
      401,
    );
    assertEquals(
      (await door(request("?project=42&generation=1", { "x-gitlab-token": gen2 }))).status,
      401,
    );
    // Another scope's token for the same generation vouches for nothing here.
    const other = await deriveScopedSecret(SECRET, "gitlab-hook:", "43", "1");
    assertEquals(
      (await door(request("?project=42&generation=1", { "x-gitlab-token": other }))).status,
      401,
    );

    // The generation is required, exactly once, digits only, at most ten of them — and the
    // generation-less token is not a fallback for a request that names none.
    const plain = await deriveScopedSecret(SECRET, "gitlab-hook:", "42");
    assertEquals((await door(request("?project=42", { "x-gitlab-token": plain }))).status, 401);
    const refused: [string, string][] = [
      ["?project=42", gen1],
      ["?project=42&generation=", gen1],
      ["?project=42&generation=1a", gen1],
      ["?project=42&generation=-1", gen1],
      ["?project=42&generation=1&generation=1", gen1],
      ["?project=42&generation=1&generation=2", gen2],
      [
        "?project=42&generation=12345678901",
        await deriveScopedSecret(SECRET, "gitlab-hook:", "42", "12345678901"),
      ],
    ];
    for (const [query, token] of refused) {
      assertEquals(
        (await door(request(query, { "x-gitlab-token": token }))).status,
        401,
        `query ${JSON.stringify(query)}`,
      );
    }
    const tenDigits = await deriveScopedSecret(SECRET, "gitlab-hook:", "42", "1234567890");
    assertEquals(
      (await door(request("?project=42&generation=1234567890", { "x-gitlab-token": tenDigits })))
        .status,
      202,
    );

    // Every accepted request named project 42, so they all wait in that one scope's queue.
    const queues = await store.getDueQueues(
      ["gitlab"],
      new Date(Date.now() + 60_000).toISOString(),
    );
    assertEquals(queues.map((q) => q.scope), ["42"]);
  } finally {
    await handle.close();
  }
});

test("a generation row carries both verified headers, drops the sender's, and queues by scope", async () => {
  const { handle, store, door, request } = await makeGenerationDoor();
  try {
    const token = await deriveScopedSecret(SECRET, "gitlab-hook:", "7", "3");
    const res = await door(request("?project=7&generation=3", {
      "x-gitlab-token": token,
      "x-gitlab-event": "Merge Request Hook",
      // A sender's own claims are dropped: only the door writes these.
      [VERIFIED_SCOPE_HEADER]: "8",
      [VERIFIED_GENERATION_HEADER]: "99",
    }));
    assertEquals(res.status, 202);
    const { id } = await res.json();
    const hook = await store.getHook(id);
    assert(hook !== null);
    assert(!JSON.stringify(hook).includes(token));
    assertEquals(hook.headers[VERIFIED_SCOPE_HEADER], "7");
    assertEquals(hook.headers[VERIFIED_GENERATION_HEADER], "3");
    assertEquals(hook.headers["x-gitlab-event"], "Merge Request Hook");
    assertEquals(hook.scope, "7");
    assertEquals((await store.getHeadHook("gitlab", "7"))?.id, id);
  } finally {
    await handle.close();
  }
});

test("a sender-sent verified-generation header is dropped for every kind, and unscoped rows have a null scope", async () => {
  const { handle, store, door } = await makeDoor();
  try {
    const req = await signedRequest("{}");
    req.headers.set(VERIFIED_GENERATION_HEADER, "5");
    req.headers.set(VERIFIED_SCOPE_HEADER, "5");
    const res = await door(req);
    assertEquals(res.status, 202);
    const hook = await store.getHook((await res.json()).id);
    assert(hook !== null);
    assertEquals(hook.headers[VERIFIED_GENERATION_HEADER], undefined);
    assertEquals(hook.headers[VERIFIED_SCOPE_HEADER], undefined);
    assertEquals(hook.scope, null);
  } finally {
    await handle.close();
  }
});

test("a derived-secret-header registration with an empty master fails closed", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const webhooks = setup({ store, diag: silent, now: () => new Date() });
    webhooks.register({
      id: "gitlab",
      verification: {
        kind: "derived-secret-header",
        header: "x-gitlab-token",
        master: "",
        label: "gitlab-hook:",
        scopeParam: "project",
      },
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const door = makeRouter(webhooks.routes);
    // Whatever is presented: there is no derivation under an empty key worth accepting.
    const res = await door(
      new Request("http://forge/v1/hooks/gitlab?project=7", {
        method: "POST",
        headers: { "x-gitlab-token": "anything" },
        body: "{}",
      }),
    );
    assertEquals(res.status, 401);
  } finally {
    await handle.close();
  }
});

test("the rate limit refuses verified requests over budget and recovers after the window", async () => {
  const handle = await makeTestDb();
  try {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const rateLimited: string[] = [];
    const store = drizzleHookStore(handle.db);
    const webhooks = setup({
      store,
      diag: silent,
      now: () => new Date(nowMs),
      onRateLimited: (id) => rateLimited.push(id),
    });
    webhooks.register({
      id: "grafana",
      verification: { kind: "secret-header", header: "authorization", secret: SECRET },
      rateLimit: { maxPerWindow: 2, windowMs: 60_000 },
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const door = makeRouter(webhooks.routes);
    const fire = () =>
      door(
        new Request("http://automations/v1/hooks/grafana", {
          method: "POST",
          headers: { authorization: SECRET },
          body: "{}",
        }),
      );

    assertEquals((await fire()).status, 202);
    assertEquals((await fire()).status, 202);
    const refused = await fire();
    assertEquals(refused.status, 429);
    assertEquals(rateLimited, ["grafana"]);

    // An unverified request never spends budget, and never trips the limiter's answer either.
    const unsigned = await door(
      new Request("http://automations/v1/hooks/grafana", { method: "POST", body: "{}" }),
    );
    assertEquals(unsigned.status, 401);

    nowMs += 60_001;
    assertEquals((await fire()).status, 202);
  } finally {
    await handle.close();
  }
});

/** A GitLab-shaped mailbox for the per-scope limits: tokens for projects 7 and 8, generation 1
 * (and 7's stale generation 0), and a door whose clock the test moves. */
async function makeScopedDoor(
  over: Partial<Pick<WebhookRegistrationInput, "rateLimit" | "admitScope" | "onOverLimit">> = {},
) {
  const handle = await makeTestDb();
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const store = drizzleHookStore(handle.db);
  const webhooks = setup({ store, diag: silent, now: () => new Date(nowMs) });
  webhooks.register({
    id: "gitlab",
    verification: {
      kind: "derived-secret-header",
      header: "x-gitlab-token",
      master: SECRET,
      label: "gitlab-hook:",
      scopeParam: "project",
      generationParam: "generation",
    },
    ...over,
    consumer: () => Promise.resolve({ kind: "ok" }),
  });
  const door = makeRouter(webhooks.routes);
  const fire = async (project: string, generation = "1", event = "Push Hook") =>
    (await door(
      new Request(`http://forge/v1/hooks/gitlab?project=${project}&generation=${generation}`, {
        method: "POST",
        headers: {
          "x-gitlab-event": event,
          "x-gitlab-token": await deriveScopedSecret(SECRET, "gitlab-hook:", project, generation),
        },
        body: "{}",
      }),
    )).status;
  const rows = async () =>
    (await handle.db.select().from(schema.webhooks)).map((r) => `${r.scope}`).sort();
  return { handle, store, fire, rows, advance: (ms: number) => nowMs += ms };
}

test("a per-scope rate limit spends each verified scope's budget apart: one project's flood is its own", async () => {
  const { handle, fire, rows, advance } = await makeScopedDoor({
    rateLimit: { maxPerWindow: 2, windowMs: 60_000, per: "scope" },
  });
  try {
    assertEquals(await fire("7"), 202);
    assertEquals(await fire("7"), 202);
    assertEquals(await fire("7"), 429, "project 7 is over its own budget");
    assertEquals(await fire("8"), 202, "and project 8 still has all of its own");
    assertEquals(await rows(), ["7", "7", "8"]);
    advance(60_001);
    assertEquals(await fire("7"), 202);
  } finally {
    await handle.close();
  }
});

test("a scope the registrant refuses at the door is answered 403 and never stored", async () => {
  const asked: string[] = [];
  const { handle, fire, rows } = await makeScopedDoor({
    // Project 7 is connected at generation 1; its generation 0 was rotated away, and project 8
    // is connected nowhere.
    admitScope: (scope, generation) => {
      asked.push(`${scope}@${generation}`);
      return Promise.resolve(scope === "7" && generation === "1");
    },
  });
  try {
    assertEquals(await fire("7", "0"), 403);
    assertEquals(await fire("8"), 403);
    assertEquals(await fire("7"), 202);
    assertEquals(await rows(), ["7"]);
    assertEquals(asked, ["7@0", "8@1", "7@1"]);
  } finally {
    await handle.close();
  }
});

test("a door whose registrant cannot answer stores nothing: 503, never an unchecked row", async () => {
  const { handle, fire, rows } = await makeScopedDoor({
    admitScope: () => Promise.reject(new Error("control plane down")),
  });
  try {
    assertEquals(await fire("7"), 503);
    assertEquals(await rows(), []);
  } finally {
    await handle.close();
  }
});

test("a token that fails verification never reaches the registrant's scope check", async () => {
  const asked: string[] = [];
  const { handle } = await makeScopedDoor();
  try {
    const store = drizzleHookStore(handle.db);
    const webhooks = setup({ store, diag: silent, now: () => new Date() });
    webhooks.register({
      id: "gitlab",
      verification: {
        kind: "derived-secret-header",
        header: "x-gitlab-token",
        master: SECRET,
        label: "gitlab-hook:",
        scopeParam: "project",
      },
      admitScope: (scope) => {
        asked.push(scope);
        return Promise.resolve(true);
      },
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const res = await makeRouter(webhooks.routes)(
      new Request("http://forge/v1/hooks/gitlab?project=7", {
        method: "POST",
        headers: { "x-gitlab-token": "a guess" },
        body: "{}",
      }),
    );
    assertEquals(res.status, 401);
    assertEquals(asked, []);
  } finally {
    await handle.close();
  }
});

test("unregister closes the door with the uniform 404 and re-register reopens it", async () => {
  const { handle, store, webhooks, door } = await makeDoor();
  try {
    const first = await door(await signedRequest("{}"));
    assertEquals(first.status, 202);

    webhooks.unregister("github");
    assertEquals((await door(await signedRequest("{}"))).status, 404);
    // What already got in stays put, waiting for the mailbox to come back.
    assert(await store.getHeadHook("github") !== null);

    webhooks.register({
      id: "github",
      verification: {
        kind: "hmac-sha256",
        header: "x-hub-signature-256",
        prefix: "sha256=",
        secret: SECRET,
      },
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    assertEquals((await door(await signedRequest("{}"))).status, 202);
  } finally {
    await handle.close();
  }
});

test("enqueue persists a pending hook without the door and kicks onIngested", async () => {
  let kicked = 0;
  const { handle, store, webhooks } = await makeDoor(() => kicked++);
  try {
    const hook = await webhooks.enqueue("github", '{"firedAt":"2026-01-01T09:00:00Z"}');
    assertEquals(hook.state, "pending");
    assertEquals(hook.headers, {});
    assertEquals(hook.scope, null); // a minted hook has no door, so no verified scope
    assertEquals(kicked, 1);
    assertEquals((await store.getHeadHook("github"))?.id, hook.id);

    let threw = false;
    await webhooks.enqueue("nobody", "{}").catch(() => threw = true);
    assert(threw);
  } finally {
    await handle.close();
  }
});

test("register refuses a duplicate id and a non-slug id", async () => {
  const { handle, webhooks } = await makeDoor();
  try {
    const reg = {
      verification: {
        kind: "hmac-sha256" as const,
        header: "x",
        prefix: "",
        secret: "s",
      },
      consumer: () => Promise.resolve({ kind: "ok" as const }),
    };
    let threw = 0;
    try {
      webhooks.register({ ...reg, id: "github" });
    } catch {
      threw++;
    }
    try {
      webhooks.register({ ...reg, id: "Not A Slug" });
    } catch {
      threw++;
    }
    assertEquals(threw, 2);
  } finally {
    await handle.close();
  }
});

test("a secret-header registration's stored row holds no trace of the secret", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const webhooks = setup({ store, diag: silent, now: () => new Date() });
    const bearer = `Bearer ${SECRET}`;
    webhooks.register({
      // The Radicle bridge's mailbox, as @ryph/forge rents it: the shared bearer verbatim on
      // `authorization`, which is the credential and must never reach the table.
      id: "radicle",
      verification: { kind: "secret-header", header: "authorization", secret: bearer },
      maxBodyBytes: 1024,
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const door = makeRouter(webhooks.routes);
    const res = await door(
      new Request("http://forge/v1/hooks/radicle", {
        method: "POST",
        headers: {
          authorization: bearer,
          cookie: "session=deadbeef",
          "x-ryph-event": "comment.created",
        },
        body: '{"kind":"comment.created"}',
      }),
    );
    assertEquals(res.status, 202);
    const { id } = await res.json();

    const hook = await store.getHook(id);
    assert(hook !== null);
    // The row is what an operator reading the table sees, headers and body together.
    assert(!JSON.stringify(hook).includes(SECRET));
    assertEquals(hook.headers["authorization"], undefined);
    assertEquals(hook.headers["cookie"], undefined);
    // Everything that is not a credential is still there — the row stays useful.
    assertEquals(hook.headers["x-ryph-event"], "comment.created");
  } finally {
    await handle.close();
  }
});

test("a signature header is dropped too, and the consumer's own headers survive", async () => {
  const { handle, store, door } = await makeDoor();
  try {
    const res = await door(await signedRequest('{"action":"created"}'));
    assertEquals(res.status, 202);
    const hook = await store.getHook((await res.json()).id);
    assert(hook !== null);
    assertEquals(hook.headers["x-hub-signature-256"], undefined);
    assertEquals(hook.headers["x-github-event"], "issue_comment");
  } finally {
    await handle.close();
  }
});

/** A one-registration door around `verification`, with a settable clock for the timestamped
 * kind. */
async function makeVerifyingDoor(
  verification: VerificationConfig,
  now: () => Date = () => new Date(),
): Promise<{
  handle: WebhooksDbHandle;
  store: HookStore;
  door: (req: Request) => Promise<Response>;
}> {
  const handle = await makeTestDb();
  const store = drizzleHookStore(handle.db);
  const webhooks = setup({ store, diag: silent, now });
  webhooks.register({
    id: "vendor",
    verification,
    maxBodyBytes: 4096,
    consumer: () => Promise.resolve({ kind: "ok" }),
  });
  return { handle, store, door: makeRouter(webhooks.routes) };
}

const vendorRequest = (headers: Record<string, string>, body: string) =>
  new Request("http://automations/v1/hooks/vendor", { method: "POST", headers, body });

test("hmac-sha256 accepts a header carrying several signatures when any one matches (PagerDuty)", async () => {
  const { handle, door } = await makeVerifyingDoor({
    kind: "hmac-sha256",
    header: "x-pagerduty-signature",
    prefix: "v1=",
    secret: SECRET,
  });
  try {
    const body = '{"event":{"event_type":"incident.triggered"}}';
    const good = createHmac("sha256", SECRET).update(body).digest("hex");
    const stale = createHmac("sha256", "the secret being rotated out").update(body).digest("hex");
    const send = (signature: string) =>
      door(vendorRequest({ "x-pagerduty-signature": signature }, body));

    // Mid-rotation: the old secret's signature first, ours second — and the other way round.
    assertEquals((await send(`v1=${stale},v1=${good}`)).status, 202);
    assertEquals((await send(`v1=${good}, v1=${stale}`)).status, 202);
    // Uppercase hex still matches; a lone signature is the one-part case.
    assertEquals((await send(`v1=${good.toUpperCase()}`)).status, 202);
    // None of the parts match, the prefix is missing, or the list is empty.
    assertEquals((await send(`v1=${stale},v1=${stale}`)).status, 401);
    assertEquals((await send(`${good}`)).status, 401);
    assertEquals((await send(",")).status, 401);
  } finally {
    await handle.close();
  }
});

test("secret-header compares against prefix + secret", async () => {
  const { handle, store, door } = await makeVerifyingDoor({
    kind: "secret-header",
    header: "authorization",
    prefix: "Bearer ",
    secret: SECRET,
  });
  try {
    const ok = await door(vendorRequest({ authorization: `Bearer ${SECRET}` }, "{}"));
    assertEquals(ok.status, 202);
    // The bare secret is not enough once a scheme is configured, nor the wrong scheme.
    assertEquals((await door(vendorRequest({ authorization: SECRET }, "{}"))).status, 401);
    assertEquals(
      (await door(vendorRequest({ authorization: `Token ${SECRET}` }, "{}"))).status,
      401,
    );

    const hook = await store.getHook((await ok.json()).id);
    assert(hook !== null);
    assert(!JSON.stringify(hook).includes(SECRET));
  } finally {
    await handle.close();
  }
});

/** A Svix-style signing secret and its key bytes: `whsec_` + the base64 of the key. */
const SVIX_KEY = Buffer.from("ryph-standard-webhooks-key!", "utf8");
const SVIX_SECRET = `whsec_${SVIX_KEY.toString("base64")}`;

function svixSign(id: string, timestamp: number, body: string, key = SVIX_KEY): string {
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

test("standard-webhooks accepts a Svix-signed request and drops the signature from the row", async () => {
  const now = new Date("2026-10-13T10:00:00Z");
  const { handle, store, door } = await makeVerifyingDoor(
    { kind: "standard-webhooks", secret: SVIX_SECRET },
    () => now,
  );
  try {
    const body = '{"event_type":"public_incident.incident_created_v2"}';
    const id = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
    const ts = Math.floor(now.getTime() / 1000);
    const sig = svixSign(id, ts, body);
    const headers = (signature: string, timestamp = ts) => ({
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    });

    const ok = await door(vendorRequest(headers(`v1,${sig}`), body));
    assertEquals(ok.status, 202);
    const hook = await store.getHook((await ok.json()).id);
    assert(hook !== null);
    assertEquals(hook.headers["webhook-signature"], undefined);
    // The delivery id carries no credential and stays for a consumer to read.
    assertEquals(hook.headers["webhook-id"], id);

    // Several space-separated signatures, one of which matches; another version is skipped.
    const other = svixSign(id, ts, body, Buffer.from("some other key"));
    assertEquals((await door(vendorRequest(headers(`v1,${other} v1,${sig}`), body))).status, 202);
    assertEquals((await door(vendorRequest(headers(`v2,${sig} v1,${sig}`), body))).status, 202);

    // A secret given without its `whsec_` prefix is the same key.
    const { handle: bare, door: bareDoor } = await makeVerifyingDoor(
      { kind: "standard-webhooks", secret: SVIX_KEY.toString("base64") },
      () => now,
    );
    try {
      assertEquals((await bareDoor(vendorRequest(headers(`v1,${sig}`), body))).status, 202);
    } finally {
      await bare.close();
    }

    // Wrong key, the signature without its version, a tampered body, a missing header.
    assertEquals((await door(vendorRequest(headers(`v1,${other}`), body))).status, 401);
    assertEquals((await door(vendorRequest(headers(sig), body))).status, 401);
    assertEquals((await door(vendorRequest(headers(`v1,${sig}`), `${body} `))).status, 401);
    const { "webhook-id": _, ...noId } = headers(`v1,${sig}`);
    assertEquals((await door(vendorRequest(noId, body))).status, 401);
    // The signature binds the id: the same signature under another id fails.
    assertEquals(
      (await door(vendorRequest({ ...headers(`v1,${sig}`), "webhook-id": "msg_other" }, body)))
        .status,
      401,
    );
  } finally {
    await handle.close();
  }
});

test("standard-webhooks refuses a timestamp more than five minutes off, either way", async () => {
  const now = new Date("2026-10-13T10:00:00Z");
  const { handle, door } = await makeVerifyingDoor(
    { kind: "standard-webhooks", secret: SVIX_SECRET },
    () => now,
  );
  try {
    const body = "{}";
    const id = "msg_replayed";
    const nowS = Math.floor(now.getTime() / 1000);
    const at = (ts: number) =>
      door(vendorRequest({
        "webhook-id": id,
        "webhook-timestamp": String(ts),
        "webhook-signature": `v1,${svixSign(id, ts, body)}`,
      }, body));

    // Correctly signed every time — only the clock distance differs.
    assertEquals((await at(nowS - 299)).status, 202);
    assertEquals((await at(nowS + 299)).status, 202);
    assertEquals((await at(nowS - 301)).status, 401);
    assertEquals((await at(nowS + 301)).status, 401);
  } finally {
    await handle.close();
  }
});

test("a secret that decodes to an empty key, or an empty secret, verifies nothing", async () => {
  const now = new Date("2026-10-13T10:00:00Z");
  const body = "{}";
  const id = "msg_forged";
  const ts = Math.floor(now.getTime() / 1000);
  // Node's base64 decoder skips what it cannot read: each of these is an EMPTY HMAC key, which
  // anyone can sign with. The door must not take a signature made with it.
  const forged = svixSign(id, ts, body, Buffer.alloc(0));
  for (const secret of ["whsec_", "!!!!!!!!!!!!!!!!", "whsec_A"]) {
    const { handle, door } = await makeVerifyingDoor(
      { kind: "standard-webhooks", secret },
      () => now,
    );
    try {
      const res = await door(vendorRequest({
        "webhook-id": id,
        "webhook-timestamp": String(ts),
        "webhook-signature": `v1,${forged}`,
      }, body));
      assertEquals(res.status, 401, secret);
    } finally {
      await handle.close();
    }
  }

  // HMAC-SHA256 under an empty key, computed by anyone (WebCrypto refuses a zero-length key).
  const emptyHmac = createHmac("sha256", Buffer.alloc(0)).update(body).digest("hex");
  const cases: Array<[VerificationConfig, Record<string, string>]> = [
    [{ kind: "hmac-sha256", header: "x-sig", prefix: "", secret: "" }, { "x-sig": emptyHmac }],
    [{ kind: "secret-header", header: "x-secret", secret: "" }, { "x-secret": "" }],
  ];
  for (const [verification, headers] of cases) {
    const { handle, door } = await makeVerifyingDoor(verification, () => now);
    try {
      assertEquals((await door(vendorRequest(headers, body))).status, 401, verification.kind);
    } finally {
      await handle.close();
    }
  }
});

test("a rate limit that drops answers 202 over budget, stores nothing, and says which scope", async () => {
  const over: string[] = [];
  const { handle, fire, rows, advance } = await makeScopedDoor({
    rateLimit: { maxPerWindow: 2, windowMs: 60_000, per: "scope", over: "drop" },
    onOverLimit: (scope, generation) => over.push(`${scope}@${generation}`),
  });
  try {
    assertEquals(await fire("7"), 202);
    assertEquals(await fire("7"), 202);
    // Over budget: GitLab is told it arrived, so it never counts toward disabling the hook.
    assertEquals(await fire("7"), 202);
    assertEquals(await fire("7"), 202);
    assertEquals(await fire("8"), 202);
    assertEquals(await rows(), ["7", "7", "8"]);
    assertEquals(over, ["7@1", "7@1"]);
    advance(60_001);
    assertEquals(await fire("7"), 202);
    assertEquals(await rows(), ["7", "7", "7", "8"]);
  } finally {
    await handle.close();
  }
});

test("a laned rate limit spends each lane of a scope's budget apart: one kind's flood never drops another", async () => {
  const over: string[] = [];
  const { handle, fire, rows } = await makeScopedDoor({
    rateLimit: {
      maxPerWindow: 2,
      windowMs: 60_000,
      per: "scope",
      over: "drop",
      lane: (headers) => headers.get("x-gitlab-event") === "Note Hook" ? "comments" : "other",
    },
    onOverLimit: (scope, generation, lane) => over.push(`${scope}@${generation}:${lane}`),
  });
  try {
    assertEquals(await fire("7", "1", "Merge Request Hook"), 202);
    assertEquals(await fire("7", "1", "Push Hook"), 202);
    assertEquals(await fire("7", "1", "Merge Request Hook"), 202); // over: dropped
    // Comments spend their own lane, and a made-up event name spends "other", not a lane of its own.
    assertEquals(await fire("7", "1", "Note Hook"), 202);
    assertEquals(await fire("7", "1", "Anything Hook"), 202); // over: dropped
    assertEquals(await fire("7", "1", "Note Hook"), 202);
    assertEquals(await fire("7", "1", "Note Hook"), 202); // over: dropped
    // And each scope's lanes are its own.
    assertEquals(await fire("8", "1", "Merge Request Hook"), 202);
    assertEquals(await rows(), ["7", "7", "7", "7", "8"]);
    assertEquals(over, ["7@1:other", "7@1:other", "7@1:comments"]);
  } finally {
    await handle.close();
  }
});
