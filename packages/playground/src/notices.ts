/** A visual catalogue, not a claim that all these mutually exclusive outcomes happened.
 * Inbox rows are installed during the existing offline backdating pass; the public message API
 * rightly cannot impersonate the platform. Runner-local notices go through the historian API.
 */
import type { Context } from "./context.ts";

export interface Notice {
  kind: "system" | "user";
  sender: { kind: "platform" } | { kind: "user"; userId: string };
  text: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  wake?: { afterMinutes: number; note: string | null };
  checksLate?: { owed: number | null };
  background?: {
    id: string;
    label: string;
    reason: "ready" | "exited" | "timeout";
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
  };
  subagent?: {
    id: string;
    label: string;
    reason: "answered" | "failed" | "timeout";
    durationMs: number;
  };
}

/** The generation's base, as a missed or released cue lands the generation at it. */
const GENERATION_BASE = "7d3e9a1c5b20";

/** The note the runner adds to a landing cue (runner core/patches.ts `fetchLanded`), for the
 * default line's branch: what it fetched and the exact command, past `landedHead` — the merged
 * head, or the generation's base for a missed or released cue. */
function landedNote(landedHead: string): string {
  const branch = "ryph/ada/wi-1/work";
  const x = landedHead.slice(0, 12);
  return "ryph fetched `origin/main` at `4f1c2a9e7b3d`. " +
    `To go on with \`${branch}\`, rebase it onto ` +
    `\`origin/main\`: \`git rebase --onto origin/main ${x} ${branch}\` (commit or stash ` +
    "uncommitted changes first), or merge it with ryph__update_from_base. To start fresh " +
    "instead, make a new branch from `origin/main`, move your later commits onto it, then " +
    `delete \`${branch}\` (\`git branch -D ${branch}\`) so its work does not ship twice.`;
}

export const NOTICE_TITLE = "Platform notices — every type (visual catalogue)";

