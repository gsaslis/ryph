// Files that hold a secret, written so no reader ever sees one half-made: the content goes into a
// fresh file beside the target (created with its mode, from its first byte: a mode given to a
// write applies only when the write creates the file), which is then put into place in one step.
// Two ways to put it there, for the two things a caller wants:
//
// - `writeSecretFile` REPLACES: renamed over whatever is there (the binary's settings file, master
//   key, login secret, backups), so an older, wider file never keeps its mode.
// - `mintedFile` CREATES ONCE: linked into place, which fails when the file exists, so two
//   processes minting at once settle on whichever link landed first and both read the winner (the
//   docker launcher's token files, which its callers read). A rename would let the second minter
//   replace the first's token after a caller had read it.

import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** A fresh file beside `path` holding `text`, created with `mode`; its path. */
function freshBeside(path: string, text: string | Uint8Array, mode: number): string {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, text, { mode, flag: "wx" });
  return tmp;
}

/** Replaces `path` with `text`, owner-only, through a fresh file renamed into place. Its
 * directory must exist. */
export function writeSecretFile(path: string, text: string | Uint8Array): Promise<void> {
  let tmp: string | null = null;
  try {
    tmp = freshBeside(path, text, 0o600);
    renameSync(tmp, path);
    return Promise.resolve();
  } catch (err) {
    if (tmp !== null) rmSync(tmp, { force: true });
    return Promise.reject(err);
  }
}

/**
 * The contents of the file at `path`, minted there first when it is absent or empty: `mint()`
 * written to a fresh file beside it, then linked into place, so the file is never seen
 * half-written and two minters agree on one value (see the header). An empty file, which only a
 * crash of an older writer leaves, counts as absent and is replaced.
 */
export function mintedFile(path: string, mint: () => string, mode = 0o644): string {
  const read = (): string => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  };
  const existing = read();
  if (existing !== "") return existing;
  const tmp = freshBeside(path, `${mint()}\n`, mode);
  try {
    try {
      linkSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Someone else's, whole — or the empty leftover of a crash, replaced outright.
      if (read() === "") renameSync(tmp, path);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return read();
}
