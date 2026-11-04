// The data root MUST resolve to absolute paths. Git subprocesses in this package run with their
// cwd set to a cache repo (never the forge's own dir), so any data path handed to git as an
// argument — a staging bundle, a cache dir to fetch from — has to be absolute or it resolves
// against the wrong directory: the "does not appear to be a git repository" / "could not open"
// class of bug. The default RYPH_FORGE_DATA is the RELATIVE "forge-data", so this is the one
// property that keeps intake (door ②) and submit (door ③) working out of the box.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { isAbsolute } from "@std/path";
import { forgeDataRoot } from "../src/helpers/data_root.ts";

test("a relative data root (the 'forge-data' default) resolves to absolute paths", () => {
  const { dataDir, cacheDir, patchesDir, stagingDir } = forgeDataRoot("forge-data");
  for (const dir of [dataDir, cacheDir, patchesDir, stagingDir]) {
    assert(isAbsolute(dir), `${dir} must be absolute`);
  }
  assertEquals(cacheDir, `${dataDir}/cache`);
  assertEquals(patchesDir, `${dataDir}/patches`);
  assertEquals(stagingDir, `${dataDir}/staging`);
});

test("an unset data root defaults to an absolute 'forge-data'", () => {
  const { dataDir } = forgeDataRoot(undefined);
  assert(isAbsolute(dataDir));
  assertEquals(dataDir, `${process.cwd()}/forge-data`);
});

test("an already-absolute data root passes through unchanged", () => {
  const { dataDir, cacheDir } = forgeDataRoot("/srv/ryph/forge-data");
  assertEquals(dataDir, "/srv/ryph/forge-data");
  assertEquals(cacheDir, "/srv/ryph/forge-data/cache");
});
