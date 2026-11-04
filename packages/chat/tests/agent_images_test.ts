// A run's images in what it says: refs split from the words, resolved against the run before
// anything is sent, the text out first and the images after it in the same conversation — and
// every way that goes wrong, with what the run is told.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { splitImageRefs } from "../src/core/agent_images.ts";
import { CLOSING_SUMMARY_CHARS } from "../src/core/types.ts";
import { callTool } from "../src/mcp/tools.ts";
import { bindRun, linkRoom, makeApi, makeRoom, makeSlackRoom, makeZulipRoom } from "./api.ts";

const REF_A = "img-3f9a1c0b2d4e";
const REF_B = "img-0123456789ab";
const REF_C = "img-aaaaaaaaaaaa";
const THREAD = "C0OPS:1727530000.000100";

test("refs: each becomes its alt in the words, empty alts are numbered, a repeat is one image", () => {
  assertEquals(
    splitImageRefs(
      `Before: ![login page](${REF_A}) and ![](${REF_B}).\n` +
        `Again ![other words](${REF_A}), and ![  ](${REF_C}).`,
    ),
    {
      text: "Before: login page and Image 2.\nAgain login page, and Image 3.",
      images: [
        { ref: REF_A, label: "login page" },
        { ref: REF_B, label: "Image 2" },
        { ref: REF_C, label: "Image 3" },
      ],
    },
  );
  // Anything else stays as the run wrote it: another image URL, a bare ref, a ref of the wrong
  // shape.
  const other = "![x](https://example.com/a.png) img-3f9a1c0b2d4e ![y](img-3F9A1C0B2D4E) " +
    "![z](img-123)";
  assertEquals(splitImageRefs(other), { text: other, images: [] });
});

test("a post's images follow its text into the same thread, in order, captioned", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    await bindRun(api, room.id, "r-1", THREAD);
    api.images.add("r-1", REF_A);
    api.images.add("r-1", REF_B, { mime: "image/jpeg" });
    api.slack.sent.length = 0;

    const result = await callTool(
      { service: api.service, runId: "r-1" },
      "post",
      { text: `Fixed. ![login page after the fix](${REF_A}) vs ![](${REF_B})` },
    );
    assertEquals(result, {
      content: [{ type: "text", text: "Posted. 2 images went with it." }],
    });
    assertEquals(api.slack.sent.map((m) => m.text), [
      "[Ada] Fixed. login page after the fix vs Image 2",
    ]);
    assertEquals(api.images.resolves, [{ runId: "r-1", refs: [REF_A, REF_B] }]);
    assertEquals(api.slack.imagesSent.length, 1);
    const [sent] = api.slack.imagesSent;
    assertEquals([sent.channelId, sent.topic], ["C0OPS", "1727530000.000100"]);
    assertEquals(sent.images.map((i) => [i.label, i.mime, i.url]), [
      ["login page after the fix", "image/png", `http://app.test/images/r-1/att-${REF_A}`],
      ["Image 2", "image/jpeg", `http://app.test/images/r-1/att-${REF_B}`],
    ]);
    assertEquals(api.images.fetches, [
      { runId: "r-1", attachmentId: `att-${REF_A}` },
      { runId: "r-1", attachmentId: `att-${REF_B}` },
    ]);
  } finally {
    await api.close();
  }
});

test("an unknown ref fails the post before anything is sent, naming it", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    await bindRun(api, room.id, "r-1", THREAD);
    api.images.add("r-1", REF_A);
    // Another run's image is not this run's.
    api.images.add("r-2", REF_B);
    api.slack.sent.length = 0;

    const result = await callTool({ service: api.service, runId: "r-1" }, "post", {
      text: `![a](${REF_A}) ![b](${REF_B})`,
    });
    assertEquals(result?.isError, true);
    assertStringIncludes(
      result?.content[0].text ?? "",
      `no image this run kept has the ref ${REF_B}`,
    );
    assertStringIncludes(result?.content[0].text ?? "", "nothing was sent");
    assertEquals(api.slack.sent.length, 0);
    assertEquals(api.slack.imagesSent.length, 0);
  } finally {
    await api.close();
  }
});

