// `ryph mcp` end to end: the real command, spawned as a client would spawn it, driven by the MCP
// SDK's own client over stdio, against a stub deployment on a port. What a client sees is the
// SDK's reading of the frames, not this package's.

import { afterAll, beforeAll, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "@std/path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { accessToken, taskDetail } from "./_fake_ryph.ts";

let server: ReturnType<typeof Bun.serve>;
let home: string;
const seen: string[] = [];
/** Requests to the hanging route, and those whose connection the client then dropped. */
const hung = { started: 0, dropped: 0 };

beforeAll(async () => {
  // Never ~/.ryph: the command reads config.env from here.
  home = await mkdtemp(join(tmpdir(), "ryph-mcp-home-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname} ${req.headers.get("authorization") ?? ""}`);
      if (url.pathname === "/api/v1/auth/token") {
        const { token } = await req.json() as { token: string };
        if (token !== "ryph_pat_e2e") return Response.json({ error: "no" }, { status: 401 });
        return Response.json({ accessToken: accessToken(["tasks:read"]), expiresIn: 900 });
      }
      if (url.pathname === "/api/v1/tasks/t-1") return Response.json(taskDetail());
      if (url.pathname === "/api/v1/tasks/t-slow") {
        // Short, but still in flight when a piped client's stdin ends right after its request.
        await Bun.sleep(150);
        return Response.json(taskDetail());
      }
      if (url.pathname === "/api/v1/tasks/t-hang") {
        // Never answered: only the client hanging up ends it.
        hung.started++;
        await new Promise<void>((resolve) => {
          req.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        hung.dropped++;
        return new Response(null, { status: 499 });
      }
      if (url.pathname === "/api/v1/agents") {
        return Response.json({ error: "requires agents:read", code: "forbidden" }, {
          status: 403,
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

async function connect(token: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-env-file", join(import.meta.dir, "..", "src", "main.ts"), "mcp"],
    env: {
      PATH: process.env.PATH ?? "",
      RYPH_HOME: home,
      RYPH_URL: `http://127.0.0.1:${server.port}`,
      RYPH_TOKEN: token,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("a client lists the tools and calls one through the real command", async () => {
  const client = await connect("ryph_pat_e2e");
  try {
    assertEquals(client.getServerVersion()?.name, "ryph");
    assertStringIncludes(client.getInstructions() ?? "", "API token");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["whoami", "tasks_list", "run_transcript", "checks_run", "agents_manage"]) {
      assert(names.includes(name), name);
    }
    assertEquals(
      tools.find((t) => t.name === "task_get")?.annotations?.readOnlyHint,
      true,
    );

    const got = await client.callTool({ name: "task_get", arguments: { taskId: "t-1" } });
    assertEquals(got.isError, undefined);
    const text = (got.content as Array<{ type: string; text: string }>)[0].text;
    assertStringIncludes(text, 'Task t-1: "Fix the login bug"');
    // The API token was exchanged once and only the access token went to the API.
    assert(seen.some((s) => s.startsWith("GET /api/v1/tasks/t-1 Bearer ")));
    assert(!seen.some((s) => s.includes("ryph_pat_e2e")));

    const refused = await client.callTool({ name: "agents", arguments: { action: "list" } });
    assertEquals(refused.isError, true);
    assertStringIncludes(
      (refused.content as Array<{ text: string }>)[0].text,
      "requires agents:read",
    );
  } finally {
    await client.close();
  }
});

test("a refused token is a tool error, and the server stays up", async () => {
  const client = await connect("ryph_pat_wrong");
  try {
    const got = await client.callTool({ name: "task_get", arguments: { taskId: "t-1" } });
    assertEquals(got.isError, true);
    const text = (got.content as Array<{ text: string }>)[0].text;
    assertStringIncludes(text, "RYPH_TOKEN was refused");
    // The exchange refused it: nothing was passed on, so nothing was dropped on the way.
    assert(!text.includes("accepted at sign-in"), text);
    assert(!text.includes("did not pass it on"), text);
    await client.ping();
  } finally {
    await client.close();
  }
});

/** The real command as a bare child process: frames written to its stdin, lines read off its
 * stdout, so what it does NOT send is observable too. */
function spawnRaw() {
  const proc = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", join(import.meta.dir, "..", "src", "main.ts"), "mcp"],
    env: {
      PATH: process.env.PATH ?? "",
      RYPH_HOME: home,
      RYPH_URL: `http://127.0.0.1:${server.port}`,
      RYPH_TOKEN: "ryph_pat_e2e",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const frames: Array<Record<string, unknown>> = [];
  void (async () => {
    let buffer = "";
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        frames.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    }
  })();
  const write = (frame: unknown) => {
    proc.stdin.write(`${JSON.stringify(frame)}\n`);
    proc.stdin.flush();
  };
  return { proc, frames, write };
}

/** The real command, answering: a cold start on a busy check machine takes seconds, and the
 * timings these tests measure start only once it is up. */
async function spawnReady() {
  const raw = spawnRaw();
  raw.write({ jsonrpc: "2.0", id: "ready", method: "ping" });
  await until("the server to start", () => raw.frames.some((f) => f.id === "ready"), 60_000);
  return raw;
}

async function until(what: string, ok: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const hangingCall = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "task_get", arguments: { taskId: "t-hang" } },
});

test("a cancelled call stops its request and is never answered", async () => {
  const { proc, frames, write } = await spawnReady();
  try {
    const before = { ...hung };
    write(hangingCall(1));
    await until("the hanging request", () => hung.started > before.started);
    write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    await until("the request to be dropped", () => hung.dropped > before.dropped);
    write({ jsonrpc: "2.0", id: 2, method: "ping" });
    await until("the ping's answer", () => frames.some((f) => f.id === 2));
    // Anything for id 1 would have been written before the ping's answer.
    assertEquals(frames.filter((f) => f.id === 1), []);
  } finally {
    proc.stdin.end();
    await proc.exited;
  }
});

test("the end of stdin ends a call still in flight after the grace window, and the process", async () => {
  const { proc, frames, write } = await spawnReady();
  const before = { ...hung };
  write(hangingCall(7));
  await until("the hanging request", () => hung.started > before.started);
  const closed = Date.now();
  proc.stdin.end();
  const code = await Promise.race([proc.exited, Bun.sleep(20_000).then(() => "still running")]);
  if (code === "still running") proc.kill();
  assertEquals(code, 0);
  // A 5 s grace window, then a cancel and up to 1 s to unwind, with room for a slow machine.
  assert(Date.now() - closed < 9000, `exited after ${Date.now() - closed}ms`);
  await until("the request to be dropped", () => hung.dropped > before.dropped);
  assertEquals(frames.filter((f) => f.id === 7), []);
});

test("a short call in flight at the end of stdin still gets its answer", async () => {
  const { proc, frames, write } = await spawnReady();
  write({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "task_get", arguments: { taskId: "t-slow" } },
  });
  proc.stdin.end();
  const code = await Promise.race([proc.exited, Bun.sleep(20_000).then(() => "still running")]);
  if (code === "still running") proc.kill();
  assertEquals(code, 0);
  await until("stdout to drain", () => frames.some((f) => f.id === 8), 1000);
  const answer = frames.find((f) => f.id === 8)!.result as { content: Array<{ text: string }> };
  assertStringIncludes(answer.content[0].text, 'Task t-1: "Fix the login bug"');
});

test("a request reusing an id still in flight is refused, and the original call is left alone", async () => {
  const { proc, frames, write } = await spawnReady();
  try {
    const before = { ...hung };
    write(hangingCall(9));
    await until("the hanging request", () => hung.started > before.started);
    write({ jsonrpc: "2.0", id: 9, method: "ping" });
    await until("the refusal", () => frames.some((f) => f.id === 9));
    assertEquals((frames.find((f) => f.id === 9)!.error as { code: number }).code, -32600);
    assertEquals(hung.dropped, before.dropped, "the original call still runs");
    write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
    await until("the request to be dropped", () => hung.dropped > before.dropped);
  } finally {
    proc.stdin.end();
    await proc.exited;
  }
});
