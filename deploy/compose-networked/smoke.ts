#!/usr/bin/env -S bun --env-file=deploy/compose-networked/.env
/**
 * The end-to-end check for the compose stack — `bun run compose:smoke`.
 *
 * It exists because 410 unit tests say nothing about the thing this workstream actually built.
 * Every one of them runs inside one process with its collaborators wired in memory; what has
 * never been exercised is the wiring BETWEEN processes — that the historian verifies the control
 * plane's JWKS over a socket, that the orchestrator's ModelAccess port really reaches the proxy
 * that holds the master key, that the app's four-way proxy sends each path to the service that
 * owns it. Each check below is one of those links and nothing else; where a check could be
 * satisfied by a service talking to itself, it is not the check we want.
 *
 * A REAL RUN. The provisioner is `docker` through the launcher (compose.yaml says why), so this
 * creates a task and the launcher starts a real agent container on the internal run network.
 * Its agent is `echo`, the runner's built-in harness, so no model is called and no account is
 * needed: the run fetches its spec and its credentials, clones the fixture repository through the forge's git gateway,
 * streams its transcript to the historian, lands its work as a patch and reports, every hop
 * through the run gate. The fixture has no `.ryph/`, so no environment is built and the run
 * launches on the agent image; the builder's path is not crossed here. Then a container on the run network probes what a
 * run can reach: the gate's routes, and nothing else (no internal listener, no service by name,
 * not the internet). And one on the tools network probes what a hosted MCP server can reach:
 * the egress relay, where only a tool claim opens anything and only to a public host, and
 * nothing else (no service, no docker host, no internet, no outside DNS).
 *
 * WHAT IT DOES NOT COVER, and why:
 * - No model call and no tool call, and no virtual key or MCP token handed to a run: `echo` can
 *   hold neither policy (the agent form refuses both), and spending them would need a provider
 *   account and a real MCP server, which the point of this file is to need none. The pi agent's
 *   form checks cross the proxy's and the gateway's internal seams instead.
 * - No preview. The control plane → previews link is crossed only when a run exposes a port,
 *   which `echo` does not; the probe checks that a run reaches the tunnel port through the gate.
 * - No GitHub. Door ③ is dark without an App, so patch submission is out of reach here. The
 *   task's repo is the stack's fixture repository instead (compose.yaml's `fixture-repo`), which
 *   the forge serves as a repository on this machine.
 *
 * Idempotent against a warm stack: it reuses the bootstrap user, the provider key, the agent and
 * the connected repository it made last time, and every pass starts one new task.
 * `bun run compose:reset` takes the volumes and starts over.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../../packages/process/src/mod.ts";
import { s3PatchStore } from "../../packages/forge/src/adapters/patch_store/s3.ts";
import { readSetupToken } from "./setup_token.ts";
import { mintEgressToken } from "../../packages/orchestrator/src/core/egress.ts";
import { mintToolEgressClaim } from "../../packages/mcp-gateway/src/core/tool_egress.ts";

const APP = process.env.RYPH_SMOKE_APP ?? "http://localhost:3000";
/** The app's ORIGIN, which a write must name and which decides its session cookie's name. */
const APP_ORIGIN = process.env.RYPH_APP_ORIGIN || new URL(APP).origin;
const ACCESS_COOKIE = new URL(APP_ORIGIN).protocol === "https:"
  ? "__Host-ryph_access_token"
  : "ryph_access_token";
const CONTROL = process.env.RYPH_SMOKE_CONTROL ?? "http://localhost:7411";
const FORGE = process.env.RYPH_SMOKE_FORGE ?? "http://localhost:7412";
const HISTORY = process.env.RYPH_SMOKE_HISTORY ?? "http://localhost:7413";
const MEMORY = process.env.RYPH_SMOKE_MEMORY ?? "http://localhost:7440";
const WEB = process.env.RYPH_SMOKE_WEB ?? "http://localhost:7480";
// The previews service's PUBLIC port, the one a browser reaches. Its tunnel (:7491) and API (:7493)
// ports are not published; the API one is checked through the control plane below, its only
// caller, and the tunnel one through the gate.
const PREVIEWS = process.env.RYPH_SMOKE_PREVIEWS ?? "http://localhost:7490";
const OBJECTS = process.env.RYPH_SMOKE_OBJECTS ?? "http://localhost:9000";
// `docker compose` on this directory's compose.yaml, wherever the check is run from.
const COMPOSE = ["compose", "-f", fileURLToPath(new URL("compose.yaml", import.meta.url))];
// The launcher's run gate and run network, named for compose.yaml's network `ryph`; and the image
// the probe runs on (the gate's own: Node and nothing else, so it starts in a moment).
const GATE = "ryph-gate-ryph";
const RUN_NETWORK = "ryph-runs-ryph";
const TOOLS_NETWORK = "ryph-tools-ryph";
const RELAY = `ryph-egress-relay-${TOOLS_NETWORK}`;
const GUARD = `ryph-tool-guard-${TOOLS_NETWORK}`;
const GATE_IMAGE = process.env.RYPH_DOCKER_GATE_IMAGE ??
  `${process.env.RYPH_REGISTRY ?? "quay.io/ryph"}/ryph-run-gate:${
    process.env.RYPH_VERSION ?? "edge"
  }`;
// Generous: the fixture builds no environment, but a cold machine may still be pulling the agent.
const RUN_TIMEOUT_MS = 20 * 60_000;

// The model-proxy publishes no port, and deliberately: :7420 is for agent containers and :7421
// for the control plane and the app, all of which are on the compose network. It is checked here
// through both of its callers instead, which is the stronger evidence anyway — a probe would
// only prove the socket is open, and these prove the two links that use it. The mcp-gateway
// (:7430/:7431) is the same shape and gets the same treatment.

// The account this check drives the app with. On a fresh stack it registers it, and the FIRST
// registration is the one that becomes admin — so on a stack where a person already claimed that
// slot, neither half works and the override is the way in.
const BOOTSTRAP = {
  name: "Compose Smoke",
  email: process.env.RYPH_SMOKE_EMAIL ?? "smoke@ryph.local",
  password: process.env.RYPH_SMOKE_PASSWORD ?? "compose-smoke-password",
};
const KEY_LABEL = "compose smoke key";
const ECHO_AGENT = "Compose Smoke Echo";
// The repository compose.yaml's `fixture-repo` makes, as the forge sees it.
const FIXTURE_REPO = "/fixtures/hello";
// Never a real key — the proxy seals whatever it is given and this one is never spent.
const KEY_SECRET = "sk-ant-compose-smoke-not-a-real-key";
// The MCP server this check registers: a public https hostname, because the gateway refuses
// anything else by default, and one that speaks no MCP, because no run will ever call it.
const SERVER_SLUG = "compose-smoke";
const SERVER_URL = "https://example.com/mcp";
// Never a real credential either — sealed, echoed nowhere, presented to nobody.
const SERVER_SECRET = "mcp-compose-smoke-not-a-real-token";

