// The agent's `publish_artifact` and `fetch_artifact`, on the runner's side: read the HTML file
// the agent wrote, from inside the checkout and nowhere else, and hand it to the platform with
// the artifact it updates; or write an artifact's current version into the checkout for the
// agent to edit. Everything about whether either may happen is the platform's to say
// (ports/artifacts.ts); this is only the file and the words.
//
// Invariants:
// - only a regular file whose real path, every symlink resolved, is inside the checkout root is
//   read, with one open and at most ARTIFACT_MAX_BYTES + 1 bytes read from what was opened
//   (helpers/read_bounded.ts): the agent's own work, never a runner file a link points at, and
//   never a file that grows or is swapped while it is read
// - a file over ARTIFACT_MAX_BYTES, or not valid UTF-8, is refused before anything is sent
// - a fetched artifact is written only into a directory inside the checkout root, as a new file
//   or over a regular file already there, never through a symlink
// - the run's own image uploads still in flight are waited on (bounded) before the platform
//   checks the refs the document names, as a summary's are

import type { Stats } from "node:fs";
import { constants, type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, SEPARATOR } from "@std/path";
import type { ArtifactPublisher } from "../ports/artifacts.ts";
import {
  ARTIFACT_MAX_BYTES,
  type FetchArtifactOutcome,
  type PublishArtifactOutcome,
} from "../ports/run_actions.ts";
import { errorMessage } from "../helpers/errors.ts";
import { readBounded } from "../helpers/read_bounded.ts";
import { IMAGE_UPLOADS_WAIT_MS, type UnkeptReason, unkeptRefError } from "./image_refs.ts";

/** The id an `artifact` argument names: the id itself, or the one in an artifact page's URL. */
export function artifactIdOf(raw: string): string {
  const trimmed = raw.trim();
  const inUrl = /\/artifacts\/([^/?#\s]+)/.exec(trimmed);
  if (inUrl === null) return trimmed;
  try {
    return decodeURIComponent(inUrl[1]);
  } catch {
    return inUrl[1];
  }
}

const inside = (real: string, realRoot: string) =>
  real === realRoot || real.startsWith(realRoot + SEPARATOR);

/** The document at `path` (absolute, or relative to `root`), or why it cannot be published. */
export async function readArtifactFile(
  root: string,
  path: string,
): Promise<{ html: string } | { reason: string }> {
  const asked = isAbsolute(path) ? path : join(root, path);
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(asked), realpath(root)]);
  } catch {
    return { reason: `${path} does not exist.` };
  }
  if (real === realRoot || !inside(real, realRoot)) {
    return {
      reason: `${path} is outside the checkout (${root}): write the page there and publish it ` +
        "from there.",
    };
  }
  // The real path, read without following anything: one open, checked to be the regular file
  // the lstat saw, and at most one byte past the cap.
  const bytes = await readBounded(real, ARTIFACT_MAX_BYTES + 1);
  if (bytes === null) return { reason: `${path} is not a file.` };
  if (bytes.byteLength > ARTIFACT_MAX_BYTES) {
    return {
      reason: `${path} is over ${ARTIFACT_MAX_BYTES} bytes; an artifact is at most ` +
        `${ARTIFACT_MAX_BYTES} bytes (2 MiB). Inline less, or show images by their img- ref ` +
        "instead of embedding them.",
    };
  }
  try {
    return { html: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { reason: `${path} is not valid UTF-8 text.` };
  }
}

/**
 * Writes `html` to `path` (absolute, or relative to `root`): into a directory whose real path is
 * inside the checkout, as a new file, or over a regular file already there. A symlink at the
 * path is refused, never followed; a file swapped in between the look and the open is caught by
 * comparing what was opened.
 */
