import { z } from "zod";
import { apiCall } from "./call";
import {
  type CommandAllowlistEntry,
  commandAllowlistEntrySchema,
  type ConnectedRepo,
  connectedRepoSchema,
  type GithubRepo,
  githubRepoSchema,
  type Installation,
  type InstallationRepo,
  installationRepoSchema,
  installationSchema,
  type RadicleRepoInfo,
  radicleRepoInfoSchema,
  type SubmissionPolicy,
} from "./types";

/**
 * A GitLab project the deployment's token reaches, as the connect step lists it: the forge's
 * `GitlabProjectListing` plus the live connected row for it when there is one, the way GitHub's
 * user-mode listing carries it.
 */
export const gitlabProjectSchema = z.object({
  /** GitLab's numeric project id, as text: what the webhook URL and token are bound to. */
  id: z.string(),
  /** `path_with_namespace`, nested: the connected repo's `repoRef`. */
  pathWithNamespace: z.string(),
  url: z.string(),
  webUrl: z.string(),
  /** Null for an empty project, which has nothing to branch from yet. */
  defaultBranch: z.string().nullable(),
  visibility: z.enum(["public", "internal", "private"]),
  /** Whether the token holds Maintainer or above on it. */
  admin: z.boolean(),
  connectedRepoId: z.string().nullable(),
});
export type GitlabProject = z.infer<typeof gitlabProjectSchema>;

/**
 * What a Maintainer pastes into a GitLab project's Webhooks page: the address deliveries go to
 * (`<origin>/v1/hooks/gitlab?project=<id>&generation=<n>`) and the secret token derived for that
 * one project at that generation, and the branch push events are limited to. Shown only to someone who may connect the repo.
 * The triggers and SSL verification are fixed, so the steps name them rather than the wire.
 */
export const gitlabHookSchema = z.object({
  /** Null where the deployment has no public address configured (`RYPH_APP_URL`). */
  url: z.string().nullable(),
  token: z.string(),
  /** Which token this is: rotating moves to the next one and refuses every earlier URL and token. */
  generation: z.number().int(),
  /** The default branch; null for a project that has none yet. */
  pushBranchFilter: z.string().nullable(),
});
export type GitlabHook = z.infer<typeof gitlabHookSchema>;

export type ConnectRepoInput = {
  installationId: string;
  /** `owner/name` — GitHub's spelling of a repo address. */
  repoRef: string;
  submissionPolicy?: SubmissionPolicy;
};

export type ConnectRadicleRepoInput = {
  /** A `rad:` RID, which is the whole address — there is no owner and no name in it. */
  repoRef: string;
  submissionPolicy?: SubmissionPolicy;
};

export async function getConnectedRepos(f = fetch): Promise<ConnectedRepo[]> {
  const res = await apiCall(f, "/v1/connected-repos");
  return z.object({ repos: z.array(connectedRepoSchema) }).parse(res).repos;
}

export async function getConnectedRepo(f = fetch, id: string): Promise<ConnectedRepo | null> {
  const repos = await getConnectedRepos(f);
  return repos.find((r) => r.id === id) ?? null;
}

export async function connectRepo(f = fetch, input: ConnectRepoInput): Promise<ConnectedRepo> {
  return connectedRepoSchema.parse(
    await apiCall(f, "/v1/connected-repos", {
      method: "POST",
      body: JSON.stringify({ provider: "github", ...input }),
    }),
  );
}

/**
 * Connecting a Radicle repo seeds it on ryph's node, so the answer carries what the node then
 * knows about it — delegates, visibility, and whether anyone has to follow ryph for its patches
 * to be visible at all. The connect screen says all of that in words; nothing else can.
 *
 * The body is spelled out key by key rather than spread, because `installationId` is GitHub's
 * and only GitHub's: the platform refuses a Radicle connect that carries the key AT ALL, and a
 * spread of a wider object is exactly how an undefined one would sneak in.
 */
