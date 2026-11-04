// How a verified bundle becomes a change request — the one part of submission that is not a
// question but a DELIVERY, and the part no two forges do alike.
//
// GitHub's is a git push: seed a scratch repo, fetch the bundle into it, push the output branch
// to the upstream, then open (or adopt) the pull request — or, for an existing one, push onto
// its own branch under a lease. Radicle's is an upload to the node's bridge, which runs
// `git push rad` against shared storage and answers with a patch id. A `local` repo's is a push
// into a directory on this machine, and the change request is the branch itself. All take the
// same bundle and answer the same pair, which is what lets `http/service.ts` hold one submit
// route.
//
// Invariants (the GitHub implementation's, and the bar a second one has to clear):
// - the head that leaves is checked against the head intake recorded, BEFORE anything is
//   published: the provenance anchor is verified where the bytes leave, not assumed
// - delivering the same bundle twice converges on one change request, never a second
// - a failure says whether it is TERMINAL; the submit sweep's clock depends on it

import type { HookFilesReport } from "../core/hook_files.ts";
import type { BodyEmbed, ForgeRepo, ProviderRegistry } from "./forge_api.ts";

/** One bundle, on its way out. Everything a delivery needs and nothing about how it travels. */
export interface ChangeDelivery {
  /** Which repo, and as whom. */
  repo: ForgeRepo;
  /** The repo's upstream clone URL, as the connected repo row holds it. A transport that
   * pushes uses it; one that hands the bundle to a node of its own ignores it. */
  repoUrl: string;
  /** The verified bundle, staged on local disk. The transport reads it and does not own it —
   * the caller stages it and removes it. */
  bundlePath: string;
  /** The one output branch the bundle carries. */
  branchName: string;
  /** The base the change asks to merge into — and whose history satisfies the bundle's
   * prerequisites. */
  baseBranch: string;
  /** The head intake recorded: what must be published, exactly. */
  headSha: string;
  title: string;
  description: string;
  /** The description's images, for a forge that stores them with the change request (a Radicle
   * embed); empty everywhere else — see `BodyEmbed`. */
  embeds: BodyEmbed[];
  /** Open it unready for review. False everywhere today; a transport that cannot express it
   * ignores it rather than refusing the delivery. */
  draft: boolean;
  /** Set: update THIS existing change request rather than open a new one — a second generation
   * of a run's work. Null: open one. */
  existingRef: string | null;
  /** May `existingRef` be a pull request whose branch lives in a fork? The connected repo's own
   * switch (`allowForkPushes`), read by the control plane when it submits. Off or absent:
   * a fork's branch is refused whatever the pull request allows. On: pushed only where the
   * transport's own push-time checks pass too. */
  allowForkPush?: boolean;
  /** The hook files a person approved this patch WITH — repo-relative paths, exactly as a
   * `needs-approval` answer named them. Only a `local` delivery reads it (core/hook_files.ts on
   * why); absent is none approved, so a patch that touches a hook file is held. */
  approvedHookPaths?: readonly string[];
}

export type ChangeDeliveryOutcome =
  /** `ref` is the change request's address as its forge spells it; `url` is where a human
   * reads it, or null where there is no such page — a branch delivered into a repository on
   * this machine (`local`) is addressed by its name alone. */
  | { kind: "delivered"; ref: string; url: string | null }
  /** `ended`: refused because the change request it was to go onto merged or closed — the
   * control plane may not have heard yet (GitHub's user mode has no webhooks). */
  | { kind: "failed"; message: string; terminal: boolean; ended?: "merged" | "closed" }
  /** Nothing was written: the patch touches hook files of the target repository a person has
   * not approved (`local` only — core/hook_files.ts). It goes through once the person approves
   * it with every path in `touched`; `more` says the list was cut, `hooksPaths` which hook
   * folders were looked at. Repo-relative paths only. */
  | ({ kind: "needs-approval" } & HookFilesReport);

export interface ChangeTransport {
  deliver(change: ChangeDelivery): Promise<ChangeDeliveryOutcome>;
}

export type ChangeTransportRegistry = ProviderRegistry<ChangeTransport>;
