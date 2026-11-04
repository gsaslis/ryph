// A docker image store for the adapters' tests, resolving references the way docker 29 on the
// containerd store does (measured): a full or partial id, with or without `sha256:`, a name with
// or without Docker Hub's long form and a default `:latest`, and `<repository>@<id>` for a
// repository the image carries. `docker image inspect --format` answers as `storedImage` reads it.

import { STORED_IMAGE_FORMAT } from "../src/adapters/environment_builder/local_images.ts";

export interface FakeImage {
  /** `sha256:<64 hex>`. */
  id: string;
  /** Its tags, as docker prints them (`repo:tag`); none for an untagged image. */
  names: string[];
}

const short = (name: string) => {
  let s = name;
  for (const registry of ["docker.io/", "index.docker.io/"]) {
    if (s.startsWith(registry)) s = s.slice(registry.length);
  }
  return s.startsWith("library/") ? s.slice("library/".length) : s;
};
const tagged = (name: string) => /:[^/]+$/.test(name) ? name : `${name}:latest`;
const repository = (name: string) => name.replace(/:[^/]+$/, "");

export function resolveImage(images: readonly FakeImage[], ref: string): FakeImage | undefined {
  const hex = /^(?:sha256:)?([0-9a-f]{1,64})$/.exec(ref);
  if (hex !== null) return images.find((i) => i.id.slice("sha256:".length).startsWith(hex[1]!));
  const digested = /^(.+)@(sha256:[0-9a-f]{64})$/.exec(ref);
  if (digested !== null) {
    const repo = repository(short(digested[1]!));
    return images.find((i) =>
      i.id === digested[2] && i.names.some((n) => repository(short(n)) === repo)
    );
  }
  const name = tagged(short(ref));
  return images.find((i) => i.names.some((n) => tagged(short(n)) === name));
}

/** The answer to `docker image inspect --format STORED_IMAGE_FORMAT <ref>`, or undefined for any
 * other command. */
export function inspectAnswer(
  images: readonly FakeImage[],
  args: readonly string[],
): string | Error | undefined {
  if (args[0] !== "image" || args[1] !== "inspect" || !args.includes(STORED_IMAGE_FORMAT)) {
    return undefined;
  }
  const ref = args.at(-1)!;
  const image = resolveImage(images, ref);
  if (image === undefined) return new Error(`Error response from daemon: No such image: ${ref}`);
  const digests = image.names.map((n) => `${repository(n)}@${image.id}`);
  return `${image.id}|${JSON.stringify(image.names)}|${JSON.stringify(digests)}\n`;
}

/** A store's `exec` for the ownership judgement, falling back to `rest` for anything else. */
export function storeExec(
  images: readonly FakeImage[],
  rest: (args: string[]) => Promise<string> = () => Promise.resolve(""),
): (args: string[]) => Promise<string> {
  return (args) => {
    const answer = inspectAnswer(images, args);
    if (answer === undefined) return rest(args);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
}

/** An id of `hex` repeated. */
export const imageId = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`;
