// Agent vision on the runner's side: a tool's images kept as run attachments before their result
// is narrated (in order, bounded, a failure narrated without one), the control plane's upload door
// as the runner speaks it, and what a model that cannot see images is given instead.

import { test } from "bun:test";
import { serve } from "@ryph/service";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeCredentials } from "../src/helpers/runtime_credentials.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BROWSER_TEXT_ONLY_INSTRUCTION,
  forBacklog,
  piHarness,
  TEXT_ONLY_HARNESS_ENV,
} from "../src/adapters/harness/pi.ts";
import {
  KEEP_BACKLOG,
  KEEP_MAX_BYTES,
  piCatalogueFiles,
  piModelSeesImages,
  REF_LINE_PREFIX,
  toolImageKeeper,
  withoutImageData,
} from "../src/adapters/harness/pi_vision.ts";
import { httpAttachments } from "../src/adapters/orchestrator/http.ts";
import type {
  HarnessInput,
  HarnessIo,
  HarnessMessage,
  HarnessTools,
} from "../src/ports/harness.ts";
import type { AttachmentRef, TranscriptChunk } from "../src/core/types.ts";
import { MAX_ATTACHMENT_BYTES } from "../../orchestrator/src/core/attachments.ts";
import {
  imageRef as extensionImageRef,
  REF_LINE_PREFIX as EXTENSION_REF_LINE_PREFIX,
  TEXT_ONLY_ENV,
} from "../../pi-mcp/images.ts";
import { imageRefOf } from "../src/core/image_refs.ts";
import { repoEntry } from "./util.ts";
import { endsAtSettle } from "./doubles/conversation.ts";

