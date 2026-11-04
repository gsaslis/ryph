// The images extension's request filter: what one request may carry, which images give way, and
// that pi's history is never edited. Pure functions over pi-shaped messages, plus a fake pi for
// the registration and the ready line the runner's pi adapter looks for.

import { test } from "bun:test";
import { assert, assertEquals, assertStrictEquals, assertStringIncludes } from "@std/assert";
import {
  IMAGE_BUDGET,
  IMAGE_MAX_CHARS,
  LEFT_OUT,
  limitImages,
  makeImagesExtension,
  type PiImagesApi,
  type PiMessage,
  TEXT_ONLY_ENV,
  withoutImages,
} from "../images.ts";

const image = (chars: number, tag = "x") => ({
  type: "image",
  data: (tag + "x".repeat(chars)).slice(0, chars),
  mimeType: "image/png",
});
const user = (...content: unknown[]): PiMessage => ({ role: "user", content, timestamp: 1 });
const read = (...content: unknown[]): PiMessage => ({
  role: "toolResult",
  toolName: "read",
  toolCallId: "t1",
  content,
  isError: false,
});
const assistant: PiMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] };

/** Every image of a request, newest last, as the provider would count them. */
const imagesOf = (messages: PiMessage[]) =>
  messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((b: { type?: string }) => b.type === "image") as { data: string }[]
      : []
  );
const totals = (messages: PiMessage[]) => {
  const images = imagesOf(messages);
  return { count: images.length, chars: images.reduce((s, i) => s + i.data.length, 0) };
};

test("images: a conversation within the budget is returned as is", () => {
  const messages = [user({ type: "text", text: "hi" }, image(10)), assistant, read(image(10))];
  assertStrictEquals(limitImages(messages, { count: 2, chars: 20 }), messages);
});

test("images: the newest images are kept and older ones give way to a line", () => {
  const messages = [
    user({ type: "text", text: "look" }, image(10, "a"), image(10, "b")),
    assistant,
    read({ type: "text", text: "Read image file" }, image(10, "c")),
    assistant,
    read(image(10, "d")),
  ];
  const out = limitImages(messages, { count: 2, chars: 1_000 });
  assertEquals(totals(out).count, 2);
  // d and c stay; both of the message's images are replaced in place, text untouched.
  assertEquals(out[4].content, [image(10, "d")]);
  assertEquals(out[2].content, [{ type: "text", text: "Read image file" }, image(10, "c")]);
  assertEquals(out[0].content, [
    { type: "text", text: "look" },
    { type: "text", text: LEFT_OUT.message },
    { type: "text", text: LEFT_OUT.message },
  ]);
  // Messages it did not change are the same objects.
  assertStrictEquals(out[1], messages[1]);
  assertStrictEquals(out[4], messages[4]);
});

test("images: the character budget binds as well as the count", () => {
  const messages = [read(image(60, "a")), read(image(60, "b")), read(image(60, "c"))];
  const out = limitImages(messages, { count: 20, chars: 130 });
  // All three are 180: the cut falls on c, the first image to start past half the budget (65).
  assertEquals(totals(out), { count: 1, chars: 60 });
  assertEquals(out[0].content, [{ type: "text", text: LEFT_OUT.read }]);
  assertEquals(out[1].content, [{ type: "text", text: LEFT_OUT.read }]);
});

test("images: once one is left out every older one is too, even one that would fit", () => {
  const messages = [read(image(1, "small")), read(image(100, "big")), read(image(50, "new"))];
  const out = limitImages(messages, { count: 20, chars: 120 });
  assertEquals(imagesOf(out).map((i) => i.data[0]), ["n"]);
});

test("images: the line says how to see the image again, by where it sat", () => {
  const mcp: PiMessage = { role: "toolResult", toolName: "figma__render", content: [image(5)] };
  const out = limitImages([user(image(5)), read(image(5)), mcp, read(image(5))], {
    count: 1,
    chars: 100,
  });
  assertEquals(out[0].content, [{ type: "text", text: LEFT_OUT.message }]);
  assertEquals(out[1].content, [{ type: "text", text: LEFT_OUT.read }]);
  assertEquals(out[2].content, [{ type: "text", text: LEFT_OUT.tool }]);
});

