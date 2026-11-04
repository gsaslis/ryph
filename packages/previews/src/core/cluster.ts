// Several previews pods, and which of them holds a run. State stays in memory, so every preview of
// a run lives on one pod, its OWNER, and every other pod sends what it gets for that run there.
// The owner is a pure function of the run's shard (keys.ts) and the replica count, so no pod asks
// another where anything is: the control plane's calls carry the run, and a preview's Host starts
// with its shard. A runner needs no forwarding at all: the owner's registration answer names the
// owner's own tunnel address, and the runner dials it.
//
// Rendezvous hashing: each ordinal scores the shard and the highest score owns it. Growing from N
// to N+1 pods moves only the runs the new pod now wins (about 1 in N+1), and shrinking moves only
// the runs of the pods that left.
import { createHash } from "node:crypto";

/** One pod as its peers, and runs, reach it: by its own Service, never the shared one. */
export interface Peer {
  host: string;
  /** Its tunnel listener (`/tunnel/<ticket>`): where its runs' runners dial. */
  tunnelPort: number;
  /** Its API listener (`/internal/*`): where another pod forwards the control plane's calls. */
  apiPort: number;
  /** Its peer listener: browser requests another pod forwarded. */
  peerPort: number;
}

export interface Cluster {
  /** This pod's ordinal: an index into `peers`. */
  self: number;
  /** Every pod by ordinal, this one included; the length is the replica count. */
  peers: readonly Peer[];
}

/** The ordinal that owns `shard` among `replicas` pods. */
export function ownerOf(shard: string, replicas: number): number {
  let best = 0;
  let top = -1;
  for (let ordinal = 0; ordinal < replicas; ordinal++) {
    // 48 bits, exact in a double. A tie goes to the lower ordinal, the same on every pod.
    const score = parseInt(
      createHash("sha256").update(`${shard}:${ordinal}`).digest("hex").slice(0, 12),
      16,
    );
    if (score > top) [best, top] = [ordinal, score];
  }
  return best;
}

/** Every peer's host from the template the chart renders (`{ordinal}` replaced), or null when the
 * template does not name the ordinal exactly once or yields something that is not a hostname. */
export function peerHosts(template: string, replicas: number): string[] | null {
  if (template.split("{ordinal}").length !== 2) return null;
  const hosts = Array.from({ length: replicas }, (_, k) => template.replace("{ordinal}", `${k}`));
  const hostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  return hosts.every((host) => host.length <= 253 && hostname.test(host)) ? hosts : null;
}

/** Where a runner dials `peer`'s tunnels: its tunnel listener, by its own address. */
export const tunnelBase = (peer: Peer): string => `ws://${peer.host}:${peer.tunnelPort}`;

/** The peer credential, on a request one pod forwards to another's peer listener. The owner takes
 * it off before anything else reads the request, and the dev server never sees it either way. */
export const PEER_HEADER = "x-ryph-previews-peer";
/** On a browser request one pod relays to another's peer listener: how many milliseconds are left
 * of the request's wait for a stream (WAIT_MS in @ryph/tunnel), so the owner waits only that and
 * a relayed request waits about as long as a direct one in all. Only the peer listener reads it,
 * behind the peer credential; every listener takes it off. */
export const WAIT_HEADER = "x-ryph-previews-wait";
/** On a call one pod forwards to another's API listener, in place of the control plane's
 * bearer: the forward credential (keys.ts), which only the pods hold. A call that carries it has
 * hopped once, and is never forwarded again. */
export const HOP_HEADER = "x-ryph-previews-hop";
/** On a browser request one pod relays to another's peer listener: the browser's own `Connection`
 * header, which the relay itself cannot carry (it is hop-by-hop, and the relay's connection is
 * its own). The relay keeps the headers it names, so the owner's gate judges what the browser
 * sent; the owner puts this back as the request's `Connection`, so those headers are dropped on
 * the way to the dev server exactly as on a direct request. Only the peer listener reads it, behind
 * the peer credential; every listener takes it off. */
export const CONNECTION_HEADER = "x-ryph-previews-connection";