class Failed extends Error {
  override readonly name = "Failed";
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failed(message);
}

async function body(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** Asserts the status before parsing, so a 500's HTML never surfaces as a JSON parse error. */
async function json<T = Record<string, unknown>>(res: Response, expect: number): Promise<T> {
  if (res.status !== expect) {
    throw new Failed(`${res.url} → ${res.status}, expected ${expect}: ${await body(res)}`);
  }
  return await res.json() as T;
}

let failures = 0;
let ran = 0;

/** Checks run in order and share state, so one failure usually cascades. Reporting all of them
 * anyway is the point: "these six links are up, that one is not" localises a broken stack far
 * faster than the first error alone. */
async function check(what: string, fn: () => Promise<void>): Promise<boolean> {
  ran++;
  try {
    await fn();
    console.log(`  ✓ ${what}`);
    return true;
  } catch (err) {
    failures++;
    const detail = err instanceof Failed ? err.message : String(err);
    console.log(`  ✗ ${what}\n      ${detail.replaceAll("\n", "\n      ")}`);
    return false;
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ── shared state, filled in as the checks go ──────────────────────────────────────────────────
let cookie = "";
let userToken = "";
let providerKeyId = "";
let mcpServerId = "";
let memoryId = "";
let repoId = "";
let echoAgentId = "";
let taskId = "";
let runId = "";

/** The bearer as the app's own routes take it: a cookie, because the access token is httpOnly
 * and the /api proxy reads it from there. */
const asUser = () => ({ cookie: `${ACCESS_COOKIE}=${cookie}` });
const asBearer = (token: string) => ({ authorization: `Bearer ${token}` });
/** JSON, from the app's own origin: the app refuses a write that cannot show it came from its own
 * pages, and the services behind it ignore the header. */
const jsonHeaders = { "content-type": "application/json", origin: APP_ORIGIN };

async function probe(name: string, base: string): Promise<void> {
  const live = await fetch(`${base}/healthz`);
  must(live.status === 200, `${name} /healthz → ${live.status}`);
  const ready = await fetch(`${base}/readyz`);
  must(ready.status === 200, `${name} /readyz → ${ready.status}: ${await body(ready)}`);
}

const decoder = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `docker <args>`, its stdout; throws Failed with its stderr when it exits non-zero. */
async function docker(args: string[]): Promise<string> {
  const out = await command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (out.code !== 0) {
    throw new Failed(`docker ${args.join(" ")}: ${decoder.decode(out.stderr).trim()}`);
  }
  return decoder.decode(out.stdout);
}

/** This compose project's container for a service, by compose's own label. */
async function serviceContainer(service: string): Promise<string> {
  const id = (await docker([...COMPOSE, "ps", "-q", service])).trim();
  must(id !== "", `no ${service} container is running`);
  return id;
}

// ── the checks ────────────────────────────────────────────────────────────────────────────────

console.log("ryph · compose stack · end-to-end check");

section("every service answers both probes");
await check("control-plane :7411", () => probe("control-plane", CONTROL));
await check("forge :7412", () => probe("forge", FORGE));
await check("historian :7413", () => probe("historian", HISTORY));
await check("memory :7440", () => probe("memory", MEMORY));
await check("web :7480", () => probe("web", WEB));
await check("previews :7490", () => probe("previews", PREVIEWS));
await check("app :3000", () => probe("app", APP));

/**
 * The login page's first-run link must agree with the control plane about whether this instance
 * still needs an admin. Asserted as an AGREEMENT rather than a fixed expectation, so the same
 * predicate is meaningful before bootstrap (link offered) and after (link gone) — and so a warm
 * stack, where both runs see a claimed instance, still checks something real.
 *
 * The bug it pins: the link used to be unconditional, so an instance somebody had already
 * claimed offered a form whose only possible answer was 401, surfaced as "unauthorized". That
 * reads as "your details are wrong", not "someone already claimed this".
 */
async function firstRunDoorAgrees(): Promise<void> {
  const state = await json<{ needsBootstrap: boolean }>(
    await fetch(`${CONTROL}/v1/auth/bootstrap`),
    200,
  );
  const login = await fetch(`${APP}/login`);
  must(login.ok, `GET /login → ${login.status}`);
  const offered = (await login.text()).includes("Create the admin account");
  must(
    offered === state.needsBootstrap,
    state.needsBootstrap
      ? "a fresh instance hid the first-run link, so there is no way in"
      : "a claimed instance still offers the first-run link, which can only answer 401",
  );

  // And the page behind it, for a bookmark or a typed URL: reachable exactly when it can work.
  const register = await fetch(`${APP}/register`, { redirect: "manual" });
  await register.body?.cancel();
  const reachable = register.status === 200;
  must(
    reachable === state.needsBootstrap,
    `/register answered ${register.status} on an instance that ` +
      `${state.needsBootstrap ? "still needs" : "already has"} an admin`,
  );
}

section("app · the first-run door");
await check("before bootstrap, the login page agrees with the control plane", firstRunDoorAgrees);

section("app → control-plane · identity");
let bootstrapNote = "";
const bootstrapped = await check("bootstrap or log in the first user", async () => {
  // First run bootstraps an admin; later runs are refused (401 admin-required) and log in
  // instead. Both paths end with the app's httpOnly cookies set, which is what is being tested.
  // RYPH_SMOKE_SETUP_TOKEN, for a stack whose log has scrolled past it.
  const setupToken = await readSetupToken(
    { command: "docker", args: [...COMPOSE, "logs", "control-plane", "--no-color"] },
    process.env.RYPH_SMOKE_SETUP_TOKEN,
  );
  let res = await fetch(`${APP}/auth/register`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ ...BOOTSTRAP, ...(setupToken ? { setupToken } : {}) }),
  });
  const bootstrapped = res.ok;
  if (!res.ok) {
    res = await fetch(`${APP}/auth/login`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ email: BOOTSTRAP.email, password: BOOTSTRAP.password }),
    });
  }
  // Drained before the assertion, not inside it: a failure message that reads the body has
  // already consumed it by the time the success path would want to.
  const said = await body(res);
  if (!res.ok) {
    // Both halves failing means one specific thing, and "invalid credentials" does not say it:
    // somebody else holds the bootstrap slot. Ask the control plane rather than guessing, so the
    // message can name the actual situation.
    const claimed = await fetch(`${CONTROL}/v1/auth/bootstrap`)
      .then((r) => r.json())
      .then((b) => b?.needsBootstrap === false)
      .catch(() => false);
    must(
      !claimed,
      `this stack already has an admin, and it is not ${BOOTSTRAP.email} — so this check can ` +
        `neither register (the first account is the admin, and it is taken) nor log in.\n` +
        `Either point it at that admin:\n` +
        `  RYPH_SMOKE_EMAIL=you@example.com RYPH_SMOKE_PASSWORD=… bun run compose:smoke\n` +
        `or run it against a fresh stack: bun run compose:reset && bun run compose:up`,
    );
  }
  must(res.ok, `neither register nor login succeeded: ${res.status} ${said}`);
  const setCookies = res.headers.getSetCookie();
  const access = setCookies.find((c) => c.startsWith(`${ACCESS_COOKIE}=`));
  must(access, `no access cookie in ${JSON.stringify(setCookies)}`);
  cookie = access.slice(`${ACCESS_COOKIE}=`.length).split(";")[0];
  // Said out loud because it is not a detail: the FIRST account to register becomes the admin,
  // so on a fresh stack this check consumes the bootstrap slot. Someone who then tries to
  // register their own admin in the UI gets a bare "unauthorized" and no way to guess why.
  bootstrapNote = bootstrapped
    ? `Bootstrapped the admin account ${BOOTSTRAP.email} / ${BOOTSTRAP.password} — this stack's\n` +
      `first registration is its admin, so log in with that rather than registering your own.`
    : `Logged in as the existing ${BOOTSTRAP.email}.`;
});

