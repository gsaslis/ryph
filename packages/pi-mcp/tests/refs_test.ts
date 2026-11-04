// The images extension's refs: the line that names each image a tool returned, what it is a hash
// of, where it goes, and that it outlives the image in a request. Pure functions over pi-shaped
// content, plus a fake pi for the two hooks. The real pi 1.0.0 was driven end to end once (a
// read and a tool whose image pi resizes after the hook); what it showed is pinned here as the
// shapes the hooks see.

import { test } from "bun:test";
import { assert, assertEquals, assertMatch, assertStrictEquals } from "@std/assert";
import {
  imageRef,
  LEFT_OUT,
  limitImages,
  makeImagesExtension,
  type PiImagesApi,
  type PiMessage,
  REF_LINE_PREFIX,
  withImageRefs,
  withoutImages,
} from "../images.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const image = (s: string) => ({ type: "image", data: bytes(s).toBase64(), mimeType: "image/png" });
const text = (t: string) => ({ type: "text", text: t });
const refLine = (s: string) => text(REF_LINE_PREFIX + imageRef(bytes(s).toBase64()));

async function sha12(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(s)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

test("refs: a ref is img- and 12 hex of the SHA-256 of the decoded bytes", async () => {
  assertEquals(imageRef(bytes("pixels").toBase64()), `img-${await sha12("pixels")}`);
  // The same bytes spelled with a line break in the base64 are the same image.
  const b64 = bytes("a longer run of pixels, past one base64 line").toBase64();
  assertEquals(imageRef(b64.slice(0, 20) + "\n" + b64.slice(20)), imageRef(b64));
  assertMatch(imageRef(b64), /^img-[0-9a-f]{12}$/);
});

test("refs: each image gets its line right after it, text untouched", () => {
  const content = [text("Read image file [image/png]"), image("a"), text("between"), image("b")];
  assertEquals(withImageRefs(content), [
    text("Read image file [image/png]"),
    image("a"),
    refLine("a"),
    text("between"),
    image("b"),
    refLine("b"),
  ]);
  // Twice is once: content that already has its lines comes back as is.
  const once = withImageRefs(content);
  assertStrictEquals(withImageRefs(once), once);
  // No image, no change.
  const plain = [text("ok")];
  assertStrictEquals(withImageRefs(plain), plain);
});

test("refs: a line naming other bytes is corrected where it stands", () => {
  // What pi 1.0.0 stores after resizing an image the hook already named: the new bytes, pi's
  // dimension note right after them, then the hook's line, which names the old bytes.
  const note = text("[Image: original 2400x100, displayed at 2000x83. Multiply coordinates...]");
  const stale = [image("resized"), note, refLine("original")];
  assertEquals(withImageRefs(stale), [image("resized"), note, refLine("resized")]);
});

test("refs: a ref line outlives its image in a request", () => {
  const tool: PiMessage = {
    role: "toolResult",
    toolName: "browser__screenshot",
    content: withImageRefs([image("old")]),
  };
  const newer: PiMessage = { ...tool, content: withImageRefs([image("new")]) };
  const cut = limitImages([tool, newer], { count: 1, chars: 1_000 });
  assertEquals(cut[0].content, [text(LEFT_OUT.tool), refLine("old")]);
  assertEquals(withoutImages([tool])[0].content, [text(LEFT_OUT.textOnly), refLine("old")]);
});

/** The handlers the extension registers, by event. */
function hooks() {
  const handlers = new Map<string, (event: never) => unknown>();
  const pi: PiImagesApi = {
    on: (event: string, h: unknown) => {
      handlers.set(event, h as (event: never) => unknown);
    },
  };
  makeImagesExtension({ note: () => {} })(pi);
  return {
    toolResult: handlers.get("tool_result") as (e: {
      toolName: string;
      content: unknown[];
      structuredContent?: unknown;
    }) => { content: unknown[]; structuredContent?: unknown } | undefined,
    messageEnd: handlers.get("message_end") as (
      e: { message: PiMessage },
    ) => { message: PiMessage } | undefined,
  };
}

test("refs: tool_result adds the lines and hands structured content back", () => {
  const { toolResult } = hooks();
  assertEquals(toolResult({ toolName: "read", content: [text("plain")] }), undefined);
  const out = toolResult({
    toolName: "figma__render",
    content: [image("x")],
    structuredContent: { frames: 1 },
  });
  assertEquals(out, { content: [image("x"), refLine("x")], structuredContent: { frames: 1 } });
  assert(!("structuredContent" in toolResult({ toolName: "read", content: [image("x")] })!));
});

test("refs: message_end corrects a tool result as stored, and nothing else", () => {
  const { messageEnd } = hooks();
  const stored: PiMessage = {
    role: "toolResult",
    toolName: "figma__render",
    toolCallId: "c1",
    content: [image("resized"), refLine("original")],
    isError: false,
  };
  assertEquals(messageEnd({ message: stored }), {
    message: { ...stored, content: [image("resized"), refLine("resized")] },
  });
  // Already right: no replacement.
  assertEquals(
    messageEnd({ message: { ...stored, content: [image("a"), refLine("a")] } }),
    undefined,
  );
  // A prompt's images are the runner's to name, not a tool's: left alone.
  assertEquals(messageEnd({ message: { role: "user", content: [image("a")] } }), undefined);
});
