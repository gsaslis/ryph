// Every route on the user surface names a capability, and asks for it before it reads anything.
//
// A caller holding no capability walks every route. Each must answer a 403 that names what it
// lacks, and must do so before touching its dependencies: every one of them throws when called,
// so a route that looks something up first fails here too. A route that takes no capability
// has to be listed below with the reason, so a new ungated route is a failing test rather than
// a quiet hole.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { AppDeps, Authenticate } from "../src/http/app.ts";
import { userRoutes } from "../src/http/user_api.ts";
import { commandRoomRoutes } from "../src/http/command_rooms_api.ts";
import { environmentRoutes } from "../src/http/environments_api.ts";
import { checksRoutes } from "../src/http/checks_api.ts";
import { capacityRoutes } from "../src/http/capacity_api.ts";
import type { Route } from "@ryph/shared/http";

/** `METHOD /pattern` of each route that takes no capability, and why. */
const UNGATED: Record<string, string> = {
  "GET /v1/limits": "the run limits every caller's runs are under, for the forms",
};

/** Anything reached through it may be read, and throws the moment it is called. */
function untouchable(path: string): unknown {
  return new Proxy(function () {}, {
    get: (_target, key) => key === "then" ? undefined : untouchable(`${path}.${String(key)}`),
    apply: () => {
      throw new Error(`called ${path}() before the gate`);
    },
  });
}

const NOBODY = {
  kind: "user",
  userId: "u-nobody",
  email: "nobody@example.com",
  name: "Nobody",
  caps: [],
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;

function routes(): Route[] {
  const deps = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (key === "authenticate") return (() => Promise.resolve(NOBODY)) as Authenticate;
      if (key === "then") return undefined;
      return untouchable(`deps.${String(key)}`);
    },
  }) as unknown as AppDeps & Parameters<typeof userRoutes>[0];
  return [
    ...userRoutes(deps),
    ...commandRoomRoutes(deps),
    ...environmentRoutes(deps),
    ...checksRoutes(deps),
    ...capacityRoutes(deps),
  ];
}

/** A concrete URL for a pattern: every `:param` filled with a placeholder. */
const concrete = (pathname: string) => pathname.replace(/:(\w+)/g, (_m, name) => `x-${name}`);

test("every user route refuses a caller without a capability, before reading anything", async () => {
  const all = routes();
  assert(all.length > 50, `only ${all.length} routes found`);
  const failures: string[] = [];
  for (const r of all) {
    const name = `${r.method} ${r.pattern.pathname}`;
    if (name in UNGATED) continue;
    const url = `http://orchestrator.test${concrete(r.pattern.pathname)}`;
    const params = r.pattern.exec(url)?.pathname.groups ?? {};
    const req = new Request(url, {
      method: r.method,
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      ...(r.method === "GET" || r.method === "DELETE" ? {} : { body: "{}" }),
    });
    let res: Response;
    try {
      res = await r.handler(req, params as Record<string, string>);
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const body = await res.clone().json().catch(() => null) as { code?: string } | null;
    if (res.status !== 403 || body?.code !== "forbidden") {
      failures.push(`${name}: answered ${res.status} ${JSON.stringify(body)}`);
    }
  }
  assertEquals(failures, [], "routes that do not gate first (or add them to UNGATED)");
});

test("every UNGATED entry is a route that still exists", () => {
  const names = new Set(routes().map((r) => `${r.method} ${r.pattern.pathname}`));
  for (const name of Object.keys(UNGATED)) assert(names.has(name), `no route ${name}`);
});
