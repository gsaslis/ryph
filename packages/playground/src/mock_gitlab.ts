/**
 * The playground's GitLab: `@ryph/fake-gitlab` served from this process, seeded with the same
 * people, a group with a nested subgroup and a few projects, so the host's forge runs in bot mode
 * against it — connect, webhooks, merge requests, threads and GitLab sign-in, end to end.
 *
 * The fake keeps its state in memory. Every start seeds the same world in the same order, so
 * project ids, tokens and webhook tokens come out the same and a reused database still points at
 * the right projects; what happened on GitLab during seeding (merge requests, notes) does not
 * survive a restart. The database keeps ryph's side of it, which is what the app shows.
 */

import { type FakeGitlab, startFakeGitlab } from "@ryph/fake-gitlab";
import { REPOS } from "./repos.ts";

/** What the host and the app are configured with: fixed, so a reused seed keeps working. */
export const GITLAB_SECRETS = {
  botToken: "glpat-playground-ryph-bot-token",
  webhookSecret: "playground-gitlab-webhook-secret",
  clientId: "playground-gitlab-app",
  clientSecret: "playground-gitlab-app-secret",
  /** Who may sign up through GitLab: members of this group. */
  group: "acme",
};

/** The bot ryph acts as. */
export const GITLAB_BOT = "ryph-bot";

/** The playground's people on GitLab, by their ryph role where they have one. */
export const GITLAB_PEOPLE = {
  olivia: { name: "Olivia Owner", email: "owner@ryph.local" },
  max: { name: "Max Member", email: "member@ryph.local" },
  priya: { name: "Priya Raman", email: "priya@acme.example" },
} as const;
export type GitlabPerson = keyof typeof GITLAB_PEOPLE;

/** The projects, by path. `from` names the local fixture repo whose history it replays. */
export const GITLAB_PROJECTS = {
  /** acme-api's history, at the top of the group. */
  billing: { path: "acme/billing-api", from: "acme-api" },
  /** infra's history, in a nested group. */
  infra: { path: "acme/platform/infra-live", from: "infra" },
  /** Not connected: something to pick in the connect step. */
  handbook: { path: "acme/platform/handbook", from: null },
  /** Empty: the connect step says why it can't be picked. */
  mobile: { path: "acme/mobile-app", from: null },
} as const;

/** Fixture repo authors (repos.ts) as GitLab users. */
const AUTHORS: Record<string, GitlabPerson> = { owner: "olivia", member: "max", priya: "priya" };

export interface MockGitlab {
  fake: FakeGitlab;
  /** What `RYPH_GITLAB_URL` and `PUBLIC_GITLAB_URL` name. */
  url: string;
  stop(): Promise<void>;
}

/**
 * Starts the fake on `port` and seeds it. `appUrl` is where GitLab sign-in returns to; `hookUrl`
 * is the forge's `/v1/hooks/gitlab`, which the connected projects' webhooks deliver to.
 */
export async function serveMockGitlab(
  port: number,
  p: { appUrl: string; hookUrl: string },
): Promise<MockGitlab> {
  const fake = await startFakeGitlab({ port });
  fake.addUser({ username: "root", name: "Administrator", admin: true });
  fake.addUser({ username: GITLAB_BOT, name: "ryph", bot: true });
  for (const [username, who] of Object.entries(GITLAB_PEOPLE)) {
    fake.addUser({ username, ...who });
  }
  fake.token(GITLAB_BOT, { token: GITLAB_SECRETS.botToken, name: "ryph" });

  fake.addGroup("acme", { visibility: "private" });
  fake.addGroup("acme/platform", { visibility: "internal" });
  fake.addMember("acme", "olivia", "owner");
  fake.addMember("acme", "priya", "maintainer");
  fake.addMember("acme", "max", "developer");
  // Developer, as the connect page says: it can push branches but not the default one.
  fake.addMember("acme", GITLAB_BOT, "developer");

  for (const project of Object.values(GITLAB_PROJECTS)) {
    const repo = project.from === null ? null : REPOS.find((r) => r.name === project.from)!;
    if (project === GITLAB_PROJECTS.handbook) {
      await fake.addProject(project.path, {
        files: { "README.md": "# Handbook\n\nHow acme's platform team works.\n" },
      });
      continue;
    }
    if (repo === null) {
      await fake.addProject(project.path);
      continue;
    }
    const [first, ...rest] = repo.commits;
    await fake.addProject(project.path, { files: first.files });
    for (const commit of rest) {
      await fake.commit(project.path, {
        as: AUTHORS[commit.author] ?? "olivia",
        branch: "main",
        files: commit.files,
        message: `${commit.message}\n`,
      });
    }
  }

  // The webhook a Maintainer pastes after connecting, already in place on the two projects the
  // gitlab fixture connects, delivering straight to the forge.
  for (const project of [GITLAB_PROJECTS.billing, GITLAB_PROJECTS.infra]) {
    fake.addRyphHook(project.path, { url: p.hookUrl, master: GITLAB_SECRETS.webhookSecret });
  }

  fake.oauthApp({
    clientId: GITLAB_SECRETS.clientId,
    clientSecret: GITLAB_SECRETS.clientSecret,
    redirectUris: [`${p.appUrl}/gitlab/callback`],
    scopes: ["read_user"],
  });
  // GitLab's own sign-in page is not faked: whoever starts a round trip is Olivia, approved.
  fake.signInAs("olivia");

  return { fake, url: fake.url, stop: () => fake.shutdown() };
}
