// GitLab's connect surface (`GitlabConnectApi`): the projects the token reaches, one project
// described live, sign-in through the OAuth application, the sign-up group gate and the
// per-project webhook tokens — plus the membership read `checkPermission` shares with it, which
// asks about a project or group and a person by their ids alone.

import type { OrgMembership } from "../../core/types.ts";
import { ForgeApiError } from "../../ports/forge_api.ts";
import {
  GITLAB_HOOK_LABEL,
  type GitlabConnectApi,
  type GitlabMode,
  type GitlabProjectListing,
} from "../../ports/gitlab.ts";
import type { OAuthIdentity } from "../../ports/github_app.ts";
import { deriveScopedSecret } from "@ryph/webhooks";
import { gitlabAccountId, gitlabIdOn } from "../../gitlab_account.ts";
import { type GitlabContext, hasMore, messageOf } from "./gitlab_client.ts";

/** GitLab's access levels that matter here. */
export const DEVELOPER = 30;
export const MAINTAINER = 40;

/** Pages of 100 the project listings walk. */
const PROJECT_PAGES = 50;

/**
 * The level a `members/all/:user_id` answer grants: its `access_level` while the membership is
 * active (`membership_state` absent, as before GitLab reported it, or `active`) and the account
 * is (`state` absent or `active`); null for one awaiting approval under a seat or user cap, or a
 * blocked, banned or deactivated account — GitLab lists those with the level they would hold,
 * and grants none of it. NaN when the answer has no level at all, which is no answer.
 */
// oxlint-disable-next-line no-explicit-any
function grantedLevel(body: any): number | null {
  if (typeof body?.access_level !== "number") return Number.NaN;
  const membership = body.membership_state;
  const account = body.state;
  if (membership !== undefined && membership !== null && membership !== "active") return null;
  if (account !== undefined && account !== null && account !== "active") return null;
  return body.access_level;
}

/**
 * A member's access level on a project or group, by numeric ids alone — `on` is
 * `projects/<id>` or `groups/<id>` — inherited and invited levels too; null on GitLab's 404 (no
 * such member) and for a membership that grants nothing (`grantedLevel`). Nobody is ever looked
 * up by username: a username can be renamed away and registered by somebody else, who would then
 * be answered for.
 */
export function memberships(ctx: GitlabContext): {
  accessLevel(on: string, userId: string): Promise<number | null>;
} {
  const { client } = ctx;
  const accessLevel = async (on: string, userId: string): Promise<number | null> => {
    if (!/^(projects|groups)\/[1-9][0-9]{0,18}$/.test(on) || !/^[1-9][0-9]{0,18}$/.test(userId)) {
      throw new ForgeApiError(`a membership is read by ids, not ${on} / ${userId}`, true);
    }
    const res = await client.call("GET", `/${on}/members/all/${userId}`);
    if (res.status === 404) return null;
    const level = res.status === 200 ? grantedLevel(res.body) : Number.NaN;
    if (Number.isNaN(level)) throw client.refusal("reading a membership", res);
    return level;
  };
  return { accessLevel };
}

export interface GitlabConnectOptions {
  mode: GitlabMode;
  webhookSecret: string | null;
  oauth: { clientId: string; clientSecret: string } | null;
  /** `RYPH_GITLAB_GROUP`'s numeric id, as the boot resolved it; null when unset. */
  groupId: string | null;
  accessLevel(on: string, userId: string): Promise<number | null>;
}

