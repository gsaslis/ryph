// The version a release is published as (scripts/version.ts): a `vX.Y.Z` tag on HEAD makes a
// semver release, anything else is an edge build named by its commit.

import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertEquals, assertThrows } from "@std/assert";
import {
  CHART,
  chartProblem,
  chartVersions,
  isReleaseName,
  normalizeVersion,
  resolveVersion,
  stampChart,
} from "../scripts/version.ts";

const REV = "0123456789abcdef0123456789abcdef01234567";
const SHA = "sha-0123456789ab";
const at = (tagsAtHead: string[], dirty = false) => ({ revision: REV, dirty, tagsAtHead });

test("a commit tagged vX.Y.Z releases as X.Y.Z, and keeps its commit's edge name", () => {
  assertEquals(resolveVersion(at(["v0.1.0"])), {
    version: "0.1.0",
    semver: true,
    shaTag: SHA,
    revision: REV,
    dirty: false,
  });
  assertEquals(resolveVersion(at(["v0.2.0-rc.1", "deployed"])).version, "0.2.0-rc.1");
  assertEquals(resolveVersion(at(["v0.1.0"]), "0.1.0").version, "0.1.0");
  assertEquals(resolveVersion(at(["v0.1.0"]), "v0.1.0").version, "0.1.0");
});

test("an untagged commit is an edge build, -dirty with local changes", () => {
  assertEquals(resolveVersion(at([])), {
    version: SHA,
    semver: false,
    shaTag: SHA,
    revision: REV,
    dirty: false,
  });
  assertEquals(resolveVersion(at([], true)).version, `${SHA}-dirty`);
  // Tags that are not versions do not make a release.
  assertEquals(resolveVersion(at(["v1", "vnext", "1.0.0", "v01.0.0"])).semver, false);
});

test("a release refuses a dirty tree, two version tags, and a --version HEAD is not tagged", () => {
  assertThrows(() => resolveVersion(at(["v0.1.0"], true)), Error, "uncommitted changes");
  assertThrows(() => resolveVersion(at(["v0.1.0", "v0.1.1"])), Error, "several version tags");
  assertThrows(() => resolveVersion(at([]), "0.1.0"), Error, "HEAD is not tagged v0.1.0");
  assertThrows(() => resolveVersion(at(["v0.1.1"]), "0.1.0"), Error, "it is v0.1.1");
  assertThrows(() => resolveVersion(at(["v0.1.0"]), "one"), Error, "not a semver");
});

test("versions are normalised without their v, and names are recognised", () => {
  assertEquals(normalizeVersion("v1.2.3"), "1.2.3");
  assertEquals(normalizeVersion("1.2.3-rc.1"), "1.2.3-rc.1");
  assertEquals(normalizeVersion("1.2"), null);
  assertEquals(normalizeVersion("sha-0123456789ab"), null);
  for (const name of ["0.1.0", "0.2.0-rc.1", SHA]) assertEquals(isReleaseName(name), true);
  for (const name of ["v0.1.0", `${SHA}-dirty`, "edge", ""]) {
    assertEquals(isReleaseName(name), false);
  }
});

test("the chart is stamped with the version, and a release checks it", () => {
  const yaml = readFileSync(CHART, "utf8");
  const stamped = stampChart(yaml, "0.3.0-rc.2");
  assertEquals(chartVersions(stamped), { version: "0.3.0-rc.2", appVersion: "0.3.0-rc.2" });
  assertEquals(chartProblem(stamped, "0.3.0-rc.2"), null);
  assertEquals(chartProblem(stamped, "0.3.0")?.includes("--stamp 0.3.0"), true);
  // Only those two lines change.
  const changed = yaml.split("\n").filter((line, i) => line !== stamped.split("\n")[i]);
  assertEquals(changed.map((line) => line.split(":")[0]), ["version", "appVersion"]);
  // The committed chart's own fields parse.
  const committed = chartVersions(yaml);
  assertEquals(typeof committed.version, "string");
  assertEquals(typeof committed.appVersion, "string");
});
