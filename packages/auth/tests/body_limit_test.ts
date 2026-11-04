import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { makeAuthService } from "../src/core/service.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { AUTH_BODY_LIMIT, authRoutes } from "../src/http/routes.ts";
import { memoryAuthStore } from "./memory_store.ts";

test("auth caps streamed login JSON before credential checks, preserving malformed-body errors", async () => {
  const service = await makeAuthService({ store: memoryAuthStore(), now: () => new Date() });
  let logins = 0;
  const login = service.login;
  service.login = (...args) => {
    logins++;
    return login(...args);
  };
  const route = authRoutes({
    service,
    verifier: verifierFromJwksSource(() => service.jwks()),
    now: () => new Date(),
  }).find((r) => r.method === "POST" && r.pattern.test("http://auth.test/v1/auth/login"))!;
  const valid = JSON.stringify({ email: "ada@example.com", password: "correct horse battery" });
  for (const [size, expected] of [[AUTH_BODY_LIMIT + 1, 413], [AUTH_BODY_LIMIT, 401]]) {
    const bytes = new TextEncoder().encode(valid.padEnd(size));
    const req = new Request("http://auth.test/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    });
    assertEquals(req.headers.has("content-length"), false);
    const res = await route.handler(req, {});
    assertEquals(res.status, expected);
    if (expected === 413) {
      assertStringIncludes((await res.json()).error, String(AUTH_BODY_LIMIT));
      assertEquals(logins, 0);
    }
  }
  assertEquals(logins, 1);
  const malformed = await route.handler(
    new Request("http://auth.test/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    {},
  );
  assertEquals(malformed.status, 400);
});
