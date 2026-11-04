/**
 * Whether a cluster is one refusals.ts may change objects on. Not a flag's say-so: the context is
 * a local kind or k3d cluster (its name, and an API server on loopback) and the release runs on
 * the dev state (`devState.enabled`), whose sealing key guards nothing of value. Pure, so the
 * refusals are tested without a cluster (throwaway_test.ts).
 */

/**
 * The hosts a local kind or k3d API server listens on. `URL.hostname` keeps IPv6's brackets.
 * k3d v5 writes `https://0.0.0.0:<port>`: a client dialling 0.0.0.0 reaches this machine.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]);

export interface ThrowawayFacts {
  /** `--kube-context`. */
  context: string;
  /** `--throwaway=<ctx>`: must name the context again. */
  throwaway: string | undefined;
  /** The context's API server, from `kubectl config view --minify`. */
  server: string;
}

/** Why this context is no throwaway cluster, from the kubeconfig alone; null when it is. */
export function contextRefusal({ context, throwaway, server }: ThrowawayFacts): string | null {
  if (throwaway !== context) {
    return `--throwaway=<ctx> must name the context again (--throwaway=${context}), ` +
      "to say this cluster may have a Secret deleted and restored";
  }
  if (!/^(kind|k3d)-/.test(context)) {
    return `context ${context} is not a kind or k3d cluster (kind-… or k3d-…)`;
  }
  let host: string;
  try {
    host = new URL(server).hostname;
  } catch {
    return `context ${context}'s API server is not a URL`;
  }
  if (!LOOPBACK.has(host)) {
    return `context ${context}'s API server ${host} is not on loopback: not a local cluster`;
  }
  return null;
}

/** Why the release is no throwaway, from its computed values; null when it runs on the dev state. */
export function releaseRefusal(values: unknown): string | null {
  const devState = (values as { devState?: { enabled?: unknown } } | null)?.devState;
  return devState?.enabled === true
    ? null
    : "the release does not run on the dev state (devState.enabled): its sealing key may guard " +
      "real credentials";
}
