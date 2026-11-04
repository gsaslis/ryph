// The image prefetch over the docker CLI (ports/image_prefetch.ts). One pull at a time, in the
// order the list names them: the agent image first, because the first run waits on it, and the
// environment build's images last, because a build starts only after a run has asked for one.
//
// Only an image a registry serves is pulled. A bare tag (`ryph-agent:dev`, what a from-source
// deployment runs) is a local build, and pulling it would ask Docker Hub for somebody else's
// `library/ryph-agent`; it is reported as present or as failed with the command that builds it.

import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { ImagePrefetch, PrefetchImage, PrefetchName } from "../../ports/image_prefetch.ts";
import { docker, type DockerExec, PULL_TIMEOUT_MS } from "../check_launcher/docker.ts";

/** How long `docker image inspect` may take before docker counts as not answering. */
export const INSPECT_TIMEOUT_MS = 15_000;

/** Whether `image` names something a registry serves rather than a bare local tag: any ref with
 * a path, so `quay.io/ryph/…` and Docker Hub's `org/name:tag`, but not `ryph-agent:dev`. */
export function fromRegistry(image: string): boolean {
  return image.includes("/");
}

/** Why a pull failed, in a line: docker's own message without its prefix. */
function reason(err: unknown, signal: AbortSignal): string {
  if (signal.aborted) return `the download took longer than ${PULL_TIMEOUT_MS / 60_000} minutes`;
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^docker \w+ failed: /, "").split("\n")[0]!.trim() || message;
}

export function dockerImagePrefetch(
  images: ReadonlyArray<{ name: PrefetchName; image: string }>,
  diag: Diagnostics,
  exec: DockerExec = docker,
): ImagePrefetch {
  const entries: PrefetchImage[] = images.map(({ name, image }) => ({
    name,
    image,
    state: "queued",
    error: null,
  }));
  let running = false;
  /** What the pass still has to look at, a start adding to it while one runs. */
  const due = new Set(entries);

  // Bounded, so a daemon that holds the socket without answering (Docker Desktop starting, or
  // paused) fails the image instead of holding the pass, and every later start, forever.
  const present = (image: string) =>
    exec(["image", "inspect", "--format", "{{.Id}}", image], {
      signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS),
    }).then(() => true, (err) => {
      if (/no such (image|object)/i.test(String(err))) return false;
      throw err;
    });

  async function fetchOne(entry: PrefetchImage): Promise<void> {
    // A second look in the same pass (a start came in during the first) begins clean, so an
    // image that turns up present never carries the first look's error.
    if (entry.state === "failed") {
      entry.state = "queued";
      entry.error = null;
    }
    try {
      if (await present(entry.image)) {
        entry.state = "present";
        return;
      }
    } catch (err) {
      entry.state = "failed";
      const message = err instanceof Error ? err.message : String(err);
      entry.error = `docker is not answering: ${message.replace(/^docker \w+ failed: /, "")}`;
      return;
    }
    if (!fromRegistry(entry.image)) {
      entry.state = "failed";
      entry.error =
        `${entry.image} is not in docker's store; build it with \`bun run agent-image\``;
      return;
    }
    entry.state = "pulling";
    const signal = AbortSignal.timeout(PULL_TIMEOUT_MS);
    diag.debug("image_prefetch.pulling", { image: entry.image });
    try {
      await exec(["pull", "--quiet", entry.image], { signal });
      entry.state = "present";
      diag.debug("image_prefetch.pulled", { image: entry.image });
    } catch (err) {
      entry.state = "failed";
      entry.error = reason(err, signal);
      diag.warn("image_prefetch.pull_failed", { image: entry.image, err: entry.error });
    }
  }

  // `running` is cleared in the same turn as the last look at `due`, so a start can never land
  // between the two and be left with nobody to act on it.
  async function pass(): Promise<void> {
    try {
      for (let next = first(); next !== undefined; next = first()) {
        due.delete(next);
        await fetchOne(next);
      }
    } finally {
      running = false;
    }
  }

  /** The earliest due entry in the list's order, which is the order they are pulled in. */
  const first = () => entries.find((entry) => due.has(entry));

  return {
    status: () => Promise.resolve(entries.map((entry) => ({ ...entry }))),
    start() {
      // A failure is retried, and an image already here is looked at again in place, so one
      // pruned since is found gone without a ready image reading as waiting in the meantime.
      for (const entry of entries) {
        if (entry.state === "pulling") continue;
        if (entry.state === "failed") {
          entry.state = "queued";
          entry.error = null;
        }
        due.add(entry);
      }
      if (running) return Promise.resolve();
      running = true;
      void pass();
      return Promise.resolve();
    },
  };
}
