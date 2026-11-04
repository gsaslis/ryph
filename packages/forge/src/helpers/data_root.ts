// The forge's data root and the three directories under it, resolved to ABSOLUTE paths.
//
// Why absolute is not optional: every git subprocess in this package runs with its cwd set to
// some repo (helpers/git_exec.ts sets `cwd`), so any data path handed to git as an ARGUMENT —
// a staging bundle to verify, a cache dir to fetch the base from — is resolved against THAT
// cwd, not the forge's own. A relative `forge-data/...` then points at a directory that does
// not exist under the repo, and git fails with "does not appear to be a git repository" or
// "could not open". Resolving the root once, here, makes every derived path cwd-independent for
// all of its uses (git argument, open, rename). An already-absolute value (an operator
// who set an absolute RYPH_FORGE_DATA) passes through unchanged.

import { resolve } from "@std/path";

export interface ForgeDataRoot {
  /** The root itself: `<data>`. */
  dataDir: string;
  /** `<data>/cache` — one bare clone per connected repo. Disposable. */
  cacheDir: string;
  /** `<data>/patches` — the saved patch bundles. Durable. */
  patchesDir: string;
  /** `<data>/staging` — scratch for requests in flight. Wiped on boot. */
  stagingDir: string;
}

/** Resolves the configured data root (or the `forge-data` default) to absolute paths. */
export function forgeDataRoot(configured: string | undefined): ForgeDataRoot {
  const dataDir = resolve(configured ?? "forge-data");
  return {
    dataDir,
    cacheDir: `${dataDir}/cache`,
    patchesDir: `${dataDir}/patches`,
    stagingDir: `${dataDir}/staging`,
  };
}
