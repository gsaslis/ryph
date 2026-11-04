// The GitLab adapter against a REAL GitLab, skipped unless one is named:
//
//   RYPH_GITLAB_LIVE_URL      the instance, e.g. http://127.0.0.1:18929
//   RYPH_GITLAB_LIVE_TOKEN    a PAT scoped `api`, `read_repository` and `write_repository`, of an
//                             account with Developer on the project
//   RYPH_GITLAB_LIVE_PROJECT  a scratch project's path; the test opens an issue there
//
// It checks what the fake can only assume: the boot reads, a comment and its 👀 (twice — a
// duplicate award is success), the thread read back, and a status reported twice on a commit of
// its own (the second is GitLab's refused transition, read as converged).

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { gitlabForgeApi } from "../src/adapters/forge_api/gitlab.ts";
import { GITLAB_TOKEN_NAMES, staticUserToken } from "../src/helpers/user_token.ts";
import { silentDiagnostics } from "./util.ts";

const URL_ = process.env.RYPH_GITLAB_LIVE_URL ?? "";
const TOKEN = process.env.RYPH_GITLAB_LIVE_TOKEN ?? "";
const PROJECT = process.env.RYPH_GITLAB_LIVE_PROJECT ?? "";
const liveTest = test.skipIf(URL_ === "" || TOKEN === "" || PROJECT === "");

liveTest(
  "the adapter on a live GitLab: comment, react twice, read back, report a status twice",
  async () => {
    const api = await gitlabForgeApi({
      mode: "bot",
      url: URL_,
      token: staticUserToken(TOKEN, GITLAB_TOKEN_NAMES),
      webhookSecret: null,
      oauth: null,
      group: null,
      diag: silentDiagnostics(),
    });
    const repo = { repoRef: PROJECT, tenantId: null };
    const stamp = new Date().toISOString();

    const issue = await api.createIssue(repo, {
      title: `ryph live check ${stamp}`,
      body: "Opened by packages/forge/tests/gitlab_live_test.ts.",
      labels: [],
    });
    const thread = { kind: "issue" as const, ref: issue.ref };
    const { commentId } = await api.postComment(repo, thread, `live comment ${stamp}`);
    await api.addReaction(repo, commentId, "eyes");
    await api.addReaction(repo, commentId, "eyes");
    const read = await api.fetchThread(repo, thread);
    assert(
      read.entries.some((e) => JSON.stringify(e).includes(`live comment ${stamp}`)),
      "the comment reads back",
    );

    // A commit of the test's own, on a branch of its own: a status on one only a protected branch
    // holds is refused to a Developer.
    const project = encodeURIComponent(PROJECT);
    const branch = `ryph-live-${Date.now()}`;
    const meta = await (await fetch(`${URL_}/api/v4/projects/${project}`, {
      headers: { "PRIVATE-TOKEN": TOKEN },
    })).json();
    const res = await fetch(`${URL_}/api/v4/projects/${project}/repository/commits`, {
      method: "POST",
      headers: { "PRIVATE-TOKEN": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({
        branch,
        start_branch: meta.default_branch,
        commit_message: "ryph live check",
        actions: [{ action: "create", file_path: `${branch}.txt`, content: `${stamp}\n` }],
      }),
    });
    assertEquals(res.status, 201, await res.clone().text());
    const headSha: string = (await res.json()).id;
    const check = {
      name: `live-${stamp}`,
      status: "in_progress" as const,
      conclusion: null,
      title: "live",
      summary: "",
      startedAt: null,
      completedAt: null,
      externalId: `cs-live:1:${stamp}`,
      forgeRef: null,
    };
    const report = {
      headSha,
      suiteId: "cs-live",
      generation: 1,
      detailsUrl: null,
      suite: { state: "running" as const, conclusion: null, summary: "" },
      checks: [check],
    };
    const first = await api.reportChecks(repo, report);
    assert(first.kind === "reported");
    const ref = first.refs[check.name];
    const again = await api.reportChecks(repo, {
      ...report,
      checks: [{ ...check, forgeRef: ref ?? null }],
    });
    assertEquals(again, { kind: "reported", refs: { [check.name]: ref } });
    const ci = await api.readChecks(repo, headSha);
    assert(ci.kind === "reported");
    assert(ci.items.some((c) => c.name === `ryph / ${check.name}`), "the status reads back");
    await fetch(`${URL_}/api/v4/projects/${project}/repository/branches/${branch}`, {
      method: "DELETE",
      headers: { "PRIVATE-TOKEN": TOKEN },
    });
  },
  60_000,
);