const FAKE_PI = new URL("./fixtures/fake_pi.ts", import.meta.url).pathname;
const PNG_B64 = "iVBORw0KGgoAAAAN";
const PNG = Uint8Array.fromBase64(PNG_B64);
const noopDiagnostics = { debug: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeInput(): Promise<{ input: HarnessInput; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  return {
    input: {
      spec: { title: "Look", instructions: "Check the page." },
      agent: { name: "Ada", email: "ada@example.test" },
      brief: null,
      layout: "## Your checkout",
      machine: "## Your machine",
      checkoutDir: dir,
      repos: [repoEntry({ url: "https://example.test/repo.git" })],
      serviceHosts: [],
      skills: [],
    },
    cleanup: () => rm(dir, { recursive: true }),
  };
}

function io(keepImage?: HarnessIo["keepImage"]) {
  const chunks: TranscriptChunk[] = [];
  const warnings: string[] = [];
  const value: HarnessIo = {
    signal: new AbortController().signal,
    onTranscript: (c) => {
      chunks.push(c);
      return chunks.length - 1;
    },
    diagnostics: { debug: () => {}, warn: (e: string) => warnings.push(e) },
    conversation: endsAtSettle(),
    ...(keepImage === undefined ? {} : { keepImage }),
  };
  return { io: value, chunks, warnings };
}

const imagesIn = (chunk: TranscriptChunk) =>
  (chunk.raw as { result: { content: Array<Record<string, unknown>> } }).result.content
    .filter((b) => b.type === "image");

test("vision: the caps and the env var are the control plane's and the extension's own", () => {
  assertEquals(KEEP_MAX_BYTES, MAX_ATTACHMENT_BYTES);
  assertEquals(TEXT_ONLY_HARNESS_ENV, TEXT_ONLY_ENV);
  assertEquals(REF_LINE_PREFIX, EXTENSION_REF_LINE_PREFIX);
});

test("vision: a ref is the one the extension computes", async () => {
  assertEquals(await imageRefOf(PNG), extensionImageRef(PNG_B64));
});

test("vision: a tool's images are kept before its result is narrated, in pi's order, even when slow", async () => {
  const { input, cleanup } = await makeInput();
  const asked: Uint8Array[] = [];
  const refs: string[] = [];
  let n = 0;
  // The first upload is slow: everything after it must still narrate after it, in order.
  const keep = async (bytes: Uint8Array, ref: string): Promise<AttachmentRef | null> => {
    asked.push(bytes);
    refs.push(ref);
    const id = `att-${++n}`;
    if (n === 1) await sleep(300);
    return { id, mime: "image/png" };
  };
  const { io: harnessIo, chunks } = io(keep);
  try {
    await piHarness({ kind: "pi" }, {
      command: [process.execPath, "--no-env-file", FAKE_PI, "--scenario=tool-images"],
    }).run(input, harnessIo);
    assertEquals(chunks.map((c) => c.kind).filter((k) => k !== "system" && k !== "final"), [
      "tool_use",
      "tool_result",
      "assistant",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    // The BMP is not a type the control plane keeps, so it is never sent: two uploads, the
    // decoded bytes each time.
    assertEquals(asked, [PNG, PNG]);
    // Each under its ref: the line beside the screenshot, which names its bytes; and for the
    // read, whose line names other bytes (pi resized it after the extension named it), the
    // bytes' own — the narrated line corrected to match.
    const own = await imageRefOf(PNG);
    assertEquals(refs, [own, own]);
    const [shot, read] = chunks.filter((c) => c.kind === "tool_result");
    const lines = (chunk: TranscriptChunk) =>
      (chunk.raw as { result: { content: Array<Record<string, unknown>> } }).result.content
        .filter((b) => b.type === "text" && String(b.text).startsWith(REF_LINE_PREFIX))
        .map((b) => b.text);
    assertEquals(lines(read), [`${REF_LINE_PREFIX}${own}`]);
    assertEquals(lines(shot)[0], `${REF_LINE_PREFIX}${own}`);
    // The narrated shape, exactly: the bytes a note of their size, the kept one its ref.
    assertEquals(imagesIn(shot), [
      {
        type: "image",
        data: `[${PNG_B64.length} base64 chars omitted]`,
        mimeType: "image/png",
        attachment: { id: "att-1", mime: "image/png" },
      },
      { type: "image", data: "[8 base64 chars omitted]", mimeType: "image/bmp" },
    ]);
    assertEquals(imagesIn(read), [{
      type: "image",
      data: `[${PNG_B64.length} base64 chars omitted]`,
      mimeType: "image/png",
      attachment: { id: "att-2", mime: "image/png" },
    }]);
    assert(!JSON.stringify(chunks).includes(PNG_B64), "no base64 in the transcript");
  } finally {
    await cleanup();
  }
});

/** Resolves once `path` exists, or rejects after `ms`. */
async function fileAppears(path: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${path} never appeared`);
      await sleep(10);
    }
  }
}

const burst = (count: number, path: string) => [
  process.execPath,
  "--no-env-file",
  FAKE_PI,
  `--scenario=image-burst:${count}:${path}`,
];

test("vision: a slow upload never stops the adapter reading pi's stdout", async () => {
  const { input, cleanup } = await makeInput();
  const drained = `${input.checkoutDir}/drained`;
  // The upload answers only once pi has written past what a pipe holds: if the read loop waited
  // for it, pi would block on its stdout and the file would never appear.
  const keep = async (): Promise<AttachmentRef | null> => {
    try {
      await fileAppears(drained, 10_000);
    } catch {
      return null;
    }
    return { id: "att-1", mime: "image/png" };
  };
  const { io: harnessIo, chunks } = io(keep);
  try {
    await piHarness({ kind: "pi" }, { command: burst(1, drained) }).run(input, harnessIo);
    const [shot] = chunks.filter((c) => c.kind === "tool_result");
    assertEquals(imagesIn(shot)[0].attachment, { id: "att-1", mime: "image/png" });
  } finally {
    await cleanup();
  }
});

test("vision: a message delivered while a settle waits on an upload starts a turn the stale settle never ends", async () => {
  const { input, cleanup } = await makeInput();
  // The upload holds until the test lets it go, so the task's settle is read and its drain
  // waits on it; a message is delivered meanwhile.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let uploading = false;
  const keep = async (): Promise<AttachmentRef | null> => {
    uploading = true;
    await released;
    return { id: "att-1", mime: "image/png" };
  };
  const { io: harnessIo, chunks } = io(keep);
  // A core that ends the run at the first settle it hears of, as a `finish` does.
  const queue: HarnessMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const done = new AbortController();
  let settles = 0;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const conversation: NonNullable<HarnessIo["conversation"]> = {
    messages: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    },
    done: done.signal,
    onSettled: () => {
      settles++;
      done.abort();
      closed = true;
      notify();
    },
  };
  try {
    const running = piHarness({ kind: "pi" }, {
      command: [process.execPath, "--no-env-file", FAKE_PI, "--scenario=conversation-image"],
    }).run(input, { ...harnessIo, conversation });
    const deadline = Date.now() + 5_000;
    while (!uploading) {
      if (Date.now() > deadline) throw new Error("the upload never started");
      await sleep(5);
    }
    // Long enough for the settle behind the upload to be read.
    await sleep(200);
    queue.push({ text: "and the footer" });
    notify();
    await sleep(100);
    release();
    const outcome = await running;
    assertEquals(outcome.interrupted, false);
    assertEquals(settles, 1, "only the new turn's settle is reported");
    assertEquals(
      chunks.filter((c) => c.kind === "assistant").map((c) => c.text),
      ["Took a look.", "Re(steer): and the footer"],
    );
    assertEquals(outcome.summary, "Re(steer): and the footer");
  } finally {
    await cleanup();
  }
});

test("vision: at most KEEP_BACKLOG events wait on uploads; later images narrate unkept, in order", async () => {
  const { input, cleanup } = await makeInput();
  const drained = `${input.checkoutDir}/drained`;
  let n = 0;
  // The first upload holds until pi has written everything, so every event is read while it
  // waits: eight queue for uploads, the rest go past the bound.
  const keep = async (): Promise<AttachmentRef | null> => {
    const id = `att-${++n}`;
    if (n === 1) await fileAppears(drained, 10_000).catch(() => {});
    return { id, mime: "image/png" };
  };
  const { io: harnessIo, chunks, warnings } = io(keep);
  const unkept: string[] = [];
  harnessIo.unkeptImage = (ref, reason) => unkept.push(`${ref} ${reason}`);
  try {
    await piHarness({ kind: "pi" }, { command: burst(KEEP_BACKLOG + 4, drained) })
      .run(input, harnessIo);
    const results = chunks.filter((c) => c.kind === "tool_result");
    assertEquals(
      results.map((c) => (c.raw as { toolCallId: string }).toolCallId),
      Array.from({ length: KEEP_BACKLOG + 4 }, (_, i) => `t${i + 1}`),
      "pi's order",
    );
    assertEquals(
      results.map((c) => (imagesIn(c)[0].attachment as { id?: string } | undefined)?.id ?? null),
      [
        ...Array.from({ length: KEEP_BACKLOG }, (_, i) => `att-${i + 1}`),
        ...Array.from({ length: 4 }, () => null),
      ],
    );
    for (const result of results) {
      assertEquals(imagesIn(result)[0].data, `[${PNG_B64.length} base64 chars omitted]`);
    }
    assert(warnings.includes("pi.tool_image.unkept"));
    assertEquals(n, KEEP_BACKLOG);
    // Each image past the bound is said unkept by its ref: the agent read one for it.
    const ref = await imageRefOf(PNG);
    assertEquals(unkept, Array.from({ length: 4 }, () => `${ref} backlog`));
  } finally {
    await cleanup();
  }
});

test("vision: an upload that fails or hangs is narrated without an attachment, and the run goes on", async () => {
  const { input, cleanup } = await makeInput();
  let calls = 0;
  // The first answers null (refused), the second never answers at all.
  const keep = (
    _bytes: Uint8Array,
    _ref: string,
    signal: AbortSignal,
  ): Promise<AttachmentRef | null> => {
    calls++;
    if (calls === 1) return Promise.resolve(null);
    return new Promise(() => {
      assert(signal instanceof AbortSignal);
    });
  };
  const { io: harnessIo, chunks } = io(keep);
  try {
    const started = Date.now();
    const outcome = await piHarness({ kind: "pi" }, {
      command: [process.execPath, "--no-env-file", FAKE_PI, "--scenario=tool-images"],
      keepImages: { imageTimeoutMs: 100 },
    }).run(input, harnessIo);
    assert(Date.now() - started < 5_000, "a hung upload held the run back past its timeout");
    assertEquals(outcome.summary, "Done.");
    const results = chunks.filter((c) => c.kind === "tool_result");
    assertEquals(results.length, 2);
    for (const result of results) {
      for (const image of imagesIn(result)) assertEquals("attachment" in image, false);
    }
    assertEquals(calls, 2);
  } finally {
    await cleanup();
  }
});

test("vision: a text-only model's tool images are kept too: it may show one by its ref", async () => {
  const { input, cleanup } = await makeInput();
  let asked = 0;
  const { io: harnessIo, chunks } = io(() => {
    asked++;
    return Promise.resolve({ id: "att-1", mime: "image/png" });
  });
  try {
    await piHarness({ kind: "pi" }, {
      command: [process.execPath, "--no-env-file", FAKE_PI, "--scenario=tool-images"],
      modelSeesImages: false,
    }).run(input, harnessIo);
    // The PNGs; never the BMP, which the control plane would not keep.
    assertEquals(asked, 2);
    const results = chunks.filter((c) => c.kind === "tool_result");
    assertEquals(results.length, 2);
    for (const result of results) {
      for (const image of imagesIn(result)) {
        assertEquals("attachment" in image, image.mimeType === "image/png");
        assertStringIncludes(String(image.data), "base64 chars omitted");
      }
    }
  } finally {
    await cleanup();
  }
});

test("vision: what waits behind an upload is only what narration reads, and none of its bytes", () => {
  const image = { type: "image", data: PNG_B64, mimeType: "image/png" };
  const toolResult = { role: "toolResult", toolCallId: "t1", content: [image] };
  const assistant = { role: "assistant", content: [{ type: "text", text: "Seen." }, image] };
  // pi repeats a tool's images in these, and narration reads none of them: never queued.
  for (
    const event of [
      { type: "message_start", message: toolResult },
      { type: "message_end", message: toolResult },
      { type: "message_update", message: assistant },
      { type: "turn_end", message: assistant, toolResults: [toolResult] },
      { type: "agent_end", messages: [toolResult, assistant] },
      { type: "response", command: "prompt", success: true },
    ]
  ) {
    assertEquals(forBacklog(event, true), null, String(event.type));
    assertEquals(forBacklog(event, false), null, String(event.type));
  }
  // What narration reads is queued — without bytes when it waits behind an upload.
  const kept = [
    { type: "agent_start" },
    { type: "message_end", message: assistant },
    { type: "tool_execution_start", toolCallId: "t2", toolName: "shot", args: {} },
    { type: "tool_execution_end", toolCallId: "t2", result: { content: [image] } },
  ];
  for (const event of kept) {
    const behind = forBacklog(event, true);
    assert(behind !== null, String(event.type));
    assert(!JSON.stringify(behind).includes(PNG_B64), `${event.type} kept its bytes`);
    assertEquals(forBacklog(event, false), event, "nothing waits: queued as it is");
  }
});

test("vision: pi's repeats of a tool's images wait behind its upload without their bytes", async () => {
  const { input, cleanup } = await makeInput();
  const keep = async (): Promise<AttachmentRef | null> => {
    await sleep(300);
    return { id: "att-1", mime: "image/png" };
  };
  const { io: harnessIo, chunks } = io(keep);
  try {
    const outcome = await piHarness({ kind: "pi" }, {
      command: [process.execPath, "--no-env-file", FAKE_PI, "--scenario=tool-image-echo"],
    }).run(input, harnessIo);
    assertEquals(outcome.summary, "Seen.");
    assertEquals(chunks.map((c) => c.kind).filter((k) => k !== "system" && k !== "final"), [
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    const [shot] = chunks.filter((c) => c.kind === "tool_result");
    assertEquals(imagesIn(shot)[0].attachment, { id: "att-1", mime: "image/png" });
    assert(!JSON.stringify(chunks).includes("QUJDQUJD"), "no base64 in the transcript");
  } finally {
    await cleanup();
  }
});

test("vision: no keeper (no control plane) narrates exactly as before", async () => {
  const { input, cleanup } = await makeInput();
  const { io: harnessIo, chunks } = io();
  try {
    await piHarness({ kind: "pi" }, {
      command: [process.execPath, "--no-env-file", FAKE_PI, "--scenario=tool-images"],
    }).run(input, harnessIo);
    const shot = chunks.find((c) => c.kind === "tool_result")!;
    assertEquals(imagesIn(shot)[0], {
      type: "image",
      data: `[${PNG_B64.length} base64 chars omitted]`,
      mimeType: "image/png",
    });
  } finally {
    await cleanup();
  }
});

test("vision: the keeper skips what it may not keep, bounds an event, and pauses after timeouts", async () => {
  let t = 0;
  const now = () => t;
  const asked: number[] = [];
  const keeper = toolImageKeeper(
    (bytes) => {
      asked.push(bytes.length);
      return new Promise(() => {}); // never answers
    },
    noopDiagnostics,
    { imageTimeoutMs: 20, eventBudgetMs: 10_000, now },
  );
  const big = "A".repeat(Math.ceil(KEEP_MAX_BYTES / 3) * 4 + 4);
  const event = (...blocks: unknown[]) => ({
    type: "tool_execution_end",
    result: { content: blocks },
  });
  const signal = new AbortController().signal;
  // Over 5 MiB: never sent.
  assertEquals(
    (await keeper.keep(event({ type: "image", data: big, mimeType: "image/png" }), signal)).size,
    0,
  );
  assertEquals(asked, []);
  // Two timeouts in a row pause uploads: the third image is not even asked.
  const png = { type: "image", data: PNG_B64, mimeType: "image/png" };
  assertEquals((await keeper.keep(event(png, { ...png }, { ...png }), signal)).size, 0);
  assertEquals(asked.length, 2);
  // Still paused a moment later; after the pause, asked again.
  t += 1_000;
  await keeper.keep(event({ ...png }), signal);
  assertEquals(asked.length, 2);
  t += 120_000;
  await keeper.keep(event({ ...png }), signal);
  assertEquals(asked.length, 3);

  // An event whose budget is spent leaves its later images unkept, without asking.
  let calls = 0;
  const budgeted = toolImageKeeper(
    () => {
      calls++;
      t += 50; // each upload takes 50 "ms"
      return Promise.resolve({ id: `a${calls}`, mime: "image/png" as const });
    },
    noopDiagnostics,
    { eventBudgetMs: 100, now },
  );
  const kept = await budgeted.keep(event({ ...png }, { ...png }, { ...png }), signal);
  assertEquals([kept.size, calls], [2, 2]);
});

test("vision: two failures of any kind in a row pause uploads — refused, or slow but kept", async () => {
  let t = 0;
  const now = () => t;
  const png = () => ({ type: "image", data: PNG_B64, mimeType: "image/png" });
  const event = (...blocks: unknown[]) => ({
    type: "tool_execution_end",
    result: { content: blocks },
  });
  const signal = new AbortController().signal;

  // Two refusals (null) in a row: the third image is not asked.
  let refusedAsks = 0;
  const refusing = toolImageKeeper(
    () => {
      refusedAsks++;
      return Promise.resolve(null);
    },
    noopDiagnostics,
    { now },
  );
  assertEquals((await refusing.keep(event(png(), png(), png()), signal)).size, 0);
  assertEquals(refusedAsks, 2);

  // Two uploads slower than KEEP_SLOW_MS: both kept, and then the pause.
  let slowAsks = 0;
  const slow = toolImageKeeper(
    () => {
      slowAsks++;
      t += 6_000;
      return Promise.resolve({ id: `s${slowAsks}`, mime: "image/png" as const });
    },
    noopDiagnostics,
    { now, eventBudgetMs: 100_000 },
  );
  assertEquals((await slow.keep(event(png(), png(), png()), signal)).size, 2);
  assertEquals(slowAsks, 2);
  t += 61_000;
  assertEquals((await slow.keep(event(png()), signal)).size, 1, "asked again after the pause");

  // A failure then a fast success is no run of failures: nothing pauses.
  let mixedAsks = 0;
  const mixed = toolImageKeeper(
    () => {
      mixedAsks++;
      return Promise.resolve(
        mixedAsks % 2 === 1 ? null : { id: `m${mixedAsks}`, mime: "image/png" as const },
      );
    },
    noopDiagnostics,
    { now },
  );
  assertEquals((await mixed.keep(event(png(), png(), png(), png()), signal)).size, 2);
  assertEquals(mixedAsks, 4);
});

test("vision: every image not kept is said by the refs the agent may know it by, and why", async () => {
  const signal = new AbortController().signal;
  const unkept: Array<[string, string]> = [];
  const keeper = toolImageKeeper(
    () => Promise.resolve(null),
    noopDiagnostics,
    { now: () => 0 },
    (ref, reason) => unkept.push([ref, reason]),
  );
  const ref = await imageRefOf(PNG);
  const bmp = Uint8Array.from([0x42, 0x4d, 1, 2, 3]);
  const stale = "img-000000000000";
  await keeper.keep({
    type: "tool_execution_end",
    result: {
      content: [
        { type: "image", data: bmp.toBase64(), mimeType: "image/bmp" },
        // The line names what the extension saw; pi resized it after. Both are said.
        { type: "image", data: PNG_B64, mimeType: "image/png" },
        { type: "text", text: `${REF_LINE_PREFIX}${stale}` },
        { type: "image", data: PNG_B64, mimeType: "image/png" },
        // Two refusals in a row paused uploads: this one is not asked.
        { type: "image", data: PNG_B64, mimeType: "image/png" },
      ],
    },
  }, signal);
  assertEquals(unkept, [
    [await imageRefOf(bmp), "type"],
    [stale, "refused"],
    [ref, "refused"],
    [ref, "refused"],
    [ref, "paused"],
  ]);
});

test("vision: withoutImageData names a kept image by its ref and nothing else", () => {
  const block = { type: "image", data: "QUJD", mimeType: "image/png" };
  const other = { type: "image", data: "QUJDRA==", mimeType: "image/jpeg" };
  const kept = new Map([[block, { id: "att-1", mime: "image/png" as const }]]);
  assertEquals(withoutImageData({ result: { content: [block, other] } }, kept), {
    result: {
      content: [
        {
          type: "image",
          data: "[4 base64 chars omitted]",
          mimeType: "image/png",
          attachment: { id: "att-1", mime: "image/png" },
        },
        { type: "image", data: "[8 base64 chars omitted]", mimeType: "image/jpeg" },
      ],
    },
  });
});

test("vision: the upload door — run token, raw bytes, the ref back; a refusal is null, a byte-budget 409 skips one image, any other 409 ends uploads", async () => {
  const seen: Array<
    { path: string; ref?: string | null; auth: string | null; type: string | null; bytes: number }
  > = [];
  let answer: () => Response = () =>
    Response.json({ id: "att-9", mime: "image/png", bytes: PNG.length }, { status: 201 });
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      seen.push({
        path: new URL(req.url).pathname,
        ...(seen.length === 0 ? { ref: new URL(req.url).searchParams.get("ref") } : {}),
        auth: req.headers.get("authorization"),
        type: req.headers.get("content-type"),
        bytes: (await req.arrayBuffer()).byteLength,
      });
      return answer();
    },
  );
  const addr = server.addr;
  const warnings: string[] = [];
  try {
    const attachments = httpAttachments({
      baseUrl: `http://${addr.hostname}:${addr.port}`,
      runToken: "run-token",
      runId: "r-1",
      diag: { ...noopDiagnostics, warn: (e: string) => warnings.push(e) },
      retryPauseMs: 1,
    });
    assertEquals(await attachments.upload(PNG, "img-0123456789ab"), {
      id: "att-9",
      mime: "image/png",
    });
    assertEquals(seen[0], {
      path: "/v1/runs/r-1/runner/attachments",
      ref: "img-0123456789ab",
      auth: "Bearer run-token",
      type: "application/octet-stream",
      bytes: PNG.length,
    });
    // A 5xx is asked again, a bounded number of times, then null.
    answer = () => new Response("down", { status: 503 });
    assertEquals(await attachments.upload(PNG, "img-0123456789ab"), null);
    assertEquals(seen.length, 4);
    // A 429 is the door busy with the run's other uploads: retried, and taken once it frees.
    let busy = 2;
    answer = () =>
      busy-- > 0
        ? Response.json({ error: "too many uploads in flight" }, { status: 429 })
        : Response.json({ id: "att-busy", mime: "image/png", bytes: 1 }, { status: 201 });
    assertEquals(await attachments.upload(PNG, "img-0123456789ab"), {
      id: "att-busy",
      mime: "image/png",
    });
    assertEquals(seen.length, 7);
    // A 415 is final at once, and later uploads still go.
    answer = () => Response.json({ error: "not a supported image" }, { status: 415 });
    assertEquals(await attachments.upload(PNG, "img-0123456789ab"), null);
    assertEquals(seen.length, 8);
    // A 409 for the byte budget refuses that image alone: a smaller one may still fit.
    answer = () => Response.json({ error: "bytes" }, { status: 409 });
    assertEquals(await attachments.upload(PNG, "img-0123456789ab"), null);
    assertEquals(seen.length, 9);
    answer = () => Response.json({ id: "att-small", mime: "image/png" }, { status: 201 });
    assertEquals(await attachments.upload(PNG, "img-0123456789ab"), {
      id: "att-small",
      mime: "image/png",
    });
    assertEquals(seen.length, 10);
    // A 409 for the count, or the run over, is final for the run: nothing more is sent.
    answer = () => Response.json({ error: "cap" }, { status: 409 });
    assertEquals(await attachments.upload(PNG, "img-0123456789ab"), null);
    answer = () => Response.json({ id: "att-10", mime: "image/png" }, { status: 201 });
    assertEquals(await attachments.upload(PNG, "img-0123456789ab"), null);
    assertEquals(seen.length, 11);
    // A terminal run's 409 closes uploads the same.
    const ended = httpAttachments({
      baseUrl: `http://${addr.hostname}:${addr.port}`,
      runToken: "run-token",
      runId: "r-2",
      diag: noopDiagnostics,
      retryPauseMs: 1,
    });
    answer = () => Response.json({ error: "run is terminal (succeeded)" }, { status: 409 });
    assertEquals(await ended.upload(PNG, "img-0123456789ab"), null);
    answer = () => Response.json({ id: "att-11", mime: "image/png" }, { status: 201 });
    assertEquals(await ended.upload(PNG, "img-0123456789ab"), null);
    assertEquals(seen.length, 12);
    assert(warnings.includes("orchestrator.attachment.upload_refused"));
  } finally {
    await server.shutdown();
  }
});

