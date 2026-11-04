// The hosting lease as a Kubernetes Lease, through @ryph/service's store over this package's own
// API client, so `kubectl -n ryph-tools get lease mcp-hosting` shows the holder.
//
// It lives beside what it guards, in the tools namespace, under the Role the gateway already has
// there: `create` on leases, and `get` and `update` on this one name (deploy/helm/ryph/templates/tools.yaml).

import { kubernetesLeaseStore, type LeaseStore } from "@ryph/service";
import { kubernetesApi, type KubernetesApiOptions } from "../kubernetes_api.ts";

/** The one lease hosting takes, named in the Role that grants it. */
export const HOSTING_LEASE_NAME = "mcp-hosting";

export interface HostingLeaseStoreOptions extends KubernetesApiOptions {
  namespace: string;
  name: string;
  /**
   * How long one request may go unanswered before it is abandoned. The lease reports a lapsed
   * lease on time without it; this is what ends the hung request, so the renewals queued behind
   * it — and the release at shutdown — are not stuck for good. Half client-go's renew deadline:
   * a renewal is at most two requests (the replace, and the read after a conflict).
   */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export function hostingLeaseStore(
  opts: HostingLeaseStoreOptions,
  deps: { fetch?: typeof fetch } = {},
): LeaseStore {
  const api = kubernetesApi(opts, deps.fetch, {
    timeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });
  return kubernetesLeaseStore(api, opts);
}
