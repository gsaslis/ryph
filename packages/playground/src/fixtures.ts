/**
 * The fixtures. Each creates its slice of a believable deployment through the same HTTP API the
 * app uses, so what it makes is valid by construction and stays valid as the code changes.
 * Order in FIXTURES is the order they apply in, and every fixture comes after what it needs.
 */

import { createHmac } from "node:crypto";
import { createOwner, invite } from "./api.ts";
import type { Context, Role, SeedCheck } from "./context.ts";
import type { FixtureInfo } from "./resolve.ts";
import { CHAT_CREDENTIALS, ZULIP_INCIDENTS_CHANNEL } from "./mock_chat.ts";
import { createRepo, REPOS } from "./repos.ts";
import { seedNotices } from "./notices.ts";
import {
  DELEGATING,
  GITLAB_CHECKS,
  GITLAB_FOLLOW_UP,
  GITLAB_ISSUE_RUN,
  GITLAB_STORIES,
  historyStories,
  STORIES,
  WORKING,
} from "./stories.ts";
import { GITLAB_BOT, GITLAB_PROJECTS, GITLAB_SECRETS } from "./mock_gitlab.ts";
import { s256 } from "@ryph/fake-gitlab";
import type { Session } from "./api.ts";

export interface Fixture extends FixtureInfo {
  apply(ctx: Context, param: number | null): Promise<void>;
}

/** Every account's password. The playground is local and throwaway; one password is the point. */
export const PASSWORD = "playground-password";

export const PEOPLE: Record<Role, { email: string; name: string }> = {
  owner: { email: "owner@ryph.local", name: "Olivia Owner" },
  member: { email: "member@ryph.local", name: "Max Member" },
  operator: { email: "operator@ryph.local", name: "Oscar Operator" },
  viewer: { email: "viewer@ryph.local", name: "Vera Viewer" },
};

const DAY = 86_400_000;

/** Which agent works on which repo when a story doesn't say. */
const AGENT_FOR_REPO: Record<string, string> = {
  "acme-api": "ada",
  "acme-web": "grace",
  infra: "linus",
};

