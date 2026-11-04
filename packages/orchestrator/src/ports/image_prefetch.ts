// The images a docker deployment launches, fetched ahead of the first run that needs them: the
// first-run flow reports them, so the first task does not sit through a few gigabytes of pulls
// it was never told about.
//
// One adapter stands behind it: adapters/image_prefetch/docker.ts, which runs inside the docker
// launcher (@ryph/launcher), and its client over the wire (adapters/launcher/), which the binary
// and the standalone control plane with the docker provisioner (deploy/compose-networked, when
// its launcher prefetches) wire at boot. Elsewhere nothing is wired, and the route answers with
// no images.
//
// Both methods answer a promise, although the docker adapter knows its answer at once: the
// entries live in the launcher's process, and a client that cached them to answer synchronously
// would show the first-run flow a pull that finished seconds ago as still running. Its only
// callers are two routes, which await it.

/** One image's short name, as packages/host/src/images.ts names them. */
export type PrefetchName =
  | "agent"
  | "run-gate"
  | "browser"
  | "tool-guard"
  | "harness"
  | "universal"
  /** The rootful BuildKit a confined docker build runs its builder on. */
  | "buildkit";

export type PrefetchState = "present" | "pulling" | "queued" | "failed";

export interface PrefetchImage {
  name: PrefetchName;
  image: string;
  state: PrefetchState;
  /** Why it failed, said for a person; null unless `failed`. */
  error: string | null;
}

export interface ImagePrefetch {
  /** Every image's state as of now, in the order they are pulled. */
  status(): Promise<PrefetchImage[]>;
  /** Looks at every image again and pulls what is not here, one at a time; a failure is retried.
   * During a pass, it joins that pass. Resolves once the pass is under way, not once it is done. */
  start(): Promise<void>;
}
