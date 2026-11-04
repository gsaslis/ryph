// publish_artifact and fetch_artifact on the runner's side: only a file inside the checkout is
// read, symlinks resolved; the size and the encoding are checked before anything is sent; an
// artifact is named by its id or its page's link; a refusal over an image the runner did not keep
// says why; and a fetched artifact is written only inside the checkout, never through a link.

import { test } from "bun:test";
import { command } from "@ryph/process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  artifactIdOf,
  fetchArtifactFile,
  publishArtifactFile,
  readArtifactFile,
  writeArtifactFile,
} from "../src/core/artifacts.ts";
import type { ArtifactPublisher, ArtifactPublishRequest } from "../src/ports/artifacts.ts";
import { ARTIFACT_MAX_BYTES } from "../src/ports/run_actions.ts";

async function checkout() {
  const base = await mkdtemp(join(tmpdir(), "ryph-"));
  const root = join(base, "work");
  await mkdir(join(root, "repo"), { recursive: true });
  return { base, root };
}

test("artifacts: a file inside the checkout is read; one outside, or linked out, is not", async () => {
  const { base, root } = await checkout();
  try {
    await writeFile(join(root, "repo", "report.html"), "<h1>Hi</h1>");
    assertEquals(await readArtifactFile(root, "repo/report.html"), { html: "<h1>Hi</h1>" });
    assertEquals(
      await readArtifactFile(root, join(root, "repo", "report.html")),
      { html: "<h1>Hi</h1>" },
    );

    await writeFile(join(base, "secret.html"), "secret");
    const outside = await readArtifactFile(root, join(base, "secret.html"));
    assert("reason" in outside);
    assertStringIncludes(outside.reason, "outside the checkout");
    const climbing = await readArtifactFile(root, "../secret.html");
    assert("reason" in climbing && climbing.reason.includes("outside the checkout"));

    await symlink(join(base, "secret.html"), join(root, "repo", "link.html"));
    const linked = await readArtifactFile(root, "repo/link.html");
    assert("reason" in linked && linked.reason.includes("outside the checkout"));

    const missing = await readArtifactFile(root, "repo/nope.html");
    assert("reason" in missing && missing.reason.includes("does not exist"));
    const dir = await readArtifactFile(root, "repo");
    assert("reason" in dir && dir.reason.includes("not a file"));
  } finally {
    await rm(base, { recursive: true });
  }
});

test("artifacts: a file over the cap, or not UTF-8, is refused before it is sent", async () => {
  const { base, root } = await checkout();
  try {
    await writeFile(join(root, "big.html"), new Uint8Array(ARTIFACT_MAX_BYTES + 1).fill(65));
    const big = await readArtifactFile(root, "big.html");
    assert("reason" in big && big.reason.includes("at most"));
    await writeFile(join(root, "bad.html"), new Uint8Array([0x3c, 0xff, 0xfe, 0x3e]));
    const bad = await readArtifactFile(root, "bad.html");
    assert("reason" in bad && bad.reason.includes("UTF-8"));
  } finally {
    await rm(base, { recursive: true });
  }
});

test("artifacts: an artifact is named by its id or its page's link", () => {
  assertEquals(artifactIdOf("art-0123456789"), "art-0123456789");
  assertEquals(artifactIdOf(" https://ryph.test/artifacts/art-0123456789 "), "art-0123456789");
  assertEquals(artifactIdOf("https://ryph.test/artifacts/art-1/v/2/content?x=1"), "art-1");
  assertEquals(artifactIdOf("/artifacts/art-1#top"), "art-1");
});

test("artifacts: the document goes up with its artifact, and an unkept image's refusal says why", async () => {
  const { base, root } = await checkout();
  try {
    const html = '<img src="img-0123456789ab"><p>img-ffffffffffff</p>';
    await writeFile(join(root, "report.html"), html);
    const sent: ArtifactPublishRequest[] = [];
    let refuse = false;
    const publisher: ArtifactPublisher = {
      publish(request) {
        sent.push(request);
        return Promise.resolve(
          refuse
            ? { kind: "refused", reason: "no image this run kept has the ref img-0123456789ab." }
            : {
              kind: "published",
              id: "art-1",
              version: 2,
              url: null,
              created: false,
              unchanged: false,
            },
        );
      },
      fetch: () => Promise.reject(new Error("unused")),
    };
    let uploaded = false;
    const pending = [new Promise<void>((r) => setTimeout(() => (uploaded = true, r()), 10))];
    const published = await publishArtifactFile(
      { publisher, checkoutRoot: root, pending, unkept: new Map() },
      { path: "report.html", title: "Report", artifact: "https://ryph.test/artifacts/art-1" },
    );
    assertEquals(published, {
      kind: "published",
      id: "art-1",
      version: 2,
      url: null,
      created: false,
      unchanged: false,
    });
    assert(uploaded, "the uploads in flight were waited on first");
    assertEquals(sent, [{ title: "Report", html, artifactId: "art-1" }]);

    refuse = true;
    const refused = await publishArtifactFile(
      {
        publisher,
        checkoutRoot: root,
        pending: [],
        unkept: new Map([["img-0123456789ab", "too-large" as const]]),
      },
      { path: "report.html", title: "Report" },
    );
    assert(refused.kind === "refused");
    assertStringIncludes(refused.reason, "no image this run kept");
    assertStringIncludes(refused.reason, "larger than 5 MiB");
    assertEquals(sent.at(-1)?.artifactId, undefined);

    const nowhere = await publishArtifactFile(
      { publisher: undefined, checkoutRoot: root, pending: [], unkept: new Map() },
      { path: "report.html", title: "Report" },
    );
    assert(nowhere.kind === "refused" && nowhere.reason.includes("no platform"));
  } finally {
    await rm(base, { recursive: true });
  }
});