test("images: an image over the per-image limit never goes, and does not move the line", () => {
  const messages = [read(image(10, "old")), read(image(IMAGE_MAX_CHARS + 1, "huge"))];
  const out = limitImages(messages, { count: 20, chars: IMAGE_MAX_CHARS * 4 });
  assertEquals(out[1].content, [{ type: "text", text: LEFT_OUT.tooLarge }]);
  assertEquals(out[0].content, messages[0].content);
});

test("images: pi's history is never edited", () => {
  const messages = [user(image(10)), read(image(10))];
  const before = structuredClone(messages);
  limitImages(messages, { count: 1, chars: 100 });
  assertEquals(messages, before);
});

test("images: messages without image content are skipped, string content included", () => {
  const messages: PiMessage[] = [
    { role: "user", content: "plain" },
    { role: "bashExecution", command: "ls", output: "" },
    assistant,
  ];
  assertStrictEquals(limitImages(messages, { count: 0, chars: 0 }), messages);
});

test("images: the measured failures stay within Anthropic's limits", () => {
  // The run that died with a 413: four 2.57 MB task images, then ten more read one by one.
  const big = 2_571_644;
  const run: PiMessage[] = [user({ type: "text", text: "task" }, ...Array(4).fill(image(big)))];
  for (let i = 0; i < 10; i++) run.push(assistant, read(image(big)));
  const a = totals(limitImages(run));
  assert(a.chars <= IMAGE_BUDGET.chars && a.count <= IMAGE_BUDGET.count, JSON.stringify(a));
  // Images 11 to 14: 10 is the boundary of the fourth 8 MiB (and of the second ten images).
  assertEquals(a.count, 4);
  // The run that died at the 100-image cap: 101 small images read. The cut is at the 91st.
  const many: PiMessage[] = [];
  for (let i = 0; i < 101; i++) many.push(assistant, read(image(200)));
  assertEquals(totals(limitImages(many)).count, 11);
});

test("images: the extension registers a context handler and says it is ready", () => {
  let handler: ((e: { messages: PiMessage[] }) => { messages: PiMessage[] } | undefined) | null =
    null;
  const notes: string[] = [];
  const pi: PiImagesApi = {
    on: (event: string, h: unknown) => {
      if (event === "context") handler = h as typeof handler;
    },
  };
  makeImagesExtension({ budget: { count: 1, chars: 100 }, note: (m) => notes.push(m) })(pi);
  assertEquals(notes.length, 1);
  assertStringIncludes(notes[0], "ready");
  assert(handler !== null);
  const h = handler as (e: { messages: PiMessage[] }) => { messages: PiMessage[] } | undefined;
  // Nothing to change: no result, so pi keeps its own list.
  assertEquals(h({ messages: [read(image(5))] }), undefined);
  const result = h({ messages: [read(image(5)), read(image(5))] });
  assertEquals(totals(result!.messages).count, 1);
});