if (bootstrapped) {
  await check("GET /api/v1/auth/me carries the session through the proxy", async () => {
    const me = await json<{ email: string; role: string }>(
      await fetch(`${APP}/api/v1/auth/me`, { headers: asUser() }),
      200,
    );
    must(me.email === BOOTSTRAP.email, `wrong user: ${me.email}`);
    must(me.role === "owner", `first user should be owner, got ${me.role}`);
  });

  await check("a bearer minted at :7411 is the one the sibling services verify", async () => {
    const pair = await json<{ accessToken: string }>(
      await fetch(`${CONTROL}/v1/auth/login`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ email: BOOTSTRAP.email, password: BOOTSTRAP.password }),
      }),
      200,
    );
    userToken = pair.accessToken;
  });
}

await check("after bootstrap, the first-run link is gone", firstRunDoorAgrees);

section("app → model-proxy :7421 · the control listener");
await check("register a provider key, and get no secret back", async () => {
  interface Key {
    id: string;
    label: string;
    last4: string;
    archivedAt: string | null;
  }
  const list = await json<{ providerKeys: Key[] }>(
    await fetch(`${APP}/api/v1/provider-keys`, { headers: asUser() }),
    200,
  );
  const existing = list.providerKeys.find((k) => k.label === KEY_LABEL && k.archivedAt === null);
  if (existing) {
    providerKeyId = existing.id;
  } else {
    const created = await json<Key>(
      await fetch(`${APP}/api/v1/provider-keys`, {
        method: "POST",
        headers: { ...jsonHeaders, ...asUser() },
        body: JSON.stringify({ provider: "anthropic", label: KEY_LABEL, secret: KEY_SECRET }),
      }),
      201,
    );
    providerKeyId = created.id;
  }
  // The whole reason the master key moved to this service: nothing that leaves it may carry the
  // secret back out. last4 is the only fragment the surface is allowed to echo.
  const after = await fetch(`${APP}/api/v1/provider-keys`, { headers: asUser() });
  const raw = await after.text();
  must(!raw.includes(KEY_SECRET), "the key list echoed the secret back");
});

section("app → mcp-gateway :7431 · the control listener");
await check("register an MCP server, and get no credential back", async () => {
  interface Server {
    id: string;
    slug: string;
    archivedAt: string | null;
  }
  const list = await json<{ mcpServers: Server[] }>(
    await fetch(`${APP}/api/v1/mcp-servers`, { headers: asUser() }),
    200,
  );
  const existing = list.mcpServers.find((s) => s.slug === SERVER_SLUG && s.archivedAt === null);
  if (existing) {
    mcpServerId = existing.id;
  } else {
    const created = await json<Server>(
      await fetch(`${APP}/api/v1/mcp-servers`, {
        method: "POST",
        headers: { ...jsonHeaders, ...asUser() },
        body: JSON.stringify({
          slug: SERVER_SLUG,
          name: "Compose Smoke",
          url: SERVER_URL,
          auth: "bearer",
          secret: SERVER_SECRET,
        }),
      }),
      201,
    );
    mcpServerId = created.id;
  }
  // The same rule as the provider key: the surface is write-only on secrets, and the last four
  // characters are the only fragment it may echo.
  const after = await fetch(`${APP}/api/v1/mcp-servers`, { headers: asUser() });
  must(!(await after.text()).includes(SERVER_SECRET), "the server list echoed the credential back");
});

section("app → memory :7440 · the memory manager");
await check("write a memory through the app's proxy, and read it back", async () => {
  interface Memory {
    id: string;
    text: string;
    trust: string;
    status: string;
  }
  const TEXT = "compose smoke: the org keeps one memory written by hand";
  // Idempotent against a warm stack: the same claim is found before it is written again.
  const found = await json<{ memories: Memory[] }>(
    await fetch(`${APP}/api/v1/memories?subject=org&q=${encodeURIComponent("compose smoke")}`, {
      headers: asUser(),
    }),
    200,
  );
  const existing = found.memories.find((m) => m.text === TEXT && m.status === "canon");
  if (existing) {
    memoryId = existing.id;
  } else {
    const created = await json<Memory>(
      await fetch(`${APP}/api/v1/memories`, {
        method: "POST",
        headers: { ...jsonHeaders, ...asUser() },
        body: JSON.stringify({ text: TEXT, kind: "fact", subject: { kind: "org" } }),
      }),
      201,
    );
    must(created.trust === "human", `a hand-written memory is ${created.trust}, not human`);
    memoryId = created.id;
  }
  // The platform's memory server: seeded by the gateway at boot, listed like any other server.
  const servers = await json<{ mcpServers: Array<{ kind: string; slug: string }> }>(
    await fetch(`${APP}/api/v1/mcp-servers`, { headers: asUser() }),
    200,
  );
  must(
    servers.mcpServers.some((s) => s.kind === "platform" && s.slug === "memory"),
    "the gateway did not seed the platform's memory server",
  );
  // And the platform's web server beside it, seeded the same way from RYPH_WEB_URL.
  must(
    servers.mcpServers.some((s) => s.kind === "platform" && s.slug === "web"),
    "the gateway did not seed the platform's web server",
  );
});

