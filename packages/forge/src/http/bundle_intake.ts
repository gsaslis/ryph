// The intake steps every door that takes a bundle shares — a run's patch (http/patches.ts) and
// a person's check bundle (the `check-bundle` service route): stage the body to a file under a
// size cap, read its one ref, and ask git whether a base repo satisfies its prerequisites. What
// the ref must be, which base it is judged against, and where the bundle is filed are each
// door's own; this file only does the parts that have to be done the same way twice.
//
// Invariants:
// - the size cap rejects WHILE STREAMING, with a Content-Length precheck in front of it for a
//   clean 413 before any disk touch: buffer-then-check is the DoS
// - a staged path handed back is the caller's to consume or remove; every other outcome leaves
//   nothing behind in the staging dir
// - the staging path is absolute (the composition root resolves `stagingDir`) — `git bundle
//   verify` runs with its cwd set to a cache repo, so a relative path would resolve against the
//   wrong directory

import { open, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { sha256Hex } from "@ryph/sealed";
import { readBundleHeader } from "../helpers/bundle.ts";
import { byteCap } from "../helpers/http_backend.ts";
import { type GitTracer, makeGit } from "../helpers/git_exec.ts";

/**
 * Where a person's check bundle is filed: under the user, the BRANCH, the BASE and the repo. The
 * branch is in the key because the bundle's one ref is `refs/heads/<branch>`: the same commit
 * asked about on two branches is two bundles. The base is in it because the bundle's
 * prerequisites were proven against that base only: the same commit asked about against two
 * bases is two bundles too. One key for either pair would let the second upload replace the
 * first under the first suite's clone. Branch and base each enter as a hash (the first 16 hex
 * of the SHA-256 of its UTF-8 bytes), so a name's slashes and characters never reach the key.
 * Ends `/<connectedRepoId>/<headSha>.bundle`, the one shape the gateway's candidate arm accepts.
 * The orchestrator derives the same key.
 */
export async function checkBundleKey(args: {
  userId: string;
  branchName: string;
  baseRef: string;
  connectedRepoId: string;
  headSha: string;
}): Promise<string> {
  const short = async (name: string): Promise<string> => (await sha256Hex(name)).slice(0, 16);
  const branchKey = await short(args.branchName);
  const baseKey = await short(args.baseRef);
  return `users/${args.userId}/${branchKey}/${baseKey}/${args.connectedRepoId}/${args.headSha}.bundle`;
}

/** What staging a request body came to: a file holding the whole bundle, or over the cap. */
export type Staged = { kind: "staged"; path: string } | { kind: "too-large" };

/**
 * Writes `stream` into a new file at `path` (never an existing one). A file that cannot be
 * created cancels the stream, which is otherwise left open: a stored bundle's is a FileHandle,
 * and one collected while open is an uncaught error under Bun, not a leak.
 */
export async function stageStream(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
  let file;
  try {
    file = await open(path, "wx");
  } catch (err) {
    await stream.cancel().catch(() => {});
    throw err;
  }
  await stream.pipeTo(Writable.toWeb(file.createWriteStream()));
}

/**
 * Streams `req`'s body into a fresh file under `stagingDir`, refusing past `maxBytes`. The
 * bundle must be a file before anything can be validated (`git bundle verify` reads a path), so
 * staging is not buffering.
 */
export async function stageUpload(
  req: Request,
  opts: { maxBytes: number; stagingDir: string },
): Promise<Staged> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > opts.maxBytes) return { kind: "too-large" };

  const path = `${opts.stagingDir}/${crypto.randomUUID()}.bundle`;
  try {
    const src = req.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    await stageStream(src.pipeThrough(byteCap(opts.maxBytes)), path);
    return { kind: "staged", path };
  } catch (err) {
    await rm(path).catch(() => {});
    if (err instanceof Error && err.name === "BodyCapExceeded") return { kind: "too-large" };
    throw err;
  }
}

/**
 * The bundle's one ref, or the sentence refusing it: not a bundle at all, or a bundle declaring
 * anything but exactly one ref.
 */
export async function soleRef(path: string): Promise<{ ref: string; sha: string } | string> {
  let header;
  try {
    header = await readBundleHeader(path);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (header.refs.length !== 1) {
    return `bundle must declare exactly one ref, got ${header.refs.length}`;
  }
  return header.refs[0];
}

/**
 * Builds the prerequisite check: null when the repo at `dir` satisfies the bundle at `path`, else
 * git's own words. `LC_ALL=C` so those words are the same on every host.
 */
export function bundleVerifier(
  diag: GitTracer,
): (dir: string, path: string) => Promise<string | null> {
  const gitExec = makeGit(diag, { LC_ALL: "C" });
  return async (dir, path) => {
    try {
      await gitExec(dir, "bundle", "verify", "--quiet", path);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
}