// --- what a model that cannot see is given ----------------------------------------------------

/** pi's catalogue as pi 1.0.0 ships it: one file per provider, `{<api>: {"chat:<id>": model}}`. */
const CATALOGUE: Record<string, string> = {
  anthropic: JSON.stringify({
    "anthropic-messages": {
      "chat:claude-sonnet-4-5": { id: "claude-sonnet-4-5", type: "chat", input: ["text", "image"] },
    },
  }),
  openrouter: JSON.stringify({
    "openai-completions": {
      "chat:openai/gpt-4": { id: "openai/gpt-4", type: "chat", input: ["text"] },
      "chat:anthropic/claude-sonnet-4": {
        id: "anthropic/claude-sonnet-4",
        type: "chat",
        input: ["text", "image"],
      },
      "chat:deepseek/deepseek-r1:free": {
        id: "deepseek/deepseek-r1:free",
        type: "chat",
        input: ["text"],
      },
    },
  }),
  openai: JSON.stringify({
    "openai-responses": {
      "chat:gpt-4": { id: "gpt-4", type: "chat", input: ["text"] },
      "chat:gpt-4o": { id: "gpt-4o", type: "chat", input: ["text", "image"] },
    },
  }),
};
const ROOT = "/opt/test/node_modules";
/** Reads the catalogue as hoisted beside pi (the second place looked). */
const readCatalogue = (path: string) => {
  for (const [provider, text] of Object.entries(CATALOGUE)) {
    if (path === piCatalogueFiles(provider, ROOT)[1]) return Promise.resolve(text);
  }
  return Promise.reject(Object.assign(new Error(path), { code: "ENOENT" }));
};
const noEnv = () => undefined;