export function noticeCatalogue(
  userId: string,
  patchId: string,
  headSha: string,
  createdAt: string,
) {
  const note = (text: string, payload: Notice["payload"] = null): Notice => ({
    kind: "system",
    sender: { kind: "platform" },
    text,
    payload,
    createdAt,
  });
  const patch = {
    kind: "patch",
    patchId,
    path: ".",
    headSha,
    generation: 1,
    forgeUrl: null,
    reason: null,
  };
  const inbox: Notice[] = [
    {
      ...note(
        "Please keep the full technical detail available; this is an ordinary human message, not a platform notice.",
      ),
      kind: "user",
      sender: { kind: "user", userId },
    },
    note(
      "Your patch for `.` was approved and is being submitted. Another message names it once it is open.",
      { ...patch, state: "approved" },
    ),
    note(
      "Your patch for `.` was submitted: https://example.com/acme/api/pull/42. Further submissions update this change request until it merges or closes.",
      { ...patch, state: "submitted", forgeUrl: "https://example.com/acme/api/pull/42" },
    ),
    note(
      "Your patch for `.` was merged into `main`, and that change request is done. To go on with this branch, rebase what you did after it onto `origin/main`: ryph adds a note with the exact command; if there is none, call ryph__update_from_base. Your next submit_patch opens a new change request." +
        `\n\n${landedNote(headSha)}`,
      { ...patch, state: "merged", onto: "main", landedHead: headSha },
    ),
    note(
      "Submitting your patch for `.` failed: the remote rejected the push because its protected branch requires a passing check. A person can retry it from the patch queue.",
      { ...patch, state: "failed", reason: "Protected branch requires a passing check" },
    ),
    note("Your patch for `.` was rejected: please split the migration from the API change.", {
      ...patch,
      state: "rejected",
      reason: "Please split the migration from the API change",
    }),
    note("The change request for your patch for `.` (head `9f2c4e1`) was closed without merging.", {
      ...patch,
      state: "closed",
    }),
    note(
      "Your patch for `.` was replaced by a newer one. Its commits remain in the next submission.",
      { ...patch, state: "superseded" },
    ),
    note(
      "Your patch for `.` (head `9f2c4e1`) is not in what merged: its change request merged into `main` without it, and that change request is done. Those commits are not in `main`. Rebase them onto `origin/main` (ryph adds a note with the exact command; if there is none, call ryph__update_from_base) and submit again." +
        `\n\n${landedNote(GENERATION_BASE)}`,
      { ...patch, state: "missed", onto: "main" },
    ),
    note(
      `Your patch for \`.\` changes git hook files (\`.husky/pre-commit\`). This repository is on the owner's computer, and git hooks run there when the branch is checked out, so a person must look at the patch and approve it in ryph before it reaches the repository — whatever the repository's usual approval setting. Tell whoever you are working with that the patch is waiting for that approval, and why, and give them its page, where they approve it: /patches/${patchId}. Do not try to get around it: no moving, renaming or re-submitting the hook changes to slip past the check. A message tells you once it is approved.`,
      { ...patch, state: "held", hookPaths: [".husky/pre-commit"] },
    ),
    ...(["ready", "failed", "superseded", "skipped"] as const).map((status) =>
      note(
        status === "ready"
          ? "The environment build for your patch for `.` succeeded. Future runs can use the prepared image; this run keeps its current checkout."
          : status === "failed"
          ? "The environment build for your patch for `.` failed: setup exited with code 1 while installing dependencies. Inspect the build log before retrying."
          : status === "superseded"
          ? "The environment build for your patch for `.` was superseded by a newer build."
          : "No environment build was needed for your patch for `.`: the environment inputs did not change.",
        { kind: "environment", patchId, path: ".", headSha, environmentId: null, status },
      )
    ),
    note(
      "The change request `#42` merged into `main` with nothing of this run on it, so this task no longer works on it. Rebase your commits in `.` onto `origin/main` (ryph adds a note with the exact command; if there is none, call ryph__update_from_base), and your next submit_patch opens a new change request." +
        `\n\n${landedNote(GENERATION_BASE)}`,
      { kind: "released", path: ".", generation: 1, onto: "main", forgeRef: "42" },
    ),
    ...(["passed", "failed", "error", "cancelled"] as const).map((state) =>
      note(
        `Checks for api at ${
          headSha.slice(0, 10)
        }: ${state}.\nOriginal check output stays available here.`,
        {
          kind: "checks",
          // This visual catalogue has no persisted suite to link to.
          suiteId: "",
          path: "api",
          commit: headSha,
          state,
          partial: false,
        },
      )
    ),
    note("The selected lint check passed. Other checks were not requested.", {
      kind: "checks",
      suiteId: "",
      path: "api",
      commit: headSha,
      state: "passed",
      partial: true,
    }),
    note("A platform update without structured metadata. Its full text is available in Details."),
    note(
      "A future platform notice with an unrecognised payload. Keep this original text visible in the fallback rather than losing information.",
      { kind: "future-platform-notice", diagnostic: "Forward-compatibility example" },
    ),
    {
      ...note(
        "Olivia Owner finished the run after reviewing the agent's reported outcome. Outstanding check verdicts will not delay finishing.",
        { kind: "finish" },
      ),
      sender: { kind: "user", userId },
    },
  ];
  const runner: Notice[] = [
    {
      ...note(
        "The wake-up you asked for 5 minutes ago is due. Your note: check whether the rollout has settled, then report the current error rate.",
      ),
      wake: { afterMinutes: 5, note: "Check whether the rollout has settled" },
    },
    {
      ...note(
        "The checks did not report a verdict in time, and the run has stopped waiting for them. Do not wait for them any longer: finish with what you have, and say in your summary that their verdict never arrived.",
      ),
      checksLate: { owed: 2 },
    },
    ...(["ready", "exited", "timeout"] as const).map((reason, i): Notice => ({
      ...note(
        reason === "ready"
          ? 'Background command "preview server" is ready after 2.4s. Matched readyWhen: Listening on http://127.0.0.1:3000. The service is still running; its output remains in /tmp/ryph-background/bg-notice-0.log.'
          : reason === "exited"
          ? 'Background command "integration tests" exited with code 1 after 12.5s. Output: FAIL webhook retry exhaustion — expected 503, received 500. Full log: /tmp/ryph-background/bg-notice-1.log.'
          : 'Background command "deployment watch" timed out after 60s and was terminated with SIGTERM. Last output: waiting for 2 replicas to become ready. Full log: /tmp/ryph-background/bg-notice-2.log.',
      ),
      background: {
        id: `bg-notice-${i}`,
        label: ["preview server", "integration tests", "deployment watch"][i],
        reason,
        exitCode: reason === "exited" ? 1 : null,
        signal: reason === "timeout" ? "SIGTERM" : null,
        durationMs: [2400, 12500, 60000][i],
      },
    })),
    ...(["answered", "failed", "timeout"] as const).map((reason, i): Notice => ({
      ...note(
        reason === "answered"
          ? 'Subagent "Review retry handling" answered after 18s:\n\nThe retry loop is bounded, but the handler still converts the final error to HTTP 500. Catch that error at the webhook boundary and return 503 so Stripe\'s own retry schedule takes over. The session tests are unrelated.'
          : reason === "failed"
          ? 'Subagent "Inspect migration" failed after 7s: the model request was rejected because the context window was exceeded. No files were changed. Retry with a narrower task or inspect migrations/ manually.'
          : 'Subagent "Audit deployment" timed out after 120s without an answer. Its last observation was that two replicas remained unready; do not treat the deployment as verified.',
      ),
      subagent: {
        id: `sa-notice-${i}`,
        label: ["Review retry handling", "Inspect migration", "Audit deployment"][i],
        reason,
        durationMs: [18000, 7000, 120000][i],
      },
    })),
  ];
  return { inbox, runner };
}