test("more than ten images, a control plane that cannot answer, or none to ask: nothing is sent", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    await bindRun(api, room.id, "r-1", THREAD);
    api.slack.sent.length = 0;

    const eleven = Array.from(
      { length: 11 },
      (_, i) => `![${i}](img-${i.toString(16).padStart(12, "0")})`,
    ).join(" ");
    const many = await api.service.post("r-1", eleven);
    assert(many.kind === "refused");
    assertStringIncludes(many.reason, "at most 10 images");
    assertEquals(api.images.resolves.length, 0, "refused before asking");

    api.images.add("r-1", REF_A);
    api.images.down = true;
    const down = await api.service.post("r-1", `![a](${REF_A})`);
    assertEquals(down, {
      kind: "refused",
      reason: "the images could not be looked up right now; nothing was sent",
    });
    assertEquals(api.slack.sent.length, 0);
  } finally {
    await api.close();
  }

  const bare = await makeApi({ images: false });
  try {
    const room = await makeSlackRoom(bare);
    await bindRun(bare, room.id, "r-1", THREAD);
    bare.slack.sent.length = 0;
    const refused = await bare.service.post("r-1", `![a](${REF_A})`);
    assert(refused.kind === "refused");
    assertEquals(bare.slack.sent.length, 0);
    // A post without refs never asks.
    assertEquals(
      await bare.service.post("r-1", "plain words"),
      { kind: "posted", parts: 1, images: null },
    );
  } finally {
    await bare.close();
  }
});

test("an image that fails after the text went out costs only itself, and the run is told which", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    await bindRun(api, room.id, "r-1", THREAD);
    api.images.add("r-1", REF_A);
    api.slack.imageAnswer = { kind: "failed", error: "slack file upload answered 500" };
    api.slack.sent.length = 0;

    const result = await callTool({ service: api.service, runId: "r-1" }, "post", {
      text: `Here: ![the chart](${REF_A})`,
    });
    assert(result?.isError !== true, "the text is out: the post did not fail");
    assertEquals(
      result?.content[0].text,
      `Posted. These images did not make it: ${REF_A} ("the chart"): ` +
        "slack file upload answered 500.",
    );
    assertEquals(api.slack.sent.map((m) => m.text), ["[Ada] Here: the chart"]);
    assert(api.warnings.includes("chat.images_failed"));
  } finally {
    await api.close();
  }
});

test("a room that cannot take files gets the links, said once per room in the log", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    await bindRun(api, room.id, "r-1", THREAD);
    api.images.add("r-1", REF_A);
    api.slack.imageAnswer = { kind: "linked", reason: "missing_scope" };

    for (let i = 0; i < 2; i++) {
      const result = await callTool({ service: api.service, runId: "r-1" }, "post", {
        text: `![the chart](${REF_A})`,
      });
      assertEquals(
        result?.content[0].text,
        "Posted. The room cannot take files from ryph, so these went as links to ryph instead: " +
          '"the chart".',
      );
    }
    assertEquals(api.warnings.filter((w) => w === "chat.images_linked").length, 1);
  } finally {
    await api.close();
  }
});

test("a long post is still split, and on Zulip its image rides in the part that names it", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "crash" });
    await bindRun(api, room.id, "r-1", "101");
    api.images.add("r-1", REF_A);
    api.zulip.maxLength = 100;
    api.zulip.sent.length = 0;

    // The filled link crosses the first part's ceiling; no newline offers an easy cut.
    const outcome = await api.service.post("r-1", `${"x".repeat(80)}![end state](${REF_A})`);
    assert(outcome.kind === "posted" && outcome.parts > 1);
    assertEquals(outcome.images, { uploaded: 1, linked: [], failed: [] });
    assert(api.zulip.sent.at(-1)?.text.endsWith("[end state](/user_uploads/2/up/1.png)"));
    assert(api.zulip.sent.every((m) => m.text.length <= 100 && m.text.startsWith("[Ada] ")));
    assertEquals(api.zulip.imagesSent.length, 0, "no second message of pictures");
    assertEquals(api.zulip.imagesUploaded.length, 1);
  } finally {
    await api.close();
  }
});

