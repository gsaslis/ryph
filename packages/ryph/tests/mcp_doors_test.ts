// Every route a `ryph mcp` tool calls is one the app forwards an API token's bearer through
// (packages/app/src/routes/api/[...path]/path.ts `BEARER_DOORS`). A tool calling a route that is
// not a door works against a local API and fails behind the app with a 401, so the two lists are
// held together here.

import { test } from "bun:test";
import { assert } from "@std/assert";
import { bearerDoors, isBearerDoor } from "../../app/src/routes/api/[...path]/path.ts";
import { ryphTools } from "../src/mcp/server.ts";

test("every route a tool calls is a bearer door of the app", () => {
  const missing: string[] = [];
  for (const tool of ryphTools()) {
    for (const [method, template] of tool.routes) {
      const path = template.replace(/^\//, "").replace(/\{[A-Za-z]+\}/g, "x-1");
      if (!isBearerDoor(method, path)) missing.push(`${tool.name}: ${method} ${template}`);
    }
  }
  assert(missing.length === 0, `not forwarded by the app:\n${missing.join("\n")}`);
});

test("the token's own capabilities are what the doors rely on: no tool reaches auth's account routes", () => {
  for (const tool of ryphTools()) {
    for (const [method, template] of tool.routes) {
      if (!template.startsWith("/v1/auth/")) continue;
      assert(method === "GET" && template === "/v1/auth/me", `${tool.name}: ${method} ${template}`);
    }
  }
});

/** An instance running its checks on another deployment, with an API token of that one
 * (packages/orchestrator/src/adapters/remote_checks/http.ts). */
const REMOTE_CHECKS = "the orchestrator's remote checks backend";

/** Doors no `ryph mcp` tool calls, and who does: nothing else may be open on a bearer. */
const OTHER_USERS: Record<string, string> = {
  "POST v1/check-delegations": REMOTE_CHECKS,
  "POST v1/check-delegations/bundle": REMOTE_CHECKS,
  "DELETE v1/check-delegations/:": REMOTE_CHECKS,
  "GET v1/check-delegations/declaration": REMOTE_CHECKS,
  "GET v1/check-delegations/:": REMOTE_CHECKS,
};

test("every bearer door is one some tool calls, or has a named other user", () => {
  const called = new Set(
    ryphTools().flatMap((t) =>
      t.routes.map(([method, template]) =>
        `${method} ${template.replace(/^\//, "").replace(/\{[A-Za-z]+\}/g, ":")}`
      )
    ),
  );
  const unused = bearerDoors()
    .map(([method, path]) => `${method} ${path.replace(/:[A-Za-z]+/g, ":")}`)
    .filter((door) => !called.has(door) && !(door in OTHER_USERS));
  assert(unused.length === 0, `doors no tool calls:\n${unused.join("\n")}`);
});