test("vision: a catalogue that cannot be read is said, once, and the model taken to see", async () => {
  const warned: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const diag = {
    warn: (event: string, fields?: Record<string, unknown>) => warned.push({ event, fields }),
  };
  const none = () => Promise.reject(Object.assign(new Error("moved"), { code: "ENOENT" }));
  for (const model of ["gpt-4", "gpt-4o"]) {
    assertEquals(
      await piModelSeesImages({ provider: "openai", model }, noEnv, none, ROOT, diag),
      true,
    );
  }
  assertEquals(warned.map((w) => w.event), ["pi.model_catalogue.unreadable"]);
  assertEquals(warned[0].fields?.files, piCatalogueFiles("openai", ROOT));
  // A catalogue that reads says nothing.
  const quiet: string[] = [];
  await piModelSeesImages({ provider: "openai", model: "gpt-4" }, noEnv, readCatalogue, ROOT, {
    warn: (e: string) => quiet.push(e),
  });
  assertEquals(quiet, []);
});

test("vision: a built-in model sees what pi's catalogue says it takes; anything unknown sees", async () => {
  const sees = (provider: string | undefined, model: string | undefined) =>
    piModelSeesImages({ provider, model }, noEnv, readCatalogue, ROOT);
  assertEquals(await sees("anthropic", "claude-sonnet-4-5"), true);
  assertEquals(await sees("openai", "gpt-4"), false);
  assertEquals(await sees("openai", "gpt-4o"), true);
  // The forms --model also takes: provider/id, and a thinking suffix.
  assertEquals(await sees("openai", "openai/gpt-4"), false);
  assertEquals(await sees("openai", "gpt-4:high"), false);
  // Every level is a suffix, the strongest two included.
  assertEquals(await sees("openai", "gpt-4:xhigh"), false);
  assertEquals(await sees("openai", "gpt-4:max"), false);
  // Not in the catalogue, no catalogue, no model, no provider: what every run assumed before.
  assertEquals(await sees("openai", "gpt-unknown"), true);
  assertEquals(await sees("mistral", "small"), true);
  assertEquals(await sees("anthropic", undefined), true);
  assertEquals(await sees(undefined, undefined), true);
  // A gateway's ids carry a slash of their own: only the run's own provider is a prefix, and
  // only a thinking level is a suffix.
  assertEquals(await sees("openrouter", "openai/gpt-4"), false);
  assertEquals(await sees("openrouter", "anthropic/claude-sonnet-4"), true);
  assertEquals(await sees("openrouter", "openrouter/openai/gpt-4"), false);
  assertEquals(await sees("openrouter", "openai/gpt-4:high"), false);
  assertEquals(await sees("openrouter", "deepseek/deepseek-r1:free"), false);
  // The nested copy is looked at first.
  const nested = (path: string) =>
    path === piCatalogueFiles("openai", ROOT)[0]
      ? Promise.resolve(CATALOGUE.openai)
      : Promise.reject(new Error("no"));
  assertEquals(
    await piModelSeesImages({ provider: "openai", model: "gpt-4" }, noEnv, nested, ROOT),
    false,
  );
});

