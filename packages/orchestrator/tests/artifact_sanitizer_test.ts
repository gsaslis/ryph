// Around the sanitizer process (adapters/artifact_html/): what its answer must look like before
// the core sees it, the boot checks of both shapes, a process the kernel killed, and the
// supervisor the control-plane image asks over a socket, with its framing, its bounds and the
// control plane's own deadline. The socket here is TCP on loopback; the image runs the same code
// on a unix socket (images/control-plane/entrypoint.sh).

import { test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { ARTIFACT_PREAMBLE, prepareArtifactHtml } from "../src/helpers/artifact_html.ts";
import {
  processArtifactHtml,
  sanitizerCommand,
  sanitizerReads,
  validatePrepared,
} from "../src/adapters/artifact_html/process_preparer.ts";
import { serveSanitizer } from "../src/adapters/artifact_html/sanitizer_supervisor.ts";
import { socketArtifactHtml } from "../src/adapters/artifact_html/socket_preparer.ts";
import {
  type Conn,
  dial,
  MAX_ANSWER_BYTES,
  MAX_REQUEST_BYTES,
  readFrame,
  socketConn,
  writeFrame,
} from "../src/adapters/artifact_html/sanitizer_protocol.ts";

const REF_A = "img-0123456789ab";

test("commands: confined, node --permission grants reading its own modules and nothing else; unconfined, this runtime", () => {
  const confined = sanitizerCommand(3_000, 192, {
    kind: "confined",
    node: "/opt/node/bin/node",
    version: "25.9.0",
    reads: ["/app/a.ts", "/app/node_modules/parse5"],
  });
  assertEquals(confined.cmd, "/opt/node/bin/node");
  assertEquals(confined.args.slice(0, 4), [
    "--permission",
    "--allow-fs-read=/app/a.ts",
    "--allow-fs-read=/app/node_modules/parse5",
    "--max-old-space-size=192",
  ]);
  assert(confined.args[4].endsWith("/artifact_html/sanitizer.ts"));
  assertEquals(confined.args.slice(5), ["3000", "192", "--confined"]);
  const unconfined = sanitizerCommand(3_000, 192, { kind: "unconfined", why: "" });
  assertEquals(unconfined.cmd, process.execPath);
  assert(!unconfined.args.includes("--permission"));
  assertEquals(unconfined.args.slice(-2), ["3000", "192"]);
  // What the confined process may read: its own three modules, and parse5 with what it imports,
  // each by the path node resolves it through and by its real one.
  const reads = sanitizerReads();
  assert(reads.some((path) => path.endsWith("/artifact_html/sanitizer.ts")));
  assert(reads.some((path) => path.endsWith("/helpers/artifact_html.ts")));
  assert(reads.some((path) => path.endsWith("/parse5")));
  assert(reads.some((path) => path.endsWith("/entities")));
  assert(!reads.some((path) => path.endsWith("/src") || path.endsWith("/orchestrator")));
});

/** Runs `program` (a module under tests/) as the sanitizer. */
const running = (program: string) => () => ({
  cmd: process.execPath,
  args: ["--no-env-file", fromFileUrl(new URL(program, import.meta.url))],
});

async function prepareOnce(
  preparer: ReturnType<typeof processArtifactHtml> | ReturnType<typeof socketArtifactHtml>,
  owner: string,
  html: string,
) {
  const slot = preparer.reserve(owner);
  if (slot.kind !== "slot") return slot;
  try {
    return await slot.prepare(html);
  } finally {
    slot.release();
  }
}

test("answer: every served document the sanitizer makes passes the shape check", () => {
  const documents = [
    "<p>hi",
    "<!doctype html><html lang=en><head><title>x</title></head><body>y",
    '<!--a--><!DOCTYPE html><!-- b > c --><html a"b=1 =x data-x=\'"q"\'><!--d--><head id=h>',
    "<html><head class='a > b'><meta charset=utf-8><body>z",
    `<img src="${REF_A}">`,
    "<svg><style>&lt;/style&gt;</style></svg>",
    // The preamble's own text in a comment before <head>: the check looks for it where <head>
    // opens, not at its first occurrence.
    `<!--${ARTIFACT_PREAMBLE}--><html><!--${ARTIFACT_PREAMBLE}--><head><title>x</title>`,
    // Comments a browser parses with a dash or `--!` inside, written back as they were parsed.
    "<html><!--a----><!--b--!--><!--c-<!-x--><head>",
    // Comments a browser ends early, written back as the empty or shortened ones they were.
    "<html><!--><!---><!-- --!><head>",
    // Characters JS `\s` matches but HTML does not split a name on: kept inside the name.
    "<html a b=x><head c d=y>",
    "<html a\vb=x><head c\vd=y>",
    "<html a b=x﻿c=y><head a　b=x>",
  ];
  for (const html of documents) {
    const out = prepareArtifactHtml(html);
    assert(out.kind === "ok", `${html} → ${out.kind}`);
    assertEquals(validatePrepared(JSON.parse(JSON.stringify(out))), out);
  }
  // A refusal carries its kind and nothing else, whatever else was sent.
  assertEquals(validatePrepared({ kind: "too_deep", extra: "x" }), { kind: "too_deep" });
});

test("answer: anything but a known refusal or a document with the preamble first in <head> is a fault", () => {
  const bad: unknown[] = [
    null,
    "ok",
    [],
    { kind: "pwned" },
    { kind: "ok", served: 1, refs: [] },
    { kind: "ok", served: `<html><head>${ARTIFACT_PREAMBLE}`, refs: [1] },
    { kind: "ok", served: `<html><head>${ARTIFACT_PREAMBLE}`, refs: "x" },
    { kind: "ok", served: "<html><head><title>x</title>", refs: [] },
    { kind: "ok", served: `<html><head><script>evil()</script>${ARTIFACT_PREAMBLE}`, refs: [] },
    { kind: "ok", served: `<script>evil()</script><html><head>${ARTIFACT_PREAMBLE}`, refs: [] },
    { kind: "ok", served: `<html><body><head>${ARTIFACT_PREAMBLE}`, refs: [] },
    // Comments a browser ends sooner than at the next `-->`: <head> opens inside them, the text
    // after them closes it, and the preamble lands in <body>.
    { kind: "ok", served: `<html><!--><head>--><head>${ARTIFACT_PREAMBLE}`, refs: [] },
    { kind: "ok", served: `<html><!---><head>--><head>${ARTIFACT_PREAMBLE}`, refs: [] },
    { kind: "ok", served: `<html><!-- --!><head>--><head>${ARTIFACT_PREAMBLE}`, refs: [] },
    { kind: "ok", served: `<!--><html><head>--><html><head>${ARTIFACT_PREAMBLE}`, refs: [] },
    // The preamble's text in a comment is not the preamble first in <head>.
    { kind: "ok", served: `<html><!--${ARTIFACT_PREAMBLE}--><head><p>x`, refs: [] },
  ];
  for (const answer of bad) {
    let threw = false;
    try {
      validatePrepared(answer);
    } catch {
      threw = true;
    }
    assert(threw, `accepted ${JSON.stringify(answer)}`);
  }
});

test("process: a sanitizer that answers a document without the preamble is a platform fault, never stored", async () => {
  const preparer = processArtifactHtml({ command: running("./lying_sanitizer.ts") });
  try {
    const slot = preparer.reserve("r-1");
    assert(slot.kind === "slot");
    await assertRejects(() => slot.prepare("<p>x"), Error, "preamble");
    assertEquals(preparer.inFlight(), []);
  } finally {
    preparer.close();
  }
});

test("process: a sanitizer the kernel SIGKILLed (out of memory) is refused as too complex, not a fault", async () => {
  const killed: string[] = [];
  const preparer = processArtifactHtml({
    command: running("./oom_killed_sanitizer.ts"),
    onKilled: (owner) => killed.push(owner),
  });
  try {
    assertEquals(await prepareOnce(preparer, "r-1", "<p>x"), {
      kind: "too_complex",
      budgetMs: 3_000,
    });
    // Not our deadline's kill.
    assertEquals(killed, []);
    assertEquals(preparer.inFlight(), []);
  } finally {
    preparer.close();
  }
});

/** A server on loopback TCP, listening, and its port. */
async function loopback(onConnection?: (socket: Socket) => void) {
  const server = createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A supervisor on loopback TCP, and a client of it. */
async function supervised(
  supervisor: Parameters<typeof serveSanitizer>[1],
  client: Omit<Parameters<typeof socketArtifactHtml>[0], "connect"> = {},
) {
  const { server: listener, port } = await loopback();
  const server = serveSanitizer(listener, supervisor);
  const connect = () => dial({ host: "127.0.0.1", port });
  const preparer = socketArtifactHtml({ connect, ...client });
  return {
    preparer,
    connect,
    async [Symbol.asyncDispose]() {
      preparer.close();
      server.stop();
      await server.done;
    },
  };
}

test("socket: the supervisor makes the served document, and refuses crafted ones as the direct path does", async () => {
  // Every document is a process started cold, and on a loaded runner even `<p>hi</p>` can take
  // longer than a tight budget to start and to make, so the served one has the default budget,
  // and both a start-up grace long enough not to be what is tested. Only the crafted one is held
  // to 500 ms, which it is past by orders of magnitude: each stray end tag walks 100,000 open
  // elements.
  const grace = { graceMs: 10_000 };
  await using s = await supervised(grace, grace);
  assertEquals(await s.preparer.ready, true);
  const ok = await prepareOnce(s.preparer, "r-1", `<p>hi</p><img src="${REF_A}">`);
  assert(
    ok.kind === "ok" && ok.refs[0] === REF_A && ok.served.includes(ARTIFACT_PREAMBLE),
    `answered ${JSON.stringify(ok).slice(0, 300)}`,
  );
  await using tight = await supervised({ budgetMs: 500, ...grace }, { budgetMs: 500, ...grace });
  const crafted = "<svg>" + "<g>".repeat(100_000) + "</q>".repeat(100_000);
  assertEquals(await prepareOnce(tight.preparer, "r-1", crafted), {
    kind: "too_complex",
    budgetMs: 500,
  });
  assertEquals(s.preparer.inFlight(), []);
  assertEquals(tight.preparer.inFlight(), []);
});

test("socket: a sanitizer that never stops is killed at the supervisor's deadline; a client that hangs up kills its process", async () => {
  const killed: string[] = [];
  await using s = await supervised(
    { budgetMs: 100, graceMs: 400, command: running("./spinning_sanitizer.ts") },
    { budgetMs: 100, graceMs: 400, onKilled: (owner) => killed.push(owner) },
  );
  const started = performance.now();
  assertEquals(await prepareOnce(s.preparer, "r-1", "<p>x"), {
    kind: "too_complex",
    budgetMs: 100,
  });
  const took = performance.now() - started;
  assert(took >= 500 && took < 1_500, `answered after ${took} ms`);
  assertEquals(killed, ["r-1"]);

  // Hanging up mid-document: the supervisor kills that process and is free for the next.
  const slot = s.preparer.reserve("r-2");
  assert(slot.kind === "slot");
  const pending = slot.prepare("<p>x");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const conn = await s.connect();
  // Busy while the first is alive.
  await writeFrame(conn, new TextEncoder().encode("<p>y"));
  assertEquals(JSON.parse(new TextDecoder().decode((await readFrame(conn, 1024))!)), {
    kind: "busy",
  });
  conn.close();
  s.preparer.close();
  assertEquals(await pending, { kind: "busy" });
  // The spinning process was killed on the hang-up, so the supervisor takes a request again as
  // soon as it has exited: well before the 500 ms its deadline would have taken.
  const hungUp = performance.now();
  let answer: { kind: string } = { kind: "busy" };
  while (answer.kind === "busy" && performance.now() - hungUp < 400) {
    const again = await s.connect();
    await writeFrame(again, new TextEncoder().encode("<p>y"));
    answer = JSON.parse(new TextDecoder().decode((await readFrame(again, 1024))!));
    again.close();
    if (answer.kind === "busy") await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // A fresh spinner, killed at its own deadline: taken, not refused as busy.
  assertEquals(answer.kind, "prepared");
  assert(performance.now() - hungUp >= 400, "it ran a fresh process to its deadline");
});

test("socket: a dead supervisor is refused as unavailable at once, said at boot, and frees the slot", async () => {
  const { server: listener, port } = await loopback();
  await new Promise((resolve) => listener.close(resolve));
  const told: string[] = [];
  const preparer = socketArtifactHtml({
    connect: () => dial({ host: "127.0.0.1", port }),
    onUnavailable: (why) => told.push(why),
  });
  try {
    assertEquals(await preparer.ready, false);
    assertStringIncludes(told[0], "does not answer");
    const started = performance.now();
    assertEquals(await prepareOnce(preparer, "r-1", "<p>x"), { kind: "unavailable" });
    assert(performance.now() - started < 1_000);
    assertEquals(preparer.inFlight(), []);
    assertEquals(told.length, 2);
  } finally {
    preparer.close();
  }
});

/** A server that does `respond` with every connection it takes. */
async function fakeSupervisor(respond: (conn: Conn) => Promise<void>) {
  const conns: Conn[] = [];
  const { server, port } = await loopback((socket) => {
    const conn = socketConn(socket);
    conns.push(conn);
    respond(conn).catch(() => {});
  });
  return {
    connect: () => dial({ host: "127.0.0.1", port }),
    close() {
      server.close();
      for (const conn of conns) conn.close();
    },
  };
}

test("socket: a hung supervisor is given up on at the client's deadline, refused as unavailable, its slot freed", async () => {
  // Takes the request and never answers.
  const hung = await fakeSupervisor(async (conn) => void await readFrame(conn, MAX_REQUEST_BYTES));
  const told: string[] = [];
  const preparer = socketArtifactHtml({
    connect: hung.connect,
    budgetMs: 100,
    graceMs: 100,
    marginMs: 200,
    onUnavailable: (why) => told.push(why),
  });
  try {
    const started = performance.now();
    assertEquals(await prepareOnce(preparer, "r-1", "<p>x"), { kind: "unavailable" });
    const took = performance.now() - started;
    assert(took >= 400 && took < 1_500, `gave up after ${took} ms`);
    assertStringIncludes(told.at(-1)!, "did not answer within 400 ms");
    assertEquals(preparer.inFlight(), []);
  } finally {
    preparer.close();
    hung.close();
  }
});

test("socket: the frames are bounded both ways, and a wrong answer is a fault", async () => {
  // The supervisor refuses a request longer than it takes, before reading it.
  {
    await using s = await supervised({});
    const conn = await s.connect();
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_REQUEST_BYTES + 1);
    await conn.write(header);
    const answer = JSON.parse(new TextDecoder().decode((await readFrame(conn, 1024))!));
    conn.close();
    assertEquals(answer.kind, "fault");
    assertStringIncludes(answer.error, "past the");
  }
  // The client refuses an answer longer than it takes, before reading it.
  const huge = await fakeSupervisor(async (conn) => {
    await readFrame(conn, MAX_REQUEST_BYTES);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_ANSWER_BYTES + 1);
    await conn.write(header);
  });
  const told: string[] = [];
  const preparer = socketArtifactHtml({
    connect: huge.connect,
    onUnavailable: (why) => told.push(why),
  });
  try {
    assertEquals(await prepareOnce(preparer, "r-1", "<p>x"), { kind: "unavailable" });
    assertStringIncludes(told.at(-1)!, "past the");
  } finally {
    preparer.close();
    huge.close();
  }
  // A well-framed answer of the wrong shape is never stored.
  const lying = await fakeSupervisor(async (conn) => {
    await readFrame(conn, MAX_REQUEST_BYTES);
    const body = {
      kind: "prepared",
      killed: false,
      prepared: { kind: "ok", served: "x", refs: [] },
    };
    await writeFrame(conn, new TextEncoder().encode(JSON.stringify(body)));
  });
  const fooled = socketArtifactHtml({ connect: lying.connect });
  try {
    const slot = fooled.reserve("r-1");
    assert(slot.kind === "slot");
    await assertRejects(() => slot.prepare("<p>x"), Error, "preamble");
    assertEquals(fooled.inFlight(), []);
  } finally {
    fooled.close();
    lying.close();
  }
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The supervisor program on a socket in `dir`, with `args` after the path: what it said, or
 * the socket's and directory's modes once it listened. */
async function superviseIn(dir: string, args: string[]) {
  const socket = join(dir, "s.sock");
  const child = await command(process.execPath, {
    args: [
      "--no-env-file",
      fromFileUrl(
        new URL("../src/adapters/artifact_html/sanitizer_supervisor.ts", import.meta.url),
      ),
      socket,
      ...args,
    ],
    env: { PATH: process.env.PATH ?? "", HOME: dir },
    clearEnv: true,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const stderr = new Response(child.stderr).text();
  for (let i = 0; i < 200 && !existsSync(socket); i++) {
    if (await Promise.race([child.status.then(() => true), sleep(25).then(() => false)])) break;
  }
  const listening = existsSync(socket);
  // The mode is set right after listen: give it a moment.
  await sleep(100);
  const modes = listening
    ? { socket: statSync(socket).mode & 0o777, dir: statSync(dir).mode & 0o777 }
    : null;
  try {
    child.kill("SIGTERM");
  } catch {
    // It has exited already.
  }
  await child.status;
  return { modes, said: await stderr };
}

test("supervisor: its directory is owner-only, or group-readable with --group, and the socket follows", async () => {
  if (process.platform === "win32") return;
  const base = await mkdtemp(join(tmpdir(), "ryph-supervisor-"));
  try {
    const dir = join(base, "s");
    await mkdir(dir, { mode: 0o750 });
    await chmod(dir, 0o750);
    const refused = await superviseIn(dir, []);
    assertEquals(refused.modes, null);
    assertStringIncludes(refused.said, "only its owner can enter");
    const grouped = await superviseIn(dir, ["--group"]);
    assertEquals(grouped.modes, { socket: 0o660, dir: 0o750 }, grouped.said);
    // Even with --group, nobody else may enter, and the group may not write.
    for (const mode of [0o755, 0o770]) {
      await chmod(dir, mode);
      const wide = await superviseIn(dir, ["--group"]);
      assertEquals(wide.modes, null);
    }
    await chmod(dir, 0o700);
    assertEquals((await superviseIn(dir, [])).modes, { socket: 0o600, dir: 0o700 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