section("control-plane → model-proxy :7421 · the internal seam");
await check("an unknown key id is a definitive 400, never a 5xx", async () => {
  // The split this seam is built on: 404 from the proxy means "no", and must surface as a
  // refusal the user can act on. Anything else means "could not ask", which must not.
  const res = await fetch(`${CONTROL}/v1/agents`, {
    method: "POST",
    headers: { ...jsonHeaders, ...asBearer(userToken) },
    body: JSON.stringify({
      name: "Smoke Refused",
      email: "refused@ryph.local",
      harnessKind: "pi",
      modelPolicy: { providerKeyId: "pk-0000000000", provider: "anthropic", allowedModels: "*" },
    }),
  });
  must(res.status === 400, `expected 400, got ${res.status}: ${await body(res)}`);
});

section("control-plane → mcp-gateway :7431 · the internal seam");
await check("an unknown MCP server id is a definitive 400, never a 5xx", async () => {
  // The same line one credential class over: the gateway's 404 must surface as a refusal the
  // user can act on, and a gateway that is down must not.
  const res = await fetch(`${CONTROL}/v1/agents`, {
    method: "POST",
    headers: { ...jsonHeaders, ...asBearer(userToken) },
    body: JSON.stringify({
      name: "Smoke Refused",
      email: "refused-tools@ryph.local",
      harnessKind: "pi",
      toolPolicy: { servers: [{ serverId: "ms-0000000000", allowedTools: "*" }] },
    }),
  });
  must(res.status === 400, `expected 400, got ${res.status}: ${await body(res)}`);
});

await check("a pi agent with a real model policy and a real tool policy is accepted", async () => {
  await json<{ id: string }>(
    await fetch(`${CONTROL}/v1/agents`, {
      method: "POST",
      headers: { ...jsonHeaders, ...asBearer(userToken) },
      body: JSON.stringify({
        name: "Compose Smoke",
        email: "smoke-agent@ryph.local",
        harnessKind: "pi",
        modelPolicy: { providerKeyId, provider: "anthropic", allowedModels: "*" },
        toolPolicy: { servers: [{ serverId: mcpServerId, allowedTools: ["search"] }] },
      }),
    }),
    201,
  );
});

/**
 * A docker socket in a mount list of `<source>=<destination>` pairs, by either end: Docker Desktop
 * reports the source of a `/var/run/docker.sock` bind as `/run/host-services/docker.proxy.sock`,
 * so the source alone misses it there, and a destination elsewhere would miss it on Linux.
 */
const DOCKER_SOCKET = /docker(\.proxy)?\.sock\b/;