test("vision: a custom endpoint's model sees only when the admin said so", async () => {
  const env = (models: unknown[]) => (name: string) =>
    name === "RYPH_MODEL_PROVIDER_CONFIG"
      ? JSON.stringify({ id: "cf", dialect: "openai-completions", models })
      : undefined;
  const models = [{ id: "llava", vision: true }, { id: "llama", vision: false }, { id: "mistral" }];
  const sees = (model: string) =>
    piModelSeesImages({ provider: "cf", model }, env(models), readCatalogue, ROOT);
  assertEquals(await sees("llava"), true);
  assertEquals(await sees("llama"), false);
  // Unset is text-only, as pi treats it; so is a model the endpoint does not list.
  assertEquals(await sees("mistral"), false);
  assertEquals(await sees("other"), false);
  assertEquals(
    await piModelSeesImages(
      { provider: "cf", model: "x" },
      (n) => n === "RYPH_MODEL_PROVIDER_CONFIG" ? "{not json" : undefined,
      readCatalogue,
      ROOT,
    ),
    false,
  );
});

function introspectCommand(): string[] {
  return [
    process.execPath,
    "--no-env-file",
    FAKE_PI,
    "--scenario=introspect",
  ];
}

test("vision: a text-only model's pi gets the env var, and its browser block says it works from snapshots", async () => {
  const { input, cleanup } = await makeInput();
  const { io: harnessIo } = io();
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  runtimeCredentials.set("RYPH_BROWSER_TOKEN", "browser-token-1");
  const tools: HarnessTools = {
    servers: [],
    tokenEnv: "RYPH_MCP_TOKEN",
    loopback: { url: "http://127.0.0.1:7480/mcp", tokenEnv: "RYPH_LOOPBACK_TOKEN" },
    browser: { url: "http://127.0.0.1:7490/mcp", tokenEnv: "RYPH_BROWSER_TOKEN" },
  };
  type Seen = { brandVars: string[]; appendix: string };
  const spawn = async (modelSeesImages?: boolean): Promise<Seen> =>
    JSON.parse(
      (await piHarness({ kind: "pi" }, {
        command: introspectCommand(),
        ...(modelSeesImages === undefined ? {} : { modelSeesImages }),
      }).run({ ...input, tools, browser: "ready" }, harnessIo)).summary,
    );
  try {
    const blind = await spawn(false);
    assertEquals(blind.brandVars, [TEXT_ONLY_HARNESS_ENV]);
    assertStringIncludes(blind.appendix, "## Your browser");
    assertStringIncludes(blind.appendix, BROWSER_TEXT_ONLY_INSTRUCTION);
    assert(!blind.appendix.includes("browser__screenshot"), "no screenshot tool to point at");

    for (const seeing of [await spawn(true), await spawn()]) {
      assertEquals(seeing.brandVars, []);
      assertStringIncludes(seeing.appendix, "browser__screenshot");
      assert(!seeing.appendix.includes(BROWSER_TEXT_ONLY_INSTRUCTION));
    }
  } finally {
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    runtimeCredentials.delete("RYPH_BROWSER_TOKEN");
    await cleanup();
  }
});