export async function connectRadicleRepo(
  f = fetch,
  input: ConnectRadicleRepoInput,
): Promise<{ repo: ConnectedRepo; radicle: RadicleRepoInfo }> {
  const body: Record<string, string> = { provider: "radicle", repoRef: input.repoRef };
  if (input.submissionPolicy !== undefined) body.submissionPolicy = input.submissionPolicy;
  const res = await apiCall(f, "/v1/connected-repos", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return z.object({ repo: connectedRepoSchema, radicle: radicleRepoInfoSchema }).parse(res);
}

/**
 * Connect a GitHub repo where ryph acts as one person on GitHub: no installation, and the
 * address, URL and default branch are read off GitHub server-side. Spelled key by key like the
 * Radicle connect, so an `installationId` (refused in this mode) cannot ride along.
 */
export async function connectGithubUserRepo(
  f = fetch,
  input: { repoRef: string; submissionPolicy: SubmissionPolicy },
): Promise<ConnectedRepo> {
  const res = await apiCall(f, "/v1/connected-repos", {
    method: "POST",
    body: JSON.stringify({
      provider: "github",
      repoRef: input.repoRef,
      submissionPolicy: input.submissionPolicy,
    }),
  });
  return connectedRepoSchema.parse(res);
}

/** Every repo the user-mode token can see on GitHub. 501 where GitHub is an App. */
export async function getGithubRepos(f = fetch): Promise<GithubRepo[]> {
  const res = await apiCall(f, "/v1/github/repos");
  return z.object({ repos: z.array(githubRepoSchema) }).parse(res).repos;
}

/** Every project GitLab lets the deployment's token reach: the bot's memberships at Developer or
 * above, or one person's projects in user mode. */
export async function getGitlabProjects(f = fetch): Promise<GitlabProject[]> {
  const res = await apiCall(f, "/v1/gitlab/projects");
  return z.object({ projects: z.array(gitlabProjectSchema) }).parse(res).projects;
}

/**
 * Connect a GitLab project by its path. The project's URL and default branch are read off GitLab
 * server-side, after the server checks the person's Maintainer access live. The answer carries
 * the webhook to paste, null where the deployment takes no webhooks (user mode, which polls).
 * Spelled key by key like the Radicle connect: GitLab has no installation.
 */
export async function connectGitlabRepo(
  f = fetch,
  input: { repoRef: string; submissionPolicy: SubmissionPolicy },
): Promise<{ repo: ConnectedRepo; webhook: GitlabHook | null }> {
  const res = await apiCall(f, "/v1/connected-repos", {
    method: "POST",
    body: JSON.stringify({
      provider: "gitlab",
      repoRef: input.repoRef,
      submissionPolicy: input.submissionPolicy,
    }),
  });
  return z.object({ repo: connectedRepoSchema, webhook: gitlabHookSchema.nullable() }).parse(res);
}

/**
 * A webhook's values plus when GitLab last delivered with its current token: null until the first
 * delivery, which is how a project nobody added the webhook to looks. Merge request events are
 * counted apart, since merges arrive only as those. And how many deliveries were dropped over the
 * project's budgets at this token — comments, which have a budget of their own, and every other
 * event — GitLab was told they arrived, so those events never reached Ryph — and when the last
 * one was.
 */
export type GitlabHookStatus = {
  webhook: GitlabHook;
  lastDeliveryAt: string | null;
  lastMergeRequestDeliveryAt: string | null;
  droppedComments: number;
  droppedOtherEvents: number;
  lastDroppedAt: string | null;
};

const gitlabHookStatusSchema = z.object({
  webhook: gitlabHookSchema,
  lastDeliveryAt: z.string().nullable(),
  lastMergeRequestDeliveryAt: z.string().nullable(),
  droppedComments: z.number().int().min(0),
  droppedOtherEvents: z.number().int().min(0),
  lastDroppedAt: z.string().nullable(),
});

/** A connected GitLab repo's webhook values again, for a Maintainer on its page. */
export async function getRepoGitlabHook(f = fetch, id: string): Promise<GitlabHookStatus> {
  return gitlabHookStatusSchema.parse(
    await apiCall(f, `/v1/connected-repos/${encodeURIComponent(id)}/gitlab-hook`),
  );
}

/**
 * Move a connected GitLab repo's webhook to a new token. The old URL and token are refused at
 * once, so the answer is what a Maintainer must paste into GitLab next.
 */
export async function rotateRepoGitlabHook(f = fetch, id: string): Promise<GitlabHookStatus> {
  return gitlabHookStatusSchema.parse(
    await apiCall(f, `/v1/connected-repos/${encodeURIComponent(id)}/gitlab-hook/rotate`, {
      method: "POST",
    }),
  );
}

/** Why the server refused a local path, as its 422 `reason` names it. */
export const LOCAL_REPO_REFUSALS = [
  "not_absolute",
  "outside_root",
  "not_found",
  "not_directory",
  "not_a_repository",
  "linked_worktree",
  "bare_repository",
  "no_default_branch",
] as const;
export type LocalRepoRefusal = (typeof LOCAL_REPO_REFUSALS)[number];

/**
 * Connect a git repository on the machine running ryph. The server canonicalises the path and
 * answers the connected repo, whose `repoRef` is the real path it settled on. Like the Radicle
 * connect, the body is spelled key by key: a local repo has no installation.
 */
export async function connectLocalRepo(f = fetch, path: string): Promise<ConnectedRepo> {
  const res = await apiCall(f, "/v1/connected-repos", {
    method: "POST",
    body: JSON.stringify({ provider: "local", path }),
  });
  return connectedRepoSchema.parse(res);
}

/** What ryph's node knows about a connected Radicle repo, read afresh from its storage. */
export async function getRepoRadicleInfo(f = fetch, id: string): Promise<RadicleRepoInfo> {
  return radicleRepoInfoSchema.parse(
    await apiCall(f, `/v1/connected-repos/${encodeURIComponent(id)}/radicle`),
  );
}

export async function updateConnectedRepo(
  f = fetch,
  id: string,
  input: {
    submissionPolicy?: SubmissionPolicy;
    sizeClass?: string | null;
    allowForkPushes?: boolean;
  },
): Promise<ConnectedRepo> {
  return connectedRepoSchema.parse(
    await apiCall(f, `/v1/connected-repos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function archiveConnectedRepo(f = fetch, id: string): Promise<ConnectedRepo> {
  return connectedRepoSchema.parse(
    await apiCall(f, `/v1/connected-repos/${encodeURIComponent(id)}/archive`, { method: "POST" }),
  );
}

// ---- the command allowlist: who may /ryph on a repo, beside its delegates ----
// Admin-gated at the API, and every call answers with the whole list, so the editor never has to
// guess what the write did.

const allowlistSchema = z.object({ entries: z.array(commandAllowlistEntrySchema) });

export async function getCommandAllowlist(
  f = fetch,
  id: string,
): Promise<CommandAllowlistEntry[]> {
  const res = await apiCall(f, `/v1/connected-repos/${encodeURIComponent(id)}/command-allowlist`);
  return allowlistSchema.parse(res).entries;
}

export async function addCommandAllowlistEntry(
  f = fetch,
  id: string,
  subject: string,
): Promise<CommandAllowlistEntry[]> {
  const res = await apiCall(f, `/v1/connected-repos/${encodeURIComponent(id)}/command-allowlist`, {
    method: "POST",
    body: JSON.stringify({ subject }),
  });
  return allowlistSchema.parse(res).entries;
}

export async function removeCommandAllowlistEntry(
  f = fetch,
  id: string,
  subject: string,
): Promise<CommandAllowlistEntry[]> {
  // A DID carries colons, and the orchestrator decodes this segment itself.
  const res = await apiCall(
    f,
    `/v1/connected-repos/${encodeURIComponent(id)}/command-allowlist/${
      encodeURIComponent(subject)
    }`,
    { method: "DELETE" },
  );
  return allowlistSchema.parse(res).entries;
}

// ---- GitHub App installations: the connect path that only GitHub has ----

export async function getInstallations(f = fetch): Promise<Installation[]> {
  const res = await apiCall(f, "/v1/installations");
  return z.object({ installations: z.array(installationSchema) }).parse(res).installations;
}

/**
 * Registers a GitHub App installation by the id the install redirect carried.
 * Everything else about it is asked of GitHub server-side, never taken from us.
 */
export async function registerInstallation(
  f = fetch,
  installationId: string,
): Promise<Installation> {
  const res = await apiCall(f, "/v1/installations", {
    method: "POST",
    body: JSON.stringify({ installationId }),
  });
  return z.object({ installation: installationSchema }).parse(res).installation;
}

/** The installation's own listing, which still speaks GitHub's `fullName` — it is a listing of
 * GitHub repositories, not of connected ones. `settingsUrl` is where the installation is managed
 * on GitHub, null when GitHub named no page for it. */
export async function getInstallationRepos(
  f = fetch,
  installationId: string,
): Promise<{ accountLogin: string; settingsUrl: string | null; repos: InstallationRepo[] }> {
  const res = await apiCall(f, `/v1/installations/${encodeURIComponent(installationId)}/repos`);
  return z.object({
    accountLogin: z.string(),
    settingsUrl: z.string().nullable(),
    repos: z.array(installationRepoSchema),
  }).parse(res);
}