section("the launcher · the one container with the docker socket");
await check("only the launcher mounts the docker socket", async () => {
  const ids = (await docker([...COMPOSE, "ps", "-q"])).trim().split("\n").filter(Boolean);
  const holders: string[] = [];
  for (const id of ids) {
    const [name, mounts] = (await docker([
      "inspect",
      "--format",
      "{{.Name}} {{range .Mounts}}{{.Source}}={{.Destination}},{{end}}",
      id,
    ])).trim().split(" ");
    if (DOCKER_SOCKET.test(mounts ?? "")) holders.push(name.replace(/^\//, ""));
  }
  must(
    holders.length === 1 && holders[0].includes("launcher"),
    `the socket is mounted in ${holders.join(", ") || "nothing"}, not the launcher alone`,
  );
  const control = await serviceContainer("control-plane");
  const env = await docker(["inspect", "--format", "{{json .Config.Env}}", control]);
  must(
    env.includes("RYPH_PROVISIONER=docker"),
    "the control plane is not on the docker provisioner",
  );
});

await check(
  "the launcher made the run gate, on the deployment network and the run network",
  async () => {
    const networks = JSON.parse(
      await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", GATE]),
    ) as Record<string, unknown>;
    must(
      "ryph" in networks && RUN_NETWORK in networks,
      `${GATE} is on ${Object.keys(networks).join(", ")}`,
    );
    const internal =
      (await docker(["network", "inspect", "--format", "{{.Internal}}", RUN_NETWORK]))
        .trim();
    must(internal === "true", `${RUN_NETWORK} is not an internal network`);
  },
);

section("a real run, launched by the launcher");
await check("an echo agent exists", async () => {
  const { agents } = await json<{ agents: Array<{ id: string; name: string }> }>(
    await fetch(`${CONTROL}/v1/agents`, { headers: asBearer(userToken) }),
    200,
  );
  const existing = agents.find((a) => a.name === ECHO_AGENT);
  if (existing) {
    echoAgentId = existing.id;
    return;
  }
  // No policies: echo speaks no provider's dialect and calls no tools, and the agent form refuses
  // either. The two minting seams are crossed by the pi agent above instead.
  const created = await json<{ id: string }>(
    await fetch(`${CONTROL}/v1/agents`, {
      method: "POST",
      headers: { ...jsonHeaders, ...asBearer(userToken) },
      body: JSON.stringify({
        name: ECHO_AGENT,
        email: "smoke-echo@ryph.local",
        harnessKind: "echo",
      }),
    }),
    201,
  );
  echoAgentId = created.id;
});

await check("the fixture repository is connected, through the forge's local provider", async () => {
  const listed = await json<{ repos: Array<{ id: string; provider: string; repoRef: string }> }>(
    await fetch(`${CONTROL}/v1/connected-repos`, { headers: asBearer(userToken) }),
    200,
  );
  const known = listed.repos.find((r) => r.provider === "local" && r.repoRef === FIXTURE_REPO);
  if (known !== undefined) {
    repoId = known.id;
    return;
  }
  const connected = await json<{ id: string }>(
    await fetch(`${CONTROL}/v1/connected-repos`, {
      method: "POST",
      headers: { ...jsonHeaders, ...asBearer(userToken) },
      body: JSON.stringify({ provider: "local", path: FIXTURE_REPO }),
    }),
    201,
  );
  repoId = connected.id;
});

await check("creating a task starts a run", async () => {
  const created = await json<{ taskId: string; runId: string }>(
    await fetch(`${CONTROL}/v1/tasks`, {
      method: "POST",
      headers: { ...jsonHeaders, ...asBearer(userToken) },
      body: JSON.stringify({
        agentId: echoAgentId,
        spec: {
          title: "compose smoke",
          instructions: "Echo this task into a file; no model is involved.",
        },
        connectedRepoId: repoId,
      }),
    }),
    201,
  );
  taskId = created.taskId;
  runId = created.runId;
});

/** What the run's container looked like while it ran, read once it is seen. */
// Assigned inside a check's callback, which control-flow narrowing cannot see: a bare `= null`
// would narrow every later read to `null`.
let runContainer = null as { networks: string[]; mounts: string; image: string } | null;
let finalRun: Record<string, unknown> = {};
await check("the launcher starts its container, and the run reports success", async () => {
  must(runId !== "", "no run to wait for");
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const view = await json<{ runs: Array<Record<string, unknown>> }>(
      await fetch(`${CONTROL}/v1/tasks/${taskId}`, { headers: asBearer(userToken) }),
      200,
    );
    finalRun = view.runs.find((r) => r.id === runId) ?? {};
    const state = `${finalRun.state}${finalRun.phase ? ` (${finalRun.phase})` : ""}`;
    if (state !== last) {
      console.log(`      … ${state}`);
      last = state;
    }
    // Read while it is there: a finished run's container is the reconcile's to remove.
    if (runContainer === null) {
      const seen = await docker([
        "inspect",
        "--format",
        "{{json .NetworkSettings.Networks}}|{{range .Mounts}}{{.Source}}={{.Destination}},{{end}}|{{.Config.Image}}",
        `ryph-run-${runId}`,
      ]).catch(() => null);
      if (seen !== null) {
        const [networks, mounts, image] = seen.trim().split("|");
        runContainer = { networks: Object.keys(JSON.parse(networks)), mounts, image };
      }
    }
    if (["succeeded", "failed", "errored", "cancelled", "lost"].includes(String(finalRun.state))) {
      break;
    }
    await sleep(3000);
  }
  if (finalRun.state !== "succeeded") {
    const logs = await docker(["logs", "--tail", "40", `ryph-run-${runId}`])
      .catch((err) => String(err));
    throw new Failed(
      `run ended ${JSON.stringify(finalRun.state)}: ${
        JSON.stringify(finalRun.result ?? finalRun).slice(0, 600)
      }\n--- container log ---\n${logs}`,
    );
  }
});

// Which agent image the run really used: the launcher launches a local image by its id, so the
// names come off the image. A registry's (quay.io/…:edge) means this smoke exercised the published
// agent, not one built from this checkout (compose.build.yaml, `ryph-agent:dev`).
if (runContainer !== null) {
  const image = runContainer.image;
  const names = await docker(["image", "inspect", "--format", "{{json .RepoTags}}", image])
    .then((out) => JSON.parse(out.trim() || "[]") as string[], () => [] as string[]);
  console.log(
    `      the run's agent image: ${image}${names.length ? ` (${names.join(", ")})` : ""}`,
  );
  if (!names.some((name) => name.endsWith(":dev"))) {
    console.log(
      "      ⚠ not a local :dev build — this run exercised a registry's agent image, not this " +
        "checkout's (RYPH_AGENT_IMAGE=ryph-agent:dev, compose.build.yaml)",
    );
  }
}

await check("its container was confined: the run network alone, no socket", () => {
  must(runContainer !== null, `never saw a container named ryph-run-${runId}`);
  must(
    runContainer.networks.length === 1 && runContainer.networks[0] === RUN_NETWORK,
    `the run's container was on ${runContainer.networks.join(", ")}`,
  );
  // No mounts at all, not merely no socket by name: a parent directory of the socket (or a
  // socket under another name) mounted in would pass a name match.
  must(runContainer.mounts === "", `the run's container had mounts: ${runContainer.mounts}`);
  return Promise.resolve();
});

await check(
  "its transcript came through the gate to the historian, and back through the app",
  async () => {
    const page = await json<{ events: Array<{ text?: string }> }>(
      await fetch(`${APP}/api/v1/runs/${runId}/events`, { headers: asUser() }),
      200,
    );
    must(
      page.events.some((e) => e.text?.startsWith("Starting: compose smoke")),
      `no "Starting:" line among ${page.events.length} events`,
    );
  },
);

await check("its work crossed the forge's gateway and landed as a patch", async () => {
  const view = await json<{ patches: unknown[] }>(
    await fetch(`${CONTROL}/v1/tasks/${taskId}`, { headers: asBearer(userToken) }),
    200,
  );
  must(view.patches.length > 0, "the task has no patch: the bundle never landed");
});

section("artifacts → isolated Chromium · real thumbnail pixels");
await check(
  "a version of the run's renders a 1200 × 750 PNG through the app, and revalidates",
  async () => {
    // echo publishes no artifact, so the version is written straight into the database against the
    // run that just finished: publishing has its own tests, and this is about the renderer. A fresh
    // artifact defeats the object cache, so a healthy listener with a broken Chromium sandbox
    // fails here.
    const id = `art-smoke-${runId}`;
    const html =
      '<!doctype html><html><body style="background:#183153;color:white"><h1>Compose thumbnail</h1><p>Rendered by isolated Chromium.</p></body></html>';
    const sql = [
      "begin;",
      "insert into artifacts (id, title, agent_id, origin_run_id, request_origin, current_version, created_at, updated_at)",
      `  select :'id', 'Compose thumbnail', agent_id, id, 'user', 1, now()::text, now()::text from runs where id = :'run';`,
      "insert into artifact_versions (artifact_id, version, title, html, served_html, bytes, run_id, task_id, created_at)",
      `  select :'id', 1, 'Compose thumbnail', :'html', :'html', octet_length(:'html'), id, task_id, now()::text from runs where id = :'run';`,
      "commit;",
    ].join("\n");
    const postgres = await serviceContainer("postgres");
    const out = await command("docker", {
      args: [
        "exec",
        "-i",
        postgres,
        "psql",
        "-U",
        "ryph",
        "-d",
        "ryph",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        `id=${id}`,
        "-v",
        `run=${runId}`,
        "-v",
        `html=${html}`,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = out.stdin.getWriter();
    await writer.write(new TextEncoder().encode(sql));
    await writer.close();
    const done = await out.output();
    must(done.code === 0, `seeding the artifact: ${decoder.decode(done.stderr).trim()}`);

    const url = `${APP}/artifacts/${id}/v/1/thumbnail`;
    const png = await fetch(url, { headers: asUser(), signal: AbortSignal.timeout(30_000) });
    must(png.status === 200, `thumbnail → ${png.status}, expected a real PNG`);
    must(png.headers.get("content-type") === "image/png", "thumbnail is not image/png");
    const bytes = new Uint8Array(await png.arrayBuffer());
    must(
      bytes.length >= 33 && bytes.length <= 4 * 1024 * 1024 &&
        [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte) &&
        new TextDecoder().decode(bytes.subarray(12, 16)) === "IHDR",
      "thumbnail has no valid PNG signature/IHDR or exceeds its size bound",
    );
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    must(
      header.getUint32(16) === 1200 && header.getUint32(20) === 750,
      "thumbnail dimensions are not 1200 × 750",
    );
    const etag = png.headers.get("etag");
    must(etag, "thumbnail has no ETag");
    const cached = await fetch(url, {
      headers: { ...asUser(), "if-none-match": etag },
      signal: AbortSignal.timeout(30_000),
    });
    await cached.body?.cancel();
    must(cached.status === 304, `thumbnail revalidation → ${cached.status}, expected 304`);

    // Even an exact cache validator must not bypass auth or version existence checks.
    const unauthorized = await fetch(`${CONTROL}/v1/artifacts/${id}/versions/1/thumbnail`, {
      headers: { "if-none-match": etag },
      signal: AbortSignal.timeout(30_000),
    });
    await unauthorized.body?.cancel();
    must(unauthorized.status === 401, `anonymous thumbnail → ${unauthorized.status}, expected 401`);
    const missing = await fetch(`${APP}/artifacts/${id}/v/999/thumbnail`, {
      headers: { ...asUser(), "if-none-match": etag },
      signal: AbortSignal.timeout(30_000),
    });
    await missing.body?.cancel();
    must(missing.status === 404, `missing thumbnail version → ${missing.status}, expected 404`);
  },
);

section("app → mcp-gateway :7431 · the tool-call trail");
await check("the run's usage trail comes back through the app's proxy", async () => {
  // The proxy's second gateway path. Empty, because no tool was called — what is being checked
  // is that the app sent the request to the service that owns the answer.
  const trail = await json<{ usage: unknown[] }>(
    await fetch(`${APP}/api/v1/mcp-usage/${runId}`, { headers: asUser() }),
    200,
  );
  must(Array.isArray(trail.usage), `no usage array in ${JSON.stringify(trail)}`);
});

section("historian · run-token verify and the conclude ping");
await check("ingest without a token is refused", async () => {
  const res = await fetch(`${HISTORY}/v1/runs/${runId}/events`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      events: [{
        seq: 99,
        at: new Date().toISOString(),
        voice: "transcript",
        kind: "message",
        text: "nope",
      }],
    }),
  });
  must(res.status === 401, `expected 401, got ${res.status}: ${await body(res)}`);
});

await check("the finished run's tail closes: the conclude ping reached the historian", async () => {
  // The observable effect of the ping, and the only one: the historian knows this run is over,
  // so a tail replays the backlog and closes with `done` instead of idling forever. The control
  // plane dials the historian directly (RYPH_HISTORY_URL); runs reach it through the gate
  // (RYPH_RUN_HISTORY_URL).
  const stop = AbortSignal.timeout(10_000);
  const res = await fetch(`${HISTORY}/v1/runs/${runId}/events/stream`, {
    headers: asBearer(userToken),
    signal: stop,
  });
  must(res.ok, `stream → ${res.status}`);
  let seen = "";
  try {
    for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
      seen += chunk;
      if (seen.includes("event: done")) return;
    }
  } catch (err) {
    if (stop.aborted) {
      throw new Failed("the tail never closed — the conclude ping did not reach the historian");
    }
    throw err;
  }
  throw new Failed(`the stream ended without a done event: ${seen.slice(-200)}`);
});