export async function writeArtifactFile(
  root: string,
  path: string,
  html: string,
): Promise<{ path: string } | { reason: string }> {
  const asked = isAbsolute(path) ? path : join(root, path);
  const name = basename(asked);
  if (name === "" || name === "." || name === "..") {
    return { reason: `${path} is not a file name.` };
  }
  let realDir: string;
  let realRoot: string;
  try {
    [realDir, realRoot] = await Promise.all([realpath(dirname(asked)), realpath(root)]);
  } catch {
    return { reason: `the directory of ${path} does not exist.` };
  }
  if (!inside(realDir, realRoot)) {
    return { reason: `${path} is outside the checkout (${root}): write the page there.` };
  }
  const target = join(realDir, name);
  const bytes = new TextEncoder().encode(html);
  let existing: Stats | null = null;
  try {
    existing = await lstat(target);
  } catch (err) {
    if (!((err as NodeJS.ErrnoException)?.code === "ENOENT")) throw err;
  }
  let file: FileHandle;
  if (existing === null) {
    try {
      // Exclusive: fails on anything that appeared since, a symlink included, never follows one.
      file = await open(target, "wx");
    } catch {
      return { reason: `${path} could not be created; try another path.` };
    }
  } else {
    if (!existing.isFile()) return { reason: `${path} is not a regular file; try another path.` };
    // Write-only, never created: a path that went missing since the lstat fails here.
    file = await open(target, constants.O_WRONLY);
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== existing.ino || opened.dev !== existing.dev) {
      await file.close();
      return { reason: `${path} changed while it was written; try again.` };
    }
    await file.truncate(0);
  }
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      written += (await file.write(bytes, written, bytes.byteLength - written, written))
        .bytesWritten;
    }
  } finally {
    await file.close();
  }
  return { path: target };
}

/**
 * Fetches an artifact's current version and writes it into the checkout, at `path` or at
 * `artifact-<id>.html` in the checkout root.
 */
export async function fetchArtifactFile(
  deps: { publisher: ArtifactPublisher | undefined; checkoutRoot: string },
  args: { artifact: string; path?: string },
): Promise<FetchArtifactOutcome> {
  if (deps.publisher === undefined) {
    return { kind: "refused", reason: "there is no platform to fetch artifacts from in this run" };
  }
  const id = artifactIdOf(args.artifact);
  if (id === "") return { kind: "refused", reason: "name the artifact by its id or its link." };
  let answer;
  try {
    answer = await deps.publisher.fetch(id);
  } catch (err) {
    return {
      kind: "refused",
      reason: `The platform could not be asked just now (${errorMessage(err)}); try again ` +
        "shortly.",
    };
  }
  if (answer.kind === "refused") return answer;
  const path = args.path === undefined || args.path.trim() === ""
    ? `artifact-${answer.id.replace(/[^A-Za-z0-9._-]/g, "_")}.html`
    : args.path;
  const written = await writeArtifactFile(deps.checkoutRoot, path, answer.html);
  if ("reason" in written) return { kind: "refused", reason: written.reason };
  return {
    kind: "fetched",
    id: answer.id,
    title: answer.title,
    version: answer.version,
    path: written.path,
  };
}

/** Every `img-…` token a document holds, for explaining the ones the runner did not keep. */
const REF_TOKEN = /img-[0-9a-f]{12}/g;

/**
 * Reads the file and publishes it. `pending` are the run's image uploads still in flight;
 * `unkept` the images the runner knows it did not keep, which a refusal over unknown refs then
 * explains.
 */
export async function publishArtifactFile(
  deps: {
    publisher: ArtifactPublisher | undefined;
    checkoutRoot: string;
    pending: readonly Promise<unknown>[];
    unkept: ReadonlyMap<string, UnkeptReason>;
    waitMs?: number;
  },
  args: { path: string; title: string; artifact?: string },
): Promise<PublishArtifactOutcome> {
  if (deps.publisher === undefined) {
    return { kind: "refused", reason: "there is no platform to publish artifacts to in this run" };
  }
  const read = await readArtifactFile(deps.checkoutRoot, args.path);
  if ("reason" in read) return { kind: "refused", reason: read.reason };
  if (/img-[0-9a-f]{12}/.test(read.html) && deps.pending.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(deps.pending),
      new Promise((resolve) => timer = setTimeout(resolve, deps.waitMs ?? IMAGE_UPLOADS_WAIT_MS)),
    ]);
    clearTimeout(timer);
  }
  const artifactId = args.artifact === undefined || args.artifact.trim() === ""
    ? undefined
    : artifactIdOf(args.artifact);
  let answer;
  try {
    answer = await deps.publisher.publish({
      title: args.title,
      html: read.html,
      ...(artifactId === undefined ? {} : { artifactId }),
    });
  } catch (err) {
    return {
      kind: "refused",
      reason: `The platform could not be asked just now (${errorMessage(err)}); try again ` +
        "shortly.",
    };
  }
  if (answer.kind === "published") return answer;
  const unkept = [...new Set(read.html.match(REF_TOKEN) ?? [])].flatMap((ref) => {
    const reason = deps.unkept.get(ref);
    return reason === undefined || !answer.reason.includes(ref)
      ? []
      : [unkeptRefError(ref, reason)];
  });
  return {
    kind: "refused",
    reason: [answer.reason, ...unkept].join(" "),
  };
}