// The prompt cache: Anthropic reuses a request's prefix only while it is unchanged, so each
// request should be the one before it plus what is new, except when the cut moves, and the cut
// should move only at a boundary. Images arrive one read at a time, as a run that reads them
// does; every request is checked against the provider's limits as well.
test("images: images added one at a time move the cut only at block boundaries", () => {
  const MiB = 1024 * 1024;
  // One string per size, shared, so a hundred images of megabytes cost nothing to build.
  const strings = new Map<number, string>();
  const data = (chars: number) => {
    let s = strings.get(chars);
    if (s === undefined) strings.set(chars, s = "x".repeat(chars));
    return s;
  };
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const scenarios: Record<string, (n: number) => number> = {
    small: () => 200_000,
    screenshots: () => Math.round(1.2 * MiB),
    large: () => 3 * MiB,
    largest: () => 4.5 * MiB,
    // Anything from 50 kB to the per-image limit, and now and then one over it.
    mixed: (n) => n % 17 === 0 ? IMAGE_MAX_CHARS + 1 : 50_000 + Math.floor(random() * 4.45 * MiB),
  };
  // Request fingerprint: everything but the image bytes, which are named by `name` instead.
  const print = (messages: PiMessage[]) =>
    messages.map((m) => JSON.stringify(m, (k, v) => k === "data" ? v.length : v));
  for (const [scenario, size] of Object.entries(scenarios)) {
    const history: PiMessage[] = [user({ type: "text", text: "task" })];
    const sendable: { name: string; chars: number }[] = [];
    let previous: { print: string[]; first: string | undefined } | null = null;
    const moves: number[] = [];
    let over = 0;
    for (let n = 1; n <= 120; n++) {
      const chars = size(n);
      history.push(
        { role: "assistant", content: [{ type: "toolCall", id: `c${n}`, name: "read" }] },
        { ...read({ type: "image", data: data(chars), mimeType: "image/png", name: `i${n}` }) },
      );
      if (chars <= IMAGE_MAX_CHARS) sendable.push({ name: `i${n}`, chars });
      const out = limitImages(history);
      const kept = imagesOf(out) as unknown as { name: string; data: string }[];
      const sum = kept.reduce((s, i) => s + i.data.length, 0);
      const at = `${scenario} image ${n}`;
      assert(kept.length <= IMAGE_BUDGET.count, `${at}: ${kept.length} images`);
      assert(sum <= IMAGE_BUDGET.chars, `${at}: ${sum} chars`);
      assert(kept.every((i) => i.data.length <= IMAGE_MAX_CHARS), `${at}: an image over the limit`);
      assert(kept.length > 0, `${at}: nothing kept`);
      // The newest sendable images, in order, and nothing else.
      assertEquals(kept.map((i) => i.name), sendable.slice(-kept.length).map((i) => i.name), at);
      if (kept.length < sendable.length) over++;
      const now = { print: print(out), first: kept[0]?.name };
      if (previous !== null && previous.first !== now.first) {
        moves.push(n);
        // A boundary, recomputed here: every tenth sendable image, or the first to start in the
        // next 8 MiB.
        const c = sendable.findIndex((i) => i.name === now.first);
        const before = sendable.slice(0, c).reduce((s, i) => s + i.chars, 0);
        const half = IMAGE_BUDGET.chars / 2;
        assert(
          c % 10 === 0 ||
            Math.floor(before / half) > Math.floor((before - sendable[c - 1].chars) / half),
          `${at}: cut at ${c} is not a boundary`,
        );
      } else if (previous !== null) {
        // The cut stayed: the previous request is exactly the start of this one.
        assertEquals(now.print.slice(0, previous.print.length), previous.print, at);
      }
      previous = now;
    }
    // Small images move it every ten, plus where one starts the next 8 MiB (the 42nd, 84th, ...
    // here): the 63rd image is the first to fit from the 42nd on, the 105th from the 84th on.
    if (scenario === "small") {
      assertEquals(moves, [21, 31, 41, 51, 61, 63, 71, 81, 91, 101, 105, 111]);
    }
    // Cutting at exactly what fits moved it on every image past the budget. Boundaries move it a
    // third less often at least (half the budget is under two of the largest images, so those still
    // move it every other image or so: 71 times here, against 117 before).
    assert(
      moves.length * 1.5 <= over,
      `${scenario}: the cut moved ${moves.length} times in ${over} requests over the budget`,
    );
  }
});

