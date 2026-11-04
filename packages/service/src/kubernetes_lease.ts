// A lease as a Kubernetes Lease (coordination.k8s.io/v1): the object client-go's leader election
// keeps, so `kubectl get lease` shows the holder the way an operator expects to read one. This
// only stores the record; lease.ts decides who holds it.
//
// It speaks to the API server through the caller's own client: each package already has one,
// with its auth, CA and request timeout. The timeout matters: lease.ts reports a lapsed lease on
// time without it, but a hung request is what holds up the renewals queued behind it and the
// release at shutdown, so the client must abandon one well inside the renew deadline.

import type { LeaseRecord, LeaseStore, VersionedLease } from "./lease_store.ts";

/** The one request this needs: JSON in and out, a non-2xx thrown as an error with its `status`. */
export interface LeaseApi {
  call(method: string, path: string, body?: unknown): Promise<unknown>;
}

/** Where the Lease is. */
export interface LeaseLocation {
  namespace: string;
  name: string;
}

export interface LeaseManifest {
  apiVersion: "coordination.k8s.io/v1";
  kind: "Lease";
  metadata: { name: string; namespace?: string; resourceVersion?: string };
  spec: {
    holderIdentity?: string;
    leaseDurationSeconds?: number;
    renewTime?: string;
    leaseTransitions?: number;
  };
}

/**
 * A Lease's times are MicroTime: RFC 3339 with exactly six fractional digits. The API server
 * refuses the three `toISOString` writes (measured on GKE 1.35: `cannot parse ".123Z" as
 * ".000000"`). Exported for the test. Pure.
 */
export function microTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`not a time: ${JSON.stringify(iso)}`);
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, (_, millis) => `.${millis}000Z`);
}

/** The Lease for a record: at `version` for a replace, without one for a create. Pure. */
export function leaseManifest(
  record: LeaseRecord,
  opts: LeaseLocation,
  version?: string,
): LeaseManifest {
  return {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      ...(version === undefined ? {} : { resourceVersion: version }),
    },
    spec: {
      // Empty once released, as client-go writes it.
      holderIdentity: record.holder ?? "",
      leaseDurationSeconds: Math.ceil(record.durationMs / 1000),
      renewTime: microTime(record.renewedAt),
      leaseTransitions: record.transitions,
    },
  };
}

/** A Lease as the record and version the core reads. Pure. */
export function leaseRecord(manifest: LeaseManifest): VersionedLease {
  const version = manifest.metadata.resourceVersion;
  if (!version) throw new Error("kubernetes answered with a Lease that has no resourceVersion");
  const spec = manifest.spec ?? {};
  return {
    version,
    record: {
      holder: spec.holderIdentity || null,
      durationMs: (spec.leaseDurationSeconds ?? 0) * 1000,
      renewedAt: spec.renewTime ?? new Date(0).toISOString(),
      transitions: spec.leaseTransitions ?? 0,
    },
  };
}

/** Whether a request failed with this HTTP status, whichever client threw it. */
function failedWith(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === status;
}

export function kubernetesLeaseStore(api: LeaseApi, at: LeaseLocation): LeaseStore {
  const leases = `/apis/coordination.k8s.io/v1/namespaces/${at.namespace}/leases`;
  const lease = `${leases}/${at.name}`;

  /** One status read as `null` — no lease yet (404), or someone else's write got there first (409). */
  const orNull = async (
    status: number,
    request: () => Promise<unknown>,
  ): Promise<VersionedLease | null> => {
    try {
      return leaseRecord(await request() as LeaseManifest);
    } catch (err) {
      if (failedWith(err, status)) return null;
      throw err;
    }
  };

  return {
    kind: "kubernetes",
    read: () => orNull(404, () => api.call("GET", lease)),
    create: (record) => orNull(409, () => api.call("POST", leases, leaseManifest(record, at))),
    // A PUT carrying the resourceVersion just read is the API server's own optimistic lock: it
    // answers 409 if anyone has written since.
    replace: (record, version) =>
      orNull(409, () => api.call("PUT", lease, leaseManifest(record, at, version))),
  };
}