test("vision: a text-only model's prompt images go as files, never inline", async () => {
  const { input, cleanup } = await makeInput();
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  const { io: harnessIo } = io();
  try {
    await writeFile(`${dir}/1.png`, PNG);
    const image = { path: `${dir}/1.png`, mime: "image/png", bytes: PNG.length, dimensions: null };
    const taskImages = { images: [image], attached: "ATTACHED task", saved: "SAVED task" };
    const spawn = async (modelSeesImages: boolean) =>
      JSON.parse(
        (await piHarness({ kind: "pi" }, { command: introspectCommand(), modelSeesImages })
          .run({ ...input, taskImages }, harnessIo)).summary,
      ) as { images: unknown[]; prompt: string };
    const blind = await spawn(false);
    assertEquals(blind.images, []);
    assertStringIncludes(blind.prompt, "SAVED task");
    const seeing = await spawn(true);
    assertEquals(seeing.images.length, 1);
    assertStringIncludes(seeing.prompt, "ATTACHED task");
  } finally {
    await rm(dir, { recursive: true });
    await cleanup();
  }
});

test("vision: the ref check asks the control plane, and throws when it cannot be asked", async () => {
  const asked: unknown[] = [];
  let status = 200;
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      asked.push({ path: new URL(req.url).pathname, body: await req.json() });
      return status === 200
        ? Response.json({
          images: [{
            ref: "img-0123456789ab",
            attachmentId: "att-1",
            mime: "image/png",
            url: null,
          }],
          unknown: ["img-ba9876543210"],
        })
        : Response.json({ error: "no" }, { status });
    },
  );
  const addr = server.addr;
  try {
    const attachments = httpAttachments({
      baseUrl: `http://${addr.hostname}:${addr.port}`,
      runToken: "run-token",
      runId: "r-1",
      diag: noopDiagnostics,
      retryPauseMs: 1,
    });
    const refs = ["img-0123456789ab", "img-ba9876543210"];
    assertEquals(await attachments.resolveImageRefs(refs), {
      known: ["img-0123456789ab"],
      unknown: ["img-ba9876543210"],
    });
    assertEquals(asked, [{ path: "/v1/runs/r-1/runner/images/resolve", body: { refs } }]);
    status = 400;
    let threw = false;
    await attachments.resolveImageRefs(refs).catch(() => threw = true);
    assert(threw);
  } finally {
    await server.shutdown();
  }
});