// The runner sends a prompt's images inline only when they fit one request together, beside a
// note saying they are attached: a boundary inside them must not split them.
test("images: the newest message's images that fit together are all kept", () => {
  const MiB = 1024 * 1024;
  // Five read images, then a prompt of twenty: count boundaries at 10 and 20 fall inside it.
  const many: PiMessage[] = [];
  for (let i = 0; i < 5; i++) many.push(assistant, read(image(200, "o")));
  many.push(user({ type: "text", text: "look" }, ...Array(20).fill(image(200, "n"))));
  assertEquals(imagesOf(limitImages(many)).map((i) => i.data[0]).join(""), "n".repeat(20));
  // Four screenshots read, then a prompt of five large ones (15 MiB): an 8 MiB boundary falls
  // inside it.
  const large: PiMessage[] = [];
  for (let i = 0; i < 4; i++) large.push(assistant, read(image(MiB, "o")));
  large.push(user({ type: "text", text: "look" }, ...Array(5).fill(image(3 * MiB, "n"))));
  assertEquals(imagesOf(limitImages(large)).map((i) => i.data[0]).join(""), "nnnnn");
  // The next image read moves the cut to a boundary again, and the limits hold.
  large.push(assistant, read(image(MiB, "r")));
  const after = totals(limitImages(large));
  assert(after.count <= IMAGE_BUDGET.count && after.chars <= IMAGE_BUDGET.chars);
});

test("images: a text-only model gets no image at all, each a line saying why", () => {
  const tool: PiMessage = {
    role: "toolResult",
    toolName: "browser__screenshot",
    toolCallId: "t2",
    content: [{ type: "text", text: "shot" }, image(5)],
    isError: false,
  };
  const messages = [
    user({ type: "text", text: "see" }, image(5), image(5)),
    assistant,
    read(image(5)),
    tool,
  ];
  const out = withoutImages(messages);
  assertEquals(imagesOf(out).length, 0);
  // Every image is its own line, in place; text and the other messages are untouched.
  assertEquals(out[0].content, [
    { type: "text", text: "see" },
    { type: "text", text: LEFT_OUT.textOnly },
    { type: "text", text: LEFT_OUT.textOnly },
  ]);
  assertStrictEquals(out[1], assistant);
  assertEquals(out[3].content, [{ type: "text", text: "shot" }, {
    type: "text",
    text: LEFT_OUT.textOnly,
  }]);
  // pi's history is never edited, and nothing to change is no change.
  assertEquals(imagesOf(messages).length, 4);
  const plain = [assistant];
  assertStrictEquals(withoutImages(plain), plain);
});

test("images: the extension goes text-only when the runner's env says so, and says it", () => {
  const run = (opts: Parameters<typeof makeImagesExtension>[0]) => {
    let handler: ((e: { messages: PiMessage[] }) => { messages: PiMessage[] } | undefined) | null =
      null;
    const notes: string[] = [];
    makeImagesExtension({ ...opts, note: (m) => notes.push(m) })({
      on: (event: string, h: unknown) => {
        if (event === "context") handler = h as typeof handler;
      },
    });
    const h = handler as unknown as (
      e: { messages: PiMessage[] },
    ) => { messages: PiMessage[] } | undefined;
    return { notes, out: h({ messages: [read(image(5))] }) };
  };
  // Within budget: a seeing model's request is left alone, a blind one's loses the image.
  assertEquals(run({ textOnly: false }).out, undefined);
  const blind = run({ textOnly: true });
  assertEquals(imagesOf(blind.out!.messages).length, 0);
  assertStringIncludes(blind.notes[0], "ready");
  assertStringIncludes(blind.notes[0], "text-only");

  // The default is read from the env var the runner sets.
  assertEquals(TEXT_ONLY_ENV, "RYPH_MODEL_TEXT_ONLY");
  const before = process.env[TEXT_ONLY_ENV];
  try {
    process.env[TEXT_ONLY_ENV] = "1";
    assertEquals(imagesOf(run({}).out!.messages).length, 0);
    process.env[TEXT_ONLY_ENV] = "0";
    assertEquals(run({}).out, undefined);
  } finally {
    if (before === undefined) delete process.env[TEXT_ONLY_ENV];
    else process.env[TEXT_ONLY_ENV] = before;
  }
});
