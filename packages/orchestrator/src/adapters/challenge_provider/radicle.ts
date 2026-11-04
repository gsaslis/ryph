// @ryph/auth's `ChallengeProvider` on Radicle: the one forge with no OAuth to borrow.
//
// Radicle has no authorization server and no accounts at all — an identity IS a key — so the
// proof is a signature over a nonce auth minted, in a namespace of ours. Auth holds the nonce
// and spends it; this adapter knows only how to ask the signature who made it, which is
// `helpers/sshsig.ts` and nothing else: no allowed_signers file, no subprocess, no network.
//
// Wired only where a Radicle bridge is configured — a card offering a proof this deployment
// could never use is a form that cannot work.

import type { ChallengeProvider, ProviderIdentity } from "@ryph/auth";
import { verifySshSig } from "../../helpers/sshsig.ts";

/** The SSHSIG namespace every Radicle link signature is made and verified in. It is what keeps
 * a signature the person made for some other tool from counting as a link here. */
const NAMESPACE = "ryph";

/** `did:key:z…` — an ed25519 key in multibase base58btc, the only DID Radicle uses. Checked
 * before anything else, because a malformed one can only ever fail to verify. */
const DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;

export function radicleChallengeProvider(): ChallengeProvider {
  return {
    providers: () => ["radicle"],
    // Pasteable as it stands. `-n ryph` is the namespace the verifier checks, and
    // `-f ~/.radicle/keys/radicle` is where `rad auth` puts the key.
    command: (_provider, nonce) =>
      `printf %s '${nonce}' | ssh-keygen -Y sign -n ${NAMESPACE} -f ~/.radicle/keys/radicle -`,
    async verify(_provider, nonce, proof): Promise<ProviderIdentity | null> {
      const did = proof.subject.trim();
      if (!DID.test(did)) return null;
      const proven = await verifySshSig(proof.signature, {
        did,
        namespace: NAMESPACE,
        message: nonce,
      });
      if (!proven) return null;
      // The DID is both the stable account id and the login: a Radicle alias is a self-chosen
      // label anyone may change or share, so it is not an identity to resolve anything by.
      return { accountId: did, login: did, name: null, verifiedEmails: [] };
    },
  };
}
