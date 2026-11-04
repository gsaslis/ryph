// The image-ref syntax and links, as pure functions (core/image_refs.ts); the doors that use
// them are exercised in attachments_test.ts.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  bodyToSend,
  imageRefsIn,
  imageUrlOf,
  MAX_IMAGE_REFS,
  summaryToSend,
  tooManyRefsError,
  unknownRefsError,
} from "../src/core/image_refs.ts";

const A = "img-0123456789ab";
const B = "img-ba9876543210";

test("image refs: only ![alt](img-…) names one, once per ref, alt trimmed", () => {
  const text = `see ![ the page ](${A}) and ![](${B}), again ![other](${A}); ` +
    `not ![x](https://example.com/${A}.png), not [link](${A}), not ![x](img-0123)`;
  assertEquals(imageRefsIn(text), [{ ref: A, alt: "the page" }, { ref: B, alt: "" }]);
  assertEquals(imageRefsIn("no images"), []);
});

test("image refs: the app link and the errors the agent reads", () => {
  assertEquals(
    imageUrlOf("https://app.test/", "r-1", "att-1"),
    "https://app.test/images/r-1/att-1",
  );
  assertEquals(imageUrlOf(null, "r-1", "att-1"), null);
  assertStringIncludes(unknownRefsError([A]), `No image this run kept has the ref ${A}.`);
  assertStringIncludes(unknownRefsError([A]), "could not be saved was not kept");
  assertStringIncludes(unknownRefsError([A, B]), `${A}, ${B}`);
  assertStringIncludes(tooManyRefsError(11), `at most ${MAX_IMAGE_REFS}`);
});

test("image refs: a summary sent on keeps only the refs its result holds", () => {
  const summary = `Done. ![the [old] page](${A}) and ![a guess](${B}) and ![](${B})`;
  const images = [{ ref: A, attachmentId: "att-1", mime: "image/png" as const, alt: "x" }];
  assertEquals(
    summaryToSend({ status: "success", branches: [], summary, images }),
    `Done. ![the [old] page](${A}) and a guess and Image`,
  );
  assertEquals(
    summaryToSend({ status: "failure", reason: "r", branches: [], summary }),
    "Done. the [old] page and a guess and Image",
  );
  assertEquals(
    summaryToSend({ status: "error", reason: "r", during: "running", branches: [] }),
    "",
  );
  assertEquals(summaryToSend(null), "");
});

test("image refs: a summary beside a description keeps only what fits the body's limit", () => {
  const ref = (n: number) => `img-${n.toString(16).padStart(12, "0")}`;
  const images = [1, 2, 3].map((n) => ({
    ref: ref(n),
    attachmentId: `att-${n}`,
    mime: "image/png" as const,
    alt: "",
  }));
  const summary = `![one](${ref(1)}) ![two](${ref(2)}) ![three](${ref(3)})`;
  // Nine in the description, ref 1 among them: ref 1 is no new image, ref 2 is the tenth, and
  // ref 3 would be the eleventh.
  const description = [1, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `![](${ref(n)})`).join(" ");
  assertEquals(
    summaryToSend({ status: "success", branches: [], summary, images }, description),
    `![one](${ref(1)}) ![two](${ref(2)}) three`,
  );
});

test("image refs: a body sent on keeps only the refs its meant parts name", () => {
  const meant = "![shot](img-aaaaaaaaaaaa)";
  const body = `Did it. ${meant}\n\n- \`abc\` fix ![the [old] page](img-000000000000)\n` +
    "- `def` ![](img-bbbbbbbbbbbb) and ![shot](img-aaaaaaaaaaaa) again";
  assertEquals(
    bodyToSend(body, meant),
    `Did it. ${meant}\n\n- \`abc\` fix the [old] page\n` +
      "- `def` Image and ![shot](img-aaaaaaaaaaaa) again",
  );
});

test("image refs: an alt read in place never closes a new ref with the text around it", () => {
  const subject = "fix !![[x]](img-000000000000)(img-ffffffffffff)";
  const out = bodyToSend(subject, "");
  assertEquals(imageRefsIn(out), []);
  assertEquals(
    summaryToSend({ status: "success", branches: [], summary: subject, images: [] }),
    out,
  );
});