section("control-plane → memory · the brief and the outcome");
await check(
  "the run was briefed with the memory, and its verdict reached memory",
  async () => {
    const detail = await json<{
      memory: { briefedCount: number };
      runs: Array<{ runId: string; outcome: string | null }>;
    }>(await fetch(`${APP}/api/v1/memories/${memoryId}`, { headers: asUser() }), 200);
    must(detail.memory.briefedCount >= 1, "the memory was never counted as briefed");
    const run = detail.runs.find((r) => r.runId === runId);
    must(run, `run ${runId} is not among the runs this memory was briefed into`);
    must(run.outcome === "success", `the outcome memory heard was ${run.outcome}, not success`);
  },
);

section("the network boundary, as a run sees it");
interface Probe {
  target: string;
  host: string;
  port: number;
  reachable: boolean;
}
const probes: Probe[] = [
  // Every route the launcher's gate relays: the whole of what a run may reach.
  ...([
    ["control-plane", 7411],
    ["forge", 7412],
    ["historian", 7413],
    ["model-proxy data", 7420],
    ["mcp-gateway data", 7430],
    ["egress-proxy", 7460],
    ["previews tunnel", 7491],
  ] as const).map(([what, port]) => ({
    target: `${what} through the gate :${port}`,
    host: GATE,
    port,
    reachable: true,
  })),
  // The internal listeners, which the gate does not relay. On the flat network this stack had
  // before the launcher, a run reached both and only a token stood in the way.
  {
    target: "model-proxy CONTROL :7421 through the gate",
    host: GATE,
    port: 7421,
    reachable: false,
  },
  {
    target: "mcp-gateway CONTROL :7431 through the gate",
    host: GATE,
    port: 7431,
    reachable: false,
  },
  {
    target: "previews API :7493 through the gate",
    host: GATE,
    port: 7493,
    reachable: false,
  },
  { target: "previews API :7493 by name", host: "previews", port: 7493, reachable: false },
  { target: "the app :3000 through the gate", host: GATE, port: 3000, reachable: false },
  { target: "the launcher :7470 through the gate", host: GATE, port: 7470, reachable: false },
  // No service by name: the run network resolves nothing but the gate.
  { target: "control-plane :7411 by name", host: "control-plane", port: 7411, reachable: false },
  { target: "model-proxy :7421 by name", host: "model-proxy", port: 7421, reachable: false },
  { target: "the launcher :7470 by name", host: "launcher", port: 7470, reachable: false },
  { target: "postgres :5432 by name", host: "postgres", port: 5432, reachable: false },
  // Nor the docker host, nor the internet: the egress proxy is the only way out.
  { target: "the docker host", host: "host.docker.internal", port: 7411, reachable: false },
  { target: "the internet directly", host: "example.com", port: 443, reachable: false },
];
// A bare TCP connect, not fetch: the question is whether a connection opens at all, and an HTTP
// error from a reachable port would read the same as a refusal to fetch.
const probeScript = `
const { connect } = require("node:net");
const probes = ${JSON.stringify(probes.map(({ host, port }) => ({ host, port })))};
const attempt = ({ host, port }) => Promise.race([
  new Promise((r) => {
    const c = connect({ host, port });
    c.once("connect", () => { c.destroy(); r("open"); });
    c.once("error", (e) => r("error: " + e.message));
  }),
  new Promise((r) => setTimeout(() => r("timeout"), 3000)),
]);
Promise.all(probes.map(attempt)).then((out) => console.log("PROBE " + JSON.stringify(out)));
`;
let outcomes: string[] = [];
await check("a container on the run network ran the probes", async () => {
  // The gate's image, for its Node; its own entrypoint (the relay) replaced by the probe. Not a
  // run's labels, so the reconcile leaves it alone; --rm takes it when it exits.
  const out = await docker([
    "run",
    "--rm",
    "--network",
    RUN_NETWORK,
    "--label",
    "ryph.smoke=probe",
    "--entrypoint",
    "/nodejs/bin/node",
    GATE_IMAGE,
    "-e",
    probeScript,
  ]);
  const line = out.split("\n").find((l) => l.startsWith("PROBE "));
  must(line, `the probe printed no result:\n${out}`);
  outcomes = JSON.parse(line.slice("PROBE ".length));
});
for (const [i, probe] of probes.entries()) {
  if (outcomes.length === 0) break;
  await check(`${probe.reachable ? "reaches" : "cannot reach"} ${probe.target}`, () => {
    const open = outcomes[i] === "open";
    must(
      open === probe.reachable,
      probe.reachable ? `expected a connection, got ${outcomes[i]}` : "the connection opened",
    );
    return Promise.resolve();
  });
}

