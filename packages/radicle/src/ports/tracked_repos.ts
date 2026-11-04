// Which repositories a USER-MODE bridge may touch, and which seeding policies it wrote itself.
//
// A deployment's bridge owns its node: every repository in storage is there because ryph seeded
// it, so storage IS the set (`RadicleService.seededRepos`). A user-mode bridge runs over
// somebody's own node, whose storage holds every repository they ever cloned, initialised or
// seeded — private ones included. Only the ones connected to ryph are its business: those are
// pulled, reconciled and served, and nothing else is. So the set is written down, by the seed
// route, and it has to survive a restart: a set that lived in memory would come back empty and
// nothing would be watched until somebody connected each repository again.
//
// `createdPolicy` is the other half of "leave the user's node alone". Connecting a repository
// the node already seeds changes nothing about it; connecting one it does not seed writes a
// policy, and only THAT policy is removed again when the repository is disconnected.
//
// Disconnecting takes a repository out of scope AT ONCE, whatever the node says. When the policy
// ryph wrote cannot be removed right then (the node is down), the row stays behind marked
// `unseedPending` — out of scope, but still remembering the policy — and the removal is retried
// until it lands.

export interface TrackedRepo {
  /** `rad:z…`, canonical form. */
  rid: string;
  /** Whether the node's seeding policy for it was written by ryph, and so is ryph's to remove. */
  createdPolicy: boolean;
  /** Disconnected, and the policy ryph wrote still to be removed. Out of scope either way. */
  unseedPending: boolean;
  trackedAt: string;
}

export interface TrackedRepoStore {
  /** Every repository in scope — tracked, and not on its way out — by RID. */
  list(): Promise<TrackedRepo[]>;
  /** The row for `rid`, a pending one included: `inScope` is `row && !row.unseedPending`. */
  get(rid: string): Promise<TrackedRepo | null>;
  /**
   * Starts tracking `rid`, or tracks it again. `createdPolicy` is OR-ed into whatever the row
   * already said — a second connect finds the policy the first one wrote and must not forget
   * whose it is, and a leftover row that said "not ours" is corrected when ryph writes one —
   * and a pending unseed is called off: the repository is wanted again. `trackedAt` becomes
   * now either way, which is what tells a connect in flight from a stale row (`untrackExcept`).
   */
  track(rid: string, createdPolicy: boolean): Promise<void>;
  /** Out of scope at once, the row kept to remember the policy still to be removed. */
  markUnseedPending(rid: string): Promise<void>;
  /** The rows whose policy removal is still owed, oldest first. */
  pendingUnseeds(): Promise<TrackedRepo[]>;
  /** Forgets `rid` entirely, answering the row it had, or null when there was none. */
  untrack(rid: string): Promise<TrackedRepo | null>;
}
