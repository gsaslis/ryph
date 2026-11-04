// The runner's check of the image refs a summary or a patch description shows
// (core/image_refs.ts): what it reads as a ref, that it waits on the run's own uploads before it
// asks, and that its words and limits are the control plane's.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkImageRefs,
  imageRefsIn,
  MAX_IMAGE_REFS,
  tooManyRefsError,
  type UnkeptReason,
  unkeptRefError,
  unknownRefsError,
} from "../src/core/image_refs.ts";
import * as control from "../../orchestrator/src/core/image_refs.ts";

const A = "img-0123456789ab";
const B = "img-ba9876543210";

test("image refs: the syntax, the limit and the words are the control plane's", () => {
  const text = `![a](${A}) ![](${B}) ![again](${A}) [not](${A}) ![x](https://x/${B}.png) ` +
    `![the [old] page]( <${B}> ) ![up](IMG-0123456789AB)`;
  assertEquals(imageRefsIn(text), control.imageRefsIn(text).map((r) => r.ref));
  assertEquals(MAX_IMAGE_REFS, control.MAX_IMAGE_REFS);
  assertEquals(unknownRefsError([A, B]), control.unknownRefsError([A, B]));
  assertEquals(tooManyRefsError(12), control.tooManyRefsError(12));
});

test("image refs: a text naming none asks nothing", async () => {
  const never = { resolveImageRefs: () => Promise.reject(new Error("asked")) };
  assertEquals(await checkImageRefs("plain text, ![x](https://x/y.png)", never, []), null);
});

test("image refs: the run's own uploads are waited on before the control plane is asked", async () => {
  const order: string[] = [];
  let release = () => {};
  const upload = new Promise<void>((resolve) => release = resolve).then(() => {
    order.push("uploaded");
  });
  const attachments = {
    resolveImageRefs: (refs: readonly string[]) => {
      order.push("asked");
      return Promise.resolve({ known: [A], unknown: refs.filter((r) => r !== A) });
    },
  };
  const checked = checkImageRefs(`![shot](${A})`, attachments, [upload]);
  setTimeout(release, 50);
  assertEquals(await checked, null);
  assertEquals(order, ["uploaded", "asked"]);
  // An unknown ref is refused by name; one that never uploads is waited on only so long.
  const stuck = new Promise(() => {});
  assertEquals(
    await checkImageRefs(`![shot](${A}) ![other](${B})`, attachments, [stuck], new Map(), 20),
    unknownRefsError([B]),
  );
});

test("image refs: too many, no keeping, or no answer each say so", async () => {
  const many = Array.from({ length: 11 }, (_, i) => `![${i}](img-${String(i).padStart(12, "0")})`)
    .join(" ");
  const ok = { resolveImageRefs: () => Promise.resolve({ known: [], unknown: [] }) };
  assertEquals(await checkImageRefs(many, ok, []), tooManyRefsError(11));
  assertStringIncludes((await checkImageRefs(`![a](${A})`, undefined, []))!, "keeps no images");
  const down = {
    resolveImageRefs: () => Promise.reject(new Error("the orchestrator answered 503")),
  };
  assertStringIncludes(
    (await checkImageRefs(`![a](${A})`, down, []))!,
    "could not be checked just now (the orchestrator answered 503)",
  );
});

test("image refs: an image the runner did not keep is refused for what happened to it", async () => {
  const C = "img-cccccccccccc";
  const none = {
    resolveImageRefs: (refs: readonly string[]) =>
      Promise.resolve({ known: [], unknown: [...refs] }),
  };
  const unkept = new Map<string, UnkeptReason>([[A, "paused"], [B, "too-large"]]);
  const why = await checkImageRefs(`![a](${A}) ![b](${B}) ![c](${C})`, none, [], unkept);
  assertEquals(
    why,
    `${unkeptRefError(A, "paused")} ${unkeptRefError(B, "too-large")} ${unknownRefsError([C])}`,
  );
  assertStringIncludes(why!, `The image ${A} was not saved: saving images was paused`);
  assertStringIncludes(why!, "Take it again");
  assertStringIncludes(why!, `The image ${B} was not saved: it is larger than 5 MiB`);
  // One the control plane knows is fine, whatever the runner once failed to keep under its ref.
  const known = { resolveImageRefs: () => Promise.resolve({ known: [A], unknown: [] }) };
  assertEquals(await checkImageRefs(`![a](${A})`, known, [], unkept), null);
});