export const FIXTURES: Fixture[] = [
  {
    name: "owner",
    summary: "the first account, an owner: owner@ryph.local",
    needs: [],
    phase: "seed",
    async apply(ctx) {
      const session = await createOwner(
        ctx.control,
        { ...PEOPLE.owner, password: PASSWORD },
        await ctx.setupToken(),
      );
      ctx.sessions.set("owner", session);
      ctx.state.people.owner = session.person;
    },
  },
  {
    name: "team",
    summary: "a member, an operator and a viewer, through invites",
    needs: ["owner"],
    phase: "seed",
    async apply(ctx) {
      for (const role of ["member", "operator", "viewer"] as const) {
        const session = await invite(ctx.owner, { ...PEOPLE[role], password: PASSWORD, role });
        ctx.sessions.set(role, session);
        ctx.state.people[role] = session.person;
      }
    },
  },
  {
    name: "model",
    summary: "a custom model endpoint (served by the playground) with a key, as the platform model",
    needs: ["owner"],
    phase: "seed",
    async apply(ctx) {
      await ctx.owner.post("/v1/providers", {
        id: "playground",
        label: "Playground models",
        baseUrl: `http://127.0.0.1:${ctx.ports.mockModel}/v1`,
        models: [
          {
            id: "playground-large",
            label: "Playground Large",
            contextWindow: 200_000,
            // Levels said for one model and not the other, so the pickers show both cases.
            thinkingLevels: ["off", "low", "medium", "high"],
            price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
          {
            id: "playground-small",
            label: "Playground Small",
            contextWindow: 128_000,
            price: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
          },
        ],
      });
      const key = await ctx.owner.post<{ id: string }>("/v1/provider-keys", {
        provider: "playground",
        label: "Playground key",
        secret: "pg-not-a-real-secret",
      });
      ctx.state.providerKeyId = key.id;
      // A second provider's key, so the keys page lists more than one. Nothing calls it.
      await ctx.owner.post("/v1/provider-keys", {
        provider: "anthropic",
        label: "Anthropic (placeholder, never called)",
        secret: "sk-ant-playground-placeholder",
      });
      await ctx.owner.put("/v1/platform-model-policy", {
        providerKeyId: key.id,
        model: "playground-small",
        allowedModels: "*",
      });
    },
  },
  {
    name: "repos",
    summary: "three local git repos with history (an API, a web app, infra), connected",
    needs: ["owner"],
    phase: "seed",
    async apply(ctx) {
      for (const fixture of REPOS) {
        const path = await createRepo(ctx.layout.repos, fixture);
        const repo = await ctx.owner.post<{ id: string }>("/v1/connected-repos", {
          provider: "local",
          path,
        });
        ctx.state.repos[fixture.name] = { id: repo.id, path };
      }
    },
  },
  {
    name: "workspace",
    summary: "a workspace grouping the API and the web app",
    needs: ["repos"],
    phase: "seed",
    async apply(ctx) {
      const { workspace } = await ctx.owner.post<{ workspace: { id: string } }>("/v1/workspaces", {
        name: "Acme platform",
        description: "The API and the dashboard, for changes that span both.",
      });
      for (const [name, path] of [["acme-api", "api"], ["acme-web", "web"]]) {
        await ctx.owner.post(`/v1/workspaces/${workspace.id}/repos`, {
          connectedRepoId: ctx.repo(name).id,
          ref: null,
          path,
          description: REPOS.find((r) => r.name === name)?.description,
        });
      }
      ctx.state.workspaceId = workspace.id;
    },
  },
  {
    name: "agents",
    summary: "four agents with different policies, all on the playground model",
    needs: ["model"],
    phase: "seed",
    async apply(ctx) {
      const modelPolicy = {
        providerKeyId: ctx.state.providerKeyId,
        provider: "playground",
        allowedModels: "*",
        defaultModel: "playground-large",
        defaultThinking: "medium",
      };
      const agents = [
        {
          key: "ada",
          name: "Ada",
          systemPrompt: "You maintain acme-api. Prefer small, tested changes.",
        },
        {
          key: "grace",
          name: "Grace",
          systemPrompt: "You build the acme dashboard.",
          browserEnabled: true,
          canPublishArtifacts: true,
        },
        { key: "linus", name: "Linus", systemPrompt: "You look after acme's infrastructure." },
        {
          key: "hopper",
          name: "Hopper",
          systemPrompt: "You investigate and report; you never change code.",
          canOpenPatches: false,
        },
      ];
      for (const { key, ...rest } of agents) {
        const agent = await ctx.owner.post<{ id: string; name: string }>("/v1/agents", {
          ...rest,
          email: `${key}@agents.ryph.local`,
          harnessKind: "pi",
          modelPolicy,
        });
        ctx.state.agents[key] = { id: agent.id, name: agent.name };
      }
    },
  },
  {
    name: "history",
    summary: "finished runs over the last three weeks: patches in every state, chats, failures",
    needs: ["agents", "repos"],
    phase: "seed",
    param: { what: "runs", default: STORIES.length },
    async apply(ctx, param) {
      const count = param ?? STORIES.length;
      const stories = historyStories(count);
      // Oldest first, spread over three weeks with the newest a couple of hours ago.
      const jobs = stories.map((story, i) => {
        const agent = story.key === "latency" || story.key === "stripe-version"
          ? "hopper"
          : AGENT_FOR_REPO[story.repo] ?? "ada";
        const ageMs = 2 * 3_600_000 +
          ((count - 1 - i) / count) * 21 * DAY * (0.85 + Math.random() * 0.15);
        return () => ctx.playStory(story, ctx.agent(agent).id, ageMs);
      });
      await pooled(jobs, 4);
    },
  },
  {
    name: "platform-notices",
    summary:
      "a visual catalogue of every inbox and runner-local platform notice, with a reviewable hook patch",
    needs: ["agents", "repos"],
    phase: "seed",
    apply: seedNotices,
  },
  {
    name: "chat",
    summary:
      "a chatroom on each mock platform: Telegram (linked to its group), Zulip, Slack and Discord",
    needs: ["owner"],
    phase: "seed",
    async apply(ctx) {
      const rooms = [
        { kind: "telegram", name: "Ops (Telegram)", ...CHAT_CREDENTIALS.telegram },
        {
          kind: "zulip",
          name: "Acme Zulip",
          realmUrl: ctx.chat.urls.zulipRealm,
          ...CHAT_CREDENTIALS.zulip,
        },
        { kind: "slack", name: "Acme Slack", ...CHAT_CREDENTIALS.slack },
        { kind: "discord", name: "Acme Discord", ...CHAT_CREDENTIALS.discord },
      ] as const;
      ctx.state.chatrooms = {};
      for (const room of rooms) {
        const { chatroom } = await ctx.owner.post<{
          chatroom: { id: string; linkCode: string | null };
        }>("/v1/chatrooms", room);
        ctx.state.chatrooms[room.kind] = chatroom.id;
        if (chatroom.linkCode === null) continue;
        // Telegram learns its group from a mention quoting the room's code, as the app tells an
        // operator to send. Said in the mock group, then waited for: the poller links it.
        ctx.chat.say({
          platform: "telegram",
          channelId: ctx.chat.telegramGroupId,
          conversation: null,
          as: "olivia",
          text: `link ${chatroom.linkCode}`,
          mention: true,
        });
        await waitUntil(30_000, `the Telegram room to link`, async () => {
          const got = await ctx.owner.get<{ chatroom: { linked: boolean } }>(
            `/v1/chatrooms/${chatroom.id}`,
          );
          return got.chatroom.linked;
        });
      }
    },
  },
  {
    name: "automations",
    summary:
      "a nightly schedule, a Sentry webhook awaiting its secret, Grafana alerts with a response in Zulip, and a paused one",
    needs: ["agents", "repos", "chat"],
    phase: "seed",
    async apply(ctx) {
      const automations = [
        {
          name: "Nightly dependency check",
          agentId: ctx.agent("ada").id,
          target: { kind: "repo", connectedRepoId: ctx.repo("acme-api").id, ref: null },
          instructions: "Check for outdated dependencies and open a patch for safe updates.",
          trigger: { kind: "schedule", cron: "0 3 * * *", timezone: "UTC" },
        },
        {
          name: "Triage Sentry alerts",
          agentId: ctx.agent("hopper").id,
          target: { kind: "repo", connectedRepoId: ctx.repo("acme-api").id, ref: null },
          instructions: "An alert fired. Find the likely cause and report back; change nothing.",
          // Created without Sentry's secret, as the app does: it waits for the paste.
          trigger: {
            kind: "webhook",
            format: { kind: "sentry" },
            verification: { kind: "hmac-sha256", header: "sentry-hook-signature", prefix: "" },
          },
        },
        {
          name: "Weekly infra drift report",
          agentId: ctx.agent("linus").id,
          target: { kind: "repo", connectedRepoId: ctx.repo("infra").id, ref: null },
          instructions: "Compare the manifests with what is deployed and list the drift.",
          trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Berlin" },
        },
      ];
      for (const [i, body] of automations.entries()) {
        const { automation } = await ctx.owner.post<{ automation: { id: string } }>(
          "/v1/automations",
          body,
        );
        if (i === 2) await ctx.owner.post(`/v1/automations/${automation.id}/disable`);
      }

      // Grafana alerts that keep a conversation per alert, and one alert that fired, so a
      // response with a title shows on the trigger's page.
      const grafana = await ctx.owner.post<{
        automation: { id: string; trigger: { path: string } };
        secret?: string;
      }>("/v1/automations", {
        name: "Grafana alerts",
        agentId: ctx.agent("hopper").id,
        target: { kind: "repo", connectedRepoId: ctx.repo("acme-api").id, ref: null },
        instructions: "An alert fired. Find the likely cause and report back; change nothing.",
        trigger: {
          kind: "webhook",
          format: { kind: "grafana" },
          verification: {
            kind: "hmac-sha256",
            header: "x-grafana-alerting-signature",
            prefix: "",
          },
          rateLimit: { maxPerWindow: 10, windowMs: 60_000 },
        },
        // Each alert opens its own topic in Zulip's private #incidents.
        response: {
          chatroomId: ctx.state.chatrooms?.zulip ?? null,
          channelId: ctx.state.chatrooms?.zulip ? ZULIP_INCIDENTS_CHANNEL : null,
          correlation: "key",
        },
      });
      if (grafana.secret) {
        const body = JSON.stringify({
          receiver: "ryph",
          status: "firing",
          state: "alerting",
          title: "[FIRING:1] HighErrorRate api",
          groupKey: '{}/{__grafana_autogenerated__="true"}:{alertname="HighErrorRate"}',
          groupLabels: { alertname: "HighErrorRate" },
          commonLabels: { alertname: "HighErrorRate", service: "api" },
          commonAnnotations: { summary: "5xx rate above 5% on the api" },
          alerts: [{
            status: "firing",
            labels: { alertname: "HighErrorRate", service: "api" },
            annotations: { summary: "5xx rate above 5% on the api" },
            startsAt: new Date().toISOString(),
            fingerprint: "57c6d9296de2ad39",
          }],
        });
        const signature = createHmac("sha256", grafana.secret).update(body).digest("hex");
        // The ingestion door is on the host's own origin in the single-process host. A refused
        // fire leaves the automation without history, which is still a valid seed.
        const res = await fetch(`${ctx.control}${grafana.automation.trigger.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-grafana-alerting-signature": signature,
          },
          body,
        }).catch(() => null);
        await res?.body?.cancel();
      }
    },
  },
  {
    name: "memory",
    summary: "accepted memories about the repos and two proposals awaiting review",
    needs: ["repos", "agents"],
    phase: "seed",
    async apply(ctx) {
      const api = { kind: "repo", url: ctx.repo("acme-api").path };
      const web = { kind: "repo", url: ctx.repo("acme-web").path };
      const memories = [
        {
          text: "acme-api keeps sessions in process memory; every pod has its own map.",
          kind: "fact",
          subject: api,
        },
        {
          text: "Run `deno task test` in acme-api before submitting; CI runs the same.",
          kind: "procedure",
          subject: api,
        },
        {
          text:
            "Stripe retries failed webhooks for three days, so the webhook should fail fast rather than loop.",
          kind: "decision",
          subject: api,
        },
        {
          text: "The dashboard uses Svelte 5 runes; don't add stores.",
          kind: "preference",
          subject: web,
        },
        {
          text: "Amounts are integer cents everywhere; format only at the edge.",
          kind: "gotcha",
          subject: { kind: "org" },
        },
      ];
      for (const m of memories) {
        await ctx.owner.post("/v1/memories", { ...m, audience: { kind: "all" }, pinned: false });
      }
      await ctx.as("member").post("/v1/memory-proposals", {
        text: "acme-prod is an Autopilot cluster: no node pools to manage.",
        kind: "fact",
        subject: { kind: "repo", url: ctx.repo("infra").path },
      });
      await ctx.as("member").post("/v1/memory-proposals", {
        text: "Ask before raising any pod's CPU request above 1 core.",
        kind: "preference",
        subject: { kind: "org" },
      });
    },
  },
  {
    name: "tools",
    summary: "a remote MCP server (unreachable: it is a stand-in for the listing)",
    needs: ["owner"],
    phase: "seed",
    async apply(ctx) {
      await ctx.owner.post("/v1/mcp-servers", {
        slug: "grafana",
        name: "Grafana",
        url: `http://127.0.0.1:${ctx.ports.mockModel}/mcp`,
        auth: "bearer",
        secret: "glsa-playground-placeholder",
      });
    },
  },
  {
    name: "gitlab",
    summary:
      "a fake GitLab in bot mode: linked accounts, two connected projects (one nested), merge requests with threads, a /ryph issue",
    needs: ["team", "agents"],
    phase: "seed",
    async apply(ctx) {
      const gl = ctx.gitlab.fake;
      // Olivia and Max link their GitLab accounts, through the OAuth round trip the app runs.
      for (const [role, username] of [["owner", "olivia"], ["member", "max"]] as const) {
        gl.signInAs(username);
        await linkGitlab(ctx.as(role), gl.url, ctx.ports.app);
      }
      gl.signInAs("olivia");

      // Connected as a Maintainer would: Olivia owns the group. The billing project holds each
      // merge request for approval; the nested infra one opens them as the agent submits.
      for (const [key, policy] of [["billing", "require-approval"], ["infra", "auto"]] as const) {
        const { repo } = await ctx.owner.post<{ repo: { id: string; repoRef: string } }>(
          "/v1/connected-repos",
          { provider: "gitlab", repoRef: GITLAB_PROJECTS[key].path, submissionPolicy: policy },
        );
        ctx.state.repos[`gitlab:${key}`] = { id: repo.id, path: repo.repoRef };
      }

      const billing = GITLAB_PROJECTS.billing.path;
      const infra = GITLAB_PROJECTS.infra.path;
      const hour = 3_600_000;

      // !1 on billing-api: approved, opened by the bot, then a review and a /ryph on its thread.
      await ctx.playStory(GITLAB_STORIES.ledgerTimeout, ctx.agent("ada").id, 3 * hour);
      const ledgerMr = await waitForMergeRequest(ctx, ctx.timeline.at(-1)!.runId);
      await seedChecks(ctx, billing, ledgerMr, GITLAB_CHECKS.ledgerTimeout);
      await gl.comment(billing, `mr-${ledgerMr}`, {
        as: "priya",
        body: "Looks right. Is 5 s enough when the ledger is under load?",
      });
      const followUp = ctx.playUnclaimed(GITLAB_FOLLOW_UP.steps, GITLAB_FOLLOW_UP.outcome);
      await gl.comment(billing, `mr-${ledgerMr}`, {
        as: "max",
        body: "/ryph ada check the timeout against Stripe's own webhook timeout",
      });
      await gl.flush();
      await followUp;

      // !1 on infra-live: opened as soon as the agent submitted, then merged by Priya.
      await ctx.playStory(GITLAB_STORIES.replicas, ctx.agent("linus").id, 5 * hour);
      const replicasMr = await waitForMergeRequest(ctx, ctx.timeline.at(-1)!.runId);
      await seedChecks(ctx, infra, replicasMr, GITLAB_CHECKS.replicas);
      await gl.approve(infra, replicasMr, { as: "priya" });
      await gl.merge(infra, replicasMr, { as: "priya", method: "merge" });
      await gl.flush();

      // An issue, and a /ryph on it: a task that starts from GitLab.
      const issue = gl.openIssue(billing, {
        as: "priya",
        title: "Stripe webhook answers 500 when the ledger is slow",
        description: "Since Tuesday's ledger incident Stripe shows a run of 500s on our webhook.",
        labels: ["bug"],
      });
      const investigation = ctx.playUnclaimed(GITLAB_ISSUE_RUN.steps, GITLAB_ISSUE_RUN.outcome);
      await gl.comment(billing, `issue-${issue.iid}`, {
        as: "olivia",
        body: "/ryph hopper find out where the 500s come from",
      });
      await gl.flush();
      await investigation;
      await gl.flush();
    },
  },
  {
    name: "live",
    summary: "a run working right now, streaming new events every few seconds",
    needs: ["agents", "repos"],
    phase: "live",
    async apply(ctx) {
      const { run } = await ctx.startRun(ctx.owner, {
        agentId: ctx.agent("ada").id,
        spec: {
          title: "Clean up expired sessions",
          instructions: "Expired sessions are never deleted. Add a sweep.",
        },
        connectedRepoId: ctx.repo("acme-api").id,
      });
      ctx.converse(run, DELEGATING, WORKING);
    },
  },
  {
    name: "waiting",
    summary: "a run that did some work and is waiting for an answer",
    needs: ["agents", "repos"],
    phase: "live",
    async apply(ctx) {
      const { run } = await ctx.startRun(ctx.as("member"), {
        agentId: ctx.agent("grace").id,
        spec: {
          title: "Add a dark mode toggle to the dashboard",
          instructions: "Users keep asking for dark mode.",
        },
        connectedRepoId: ctx.repo("acme-web").id,
      });
      ctx.converse(run, [
        { read: "src/routes/+page.svelte" },
        {
          think:
            "There's no theme handling at all yet. Before building it: system preference only, or a toggle that overrides it?",
        },
        {
          say:
            "Before I start: should dark mode **follow the system setting**, or do you want a **toggle** that overrides it (stored per user)?",
        },
      ], null);
    },
  },
];

/**
 * Links the session's person to whoever the fake GitLab signs in, as the app's link round trip
 * does: authorize with PKCE, then hand the code and the leg to the control plane.
 */
async function linkGitlab(who: Session, gitlabUrl: string, appPort: number): Promise<void> {
  const redirectUri = `http://localhost:${appPort}/gitlab/callback`;
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const authorize = new URL(`${gitlabUrl}/oauth/authorize`);
  authorize.searchParams.set("client_id", GITLAB_SECRETS.clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "read_user");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", s256(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "playground");
  const res = await fetch(authorize, { redirect: "manual" });
  await res.body?.cancel();
  const code = new URL(res.headers.get("location") ?? "", redirectUri).searchParams.get("code");
  if (!code) throw new Error(`GitLab sign-in gave no code (${res.status})`);
  await who.post("/v1/auth/oauth/gitlab/callback", { code, redirectUri, codeVerifier: verifier });
}

/**
 * Gives the last played run's merge request a finished check suite: on ryph's side once the host
 * is offline (backdate.ts), and on GitLab as the commit statuses ryph reports, `ryph / <name>`.
 */
async function seedChecks(
  ctx: Context,
  project: string,
  iid: number,
  checks: SeedCheck[],
): Promise<void> {
  const entry = ctx.timeline.at(-1)!;
  entry.checks = checks;
  const bot = ctx.gitlab.fake.client(GITLAB_BOT);
  const at = `/projects/${encodeURIComponent(project)}`;
  const res = await bot("GET", `${at}/merge_requests/${iid}`);
  if (!res.ok) throw new Error(`reading !${iid} on ${project}: ${res.status}`);
  const mr = await res.json() as { sha: string; source_branch: string };
  for (const check of checks) {
    const posted = await bot("POST", `${at}/statuses/${mr.sha}`, {
      state: check.state === "passed" ? "success" : "failed",
      ref: mr.source_branch,
      name: `ryph / ${check.name}`,
      target_url: `http://localhost:${ctx.ports.app}/checks/cs-${entry.runId.replace(/^r-/, "")}`,
      description: check.state === "passed" ? "Passed" : "Failed",
    });
    await posted.body?.cancel();
    if (!posted.ok) throw new Error(`posting ryph / ${check.name}: ${posted.status}`);
  }
}

/** The merge request the run's patch became, by iid, once the forge has opened it. */
async function waitForMergeRequest(ctx: Context, runId: string): Promise<number> {
  let iid: number | null = null;
  await waitUntil(60_000, `the merge request of ${runId}`, async () => {
    const { patches } = await ctx.owner.get<{
      patches: Array<{ runId: string; state: string; forgeRef: string | null }>;
    }>("/v1/patches?limit=100");
    const patch = patches.find((p) => p.runId === runId);
    if (patch?.state === "failed") throw new Error(`the patch of ${runId} failed to submit`);
    if (patch?.state !== "submitted" || !patch.forgeRef) return false;
    iid = Number(/(\d+)$/.exec(patch.forgeRef)?.[1]);
    return true;
  });
  return iid!;
}

/** Asks `done` every half second until it answers true, failing after `timeoutMs`. */
async function waitUntil(
  timeoutMs: number,
  what: string,
  done: () => Promise<boolean>,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Runs `jobs` at most `limit` at a time, failing on the first error. */
async function pooled(jobs: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}