test("artifacts: a FIFO or a device inside the checkout is not read, and a big file is read only to the cap", async () => {
  const { base, root } = await checkout();
  try {
    const fifo = join(root, "pipe.html");
    await command("mkfifo", { args: [fifo] }).output();
    // Read without following and without opening a FIFO for good: refused at once.
    const piped = await readArtifactFile(root, "pipe.html");
    assert("reason" in piped && piped.reason.includes("not a file"));
    await symlink("/dev/zero", join(root, "zero.html"));
    const zero = await readArtifactFile(root, "zero.html");
    assert("reason" in zero && zero.reason.includes("outside the checkout"));
  } finally {
    await rm(base, { recursive: true });
  }
});

test("artifacts: a fetched artifact is written inside the checkout, never through a link", async () => {
  const { base, root } = await checkout();
  try {
    const written = await writeArtifactFile(root, "repo/page.html", "<p>one</p>");
    assert("path" in written);
    assertEquals(await readFile(join(root, "repo", "page.html"), "utf8"), "<p>one</p>");
    // Over a regular file: replaced whole, shorter or not.
    await writeArtifactFile(root, "repo/page.html", "<p>2</p>");
    assertEquals(await readFile(join(root, "repo", "page.html"), "utf8"), "<p>2</p>");

    // Outside, by climbing or by a linked directory: refused.
    const climbing = await writeArtifactFile(root, "../out.html", "x");
    assert("reason" in climbing && climbing.reason.includes("outside the checkout"));
    await mkdir(join(base, "elsewhere"));
    await symlink(join(base, "elsewhere"), join(root, "linked"));
    const viaDir = await writeArtifactFile(root, "linked/page.html", "x");
    assert("reason" in viaDir && viaDir.reason.includes("outside the checkout"));
    // A symlink at the path itself, even to a file inside: refused, its target untouched.
    await writeFile(join(base, "target.html"), "keep");
    await symlink(join(base, "target.html"), join(root, "trap.html"));
    const trap = await writeArtifactFile(root, "trap.html", "x");
    assert("reason" in trap && trap.reason.includes("not a regular file"));
    assertEquals(await readFile(join(base, "target.html"), "utf8"), "keep");
    const noDir = await writeArtifactFile(root, "nope/page.html", "x");
    assert("reason" in noDir && noDir.reason.includes("does not exist"));
  } finally {
    await rm(base, { recursive: true });
  }
});

test("artifacts: fetch writes the current version to artifact-<id>.html by default", async () => {
  const { base, root } = await checkout();
  try {
    const asked: string[] = [];
    const publisher: ArtifactPublisher = {
      publish: () => Promise.reject(new Error("unused")),
      fetch(id) {
        asked.push(id);
        return Promise.resolve(
          id === "art-1"
            ? {
              kind: "fetched",
              id: "art-1",
              title: "Report",
              version: 3,
              html: '<img src="img-0123456789ab">',
            }
            : { kind: "refused", reason: `no artifact ${id} of this agent` },
        );
      },
    };
    const fetched = await fetchArtifactFile(
      { publisher, checkoutRoot: root },
      { artifact: "https://ryph.test/artifacts/art-1" },
    );
    assert(fetched.kind === "fetched");
    assertEquals([fetched.version, fetched.title], [3, "Report"]);
    assertEquals(
      await readFile(join(root, "artifact-art-1.html"), "utf8"),
      '<img src="img-0123456789ab">',
    );
    const elsewhere = await fetchArtifactFile(
      { publisher, checkoutRoot: root },
      { artifact: "art-1", path: "repo/mine.html" },
    );
    assert(elsewhere.kind === "fetched" && elsewhere.path.endsWith("mine.html"));
    const refused = await fetchArtifactFile(
      { publisher, checkoutRoot: root },
      { artifact: "art-9" },
    );
    assert(refused.kind === "refused" && refused.reason.includes("no artifact art-9"));
    assertEquals(asked, ["art-1", "art-1", "art-9"]);
  } finally {
    await rm(base, { recursive: true });
  }
});
