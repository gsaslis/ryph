// Where a lease is recorded, as the lease's rules see it: one small record, read and replaced
// under optimistic concurrency. lease.ts decides who holds it; a store only keeps it. The one store
// is a Kubernetes Lease (kubernetes_lease.ts), because Kubernetes is the one backend where two
// replicas of a process overlap; the local ones run a single process by construction.

export interface LeaseRecord {
  /** Who holds it; null once released. */
  holder: string | null;
  /** How long a holder that stops renewing keeps it. */
  durationMs: number;
  /**
   * When the holder last renewed, by THAT process's clock. Kept for an operator reading the
   * lease; the core never compares it with its own clock.
   */
  renewedAt: string;
  /** How many times it has changed hands. */
  transitions: number;
}

export interface VersionedLease {
  record: LeaseRecord;
  /** Opaque. Changes on every write, whoever makes it. */
  version: string;
}

export interface LeaseStore {
  readonly kind: string;
  /** Null when no lease has been written yet. */
  read(): Promise<VersionedLease | null>;
  /** Null when one already exists: somebody else created it first. */
  create(record: LeaseRecord): Promise<VersionedLease | null>;
  /** Replaces it only if it is still at `version`. Null when it has moved since. */
  replace(record: LeaseRecord, version: string): Promise<VersionedLease | null>;
}
