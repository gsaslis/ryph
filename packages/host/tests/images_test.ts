// The images a docker deployment launches when nothing names them (src/images.ts): the binary's
// published refs, pinned to the commit it was built from, and the local `:dev` builds from source.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  defaultImage,
  environmentImage,
  imageDefaultsNote,
  publishedTag,
  ryphVersion,
} from "../src/images.ts";

const SHA = "sha-0123456789ab";

test("a binary built at a clean commit pins every default to that commit's tag", () => {
  assertEquals(publishedTag(SHA), { tag: SHA, pinned: true });
  assertEquals(defaultImage("agent", SHA), `quay.io/ryph/ryph-agent:${SHA}`);
  assertEquals(defaultImage("browser", SHA), `quay.io/ryph/ryph-browser:${SHA}`);
  assertEquals(defaultImage("tool-guard", SHA), `quay.io/ryph/ryph-tool-guard:${SHA}`);
  assertEquals(defaultImage("run-gate", SHA), `quay.io/ryph/ryph-run-gate:${SHA}`);
  assertEquals(imageDefaultsNote(SHA), null);
});

test("a released binary pins every default to its version's tag, and reports that version", () => {
  for (const version of ["0.1.0", "0.2.0-rc.1", "12.0.3"]) {
    assertEquals(publishedTag(version), { tag: version, pinned: true });
    assertEquals(defaultImage("agent", version), `quay.io/ryph/ryph-agent:${version}`);
    assertEquals(imageDefaultsNote(version), null);
    assertEquals(ryphVersion(version), version);
  }
  assertEquals(ryphVersion(SHA), SHA);
  assertEquals(ryphVersion(""), "dev");
  assertEquals(ryphVersion(undefined), "dev");
});

test("a dirty or commit-less binary follows edge, and its status says why", () => {
  for (const baked of [`${SHA}-dirty`, "", "v1.2.3", "01.2.3", "sha-short"]) {
    assertEquals(publishedTag(baked).tag, "edge");
    assertEquals(defaultImage("agent", baked), "quay.io/ryph/ryph-agent:edge");
  }
  assertEquals(imageDefaultsNote(`${SHA}-dirty`)?.includes("uncommitted changes"), true);
  assertEquals(imageDefaultsNote("")?.includes("without a known commit"), true);
});

test("from source the defaults are the local builds, and there is no browser", () => {
  assertEquals(defaultImage("agent", undefined), "ryph-agent:dev");
  assertEquals(defaultImage("tool-guard", undefined), "ryph-tool-guard:dev");
  assertEquals(defaultImage("run-gate", undefined), "ryph-run-gate:dev");
  assertEquals(defaultImage("browser", undefined), null);
  assertEquals(imageDefaultsNote(undefined), null);
});

test("an environment build reads the agent image's siblings, else the defaults", () => {
  const agent = `quay.io/ryph/ryph-agent:${SHA}`;
  assertEquals(environmentImage("harness", agent, SHA), `quay.io/ryph/ryph-harness:${SHA}`);
  assertEquals(environmentImage("universal", agent, SHA), `quay.io/ryph/ryph-universal:${SHA}`);
  assertEquals(environmentImage("harness", "ryph-agent:dev", undefined), "ryph-harness:dev");
  assertEquals(
    environmentImage("universal", "localhost:5000/ryph/ryph-agent:edge", SHA),
    "localhost:5000/ryph/ryph-universal:edge",
  );
  // Not a ryph-agent image, or pinned by digest: the defaults, which follow the binary's tag.
  for (const other of ["registry.example/my-agent:1", `${agent}@sha256:${"a".repeat(64)}`, null]) {
    assertEquals(environmentImage("harness", other, SHA), `quay.io/ryph/ryph-harness:${SHA}`);
    assertEquals(environmentImage("universal", other, undefined), "ryph-universal:dev");
  }
});
