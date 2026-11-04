// Archiving an MCP server, as the control plane fronts it: refused while a live agent's tool
// policy names the server (an archived server boot-fails every run such an agent gets), with the
// agents named; the gateway's kill switch reached only once nothing does.

import { test } from "bun:test";
import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals } from "@std/assert";
import {
  makeHandler,
  type Principal,
  type ToolAccess,
  type ToolServerArchive,
} from "../src/http/app.ts";
import { SERVER_IN_USE } from "../src/http/user/mcp_servers.ts";
import { memoryTaskStore } from "./memory_store.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const BREAK_GLASS: Principal = { kind: "break-glass" };
const MEMBER: Principal = {
  kind: "user",
  userId: "u-1",
  email: "grace@example.com",
  name: "Grace",
  caps: capsClaimOf("member"),
  emailVerified: true,
  sid: "s-1",
  via: "session",
};
const ARCHIVED_AT = "2026-11-04T12:00:00.000Z";

function fakeTools() {
  const servers = new Map([
    ["ms-novu", { id: "ms-novu", slug: "novu", name: "Novu", archivedAt: null as string | null }],
    ["ms-other", {
      id: "ms-other",
      slug: "other",
      name: "Other",
      archivedAt: null as string | null,
    }],
  ]);
  const archived: string[] = [];
  const toolAccess: ToolAccess = {
    getServer: (id) => Promise.resolve(servers.get(id) ?? null),
    issueRunCredentials: () => Promise.reject(new Error("not in these tests")),
    revokeRunCredentials: () => Promise.resolve(),
    archiveServer(id): Promise<ToolServerArchive> {
      const row = servers.get(id);
      if (!row) return Promise.resolve({ kind: "missing" });
      archived.push(id);
      row.archivedAt ??= ARCHIVED_AT;
      return Promise.resolve({ kind: "archived", server: { ...row, kind: "remote" } });
    },
  };
  return { toolAccess, archived, servers };
}

function buildApp(opts: { toolAccess?: ToolAccess | null } = {}) {
  const store = memoryTaskStore();
  const tools = fakeTools();
  let caller: Principal = BREAK_GLASS;
  const handler = makeHandler({
    store,
    provisioner: fakeProvisioner().provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: () => Promise.resolve(caller),
    toolAccess: opts.toolAccess === undefined ? tools.toolAccess : opts.toolAccess,
    now: fakeClock().now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 },
      runHistoryUrl: null,
      appUrl: "https://ryph.test",
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  });
  return {
    handler,
    store,
    archived: tools.archived,
    servers: tools.servers,
    as: (p: Principal) => (caller = p),
  };
}

type App = ReturnType<typeof buildApp>;

function send(app: App, method: string, path: string, body?: unknown) {
  return app.handler(
    new Request(`http://orchestrator.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function agentUsing(app: App, name: string, serverIds: string[]): Promise<string> {
  const res = await send(app, "POST", "/v1/agents", {
    name,
    email: `${name.toLowerCase()}@example.com`,
    harnessKind: "pi",
    memoryPolicy: null,
    toolPolicy: { servers: serverIds.map((serverId) => ({ serverId, allowedTools: "*" })) },
  });
  assertEquals(res.status, 201, await res.clone().text());
  return (await res.json()).id;
}

const archive = (app: App, id: string) => send(app, "POST", `/v1/mcp-servers/${id}/archive`);

test("a server a live agent still uses is refused, naming the agents, and nothing is archived", async () => {
  const app = buildApp();
  const drippy = await agentUsing(app, "Drippy", ["ms-novu"]);
  const foo = await agentUsing(app, "Foo", ["ms-other", "ms-novu"]);
  await agentUsing(app, "Bystander", ["ms-other"]);

  const res = await archive(app, "ms-novu");
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.code, SERVER_IN_USE);
  assertEquals(
    body.error,
    '"Novu" is still used by agents Drippy, Foo — remove it from their tool policies first',
  );
  assertEquals(
    new Set(body.agents.map((a: { id: string }) => a.id)),
    new Set([drippy, foo]),
  );
  assertEquals(app.archived, []);
});

test("one agent reads in the singular", async () => {
  const app = buildApp();
  await agentUsing(app, "Drippy", ["ms-novu"]);
  const body = await (await archive(app, "ms-novu")).json();
  assertEquals(
    body.error,
    '"Novu" is still used by agent Drippy — remove it from its tool policy first',
  );
});

test("an archived agent is no reference, and an unused server archives through the gateway", async () => {
  const app = buildApp();
  const old = await agentUsing(app, "Old", ["ms-novu"]);
  assertEquals((await send(app, "POST", `/v1/agents/${old}/archive`)).status, 200);

  const res = await archive(app, "ms-novu");
  assertEquals(res.status, 200);
  const server = await res.json();
  assertEquals([server.id, server.archivedAt], ["ms-novu", ARCHIVED_AT]);
  assertEquals(app.archived, ["ms-novu"]);
});

test("an already-archived server answers as it stands, even if an agent still names it", async () => {
  const app = buildApp();
  await agentUsing(app, "Drippy", ["ms-novu"]);
  // Archived before this check existed, or by the race the route accepts.
  app.servers.get("ms-novu")!.archivedAt = ARCHIVED_AT;
  const again = await archive(app, "ms-novu");
  assertEquals(again.status, 200);
  assertEquals((await again.json()).archivedAt, ARCHIVED_AT);
});

test("unknown, platform, ungated and tools-off are each their own answer", async () => {
  const app = buildApp();
  const missing = await archive(app, "ms-nope");
  assertEquals(missing.status, 404);
  await missing.body?.cancel();

  const platform = await archive(app, "ms-platform-memory");
  assertEquals(platform.status, 409);
  assertEquals((await platform.json()).code, "platform_managed");

  app.as(MEMBER);
  const member = await archive(app, "ms-novu");
  assertEquals(member.status, 403);
  await member.body?.cancel();
  assertEquals(app.archived, []);

  const off = buildApp({ toolAccess: null });
  const dark = await archive(off, "ms-novu");
  assertEquals(dark.status, 503);
  assertEquals((await dark.json()).code, "mcp_disabled");
});

test("the refusal holds only live references: a policy without the server does not count", async () => {
  const app = buildApp();
  await agentUsing(app, "Other", ["ms-other"]);
  const res = await archive(app, "ms-novu");
  assert(res.ok);
  await res.body?.cancel();
});
