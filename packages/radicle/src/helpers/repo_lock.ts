// One writer per repository, enforced in this process.
//
// The problem: `submitChange` builds a UNIQUE scratch repository per request, which reads as
// isolation and is not. `git push rad://…` hands the work to `git-remote-rad`, and the helper
// writes into the SHARED storage repository — `RAD_HOME/storage/<rid>`: the patch COB, the
// namespaced refs, `refs/rad/sigrefs`, the identity's signature over all of it. Two pushes for
// one repository at the same time interleave there. So does a `rad issue open` against a
// `rad cob update`, an unseed against a push, and the git door's mirror rewrite against anything
// that moves a ref under it. The HTTP surface accepts concurrent requests for one RID, so
// "nobody would do that" is not a defence: a forge retry and its original are exactly this.
//
// IN-PROCESS IS SUFFICIENT, AND ONLY BECAUSE OF THE DEPLOYMENT'S SHAPE. The bridge is a SINGLE
// REPLICA by design — it is the only process that touches RAD_HOME, one pod, one volume (see
// the package README's two invariants). A second replica would not merely need a distributed
// lock; it would violate the invariant the whole package is built on. The one writer this
// mutex does NOT cover is the paired `radicle-node`, which writes storage when it fetches;
// heartwood takes git's own ref locks for that, which is why a fetch racing a push loses a ref
// update rather than corrupting one, and is the reason every write here CONFIRMS by reading the
// COB back afterwards.
//
// The queue is FIFO per key and the lock is released in a `finally`, so a thrown operation —
// a refusal, a timeout, a killed subprocess — never wedges the repository.

/** The tail of each key's queue. A key with nothing running holds no entry. */
const tails = new Map<string, Promise<void>>();

/**
 * Runs `fn` with exclusive use of `key`, after everything already queued for it.
 *
 * Re-entrancy is NOT supported and must not be needed: an operation that already holds the lock
 * calls the unlocked inner form (`updateCobUnlocked` and friends) rather than taking it twice.
 */
export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  // `previous` is already swallowed below, so this only ever waits — it never inherits a failure.
  const result = previous.then(fn);
  // What the NEXT caller waits on: the same work, with its outcome discarded. A rejection is the
  // caller's to handle, not the next one's to inherit.
  const tail = result.then(() => {}, () => {});
  tails.set(key, tail);
  void tail.then(() => {
    // Only if nobody queued behind us — otherwise the newer tail is the live one.
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

/**
 * Takes the lock and answers the function that releases it — for work that OUTLIVES the call
 * that started it.
 *
 * The one such caller is the git door's `upload-pack`: it returns a `Response` whose body is
 * still being produced by a subprocess after the handler has returned, so `withRepoLock` would
 * release the lock before a single byte of the pack existed. The release then belongs to the
 * end of the stream instead.
 *
 * Releasing is the caller's obligation, and releasing twice is harmless. Nothing here can
 * release it for them: a caller that drops the function wedges the repository for the life of
 * the process, which is why this is not the form anything else should use.
 */
export function acquireRepoLock(key: string): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = tails.get(key) ?? Promise.resolve();
  // What the next caller waits on: not this call returning, but the holder letting go.
  const tail = previous.then(() => held);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return previous.then(() => release);
}

/** How many keys are currently held or queued. For tests and diagnostics only. */
export function heldRepoLocks(): number {
  return tails.size;
}
