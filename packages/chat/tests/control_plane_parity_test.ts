// What the chat service restates from the control plane, held to the control plane's own code:
// the marker's form, the image sniff and the caps (core/types.ts, core/images.ts). The chat
// package imports nothing of @ryph/orchestrator on purpose — it deploys separately — so a drift
// between the two would otherwise only show as a mention refused at the door, or an image the
// agent is told about in the wrong place. Tests sit outside the architecture guard, so the
// import across packages is a test's, never the service's (as packages/runner/tests/skills_test.ts).

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  imageMarker as controlPlaneMarker,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  neutraliseMarkers as controlPlaneNeutralise,
  sniffImage as controlPlaneSniff,
} from "../../orchestrator/src/core/attachments.ts";
import { MAX_MESSAGE_CHARS } from "../../orchestrator/src/core/types.ts";
import { neutralizeMarkers, sniffImage } from "../src/core/images.ts";
import {
  imageMarker,
  MAX_MENTION_IMAGE_BYTES,
  MAX_MENTION_IMAGES,
  MAX_MENTION_TEXT_CHARS,
} from "../src/core/types.ts";

test("the caps are the control plane's", () => {
  assertEquals(MAX_MENTION_IMAGE_BYTES, MAX_ATTACHMENT_BYTES);
  assertEquals(MAX_MENTION_IMAGES, MAX_ATTACHMENTS);
  assertEquals(MAX_MENTION_TEXT_CHARS, MAX_MESSAGE_CHARS);
});

test("the marker is the control plane's, and a neutralized one is never it", () => {
  for (const n of [1, 2, 9, 10, 11, 100]) {
    assertEquals(imageMarker(n), controlPlaneMarker(n));
    const typed = neutralizeMarkers(controlPlaneMarker(n));
    assertEquals(typed.length, controlPlaneMarker(n).length);
    for (let k = 1; k <= 100; k++) assertEquals(typed.includes(controlPlaneMarker(k)), false);
  }
});

test("a typed marker is neutralized exactly as the control plane neutralises one", () => {
  const samples = [
    "[image 2]",
    "[IMAGE 2] and [ image  10 ]",
    "\uFF3Bimage 2\uFF3D fullwidth",
    "[image 2\uFF3D mixed \uFF3Bimage 3]",
    "[image not attached: larger than 5 MiB]",
    "\uFF3Bimage not attached (x.png): it could not be downloaded]",
    "[images of the bug] [imagery] [image] [image 2",
    "nested [[image 1]] and ([image 1])",
    "ordinary [link](https://example.com) text",
    "",
  ];
  for (const text of samples) {
    const ours = neutralizeMarkers(text);
    assertEquals(ours, controlPlaneNeutralise(text), JSON.stringify(text));
    assert(ours.length <= text.length, "never longer, so a cut measured before still holds");
    assert(!/\[image \d+\]|\[image not attached/.test(ours), JSON.stringify(ours));
  }
});

test("the sniff is the control plane's, byte for byte", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const cases: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]),
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    new Uint8Array([0xff, 0xd8]),
    enc("GIF87a.."),
    enc("GIF89a.."),
    enc("GIF88a.."),
    new Uint8Array([...enc("RIFF"), 1, 2, 3, 4, ...enc("WEBPVP8 ")]),
    new Uint8Array([...enc("RIFF"), 1, 2, 3, 4, ...enc("WAVE")]),
    enc('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    enc("%PDF-1.7"),
    new Uint8Array(),
  ];
  for (const bytes of cases) assertEquals(sniffImage(bytes), controlPlaneSniff(bytes));
});
