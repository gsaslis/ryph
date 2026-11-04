// Where the event consumer remembers how far it has read each COB reference.
//
// The unit is one storage reference — `refs/namespaces/<nid>/refs/cobs/<type>/<id>` — and the
// value is the oid the consumer has already turned into events. Reconcile compares the stored
// oid against what storage holds now, so a missed event costs a scan, never a lost delivery.
//
// The key is (rid, ref), not (rid, cob): the same COB has one reference per author, and each
// author's history advances independently.
//
// One other kind of reference lives here: the canonical default branch, `refs/heads/<name>`,
// whose value is the commit a `branch.updated` was last delivered for. The two never collide —
// every COB reference is under `refs/namespaces/`.

export interface Cursor {
  rid: string;
  ref: string;
  oid: string;
}

export interface CursorStore {
  get(rid: string, ref: string): Promise<string | null>;
  set(rid: string, ref: string, oid: string): Promise<void>;
  /** Every cursor for one repository. An empty answer means "never seen" — see `core/events.ts`,
   * which then seeds cursors WITHOUT emitting the history it just discovered. */
  listByRepo(rid: string): Promise<Cursor[]>;
  /** Forgets a repository's cursors — used when a repo is unseeded. */
  clearRepo(rid: string): Promise<void>;
  close(): Promise<void>;
}
