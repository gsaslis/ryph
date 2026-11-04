// A LeaseStore in a variable: versions are a counter, a conflict is a version that moved, and an
// API server that will not answer is one call away. What core/lease.ts is tested against.

import type { LeaseRecord, LeaseStore, VersionedLease } from "../src/lease_store.ts";

export interface MemoryLeaseStore extends LeaseStore {
  /** What is stored now, or null. */
  current(): VersionedLease | null;
  /** The next `times` calls, of any kind, throw — the way an unreachable API server would. */
  failNext(times: number): void;
  /** Writes it as some other process would, moving the version. */
  overwrite(record: LeaseRecord): void;
}

export function memoryLeaseStore(): MemoryLeaseStore {
  let lease: VersionedLease | null = null;
  let version = 0;
  let failures = 0;

  const put = (record: LeaseRecord): VersionedLease => {
    lease = { record: structuredClone(record), version: String(++version) };
    return structuredClone(lease);
  };
  const unreachable = (): boolean => {
    if (failures === 0) return false;
    failures--;
    return true;
  };
  const refuse = () => Promise.reject(new Error("the API server did not answer"));

  return {
    kind: "memory",
    read: () =>
      unreachable() ? refuse() : Promise.resolve(lease === null ? null : structuredClone(lease)),
    create: (record) =>
      unreachable() ? refuse() : Promise.resolve(lease === null ? put(record) : null),
    replace: (record, expected) =>
      unreachable()
        ? refuse()
        : Promise.resolve(lease !== null && lease.version === expected ? put(record) : null),
    current: () => lease === null ? null : structuredClone(lease),
    failNext: (times) => {
      failures = times;
    },
    overwrite: (record) => {
      put(record);
    },
  };
}