section("the network boundary, as a hosted server sees it");
// The tools network is the launcher's, made when the gateway's hosting booted (POST
// /v1/tools/network): internal, its gateway isolated on an engine that can, and no service on it.
await check(
  `${TOOLS_NETWORK} is internal, and isolated where the engine can make it so`,
  async () => {
    const [internal, v4, v6] = (await docker([
      "network",
      "inspect",
      "-f",
      `{{.Internal}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}|` +
      `{{index .Options "com.docker.network.bridge.gateway_mode_ipv6"}}`,
      TOOLS_NETWORK,
    ])).trim().split("|");
    must(internal === "true", `${TOOLS_NETWORK} is not internal`);
    const major = Number((await docker(["info", "--format", "{{.ServerVersion}}"])).split(".")[0]);
    if (major >= 28) must(v4 === "isolated" && v6 === "isolated", "its gateway is not isolated");
  },
);
await check("only hosted servers, their guard and their relay are on it", async () => {
  const names = (await docker([
    "network",
    "inspect",
    "-f",
    "{{range .Containers}}{{.Name}} {{end}}",
    TOOLS_NETWORK,
  ])).split(/\s+/).filter((n) => n !== "");
  const strangers = names.filter((n) => !n.startsWith("ryph-tool-") && n !== RELAY);
  must(strangers.length === 0, `on the tools network too: ${strangers.join(", ")}`);
  must(names.includes(GUARD), `the guard ${GUARD} is not on it`);
  must(names.includes(RELAY), `the egress relay ${RELAY} is not on it`);
});
await check(
  "the guard and the relay are on both sides, and the relay goes to :7461 alone",
  async () => {
    for (const name of [GUARD, RELAY]) {
      const on = (await docker([
        "inspect",
        "-f",
        "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}",
        name,
      ])).split(/\s+/).filter((n) => n !== "").sort();
      must(on.join(",") === ["ryph", TOOLS_NETWORK].sort().join(","), `${name} is on ${on}`);
    }
    const cmd = (await docker(["inspect", "-f", "{{json .Config.Cmd}}", RELAY])).trim();
    must(cmd === JSON.stringify(["7460=egress-proxy:7461"]), `the relay's command is ${cmd}`);
  },
);

// What a vendor's container can do from there: each probe a TCP connect, a DNS lookup or a
// CONNECT through the relay with a given claim, from a throwaway container on the tools network
// alone (the gate's image, for its Node).
const toolKey = process.env.RYPH_EGRESS_TOOL_KEY;
const runKey = process.env.RYPH_EGRESS_KEY;
const hex = (value: string) => Uint8Array.from(value.match(/../g)!, (b) => Number.parseInt(b, 16));
let toolOutcomes: Record<string, string> = {};
await check("a container on the tools network ran the probes", async () => {
  must(toolKey && runKey, "no egress keys in the environment; run `bun run compose:init`");
  const toolClaim = await mintToolEgressClaim(hex(toolKey), {
    subject: "ryph-tool-smoke",
    issuedAt: Math.floor(Date.now() / 1000),
  });
  const runClaim = await mintEgressToken(hex(runKey), {
    runId: "smoke",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    hosts: ["example.com"],
  });
  const bridge = (await docker([
    "network",
    "inspect",
    "-f",
    "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
    "ryph",
  ])).trim().split(/\s+/)[0];
  const script = `
const net = require("node:net");
const dns = require("node:dns");
const tcp = (host, port) => Promise.race([
  new Promise((r) => {
    const c = net.connect({ host, port });
    c.once("connect", () => { c.destroy(); r("open"); });
    c.once("error", (e) => r("error: " + e.message));
  }),
  new Promise((r) => setTimeout(() => r("timeout"), 3000)),
]);
const lookup = (name) => new Promise((r) => dns.lookup(name, (e, a) => r(e ? "error: " + e.code : "resolved " + a)));
const connect = (target, user) => new Promise((r) => {
  const c = net.connect({ host: ${JSON.stringify(RELAY)}, port: 7460 });
  let text = "";
  const auth = user === null ? "" : "proxy-authorization: Basic " + Buffer.from(user).toString("base64") + "\\r\\n";
  c.once("connect", () => c.write("CONNECT " + target + " HTTP/1.1\\r\\nhost: " + target + "\\r\\n" + auth + "\\r\\n"));
  c.on("data", (d) => { text += d; if (text.includes("\\r\\n")) { c.destroy(); r(text.split("\\r\\n")[0]); } });
  c.once("error", (e) => r("error: " + e.message));
  setTimeout(() => { c.destroy(); r("timeout"); }, 15000);
});
(async () => {
  const out = {
    internet: await tcp("1.1.1.1", 443),
    dns: await lookup("example.com"),
    controlPlane: await tcp("control-plane", 7411),
    gatewayControl: await tcp("mcp-gateway", 7431),
    egressDirect: await tcp("egress-proxy", 7461),
    host: await tcp("host.docker.internal", 7411),
    bridge: await tcp(${JSON.stringify(bridge)}, 7411),
    noClaim: await connect("example.com:443", null),
    runClaim: await connect("example.com:443", "smoke:" + ${JSON.stringify(runClaim)}),
    toolPublic: await connect("example.com:443", "tool:" + ${JSON.stringify(toolClaim)}),
    toolPrivate: await connect("10.0.0.1:443", "tool:" + ${JSON.stringify(toolClaim)}),
  };
  console.log("PROBE " + JSON.stringify(out));
})();
`;
  const out = await docker([
    "run",
    "--rm",
    "--network",
    TOOLS_NETWORK,
    "--label",
    "ryph.smoke=probe",
    "--entrypoint",
    "/nodejs/bin/node",
    GATE_IMAGE,
    "-e",
    script,
  ]);
  const line = out.split("\n").find((l) => l.startsWith("PROBE "));
  must(line, `the probe printed no result:\n${out}`);
  toolOutcomes = JSON.parse(line.slice("PROBE ".length));
});
const toolProbes: Array<[string, string, (outcome: string) => boolean]> = [
  ["cannot reach the internet directly", "internet", (o) => o !== "open"],
  ["resolves no outside name", "dns", (o) => o.startsWith("error")],
  ["cannot reach the control plane by name", "controlPlane", (o) => o !== "open"],
  ["cannot reach mcp-gateway's control listener", "gatewayControl", (o) => o !== "open"],
  ["cannot reach the egress proxy but through the relay", "egressDirect", (o) => o !== "open"],
  ["cannot reach the docker host", "host", (o) => o !== "open"],
  ["cannot reach the deployment network's gateway", "bridge", (o) => o !== "open"],
  ["is refused by the relay with no claim (407)", "noClaim", (o) => o.includes(" 407 ")],
  ["is refused by the relay with a run's claim (407)", "runClaim", (o) => o.includes(" 407 ")],
  ["reaches a public host with a tool claim (200)", "toolPublic", (o) => o.includes(" 200 ")],
  [
    "is refused a private address with a tool claim (403)",
    "toolPrivate",
    (o) => o.includes(" 403 "),
  ],
];
for (const [what, key, holds] of toolProbes) {
  if (Object.keys(toolOutcomes).length === 0) break;
  await check(`a hosted server ${what}`, () => {
    must(holds(toolOutcomes[key] ?? "(none)"), `got ${toolOutcomes[key]}`);
    return Promise.resolve();
  });
}

