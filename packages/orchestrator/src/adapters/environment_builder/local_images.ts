// What the docker adapters share about an environment image the docker builder made: it lives
// in one daemon's store and nowhere else, and on a shared daemon beside other deployments'. Whose
// an image is is judged on the image docker resolves a caller's reference to (`judgeImage`), never
// on the reference's spelling: docker reaches one image by many spellings (short and partial ids,
// Docker Hub's long form, `<repo>@<id>`). A run, a check and a confined build then use the image by
// the id judged; when it is gone from the store, a launch says so the same way (`ImageGone`), on
// the same evidence.

import { createHash } from "node:crypto";

/**
 * The local repository every environment image is tagged under:
 * `ryph-env/<deployment>/<subject>:<env>`, `<deployment>` being `deploymentDigest`.
 */
export const LOCAL_REPOSITORY = "ryph-env";

/**
 * A deployment id (the provisioner's `deploymentId`: its docker network) as a fixed-length digest,
 * so no caller-chosen subject or environment id can spell another deployment's: the confined
 * builders' names and the environment images' repository both carry it.
 */
export function deploymentDigest(deployment: string): string {
  return createHash("sha256").update(deployment).digest("hex").slice(0, 12);
}

/**
 * What a confined environment build's builder is named after (`docker buildx create --name`), so
 * a warning can tell its BuildKit container, `buildx_buildkit_<name>0`, from a run's.
 */
export const CONFINED_BUILDER_PREFIX = "ryph-build-";

/**
 * What every confined builder (and build network) of `deployment` (a `deploymentId`) is named
 * starting with. Here, beside `deploymentDigest`, so a script that only tears down
 * (deploy/compose-networked/down.ts) needs nothing but this dependency-free file.
 */
export function confinedBuilderPrefixFor(deployment: string): string {
  return `${CONFINED_BUILDER_PREFIX}${deploymentDigest(deployment)}-`;
}

/**
 * What every environment image this deployment's builder tags starts with. Docker's store is the
 * daemon's, shared by every deployment on it, and tags carry no labels; so the repository path is
 * what tells this deployment's environment images from another's. A launcher launches, builds on
 * and untags only images under it (`judgeImage`).
 */
export function localImagePrefix(deployment: string): string {
  return `${LOCAL_REPOSITORY}/${deploymentDigest(deployment)}/`;
}

/**
 * A full image id: helpers/digest.ts's `isDigest`, spelled out here so this file imports nothing
 * of the package (deploy/compose-networked/down.ts imports it alone).
 */
const FULL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/**
 * Whether `image` is SPELLED as one that lives in one daemon's store and nowhere else, so no pull
 * brings it back once it is gone: a tag under `LOCAL_REPOSITORY` (what a check runs in), or a full
 * image id (what a run on a docker-built environment launches on). Pulled, the first would be asked
 * of Docker Hub, where `ryph-env` is nobody's of ours; the second names no repository at all.
 * This says nothing about whose an image is: docker resolves other spellings to the same image
 * (`refusedImageSpelling`), so ownership is judged on the image docker resolves (`judgeImage`).
 */
export function localOnlyImage(image: string): boolean {
  return image.startsWith(`${LOCAL_REPOSITORY}/`) || FULL_IMAGE_ID.test(image);
}

/** A caller's image reference refused for what it is, not for anything docker failed to say. */
export class ImageRefused extends Error {
  override name = "ImageRefused";
}

/**
 * Why a caller's image reference is refused before docker is asked about it, or null. Each is a
 * spelling docker resolves to a LOCAL image while saying nothing of whose it is (measured, Docker
 * 29.8 on the containerd store): a short or full bare hex id, a truncated `sha256:` id — both
 * reach an untagged image too, which no tag can be judged by — and Docker Hub's long form of the
 * local repository, which docker answers with the local `ryph-env/…` image, and which, absent,
 * would be pulled from Docker Hub rather than met as gone.
 */
export function refusedImageSpelling(image: string): string | null {
  if (/^[0-9a-f]{4,64}$/.test(image)) {
    return `${image} looks like an image id; name an image by its reference or its full sha256: id`;
  }
  if (image.startsWith("sha256:") && !FULL_IMAGE_ID.test(image)) {
    return `${image} is a partial image id; name an image by its reference or its full sha256: id`;
  }
  if (/^(index\.)?docker\.io\/(library\/)?ryph-env\//.test(image)) {
    return `${image} names the local environment repository through Docker Hub`;
  }
  return null;
}

/** Whether a docker command's failure is the daemon saying `image` is not in its store: its own
 * word, never inferred from a failure that merely names the image. */
export function daemonLacksImage(err: unknown, image: string): boolean {
  const text = String(err);
  return /no such image/i.test(text) && text.includes(image);
}

/** One image in docker's store, as it resolved a reference: its id, and every name it carries
 * (tags and digested names alike), in the short form docker itself prints them. */
export interface StoredImage {
  id: string;
  names: string[];
}

/** `docker image inspect`'s format for `storedImage`. */
export const STORED_IMAGE_FORMAT = "{{.Id}}|{{json .RepoTags}}|{{json .RepoDigests}}";

