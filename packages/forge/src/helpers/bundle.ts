// Reading a git bundle's self-description. A bundle is a packfile PLUS a header naming the
// refs it carries and the commits it requires — and that self-description is the entire reason
// the intake door accepts bundles rather than bare packfiles: it is what lets an upload from an
// untrusted container be VALIDATED (exactly one ref, the run's expected branch, prerequisites
// the cache can satisfy) before anything is stored. This helper parses the header; deciding
// what to do with it is http/patches.ts's job.
//
// Header format (git's own, documented in gitformat-bundle):
//   v2:  "# v2 git bundle" · prerequisite lines ("-<sha> [comment]") · ref lines
//        ("<sha> <refname>") · one empty line · packfile bytes
//   v3:  "# v3 git bundle" · capability lines ("@key[=value]") · then as v2
//
// Invariants:
// - bounded: only the first HEADER_MAX bytes are ever read — a hostile "bundle" that never
//   ends its header is refused, not buffered
// - parse-only: nothing here touches a repo; `git bundle verify` (run by the caller against
//   the cache) is what checks the prerequisites actually exist

import { open } from "node:fs/promises";

const HEADER_MAX = 64 * 1024;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // sha1, or sha256 under objectformat=sha256

export interface BundleHeader {
  version: 2 | 3;
  /** The commits the bundle requires to already exist wherever it is applied. */
  prerequisites: string[];
  /** The refs the bundle carries. */
  refs: Array<{ sha: string; ref: string }>;
}

/** Parses the header of the bundle file at `path`. Throws with the reason on anything
 * that is not a well-formed bundle header. */
export async function readBundleHeader(path: string): Promise<BundleHeader> {
  const file = await open(path, "r");
  const buf = new Uint8Array(HEADER_MAX);
  let filled = 0;
  try {
    while (filled < HEADER_MAX) {
      const { bytesRead } = await file.read(buf, filled, HEADER_MAX - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
  } finally {
    await file.close();
  }
  return parseBundleHeader(buf.subarray(0, filled));
}

/** The parse itself, on bytes — exported for tests. */
export function parseBundleHeader(bytes: Uint8Array): BundleHeader {
  const text = new TextDecoder().decode(bytes);
  // Signature first — a non-bundle is refused as such, however it is (or isn't) terminated.
  let version: 2 | 3;
  if (text.startsWith("# v2 git bundle\n")) version = 2;
  else if (text.startsWith("# v3 git bundle\n")) version = 3;
  else throw new Error("not a git bundle (bad signature)");

  // The header ends at an empty LINE — two consecutive newlines — with the packfile after.
  // Splitting on "\n" and looking for "" would mistake a truncated header's final newline
  // for the terminator; searching for the pair cannot.
  const end = text.indexOf("\n\n");
  if (end === -1) throw new Error("bundle header never ends (or exceeds the header cap)");
  const lines = text.slice(0, end).split("\n");
  lines.shift(); // the signature, already validated

  const prerequisites: string[] = [];
  const refs: Array<{ sha: string; ref: string }> = [];

  for (const line of lines) {
    if (line.startsWith("@")) {
      if (version !== 3) throw new Error("capability line in a v2 bundle");
      continue; // capabilities (object-format, filter) don't affect ref validation
    }
    if (line.startsWith("-")) {
      const sha = line.slice(1).split(" ")[0];
      if (!SHA_RE.test(sha)) throw new Error("malformed prerequisite line");
      prerequisites.push(sha);
      continue;
    }
    const space = line.indexOf(" ");
    if (space === -1) throw new Error("malformed ref line");
    const sha = line.slice(0, space);
    const ref = line.slice(space + 1);
    if (!SHA_RE.test(sha) || ref === "") throw new Error("malformed ref line");
    refs.push({ sha, ref });
  }

  if (refs.length === 0) throw new Error("bundle carries no refs");
  return { version, prerequisites, refs };
}
