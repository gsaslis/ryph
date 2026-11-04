// Shellchecks every `.sh` file under src/: the scripts the platform runs in check pods and
// environment builds, imported as text (helpers/shell.ts). Run via `bun run lint:shell`, and part
// of `bun run guard`.
//
// Each file names its own dialect, a `# shellcheck shell=…` directive or a shebang: bash for the
// check pod's and the clone's, busybox `sh` for what runs on the buildkit image. A file is a part
// of a script, after a constants header TypeScript writes, so the header's `RYPH_*` names are set
// where shellcheck cannot see them; upper-case, they are taken for the environment's.
//
// shellcheck is required, not skipped when missing: the universal image ships it (the image the
// repo's own checks run on), and `brew install shellcheck` or `apt install shellcheck` is the fix
// anywhere else.

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { command } from "@ryph/process";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

async function shellFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) found.push(...(await shellFiles(`${path}/`)));
    else if (entry.name.endsWith(".sh")) found.push(path);
  }
  return found.sort();
}

const files = await shellFiles(SRC);
let result;
try {
  result = await command("shellcheck", {
    args: files,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
} catch {
  console.error(
    "shellcheck is not installed: brew install shellcheck, or apt install shellcheck " +
      "(the universal image ships it)",
  );
  process.exit(1);
}
if (result.code !== 0) {
  console.error(`shellcheck: findings in ${files.length} file(s) under src/`);
  process.exit(1);
}
console.log(`shellcheck: clean (${files.length} files)`);