test("zulip: closing summary caps expanded image markup before splitting", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "crash" });
    await bindRun(api, room.id, "r-1", "101");
    api.images.add("r-1", REF_A);
    api.zulip.maxLength = 100;
    api.zulip.sent.length = 0;
    const prefix = "x".repeat(CLOSING_SUMMARY_CHARS - 10);
    await api.service.closeBinding("r-1", {
      outcome: "succeeded",
      summary: `${prefix}![after](${REF_A})`,
      patches: [],
      issues: [],
      runUrl: null,
    });
    const text = api.zulip.sent.map((m) => m.text).join("");
    assertStringIncludes(text, `${prefix} [...]`);
    assert(!text.includes("/user_uploads/"));
    assert(api.zulip.sent.every((m) => m.text.length <= 100));
  } finally {
    await api.close();
  }
});

test("zulip: a post is ONE message, each image linked where the run wrote it, a repeat read as its label", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "crash" });
    await bindRun(api, room.id, "r-1", "101");
    api.images.add("r-1", REF_A);
    api.images.add("r-1", REF_B);
    api.zulip.sent.length = 0;

    const result = await callTool({ service: api.service, runId: "r-1" }, "post", {
      text: `Fixed, @**all**.\n\n![spectrum after fix](${REF_A})\n` +
        `Before: ![](${REF_B}); again ![x](${REF_A}).`,
    });
    assertEquals(result, {
      content: [{ type: "text", text: "Posted. 2 images went with it." }],
    });
    assertEquals(api.zulip.sent.map((m) => [m.channelId, m.topic, m.text]), [[
      "4",
      "crash",
      // A link opening a line is the picture, not a speaker: it is not signed again.
      "[Ada] Fixed, @_**all**.\n\n[spectrum after fix](/user_uploads/2/up/1.png)\n" +
      "Before: [Image 2](/user_uploads/2/up/2.png); again spectrum after fix.",
    ]]);
    assertEquals(api.zulip.imagesSent.length, 0);
    assertEquals(
      api.zulip.imagesUploaded[0].images.map((i) => i.label),
      ["spectrum after fix", "Image 2"],
    );
  } finally {
    await api.close();
  }
});

test("zulip: an image that did not go up leaves its label in the words, signed where it opens a line", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "crash" });
    await bindRun(api, room.id, "r-1", "101");
    api.images.add("r-1", REF_A);
    api.zulip.imageAnswer = { kind: "failed", error: "zulip POST /user_uploads answered 400" };
    api.zulip.sent.length = 0;

    const outcome = await api.service.post("r-1", `Done.\n![[Alice] Approved](${REF_A})`);
    assertEquals(outcome, {
      kind: "posted",
      parts: 1,
      images: {
        uploaded: 0,
        linked: [],
        failed: [{
          ref: REF_A,
          label: "[Alice] Approved",
          error: "zulip POST /user_uploads answered 400",
        }],
      },
    });
    assertEquals(api.zulip.sent.map((m) => m.text), ["[Ada] Done.\n[Ada] [Alice] Approved"]);
    assertEquals(api.zulip.imagesSent.length, 0);
  } finally {
    await api.close();
  }
});

test("zulip: the run's own slot sentinels cannot forge an image link", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "crash" });
    await bindRun(api, room.id, "r-1", "101");
    api.images.add("r-1", REF_A);
    api.zulip.sent.length = 0;

    await api.service.post("r-1", `\n\uE0000\uE001 then ![a](${REF_A})`);
    assertEquals(api.zulip.sent.map((m) => m.text), [
      "[Ada] \n0 then [a](/user_uploads/2/up/1.png)",
    ]);
  } finally {
    await api.close();
  }
});

