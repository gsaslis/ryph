// A new, empty file under a name nobody else holds — what a spool or a staging file is written to.
//
// Created exclusively (`wx`), so a name that somehow already exists is an error rather than
// somebody else's file being reused, and readable by this uid alone.

import { open } from "node:fs/promises";
import { join } from "node:path";

/** Creates `<dir>/<random><suffix>` and returns its path. The caller deletes it. */
export async function makeTempFile(dir: string, suffix = ""): Promise<string> {
  const path = join(dir, `${crypto.randomUUID()}${suffix}`);
  await (await open(path, "wx", 0o600)).close();
  return path;
}
