// The bundle header parser, against bundles real git wrote — plus the malformed shapes it
// must refuse.

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseBundleHeader, readBundleHeader } from "../src/helpers/bundle.ts";
import { git } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream } from "./util.ts";

test("reads a real bundle: one ref, one prerequisite, the branch's tip", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const repo = `${root}/repo`;
    const baseSha = await makeUpstream(repo);
    await git(repo, "checkout", "--quiet", "-b", "ryph/ada/r-1");
    await writeFile(`${repo}/work.txt`, "the agent's work\n");
    await git(repo, "add", ".");
    await commit(repo, "do the work");
    const headSha = await git(repo, "rev-parse", "HEAD");

    const bundlePath = `${root}/out.bundle`;
    await git(repo, "bundle", "create", bundlePath, `${baseSha}..refs/heads/ryph/ada/r-1`);

    const header = await readBundleHeader(bundlePath);
    assertEquals(header.version, 2);
    assertEquals(header.prerequisites, [baseSha]);
    assertEquals(header.refs, [{ sha: headSha, ref: "refs/heads/ryph/ada/r-1" }]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a HEAD bundle declares HEAD — visible to the validator, not hidden", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const repo = `${root}/repo`;
    const baseSha = await makeUpstream(repo);
    await git(repo, "checkout", "--quiet", "-b", "branch");
    await writeFile(`${repo}/f`, "x\n");
    await git(repo, "add", ".");
    await commit(repo, "c");
    const bundlePath = `${root}/head.bundle`;
    await git(repo, "bundle", "create", bundlePath, `${baseSha}..HEAD`);

    const header = await readBundleHeader(bundlePath);
    // This is the footgun the runner's transport avoids by bundling the NAMED branch:
    // a HEAD bundle can never match refs/heads/<branchName> and intake rightly refuses it.
    assertEquals(header.refs.map((r) => r.ref), ["HEAD"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

const enc = (s: string) => new TextEncoder().encode(s);

test("refuses non-bundles and truncated headers", () => {
  const sha = "b".repeat(40);
  assertThrows(() => parseBundleHeader(enc("PACK....")), Error, "bad signature");
  // Well-formed lines but the empty-line terminator never arrives (truncated or hostile).
  assertThrows(
    () => parseBundleHeader(enc(`# v2 git bundle\n${sha} refs/heads/x\n`)),
    Error,
    "never ends",
  );
  assertThrows(() => parseBundleHeader(enc("# v2 git bundle\n\n")), Error, "no refs");
  assertThrows(
    () => parseBundleHeader(enc("# v2 git bundle\nnot-a-sha refs/heads/x\n\n")),
    Error,
    "malformed ref line",
  );
});

test("parses a v3 header with capabilities", () => {
  const sha = "a".repeat(40);
  const header = parseBundleHeader(enc(
    `# v3 git bundle\n@object-format=sha1\n-${sha} base\n${sha} refs/heads/x\n\n`,
  ));
  assertEquals(header.version, 3);
  assertEquals(header.prerequisites, [sha]);
  assert(header.refs[0].ref === "refs/heads/x");
});
