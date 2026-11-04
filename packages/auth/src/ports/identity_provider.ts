// An identity provider, as the auth core asks it: a forge today, any OAuth party in principle.
// Auth never dials a provider itself — the composition root hands it this port, implemented
// over whatever holds the client secret (the forge service, for a forge).

/** Three-valued for the resilience seam: a sign-up gate must tell "no" from "could not ask". */
/**
 * Whether a login belongs to the deployment's organization. `no-organization` is the deployment
 * with nothing installed yet: nobody can be a member of it, and unlike `unknown` no retry will
 * change that.
 */
export type ProviderMembership = "member" | "not-member" | "unknown" | "no-organization";

/** The person behind an authorization code, as the provider describes them. */
export interface ProviderIdentity {
  /** The provider's stable id for the account — logins rename, this does not. */
  accountId: string;
  login: string;
  name: string | null;
  /** Every address the provider itself has verified, primary first. Proof of nothing on its own:
   * `IdentityProvider.trustsEmails` says whether this provider's verification counts here. */
  verifiedEmails: string[];
}

/**
 * What the authorize leg pinned that the token leg must repeat, carried from the callback to the
 * provider untouched. GitLab requires the `redirect_uri` on both legs and takes a PKCE verifier;
 * GitHub's leg takes neither, so both are null there. Auth reads neither: the provider judges.
 */
export interface OAuthCodeLeg {
  redirectUri: string | null;
  codeVerifier: string | null;
}

/** A leg with nothing pinned — GitHub's. */
export const NO_CODE_LEG: OAuthCodeLeg = { redirectUri: null, codeVerifier: null };

export interface IdentityProvider {
  /** The provider names sign-in may be offered for, e.g. `["github"]`. */
  providers(): string[];
  /** Redeems a one-time code, with what its authorize leg pinned. Throws when the provider
   * refuses it, is unknown, or needs a leg value that is missing. */
  exchangeCode(provider: string, code: string, leg: OAuthCodeLeg): Promise<ProviderIdentity>;
  /** Whether the person the code exchange named belongs to the org (or is the user) the
   * provider's App is installed on, or the group the provider gates sign-up on. Both of the
   * exchange's names for them are handed over, and the provider asks by the one that cannot be
   * handed on: a GitLab username can be renamed away and registered by somebody else, so GitLab
   * asks about `accountId`. */
  isOrgMember(
    provider: string,
    who: { login: string; accountId: string },
  ): Promise<ProviderMembership>;
  /**
   * Whether the provider's word that an address is verified is proof this deployment acts on:
   * enough to sign into, claim or bind an invite to the account that holds the address. GitHub's
   * is — it confirms an address only by a link mailed to it. A self-managed GitLab's is not: its
   * default confirms whatever address is typed at sign-up, and an LDAP, SAML or OmniAuth account
   * is confirmed on the upstream's word. An untrusted provider's addresses decide nothing about
   * an existing account, and the account it registers does not hold them (`User.unprovenEmail`).
   */
  trustsEmails(provider: string): boolean;
}

/**
 * What a person pastes back to prove a proof-based account: who they claim to be, and the
 * signature that stands for it. Opaque to auth — only the provider knows how to read either.
 */
export interface IdentityProof {
  subject: string;
  signature: string;
}

/**
 * A provider with no authorization server to redirect to. Radicle has no OAuth and no accounts
 * at all — an identity IS a key — so the proof is a signature over a nonce THIS deployment
 * minted, in a namespace of ours, spendable once.
 *
 * Kept apart from `IdentityProvider` on purpose: these providers do not sign anyone IN (there is
 * no account to sign in to), they only attach an identity to an account that already exists, so
 * the sign-in page must never offer them.
 */
export interface ChallengeProvider {
  /** The providers an identity may be linked by signed challenge for, e.g. `["radicle"]`. */
  providers(): string[];
  /** The line the person runs to sign `nonce` — pasteable as it stands. */
  command(provider: string, nonce: string): string;
  /** The account behind `proof` over `nonce`, or null when nothing about it verifies. Never
   * throws for a bad proof: every way of failing is one answer at the surface. */
  verify(
    provider: string,
    nonce: string,
    proof: IdentityProof,
  ): Promise<ProviderIdentity | null>;
}
