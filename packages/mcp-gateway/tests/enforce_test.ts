// The per-request decision, rule by rule, with plain objects.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { decide, isMethodAllowed, isToolAllowed } from "../src/core/enforce.ts";
import type { McpVirtualKey } from "../src/core/types.ts";
import { server, T0 } from "./fixtures.ts";

const LATER = "2026-01-01T00:01:00.000Z";

function key(overrides: Partial<McpVirtualKey> = {}): McpVirtualKey {
  return {
    id: "mk-1",
    runId: "r-1",
    tokenHash: "hash",
    scope: [{ serverId: "ms-1", slug: "linear", allowedTools: ["list_issues"] }],
    expiresAt: LATER,
    revokedAt: null,
    createdAt: T0,
    ...overrides,
  };
}

const PATH = { runId: "r-1", slug: "linear" };

test("a live key on its own run and a server in scope is allowed", () => {
  const d = decide(key(), PATH, server(), T0);
  assertEquals(d.allow, true);
  if (d.allow) {
    assertEquals(d.scoped.allowedTools, ["list_issues"]);
    assertEquals(d.server.id, "ms-1");
  }
});

test("unknown, revoked, expired, wrong run, slug out of scope: identical 401s", () => {
  const cases: Array<[McpVirtualKey | null, typeof PATH]> = [
    [null, PATH],
    [key({ revokedAt: T0 }), PATH],
    [key({ expiresAt: T0 }), PATH], // expires exactly now: gone
    [key(), { runId: "r-2", slug: "linear" }], // a real token on another run's URL
    [key(), { runId: "r-1", slug: "github" }], // a server the run was never granted
  ];
  for (const [k, path] of cases) {
    assertEquals(decide(k, path, server(), T0), {
      allow: false,
      status: 401,
      error: "unauthorized",
    });
  }
});

test("a vanished, swapped, or archived server answers 403, not 401", () => {
  for (
    const s of [
      null,
      server({ id: "ms-other" }), // the scope points at ms-1; this row is someone else
      server({ archivedAt: T0 }),
    ]
  ) {
    const d = decide(key(), PATH, s, T0);
    assertEquals(d.allow, false);
    if (!d.allow) assertEquals(d.status, 403);
  }
});

test("a credentialed server with no sealed credential is refused; a public one is fine", () => {
  const missing = decide(key(), PATH, server({ encryptedAuth: null }), T0);
  assertEquals(missing.allow, false);
  // The one answer for a credential that must be entered again, here and at the model-proxy.
  if (!missing.allow) assertEquals([missing.status, missing.code], [409, "secret_required"]);

  const publicServer = server({ auth: "none", encryptedAuth: null, authLast4: null });
  assertEquals(decide(key(), PATH, publicServer, T0).allow, true);
});

test("the allowlist: a list is exact, '*' is everything", () => {
  assertEquals(isToolAllowed(["a", "b"], "a"), true);
  assertEquals(isToolAllowed(["a", "b"], "c"), false);
  assertEquals(isToolAllowed([], "a"), false);
  assertEquals(isToolAllowed("*", "anything"), true);
});

test("the method allowlist is default-deny: a client's five methods, and nothing else", () => {
  for (
    const method of [
      "initialize",
      "ping",
      "tools/list",
      "tools/call",
      "notifications/initialized",
      "notifications/cancelled",
      "notifications/progress",
      "notifications/roots/list_changed",
    ]
  ) {
    assertEquals(isMethodAllowed(method), true, method);
  }
  // Notifications by name, not by prefix: server→client ones, task status, and anything a
  // vendor hangs under `notifications/` are not a client's to send.
  for (
    const method of [
      "notifications/message",
      "notifications/tools/list_changed",
      "notifications/resources/updated",
      "notifications/tasks/status",
      "notifications/elicitation/complete",
      "notifications/vendor/exfiltrate",
      "notifications/",
      "Notifications/initialized",
    ]
  ) {
    assertEquals(isMethodAllowed(method), false, method);
  }
  for (
    const method of [
      "resources/list",
      "resources/read",
      "resources/subscribe",
      "prompts/list",
      "prompts/get",
      "completion/complete",
      "logging/setLevel",
      "sampling/createMessage",
      "roots/list",
      "vendor/doAnything",
      "tools/listChanged",
      "",
    ]
  ) {
    assertEquals(isMethodAllowed(method), false, method);
  }
});