export function gitlabConnect(ctx: GitlabContext, opts: GitlabConnectOptions): GitlabConnectApi {
  const { client, self, diag, url } = ctx;
  const { mode, accessLevel } = opts;
  // oxlint-disable-next-line no-explicit-any
  const listingOf = (raw: any, admin: boolean): GitlabProjectListing | null => {
    if (
      typeof raw?.id !== "number" || typeof raw.path_with_namespace !== "string" ||
      typeof raw.http_url_to_repo !== "string" || typeof raw.web_url !== "string" ||
      !["public", "internal", "private"].includes(raw.visibility)
    ) {
      return null;
    }
    return {
      id: String(raw.id),
      pathWithNamespace: raw.path_with_namespace,
      url: raw.http_url_to_repo,
      webUrl: raw.web_url,
      defaultBranch: typeof raw.default_branch === "string" ? raw.default_branch : null,
      visibility: raw.visibility,
      admin,
    };
  };

  /** Every project of one `/projects` query, walked to its end or the ceiling. */
  // oxlint-disable-next-line no-explicit-any
  const walkProjects = async (query: string): Promise<any[]> => {
    // oxlint-disable-next-line no-explicit-any
    const out: any[] = [];
    for (let page = 1; page <= PROJECT_PAGES; page++) {
      const res = await client.call(
        "GET",
        `/projects?${query}&order_by=id&sort=asc&per_page=100&page=${page}`,
      );
      if (res.status !== 200 || !Array.isArray(res.body)) {
        throw client.refusal("listing GitLab projects", res);
      }
      out.push(...res.body);
      if (!hasMore(res, 100)) return out;
    }
    diag.warn("gitlab.projects_capped", { pages: PROJECT_PAGES, projects: out.length });
    return out;
  };

  const requireOAuth = () => {
    if (mode.mode !== "bot" || opts.oauth === null) {
      throw new ForgeApiError(
        mode.mode === "user"
          ? "GitLab sign-in is not offered in user mode: the token's person is every user here"
          : "no GitLab OAuth application is configured (RYPH_GITLAB_CLIENT_ID / _SECRET)",
        true,
      );
    }
    return opts.oauth;
  };

  return {
    mode,
    self,

    async listProjects() {
      // The reach, and — asked by GitLab, which counts inherited and group-shared access the
      // way a membership check does — which of it the account administers.
      const [reach, administered] = await Promise.all([
        walkProjects(
          mode.mode === "bot" ? `membership=true&min_access_level=${DEVELOPER}` : "membership=true",
        ),
        walkProjects(`membership=true&min_access_level=${MAINTAINER}`),
      ]);
      const admin = new Set(administered.map((p: { id?: unknown }) => p?.id));
      return reach.flatMap((raw) => {
        const listed = listingOf(raw, admin.has(raw?.id));
        return listed === null ? [] : [listed];
      });
    },

    async describeProject(id) {
      // A path is looked up here and nowhere else: it is the connect flow binding the name a
      // person chose just now to the id everything after is addressed by.
      const byId = /^[1-9][0-9]{0,18}$/.test(id);
      const res = await client.call("GET", `/projects/${byId ? id : encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (res.status !== 200) throw client.refusal(`reading ${id}`, res);
      const found = typeof res.body?.id === "number" ? String(res.body.id) : null;
      if (found === null || (byId && found !== id)) {
        throw new ForgeApiError(`reading ${id}: GitLab answered with another project`, false);
      }
      const level = await accessLevel(`projects/${found}`, self.id);
      const listed = listingOf(res.body, level !== null && level >= MAINTAINER);
      if (listed === null) {
        throw new ForgeApiError(`reading ${id}: the forge's answer is missing fields`, false);
      }
      return listed;
    },

    async exchangeOAuthCode(code, redirectUri, codeVerifier): Promise<OAuthIdentity> {
      const app = requireOAuth();
      const form = new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        ...(codeVerifier === null ? {} : { code_verifier: codeVerifier }),
      });
      const res = await client.send(`${url}/oauth/token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => null)) ?? {};
      if (!res.ok || typeof body.access_token !== "string") {
        throw new ForgeApiError(
          `the GitLab OAuth exchange failed (${res.status}): ${messageOf(body)}`,
          res.status >= 400 && res.status < 500,
        );
      }
      const as = (path: string) =>
        client.send(`${client.apiBase}${path}`, {
          method: "GET",
          headers: { authorization: `Bearer ${body.access_token}`, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
      const userRes = await as("/user");
      const user = (await userRes.json().catch(() => null)) ?? {};
      if (
        userRes.status !== 200 || typeof user.username !== "string" || typeof user.id !== "number"
      ) {
        throw new ForgeApiError(`resolving the GitLab user failed (${userRes.status})`, false);
      }
      // Only confirmed addresses: an unconfirmed one is anybody's claim. The primary address
      // counts when the account itself is confirmed; `/user/emails` lists it too (verified on
      // GitLab 17.11, for a personal and an OAuth token alike).
      const verified = new Set<string>();
      if (typeof user.email === "string" && user.email !== "" && user.confirmed_at != null) {
        verified.add(user.email);
      }
      const emailsRes = await as("/user/emails");
      const emails = (await emailsRes.json().catch(() => null)) ?? [];
      if (emailsRes.status === 200 && Array.isArray(emails)) {
        for (const e of emails) {
          if (typeof e?.email === "string" && e.confirmed_at != null) verified.add(e.email);
        }
      } else {
        diag.warn("gitlab.emails_unanswerable", { login: user.username, status: emailsRes.status });
      }
      return {
        accountId: gitlabAccountId(url, String(user.id)),
        login: user.username,
        name: typeof user.name === "string" ? user.name : null,
        verifiedEmails: [...verified],
        // The user token is discarded: sign-in needs who, not their reach.
        accessToken: null,
      };
    },

    async checkGroupMembership(accountId): Promise<OrgMembership | null> {
      if (opts.groupId === null) return null;
      // An account on this instance, by its id: never a username, which its holder can give up
      // and anybody can register next — and pass the gate as whoever held it.
      const userId = gitlabIdOn(accountId, url);
      if (userId === null) {
        diag.warn("gitlab.membership_not_an_account", { group: opts.groupId });
        return "not-member";
      }
      try {
        const level = await accessLevel(`groups/${opts.groupId}`, userId);
        return level === null ? "not-member" : "member";
      } catch (err) {
        diag.warn("gitlab.membership_unreachable", { group: opts.groupId, err: String(err) });
        return "unknown";
      }
    },

    async describeUser(accountId) {
      const userId = gitlabIdOn(accountId, url);
      if (userId === null) {
        throw new ForgeApiError("not a GitLab account on this instance", true);
      }
      const res = await client.call("GET", `/users/${userId}`);
      if (res.status === 404) return null;
      if (
        res.status !== 200 || typeof res.body?.username !== "string" || res.body.username === ""
      ) {
        throw client.refusal(`reading user ${userId}`, res);
      }
      if (String(res.body.id) !== userId) {
        throw new ForgeApiError(`GitLab answered user ${userId} with another account`, false);
      }
      return { login: res.body.username };
    },

    async hookToken(projectId, generation) {
      if (opts.webhookSecret === null) {
        throw new ForgeApiError(
          mode.mode === "user"
            ? "GitLab user mode takes no webhooks: merges are polled"
            : "no GitLab webhook secret is configured (RYPH_GITLAB_WEBHOOK_SECRET)",
          true,
        );
      }
      if (!/^[0-9]+$/.test(projectId)) {
        throw new ForgeApiError(`${JSON.stringify(projectId)} is not a GitLab project id`, true);
      }
      if (!Number.isSafeInteger(generation) || generation < 1 || generation > 9_999_999_999) {
        throw new ForgeApiError(`${generation} is not a webhook token generation`, true);
      }
      return await deriveScopedSecret(
        opts.webhookSecret,
        GITLAB_HOOK_LABEL,
        projectId,
        String(generation),
      );
    },
  };
}