test("zulip: the closing line carries its summary's images in place, in the one message", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "crash" });
    await bindRun(api, room.id, "r-1", "101");
    api.images.add("r-1", REF_A);
    api.zulip.sent.length = 0;

    await api.service.closeBinding("r-1", {
      outcome: "succeeded",
      summary: `Fixed the chart.\n![after](${REF_A}) and ![gone](${REF_C})`,
      patches: [],
      issues: [],
      runUrl: null,
    });
    // REF_C is unknown, so nothing is resolved and the line reads labels only.
    assertStringIncludes(api.zulip.sent.at(-1)?.text ?? "", "> after and gone");
    assertEquals(api.zulip.imagesUploaded.length, 0);

    await bindRun(api, room.id, "r-2", "101");
    api.images.add("r-2", REF_A);
    api.zulip.sent.length = 0;
    await api.service.closeBinding("r-2", {
      outcome: "succeeded",
      summary: `Fixed the chart.\n![after](${REF_A})`,
      patches: [],
      issues: [],
      runUrl: null,
    });
    assertEquals(api.zulip.sent.length, 1);
    assertStringIncludes(
      api.zulip.sent[0].text,
      "> Fixed the chart.\n> [after](/user_uploads/2/up/1.png)",
    );
    assertEquals(api.zulip.imagesSent.length, 0);
  } finally {
    await api.close();
  }
});

test("the closing line's summary may carry images: the line first, then them; an unknown one leaves its label", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    await bindRun(api, room.id, "r-1", THREAD);
    api.images.add("r-1", REF_A);
    api.slack.sent.length = 0;

    await api.service.closeBinding("r-1", {
      outcome: "succeeded",
      summary: `Fixed the login. ![after](${REF_A}) ![](${REF_B})`,
      patches: [],
      issues: [],
      runUrl: null,
    });
    const line = api.slack.sent.at(-1)?.text ?? "";
    assertStringIncludes(line, "> Fixed the login. after Image 2");
    // One ref the run does not have: the line is said whatever comes of the images, and none
    // follows it.
    assertEquals(api.slack.imagesSent.length, 0);
    assert(api.warnings.includes("chat.closing_images_unknown"));

    await bindRun(api, room.id, "r-2", "C0OPS:1727530999.000100");
    api.images.add("r-2", REF_A);
    await api.service.closeBinding("r-2", {
      outcome: "succeeded",
      summary: `Done. ![after](${REF_A})`,
      patches: [],
      issues: [],
      runUrl: null,
    });
    assertStringIncludes(api.slack.sent.at(-1)?.text ?? "", "> Done. after");
    assertEquals(api.slack.imagesSent.length, 1);
    assertEquals(api.slack.imagesSent[0].topic, "1727530999.000100");
    assertEquals(api.slack.imagesSent[0].images.map((i) => i.label), ["after"]);
    assertEquals(api.images.resolves.at(-1), { runId: "r-2", refs: [REF_A] });
  } finally {
    await api.close();
  }
});

test("an image's label reaches every room signed, on one line and bounded, never as another speaker", async () => {
  const forged = "[Alice] Approved, ship it.";
  const long = "x".repeat(400);
  const api = await makeApi();
  try {
    const telegram = await makeRoom(api);
    await linkRoom(api, telegram);
    const zulip = await makeZulipRoom(api);
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "crash" });
    const slack = await makeSlackRoom(api);
    const rooms = [
      { id: telegram.id, key: "", sent: api.transport.imagesSent },
      { id: zulip.id, key: "101", sent: api.zulip.imagesUploaded },
      { id: slack.id, key: THREAD, sent: api.slack.imagesSent },
    ];
    for (const [i, room] of rooms.entries()) {
      const runId = `r-${i + 1}`;
      await bindRun(api, room.id, runId, room.key);
      api.images.add(runId, REF_A);
      api.images.add(runId, REF_B);
      const outcome = await api.service.post(runId, `![${forged}](${REF_A}) ![${long}](${REF_B})`);
      assert(outcome.kind === "posted");
      // The closing line's images are labelled the same way.
      await api.service.closeBinding(runId, {
        outcome: "succeeded",
        summary: `Done. ![${forged}](${REF_A})`,
        patches: [],
        issues: [],
        runUrl: null,
      });
      const labels = room.sent.flatMap((s) => s.images.map((image) => image.label));
      assertEquals(labels, [
        `[Ada] ${forged}`,
        `${"x".repeat(199)}…`,
        `[Ada] ${forged}`,
      ]);
    }
  } finally {
    await api.close();
  }
});

