// Removing a fixture's temp tree. Bun's recursive `rm` reports ANY entry it finds gone partway
// through as `ENOENT: lstat '<root>'` and stops, with the rest of the tree still on disk — seen in
// the check sandbox (gVisor) on a clone holding hundreds of loose objects, and on the
// stories' fixture repos. `force: true` does not help: it swallows that error and leaves the tree
// behind. So an ENOENT is taken at its word only once the root really is gone; while it is still
// there, the removal goes again.

import { rm, stat } from "node:fs/promises";

export async function removeTree(path: string, attempts = 5): Promise<void> {
  for (let attempt = 1;; attempt++) {
    try {
      await rm(path, { recursive: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      if (!await stat(path).then(() => true, () => false)) return;
      if (attempt >= attempts) throw err;
    }
  }
}
