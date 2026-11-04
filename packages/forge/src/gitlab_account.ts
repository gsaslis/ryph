// How ryph names a GitLab account or project, exported for the control plane: sign-in stores a
// link under the account spelling, the connect flow stores a project under the project spelling,
// and the orchestrator's identity directory spells an inbound event's actor the same way before
// looking it up.
//
// THE INVARIANT: on GitLab, a project and a user are named by their numeric id ON ONE INSTANCE —
// `<id>@<RYPH_GITLAB_URL>` — and never by a path or a username. A path or a username is a name its
// holder can give up and anybody can take next; an id is not, and GitLab's ids are per instance, so
// a bare one would make id 1234 of an instance the deployment is later pointed at the project or
// person 1234 was on the old one. The forge refuses every GitLab call whose project or subject is
// not spelled this way for the instance it is configured with.

/**
 * A GitLab account as ryph keys it: the user's id on THIS instance, `<id>@<RYPH_GITLAB_URL>`.
 * What a permission check, the sign-up group gate and a requester are asked about.
 */
export function gitlabAccountId(url: string, userId: string): string {
  return `${userId}@${url}`;
}

/**
 * A GitLab project as ryph addresses it: its id on THIS instance, `<id>@<RYPH_GITLAB_URL>` — the
 * `forgeId` every call, grant and git contact about a GitLab repo carries.
 */
export function gitlabProjectRef(url: string, projectId: string): string {
  return `${projectId}@${url}`;
}

const GITLAB_ID = /^([1-9][0-9]{0,18})@(.+)$/;

/**
 * The bare numeric id out of an account id or a project ref, when it names one on the instance at
 * `url` — null for anything else: a name, a bare id (which says no instance), or an id on another
 * instance, which names nobody here.
 */
export function gitlabIdOn(ref: string, url: string): string | null {
  const m = GITLAB_ID.exec(ref);
  return m !== null && m[2] === url ? m[1]! : null;
}

/** Whether `ref` is spelled as an id on some instance — the shape the wire schemas take. */
export function isGitlabRef(ref: string): boolean {
  return GITLAB_ID.test(ref) && ref.length <= 2_100;
}