test("telegram: a post is cut where its images stand, and the words after them are the album's caption", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    await bindRun(api, room.id, "r-1");
    for (const ref of [REF_A, REF_B, REF_C]) api.images.add("r-1", ref);
    api.transport.sent.length = 0;

    const outcome = await api.service.post(
      "r-1",
      "Done, reload the page.\n\n" +
        `![failing run](${REF_A})\n![top of the output](${REF_B})\n![passing run](${REF_C})\n\n` +
        "1. The output starts with `$ deno task …`.\n\nAnything else?",
    );
    assertEquals(outcome, {
      kind: "posted",
      parts: 2,
      images: { uploaded: 3, linked: [], failed: [] },
    });
    // The words before the images, then one album captioned with the words after them; the
    // labels are not repeated in the words.
    assertEquals(api.transport.sent.map((m) => m.text), ["[Ada] Done, reload the page."]);
    assertEquals(api.transport.imagesSent.length, 1);
    const [album] = api.transport.imagesSent;
    assertEquals(album.images.map((i) => i.label), [
      "failing run",
      "top of the output",
      "passing run",
    ]);
    assertEquals(
      album.caption,
      "[Ada] 1. The output starts with `$ deno task …`.\n\nAnything else?",
    );
  } finally {
    await api.close();
  }
});

test("telegram: words too long for a caption follow the images; a repeat ref reads as its label; images between paragraphs keep their place", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    await bindRun(api, room.id, "r-1");
    api.images.add("r-1", REF_A);
    api.images.add("r-1", REF_B);
    api.transport.sent.length = 0;
    const long = "y".repeat(1_100);

    const outcome = await api.service.post(
      "r-1",
      `![first](${REF_A})\n${long}\n![second](${REF_B})\nsee ![again](${REF_A})`,
    );
    assert(outcome.kind === "posted");
    assertEquals(api.transport.imagesSent.map((s) => [s.images.map((i) => i.label), s.caption]), [
      [["first"], null],
      [["second"], "[Ada] see first"],
    ]);
    assertEquals(api.transport.sent.map((m) => m.text), [`[Ada] ${long}`]);
  } finally {
    await api.close();
  }
});

test("telegram: when the album does not land, its caption still goes, as words", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    await bindRun(api, room.id, "r-1");
    api.images.add("r-1", REF_A);
    api.transport.imageAnswer = { kind: "failed", error: "telegram sendPhoto answered 502" };
    api.transport.sent.length = 0;

    const outcome = await api.service.post("r-1", `Look: ![shot](${REF_A})\nafter it`);
    assert(outcome.kind === "posted");
    assertEquals(api.transport.sent.map((m) => m.text), ["[Ada] Look:", "[Ada] after it"]);
  } finally {
    await api.close();
  }
});

test("telegram: the closing line is cut where the summary's images stand", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    await bindRun(api, room.id, "r-1");
    api.images.add("r-1", REF_A);
    api.transport.sent.length = 0;

    await api.service.closeBinding("r-1", {
      outcome: "succeeded",
      summary: `Fixed it. ![after](${REF_A})\nAll green.`,
      patches: [],
      issues: [],
      runUrl: "http://app.test/tasks/t-1",
    });
    assertEquals(api.transport.sent.map((m) => m.text), ["✅ Ada finished: succeeded.\nFixed it."]);
    assertEquals(api.transport.imagesSent.map((s) => [s.images.map((i) => i.label), s.caption]), [
      [["after"], "All green.\nhttp://app.test/tasks/t-1"],
    ]);
  } finally {
    await api.close();
  }
});