// The guard is the one hosted container on `ryph` as well, under docker's default runtime, so its
// launch is the gateway's fixed shape and not only its image: a tools-token holder naming the
// guard with the guard's own image and NODE_OPTIONS (or a command) would otherwise run its code
// there. Asked of the launcher directly, from a container on `ryph`, as a gateway would ask it.
await check(
  "the launcher refuses a guard launch with NODE_OPTIONS or a command (400)",
  async () => {
    const toolsToken = process.env.RYPH_LAUNCHER_TOOLS_TOKEN;
    must(toolsToken, "no RYPH_LAUNCHER_TOOLS_TOKEN in the environment; run `bun run compose:init`");
    const script = `
(async () => {
  const headers = {
    authorization: "Bearer " + process.env.RYPH_LAUNCHER_TOOLS_TOKEN,
    "content-type": "application/json",
  };
  const info = await (await fetch("http://launcher:7470/v1/tools/info", { headers })).json();
  const guard = {
    name: info.guardName,
    image: info.guardImage,
    command: [],
    env: { RYPH_TOOL_ROUTES: "" },
    secretEnv: {},
    port: 8080,
    memory: "256m",
    lifetime: "shared",
  };
  const node = "--import=data:text/javascript,process.exit(9)";
  const out = {};
  for (const [key, spec] of [
    ["env", { ...guard, env: { ...guard.env, NODE_OPTIONS: node } }],
    ["secretEnv", { ...guard, secretEnv: { NODE_OPTIONS: node } }],
    ["command", { ...guard, command: ["-e", "process.exit(9)"] }],
  ]) {
    const res = await fetch("http://launcher:7470/v1/tools/launch", {
      method: "POST",
      headers,
      body: JSON.stringify({ spec }),
    });
    out[key] = res.status;
  }
  console.log("PROBE " + JSON.stringify(out));
})();
`;
    const out = await docker([
      "run",
      "--rm",
      "--network",
      "ryph",
      "--label",
      "ryph.smoke=probe",
      // By name: the value stays on this process's environment, off the argv.
      "-e",
      "RYPH_LAUNCHER_TOOLS_TOKEN",
      "--entrypoint",
      "/nodejs/bin/node",
      GATE_IMAGE,
      "-e",
      script,
    ]);
    const line = out.split("\n").find((l) => l.startsWith("PROBE "));
    must(line, `the probe printed no result:\n${out}`);
    const statuses = JSON.parse(line.slice("PROBE ".length)) as Record<string, number>;
    for (const [key, status] of Object.entries(statuses)) {
      must(status === 400, `a guard launch with ${key} of the caller's answered ${status}`);
    }
    // And the guard hosting launched is still the one running.
    const running = (await docker(["inspect", "-f", "{{.State.Running}}", GUARD])).trim();
    must(running === "true", `${GUARD} is not running`);
  },
);

section("forge → object storage · where patches actually live");
await check("a real S3 implementation accepts the forge's signature", async () => {
  // The one thing no unit test can answer. SigV4 is hand-rolled (packages/forge/src/helpers),
  // its arithmetic is pinned against AWS's published vectors, and a fake store checking our own
  // signature would only be checking our own arithmetic. This drives the SAME adapter the forge
  // runs against the SAME store it writes to, and a wrong signature is a bare 403 here.
  //
  // The keys are the stack's own, from the .env `compose:init` wrote (the task loads it).
  const accessKeyId = process.env.RYPH_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RYPH_S3_SECRET_ACCESS_KEY;
  must(
    accessKeyId && secretAccessKey,
    "no S3 keys in the environment; run `bun run compose:init`",
  );
  const store = s3PatchStore({
    config: {
      endpoint: OBJECTS,
      region: process.env.RYPH_S3_REGION ?? "us-east-1",
      bucket: "ryph-patches",
      accessKeyId,
      secretAccessKey,
      forcePathStyle: true,
    },
    diag: { debug() {}, warn() {} },
  });

  const key = `patches/compose-smoke/${crypto.randomUUID()}.pack`;
  const contents = `bundle bytes ${new Date().toISOString()}`;
  const stagingDir = await mkdtemp(join(tmpdir(), "ryph-smoke-"));
  const staging = join(stagingDir, "bundle");
  await writeFile(staging, contents);

  await store.put(key, staging);
  // The port promises the source is consumed — on this adapter by removal, since the bytes were
  // copied rather than renamed.
  const survived = await stat(staging).then(() => true, () => false);
  await rm(stagingDir, { recursive: true, force: true });
  must(!survived, "the staging file was left behind to fill the disk");

  const read = await store.get(key);
  must(read, "the bundle that was just written read back as missing");
  must(
    await new Response(read).text() === contents,
    "the bundle came back with different bytes",
  );

  // And the definitive-no: a key that was never written is null, not an error, because that is
  // what the route turns into its own 404.
  must(await store.get("patches/compose-smoke/never-written.pack") === null, "a miss was not null");
});

if (bootstrapNote !== "") console.log(`\n${bootstrapNote}`);
console.log(
  failures === 0
    ? `${ran} checks passed — every service link in the stack is up.`
    : `${failures} of ${ran} checks failed.`,
);
process.exit(failures === 0 ? 0 : 1);
