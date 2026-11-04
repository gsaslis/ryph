// The composition boundary: splitting the user surface must neither lose a route nor put the
// task stream behind the :id matcher. Handler behavior stays covered by the existing API tests.
import { test } from "bun:test";
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { WiredDeps } from "../src/http/app.ts";
import { json, makeRouter } from "@ryph/shared/http";
import { userRoutes } from "../src/http/user_api.ts";

// The public inventory before the split. Order between unrelated routes is not a contract.
const INVENTORY = [
  "POST /v1/agents",
  "GET /v1/images",
  "POST /v1/images/pull",
  "GET /v1/harnesses",
  "GET /v1/run-sizes",
  "GET /v1/limits",
  "GET /v1/egress",
  "PUT /v1/egress",
  "GET /v1/agents",
  "GET /v1/agents/:id",
  "PATCH /v1/agents/:id",
  "POST /v1/agents/:id/archive",
  "POST /v1/tasks",
  "GET /v1/tasks",
  "GET /v1/tasks/stream",
  "GET /v1/tasks/:id",
  "POST /v1/tasks/:id/cancel",
  "POST /v1/tasks/:id/finish",
  "POST /v1/tasks/:id/start-without-environment",
  "POST /v1/connected-repos/:id/environment/setup",
  "POST /v1/workspaces/:id/environment/setup",
  "POST /v1/runs/:id/messages",
  "GET /v1/responses",
  "GET /v1/responses/:id",
  "POST /v1/responses/:id/close",
  "GET /v1/patches",
  "GET /v1/patches/:id",
  "GET /v1/patches/:id/diff",
  "POST /v1/patches/:id/approve",
  "POST /v1/patches/:id/reject",
  "POST /v1/patches/:id/retry",
  "POST /v1/installations",
  "GET /v1/installations",
  "GET /v1/installations/:installationId/repos",
  "POST /v1/connected-repos",
  "GET /v1/connected-repos",
  "PATCH /v1/connected-repos/:id",
  "POST /v1/connected-repos/:id/archive",
  "POST /v1/workspaces",
  "GET /v1/workspaces",
  "GET /v1/workspaces/:id",
  "PATCH /v1/workspaces/:id",
  "POST /v1/workspaces/:id/archive",
  "POST /v1/workspaces/:id/repos",
  "PATCH /v1/workspaces/:id/repos/:connectedRepoId",
  "DELETE /v1/workspaces/:id/repos/:connectedRepoId",
  "GET /v1/connected-repos/:id/command-allowlist",
  "POST /v1/connected-repos/:id/command-allowlist",
  "DELETE /v1/connected-repos/:id/command-allowlist/:subject",
  "GET /v1/connected-repos/:id/radicle",
  "GET /v1/connected-repos/:id/installation-settings",
  "GET /v1/connected-repos/:id/gitlab-hook",
  "POST /v1/connected-repos/:id/gitlab-hook/rotate",
  "GET /v1/forge-providers",
  "GET /v1/github/repos",
  "GET /v1/gitlab/projects",
  "GET /v1/radicle/identity",
  "POST /v1/mcp-servers/:id/archive",
];

test("user route composition preserves the complete inventory without duplicates", () => {
  // Construction must not call any ports. The auth-refusal test below likewise deliberately
  // supplies no backing services: a request must authenticate before touching one.
  const routes = userRoutes({} as WiredDeps);
  assertEquals(
    routes.map((r) => `${r.method} ${r.pattern.pathname}`).sort(),
    [...INVENTORY].sort(),
  );
});

test("every composed user route returns the authentication refusal first", async () => {
  const refusal = json(401, { error: "authentication required" });
  const routes = userRoutes(
    { authenticate: () => Promise.resolve(refusal) } as unknown as WiredDeps,
  );
  const handle = makeRouter(routes);
  for (const entry of INVENTORY) {
    const [method, pattern] = entry.split(" ");
    const pathname = pattern.replace(/:[A-Za-z]+/g, "sample");
    const response = await handle(new Request(`http://test${pathname}`, { method }));
    assertStrictEquals(response, refusal, entry);
  }
});

test("user route composition matches the task stream before the task id", async () => {
  const routes = userRoutes({} as WiredDeps);
  // Use marker handlers to exercise the real router's first-match rule without starting a
  // streaming response (the stream's frames and cleanup have their own tests).
  const handle = makeRouter(routes.map((r) => ({
    ...r,
    handler: () => json(200, { matched: r.pattern.pathname }),
  })));
  const response = await handle(new Request("http://test/v1/tasks/stream"));
  assertEquals(await response.json(), { matched: "/v1/tasks/stream" });
});