export async function seedNotices(ctx: Context): Promise<void> {
  const realStart = new Date().toISOString();
  const { run, taskId } = await ctx.startRun(ctx.owner, {
    agentId: ctx.agent("ada").id,
    connectedRepoId: ctx.repo("acme-api").id,
    spec: {
      title: NOTICE_TITLE,
      instructions:
        "A visual catalogue of platform notices, not a real sequence of patch outcomes. Expand each notice to inspect its original verbose details. The pending hook patch is real and can be reviewed.",
    },
  });
  await run.play([
    {
      say:
        "This catalogue deliberately shows mutually exclusive outcomes side by side. Only the pending hook patch is real; the other platform notices are visual examples. Human messages should remain visually distinct.",
    },
    {
      write: ".husky/pre-commit",
      content: "#!/bin/sh\n# Playground inspection fixture: intentionally a no-op.\nexit 0\n",
    },
    {
      submit: {
        title: "Notice catalogue: review a harmless git hook",
        description: "A no-op hook used to inspect the approval hold UI. Review before approving.",
      },
    },
  ], 0);
  const { patches } = await ctx.owner.get<
    { patches: Array<{ id: string; runId: string; headSha: string }> }
  >("/v1/patches?limit=100");
  const patch = patches.find((p) => p.runId === run.runId);
  if (!patch) throw new Error("notice catalogue did not create its reviewable hook patch");
  const { inbox, runner } = noticeCatalogue(
    ctx.owner.person.id,
    patch.id,
    patch.headSha,
    new Date().toISOString(),
  );
  for (const notice of runner) run.emit("transcript", "inbound", notice.text, notice);
  await run.conclude({
    kind: "success",
    summary:
      "Visual catalogue complete. Inspect the platform notices and their original details; the harmless hook patch remains available for human review.",
  });
  ctx.timeline.push({
    runId: run.runId,
    taskId,
    realStart,
    realEnd: new Date().toISOString(),
    ageMs: 30 * 60_000,
    durationMs: 10 * 60_000,
    notices: inbox,
  });
  console.log(`  platform-notices: ${run.runId} — /tasks/${taskId}`);
}