/** A name as docker shortens it: no default registry, no `library/` namespace, no digest. */
function shortName(name: string): string {
  let short = name.replace(/@sha256:[0-9a-f]+$/, "");
  for (const registry of ["docker.io/", "index.docker.io/"]) {
    if (short.startsWith(registry)) short = short.slice(registry.length);
  }
  if (short.startsWith("library/")) short = short.slice("library/".length);
  return short;
}

/**
 * The image docker resolves `image` to in its store, or null when the daemon says it has none.
 * Throws when docker could not say, so nothing goes ahead on an unanswered question. Every name is
 * read, digested ones too: an image pulled by digest carries no tag, only a digested name.
 */
export async function storedImage(
  image: string,
  /** `docker <args>`, answering stdout and throwing with docker's words on failure. */
  docker: (args: string[]) => Promise<string>,
): Promise<StoredImage | null> {
  let out: string;
  try {
    out = await docker(["image", "inspect", "--format", STORED_IMAGE_FORMAT, image]);
  } catch (err) {
    if (/no such image/i.test(String(err))) return null;
    throw err;
  }
  const match = /^(sha256:[0-9a-f]{64})\|(.*)\|(.*)$/.exec(out.trim());
  const list = (raw: string | undefined): string[] => {
    try {
      const parsed: unknown = JSON.parse(raw || "null");
      return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
  };
  if (match === null) throw new Error(`docker's inspection of ${image} could not be read`);
  const names = [...list(match[2]), ...list(match[3])]
    .filter((name) => !name.startsWith("<none>"))
    .map(shortName);
  return { id: match[1]!, names: [...new Set(names)] };
}

/**
 * What a caller's image reference is, judged on the image docker will actually use — never on
 * the reference's spelling, which docker resolves in more ways than any check of it can follow.
 *
 * - `registry`: not in the store, and not spelled as a local-only image: pulled by its name, as
 *   before.
 * - `absent`: not in the store, and spelled as a local-only image (`localOnlyImage`), which no pull
 *   brings back.
 * - `local`: in the store, launched by `id` so that a retag between this judgement and the launch
 *   cannot swap it. `environment` says whose environment image it is: `own` (a name under this
 *   deployment's `prefix`), `foreign` (a name under `LOCAL_REPOSITORY` and none under `prefix`, or
 *   no name at all — an untagged image, which may be anybody's environment), or `none` (only
 *   names outside `LOCAL_REPOSITORY`: a pulled or tagged image anybody could name).
 *
 * Throws `ImageRefused` on a refused spelling (`refusedImageSpelling`), and docker's words when it
 * could not say.
 */
export type ImageVerdict =
  | { kind: "registry" }
  | { kind: "absent" }
  | { kind: "local"; id: string; environment: "own" | "foreign" | "none" };

export async function judgeImage(
  image: string,
  /** This deployment's `localImagePrefix`; null where no environment image is anybody's own. */
  prefix: string | null,
  docker: (args: string[]) => Promise<string>,
): Promise<ImageVerdict> {
  const refused = refusedImageSpelling(image);
  if (refused !== null) throw new ImageRefused(refused);
  const stored = await storedImage(image, docker);
  if (stored === null) return { kind: localOnlyImage(image) ? "absent" : "registry" };
  const environment = prefix !== null && stored.names.some((name) => name.startsWith(prefix))
    ? "own"
    : stored.names.length === 0 ||
        stored.names.some((name) => name.startsWith(`${LOCAL_REPOSITORY}/`))
    ? "foreign"
    : "none";
  return { kind: "local", id: stored.id, environment };
}

/**
 * The one answer for an image this deployment may not use as an environment's, whether it is
 * absent or another deployment's: worded the same either way, so no launch, prepare or build tells
 * a caller what another deployment's store holds.
 */
export function notOwnImage(image: string): string {
  return `${image} is not an image of this deployment in docker's store`;
}

/**
 * The reference to launch `image` by, for a run, a check or a build that may use this
 * deployment's environment images and no other deployment's: the resolved id of a local image
 * (`judgeImage`), the reference itself for one a registry serves, and null for one that is
 * absent or another deployment's (`notOwnImage`).
 */
export async function ownImageRef(
  image: string,
  prefix: string,
  docker: (args: string[]) => Promise<string>,
): Promise<string | null> {
  const verdict = await judgeImage(image, prefix, docker);
  if (verdict.kind === "registry") return image;
  if (verdict.kind === "absent" || verdict.environment === "foreign") return null;
  return verdict.id;
}

/**
 * The reference to launch `image` by where no environment image belongs at all — a hosted MCP
 * server, a build's base or harness image: the resolved id of a local image that is no
 * environment image, or the reference itself for one a registry serves. Throws on any environment
 * image, this deployment's included, and on any spelled as one.
 */
export async function noEnvironmentImageRef(
  image: string,
  docker: (args: string[]) => Promise<string>,
): Promise<string> {
  // No deployment's own: every environment image is `foreign` here.
  const verdict = await judgeImage(image, null, docker);
  if (verdict.kind === "registry") return image;
  if (verdict.kind === "local" && verdict.environment === "none") return verdict.id;
  throw new ImageRefused(`${image} is a locally built environment image, or may be one`);
}
