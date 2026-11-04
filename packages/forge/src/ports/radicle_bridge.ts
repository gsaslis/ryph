// What only a Radicle node can answer, kept OFF the shared `ForgeApi` for the reason
// `github_app.ts` keeps installations off it: seeding, an identity document and a node's own
// DID are not a forge's concepts, they are Radicle's. GitHub has no counterpart to any of
// them, and putting them on the port every provider implements would make the GitHub adapter
// a pile of "not applicable" throws.
//
// Wired only where `RYPH_RADICLE_URL` names a bridge, and dialed only by the connect flow —
// the orchestrator asks, this package acts.

/** A repository's identity document as the bridge read it out of verified storage, plus what
 * it means for THIS deployment. The connect flow's whole answer: who may write, whether we
 * may fetch at all, and the two commands a human may have to paste. */
export interface RadicleRepoInfo {
  rid: string;
  name: string;
  description: string;
  defaultBranch: string;
  /** Delegate DIDs, in document order — Radicle's version of "who has write access". */
  delegates: string[];
  threshold: number;
  visibility: "public" | "private";
  /** For a private repo, the DIDs allowed to fetch it. Empty for a public one. */
  allow: string[];
  /** This deployment's own identity, so a caller never needs a second round trip. */
  self: { did: string; nid: string; alias: string | null };
  /** Whether OUR DID is a delegate — the capability probe the tool surface greys out on. */
  isDelegate: boolean;
  /** Whether we may fetch it: public, or private with our DID in `allow`. */
  isAllowed: boolean;
}

/**
 * What a seed answers when the node came back with no identity document at all.
 *
 * This is one answer for two situations the Radicle wire cannot tell apart. A private
 * repository refuses the fetch at the responding node and the initiator sees only a broken
 * handshake; it is also absent from every inventory announcement, so the routing table stays
 * empty. A repository nobody is offering looks exactly the same. So the honest answer carries
 * both readings: the command that fixes the first, and `seeds` — the only evidence there is
 * that somebody out there does hold it.
 */
export interface RadicleRepoUnavailable {
  kind: "unavailable";
  rid: string;
  /** ryph's own DID — the one a delegate would have to add to the allow list. */
  did: string;
  /** `rad id update --allow <did>`, ready to paste. */
  command: string;
  /** Peers the routing table claims hold it; null when the node could not be asked. Above zero
   * means a peer IS offering the repository and our fetch still came back empty — which is
   * what a refusal looks like from this side. */
  seeds: number | null;
  /** How many of those the node was CONNECTED to and actually asked. Zero means nothing that
   * claims to hold it was reachable, which is NOT the same as being refused by something that
   * has it — and only the second reading points at a private repository. */
  triedSeeds: number;
  /** The node's own words for why the fetch produced nothing. */
  reason: string;
}

/**
 * A user-mode bridge refused to seed a repository its owner's node explicitly BLOCKS
 * (`rad block`): their decision about their own node, which ryph neither overrides nor touches.
 * `command` lifts it; `reason` says so in a sentence fit to show.
 */
export interface RadicleRepoBlocked {
  kind: "blocked";
  rid: string;
  command: string;
  reason: string;
}

export type RadicleSeedOutcome =
  | { kind: "seeded"; repo: RadicleRepoInfo }
  | RadicleRepoUnavailable
  | RadicleRepoBlocked;

/** The node's own identity. `node` is null when the node process is unreachable — writes
 * still work (they are local storage commits), only gossip is delayed. */
export interface RadicleIdentity {
  did: string;
  nid: string;
  alias: string | null;
  node: { running: boolean; sessions: number } | null;
  /** How the bridge says it acts — `deployment` from one too old to say. */
  mode: RadicleBridgeMode;
}

/**
 * Whose node the bridge stands beside. `deployment`: its own, signing with the deployment's key.
 * `user`: a person's own node and identity, which every write on every repository connected
 * through it is signed as — so the control plane holds connecting one to a higher bar.
 */
export type RadicleBridgeMode = "deployment" | "user";

export interface RadicleBridgeApi {
  /** How the bridge acts — configured beside it, never asked over the wire. */
  readonly mode: RadicleBridgeMode;
  /** Who this deployment is on the Radicle network. */
  identity(): Promise<RadicleIdentity>;
  /** The repo's identity document, read live. Throws a terminal `ForgeApiError` when the node
   * holds no such repository. */
  describeRepo(repoRef: string): Promise<RadicleRepoInfo>;
  /** Seed with scope `all` — the one scope that lets a stranger's `/ryph` comment reach us —
   * and fetch once. Answers the identity document the fetch produced, or why there is none. */
  seedRepo(repoRef: string): Promise<RadicleSeedOutcome>;
  /** Stop seeding. Idempotent: unseeding what was never seeded is a success. */
  unseedRepo(repoRef: string): Promise<void>;
}
