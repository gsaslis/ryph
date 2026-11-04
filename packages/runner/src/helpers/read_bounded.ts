// Reading a file the checkout wrote — a context file, environment.md, services.yml — without
// trusting it to be a file. A committed symlink can point anywhere: `/dev/zero` never ends,
// `/proc/self/environ` is this process's own environment, and reading either whole before
// deciding what to keep is a hang or a leak. So the read refuses to follow (it lstat's the path
// and requires a regular file — a symlink, a directory, a device are all "absent") and it reads
// at most the bytes the caller asked for, so nothing here depends on the file having a size at
// all. The caller compares the length to its own cap: handed `cap + 1`, a result longer than
// `cap` means "over", and the tail was never read.
//
// The lstat and the open are two looks at a path something else can change in between — a
// process a setup step left running, swapping the file for a symlink. So what was OPENED is
// checked too: the same inode on the same device as the regular file lstat saw, or nothing.

import { type FileHandle, lstat, open } from "node:fs/promises";
import type { Stats } from "node:fs";

/** The first `maxBytes` bytes of a regular file at `path`, or null when nothing regular is
 * there. Never follows a symlink; never reads past `maxBytes`. */
export async function readBounded(path: string, maxBytes: number): Promise<Uint8Array | null> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (err) {
    if (((err as NodeJS.ErrnoException)?.code === "ENOENT")) return null;
    throw err;
  }
  if (!info.isFile()) return null;
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch (err) {
    if (((err as NodeJS.ErrnoException)?.code === "ENOENT")) return null; // gone since the lstat
    throw err;
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) return null;
    const buf = new Uint8Array(maxBytes);
    let filled = 0;
    while (filled < maxBytes) {
      const { bytesRead } = await file.read(buf, filled, maxBytes - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buf.subarray(0, filled);
  } finally {
    await file.close();
  }
}
