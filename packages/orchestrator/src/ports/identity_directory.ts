// Who a ryph user is on a forge, as the control plane asks it. Linked identities are auth's
// rows; this port is the reads the control plane needs: the subject permission checks ask
// about, who attribution names, the inbound-trigger lookup back to users, and whether a user can
// still act at all (and start work, by their current role).
//
// On GitLab a person is their account id, `<id>@<instance URL>`, as sign-in stored it — never
// their username. A username can be renamed away and registered by somebody else, who would
// then inherit every permission, gate and mention that was asked or written about it.

/**
 * Who a run's writes on a forge name as having asked for it: a login, which the report writes
 * as an @-mention, or — where a login would name the wrong person — the user's ryph name, as
 * plain text that pings nobody.
 */
export type Requester = { login: string } | { name: string };

export interface IdentityDirectory {
  /** The identity permission checks ask the forge about on `provider`, null when nothing is
   * linked: the login on GitHub, the DID on Radicle, the account id (`<id>@<url>`) of a link
   * made on the current instance on GitLab. Never shown to anybody as a name. */
  subjectFor(userId: string, provider: string): Promise<string | null>;
  /**
   * Who to name as the requester of a run's writes on `provider` — attribution, not access.
   * Usually the linked login; on GitLab the username GitLab gives the linked account NOW, read
   * by its id — never the one stored at link time, which may be somebody else's by now — and the
   * user's ryph name where it cannot be read. Where every user acts on the forge as ONE account (GitHub's user
   * mode) that login is the account's owner for everyone, so naming it would say the owner
   * asked for every run: the user's ryph name stands instead. Null when neither resolves.
   */
  requesterFor(userId: string, provider: string): Promise<Requester | null>;
  /** Every user who linked this login. Logins are reassignable on a provider, so more than one
   * is possible — the caller decides what that means. Always empty on GitLab, whose people are
   * found by account id alone (`userIdsForAccount`). */
  userIdsForLogin(provider: string, login: string): Promise<string[]>;
  /** The user who linked this account, by the forge's own stable id for it (GitLab's bare
   * numeric user id, which the directory spells on the current instance as sign-in stored it) —
   * empty when nobody did, or linked it under another instance URL. One at most: an account
   * links to one user. What an inbound event's actor is resolved by when the forge read their
   * id, since a login can be renamed and later taken by someone else. */
  userIdsForAccount(provider: string, accountId: string): Promise<string[]>;
  /**
   * Whether the user still exists and is active — false for a deleted or deactivated one. What
   * an unattended start (an automation's fire, a chat room's mention, a `/ryph` command) asks
   * of the person it acts for. Most of those also ask a forge about the person's linked login,
   * and a deleted user has none; a `local` repository asks no forge, so without this nothing
   * would stand between a removed owner and their room or automation firing on.
   */
  isActiveUser(userId: string): Promise<boolean>;
  /**
   * Whether the user is active AND their role, as stored NOW, holds `tasks:create` — expanded by
   * the same table that fills an access token's capabilities. The same doors ask it, next to
   * `isActiveUser`: they act for a person without a token of theirs in hand, so nothing else
   * holds a demoted owner's automations, a viewer's `/ryph` or a room set up before its owner's
   * role changed to what that person may do in the app.
   */
  mayStartTasks(userId: string): Promise<boolean>;
  /** The user's display name in ryph, as they set it — null for a deleted or deactivated one.
   * Raw text: whoever renders it sanitizes it for where it goes. */
  nameFor(userId: string): Promise<string | null>;
}
