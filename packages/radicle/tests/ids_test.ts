// The pure half: identifier shapes, the explorer template, and the COB reference parser. No
// binaries, no sockets — these run everywhere, including a CI job with no Radicle installed.

import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import {
  EXPLORER_PLACEHOLDERS,
  fullOidsIn,
  isExplorerTemplate,
  isFullOid,
  isNid,
  isOidPrefix,
  isRid,
  normalizeRid,
  renderExplorerUrl,
} from "../src/helpers/ids.ts";
import { parseCobRef } from "../src/core/events.ts";

const RID = "rad:z4V14vdenmiCJQPkp9347PXnNUahZ";
const NID = "z6MkrZSV9qadiiEtb9UadbAbMRZgtPxxzprBoTgvqiZqq1gG";
const OID = "146df3b60c9d76dd331971cc94c06b16cf596407";

test("a RID is accepted with or without the rad: prefix", () => {
  assertEquals(isRid(RID), true);
  assertEquals(isRid(RID.slice(4)), true);
  assertEquals(normalizeRid(RID.slice(4)), RID);
  assertEquals(normalizeRid(RID), RID);
});

test("anything that could escape a path or a flag is not a RID", () => {
  for (
    const bad of [
      "",
      "rad:",
      "rad:../../etc/passwd",
      "../z4V14vdenmiCJQPkp9347PXnNUahZ",
      "rad:z4V14vdenmiCJQPkp9347PXnNUahZ/../..",
      "--upload-pack=touch",
      "rad:z0OIl4V14vdenmiCJQPkp9347PXnNUahZ", // 0, O, I and l are not in the btc alphabet
    ]
  ) {
    assertEquals(isRid(bad), false, `${bad} should not be a RID`);
    assertThrows(() => normalizeRid(bad));
  }
});

test("object ids: a full one, a human prefix, and nothing else", () => {
  assertEquals(isFullOid(OID), true);
  assertEquals(isOidPrefix(OID), true);
  assertEquals(isOidPrefix("146df3b"), true);
  assertEquals(isFullOid("146df3b"), false);
  assertEquals(isOidPrefix("146df3"), false, "six characters is below the usable prefix length");
  assertEquals(isOidPrefix("146DF3B"), false, "uppercase is not a git object id");
  assertEquals(isOidPrefix("../../x"), false);
  assertEquals(isNid(NID), true);
  assertEquals(isNid("z6Mk"), false);
});

test("a patch id is scraped out of git's stderr, in order", () => {
  const stderr = `✓ Patch ${OID} opened\nTo rad://x\n * [new reference]   HEAD -> refs/patches\n`;
  assertEquals(fullOidsIn(stderr), [OID]);
  assertEquals(fullOidsIn("nothing here"), []);
});

test("the explorer template substitutes, and an unset one stays null", () => {
  assertEquals(
    renderExplorerUrl("https://app.radicle.xyz/nodes/seed/{rid}/{kind}/{id}", {
      rid: RID,
      id: OID,
      kind: "patches",
    }),
    `https://app.radicle.xyz/nodes/seed/${RID}/patches/${OID}`,
  );
  assertEquals(renderExplorerUrl(null, { rid: RID, id: OID, kind: "patches" }), null);
  assertEquals(renderExplorerUrl("", { rid: RID, id: OID, kind: "issues" }), null);
});

test("a template naming no placeholder is not a link, it is the explorer's home page", () => {
  // The bug this fixes: a bare origin rendered unchanged, so every patch and every issue in
  // every repository got the SAME url — a link a caller cannot tell apart from a real one.
  for (
    const bare of ["https://app.radicle.xyz", "https://app.radicle.xyz/nodes/seed", "not a url"]
  ) {
    assertEquals(isExplorerTemplate(bare), false, `${bare} names no placeholder`);
    assertEquals(renderExplorerUrl(bare, { rid: RID, id: OID, kind: "patches" }), null);
  }
  // A template naming even one of them is usable: the id alone addresses a COB on some
  // explorers, and the rest is the operator's business.
  for (const placeholder of EXPLORER_PLACEHOLDERS) {
    assertEquals(isExplorerTemplate(`https://x.test/${placeholder}`), true);
  }
  assertEquals(isExplorerTemplate(null), false);
  assertEquals(isExplorerTemplate(""), false);
  // Every occurrence is substituted, and nothing that merely looks like a placeholder is.
  assertEquals(
    renderExplorerUrl("https://x.test/{rid}/{kind}/{id}?back=/{rid}&p=${id}&q={patch}", {
      rid: RID,
      id: OID,
      kind: "issues",
    }),
    `https://x.test/${RID}/issues/${OID}?back=/${RID}&p=$${OID}&q={patch}`,
  );
});

test("a COB reference parses into namespace, type and object", () => {
  const parsed = parseCobRef(`refs/namespaces/${NID}/refs/cobs/xyz.radicle.patch/${OID}`);
  assertEquals(parsed, { nid: NID, typeName: "xyz.radicle.patch", cob: OID });
});

test("refs that are not COB refs are ignored rather than half-parsed", () => {
  for (
    const ref of [
      `refs/namespaces/${NID}/refs/heads/main`,
      `refs/namespaces/${NID}/refs/rad/sigrefs`,
      "refs/heads/main",
      `refs/namespaces/${NID}/refs/cobs/xyz.radicle.patch/not-a-sha`,
    ]
  ) {
    assertEquals(parseCobRef(ref), null, `${ref} should not parse`);
  }
});

test("an identity COB reference parses but names a type the consumer skips", () => {
  const ref = `refs/namespaces/${NID}/refs/cobs/xyz.radicle.id/${OID}`;
  assertEquals(parseCobRef(ref)?.typeName, "xyz.radicle.id");
});
