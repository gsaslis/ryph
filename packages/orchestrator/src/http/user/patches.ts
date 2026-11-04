import { isTerminal } from "../../core/lifecycle.ts";
import type { ForgeProvider, Patch, PatchApprover, Task } from "../../core/types.ts";
import { patchMayShip } from "../../core/patch_permission.ts";
import { notifyPatch } from "../../core/inbox.ts";
import {
  approvePatch,
  isLandingHold,
  isPatchUnpublished,
  rejectPatch,
  retryPatch,
  submissionTarget,
} from "../../core/patch_lifecycle.ts";
import { applyLandingRule, heldDestinationOf } from "../../core/landing_rule.ts";
import { lineBase } from "../../core/landing.ts";
import { reportPatchFate } from "../../core/conclude_run.ts";
import { forgeRepoRef } from "../../core/forge_repo.ts";
import {
  MAX_PATCH_DECISION_BODY_BYTES,
  type PatchDecision,
  PatchDecisionSchema,
} from "../../schema.ts";
import { decodeListCursor } from "../../ports/task_store.ts";
import type { Principal, WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { scopeFor } from "../scope.ts";
import {
  PATCH_CHANGED_ERROR,
  type PatchChecksSummary,
  TOO_MANY_HOOK_FILES_ERROR,
  toPublicPatch,
} from "./public_views.ts";
import { repoAccess } from "./repo_access.ts";

/** The acting principal as a patch transition records it. */
function asApprover(caller: Principal): PatchApprover {
  return caller.kind === "user" ? { kind: "user", userId: caller.userId } : { kind: "break-glass" };
}

export function patchRoutes(deps: WiredDeps): Route[] {
  const { store } = deps;
  const nowIso = () => deps.now().toISOString();
  const { refuseRepoPermissionHere } = repoAccess(deps);

  // ---- patches -------------------------------------------------------------

  /**
   * A page of patches with the context the approval queue renders — what work, by whom, against
   * what. Four reads for the whole page rather than four PER PATCH, which is what this was and
   * what made the queue cost more the longer the deployment had been running.
   */
  const describePatches = async (patches: Patch[]) => {
    const [tasks, runs, repos] = await Promise.all([
      store.listTasksByIds([...new Set(patches.map((p) => p.taskId))]),
      store.listRunsByIds([...new Set(patches.map((p) => p.runId))]),
      store.listConnectedRepos(),
    ]);
    const byTask = new Map(tasks.map((r) => [r.task.id, r.task]));
    const agents = await store.listAgentsByIds([...new Set(tasks.map((r) => r.task.agentId))]);
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    const byRun = new Map(runs.map((r) => [r.id, r]));
    const byRepo = new Map(repos.map((r) => [r.id, r]));
    // The suite each patch is judged by, counted — the one its forge shows, beside the diff.
    const checks = new Map<string, PatchChecksSummary>();
    if (deps.checks) {
      const service = deps.checks;
      const suites = await Promise.all(patches.map((patch) => service.forPatch(patch)));
      for (const [i, patch] of patches.entries()) {
        const suite = suites[i];
        if (suite === null) continue;
        checks.set(patch.id, {
          suiteId: suite.id,
          state: suite.state,
          passed: suite.checks.filter((c) => c.state === "passed").length,
          failed: suite.checks.filter((c) =>
            c.state === "failed" || c.state === "timed_out" || c.state === "setup_failed" ||
            c.state === "error"
          ).length,
          total: suite.checks.length,
        });
      }
    }
    // Where approving each held, waiting one sends it, read now: the task moves under a hold
    // (`heldDestinationOf`). One task read per task that has one, which is few.
    const heldTasks = [
      ...new Set(
        patches.filter((p) => isLandingHold(p) && p.state === "pending_approval")
          .map((p) => p.taskId),
      ),
    ];
    const taskPatches = new Map(
      await Promise.all(heldTasks.map(async (id) => [id, await store.patchesForTask(id)] as const)),
    );
    return patches.map((patch) => {
      const task = byTask.get(patch.taskId) ?? null;
      const repo = byRepo.get(patch.connectedRepoId) ?? null;
      const run = byRun.get(patch.runId) ?? null;
      const siblings = taskPatches.get(patch.taskId);
      const result = run?.result ?? null;
      // The patch's own commits, as its branch reported them at its birth (`Patch.commits`).
      // Only a row that holds none falls back to its branch in the run's result — a set's other
      // members have their own rows and their own commits, and so does each other line of the
      // same repo. By name first; a result that moved the line on to a later generation's branch
      // still names the line.
      const own = patch.commits.length > 0
        ? patch
        : result?.branches.find((b) => b.path === patch.path && b.name === patch.branchName) ??
          result?.branches.find((b) => b.path === patch.path && b.line === patch.line) ?? null;
      return {
        ...toPublicPatch(patch, repo?.provider ?? null),
        taskTitle: task?.spec.title ?? null,
        agentName: task === null ? null : agentName.get(task.agentId) ?? null,
        // Which forge, beside its address: "12" is a number on one and a 40-hex object id on the
        // other, and a reader that had to tell them apart by SPELLING would be guessing.
        provider: repo?.provider ?? null,
        repoRef: repo?.repoRef ?? null,
        summary: result !== null && "summary" in result ? result.summary : null,
        commits: own?.commits ?? [],
        checks: checks.get(patch.id) ?? null,
        // Whether the run that made it still goes on: a held patch is not approvable until it
        // does not (`heldGate`). False when the run is gone.
        runLive: run !== null && !isTerminal(run),
        // Whether its hold waits for the run to end (a landing hold), not only for a person.
        heldUntilRunEnds: isLandingHold(patch),
        heldDestination: task !== null && siblings !== undefined && isLandingHold(patch) &&
            patch.state === "pending_approval"
          ? heldDestinationOf(task, repo, siblings, patch)
          : null,
      };
    });
  };

  const listPatches = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "patches:read");
    if (denied) return denied;
    const state = new URL(req.url).searchParams.get("state");
    const states: Patch["state"][] = [
      "pending_approval",
      "queued",
      "submitting",
      "submitted",
      "failed",
      "rejected",
      "superseded",
    ];
    if (state !== null && !states.includes(state as Patch["state"])) {
      return json(400, { error: `unknown patch state "${state}"`, states });
    }
    const params = new URL(req.url).searchParams;
    // Paged for the same reason the task list is: a patch per push per run is a table that only
    // grows, and the approval queue is the page people leave open.
    const limit = params.get("limit");
    if (limit !== null && (!/^\d{1,4}$/.test(limit) || Number(limit) < 1)) {
      return json(400, { error: "limit must be a whole number of rows" });
    }
    const cursor = params.get("cursor");
    if (cursor !== null && decodeListCursor(cursor) === null) {
      return json(400, { error: "cursor is not a cursor this surface issued" });
    }
    const page = await store.listPatches({
      state: state === null ? undefined : state as Patch["state"],
      limit: limit === null ? undefined : Number(limit),
      cursor: cursor ?? undefined,
      scope: await scopeFor(deps, caller, "tasks:read-all"),
    });
    return json(200, {
      patches: await describePatches(page.patches),
      nextCursor: page.nextCursor,
      hasMore: page.nextCursor !== null,
    });
  };

  /**
   * One patch and its task, as the caller may see them: the list's scope, applied through the
   * task the patch belongs to — the same predicate the list filters by. A patch outside it is
   * the same 404 as one that does not exist, so the answer never says which.
   */
  const visiblePatch = async (
    caller: Principal,
    id: string,
  ): Promise<{ patch: Patch; task: Task } | Response> => {
    const denied = refuseUnless(caller, "patches:read");
    if (denied) return denied;
    const patch = await store.getPatch(id);
    const task = patch === null
      ? null
      : await store.getTask(patch.taskId, await scopeFor(deps, caller, "tasks:read-all"));
    if (patch === null || task === null) return json(404, { error: "no such patch" });
    return { patch, task };
  };

  /**
   * What a patch's diff is measured against, beyond the patch itself: for one not yet published,
   * the branch the submission would land it on and the earlier patch whose change request that
   * is (core/patch_lifecycle.ts); a settled one is shown as a record. These move after the patch
   * is born, so the detail page reads them with the patch and reads the diff again when they do.
   * Null when the patch's repo has left its task's checkout.
   */
  const diffBasisOf = async (patch: Patch, task: Task) => {
    const entry = task.repos.find((r) =>
      r.connectedRepoId === patch.connectedRepoId && r.path === patch.path
    );
    if (entry === undefined) return null;
    const repo = await store.getConnectedRepo(patch.connectedRepoId);
    if (repo === null) return null;
    const live = isPatchUnpublished(patch);
    const target = submissionTarget(
      task,
      await store.patchesForTask(task.id),
      patch,
      lineBase(entry, task.landings, patch.line, patch.runId),
      repo.provider,
    );
    // A published patch is measured against what its submission measured it against, as it
    // recorded it: the task may have moved on since (a merge lands the repo elsewhere), and a
    // settled patch's diff is a record of what was sent.
    return {
      mode: live ? "live" as const : "record" as const,
      targetRef: !live && patch.diffRef !== null ? patch.diffRef : target.diffRef,
      previous: live ? target.earlier : undefined,
    };
  };

  /** The basis as the page reads it. */
  const publicBasis = (basis: Awaited<ReturnType<typeof diffBasisOf>>) =>
    basis === null ? null : {
      mode: basis.mode,
      targetRef: basis.targetRef,
      sincePatchId: basis.previous?.id ?? null,
    };

  const getPatchRoute = async (req: Request, params: Record<string, string>) => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const found = await visiblePatch(caller, params.id);
    if (found instanceof Response) return found;
    const [patch] = await describePatches([found.patch]);
    return json(200, {
      patch,
      diffBasis: publicBasis(await diffBasisOf(found.patch, found.task)),
    });
  };

  /**
   * What a patch changes, for whoever decides on it, as the forge reads it out of the bundle:
   * for one not yet published, measured against the branch the submission would land it on
   * (`diffBasisOf`); for one settled, a record from its own base. The forge files the diff
   * beside the bundle, keyed on what it was measured against, so a second look is one read.
   */
  /** The forge's diff of a patch against what it would publish onto now (`diffBasisOf`). */
  const measurePatch = async (patch: Patch, task: Task) => {
    if (!deps.patchDiffs) {
      return json(503, { error: "the forge is not configured; patch diffs are unavailable" });
    }
    const repo = await store.getConnectedRepo(patch.connectedRepoId);
    if (!repo) return json(409, { error: "the patch's connected repo no longer resolves" });
    const basis = await diffBasisOf(patch, task);
    if (basis === null) {
      return json(409, { error: "the patch's repo is not in its task's checkout" });
    }
    const outcome = await deps.patchDiffs.readPatchDiff(forgeRepoRef(repo), repo.url, {
      connectedRepoId: repo.id,
      bundleKey: patch.bundleKey,
      branchName: patch.branchName,
      headSha: patch.headSha,
      baseSha: patch.baseSha,
      targetRef: basis.targetRef,
      mode: basis.mode,
    });
    return { basis, outcome };
  };

  /**
   * Every answer of the diff route, the refusals as much as the diff, is the caller's own: read
   * under their permissions and naming their patch's bundle. None is kept by anything shared,
   * and the diff itself is asked again each time — what it runs from can move (the task
   * retargeted, an earlier patch's change request closed); the forge keeps the diff it made, so
   * a second look costs one read.
   */
  const getPatchDiff = async (req: Request, params: Record<string, string>) => {
    const res = await readPatchDiffRoute(req, params);
    res.headers.set("cache-control", "private, no-cache");
    return res;
  };

  const readPatchDiffRoute = async (req: Request, params: Record<string, string>) => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const found = await visiblePatch(caller, params.id);
    if (found instanceof Response) return found;
    const measured = await measurePatch(found.patch, found.task);
    if (measured instanceof Response) return measured;
    const { basis, outcome } = measured;
    switch (outcome.kind) {
      case "diff": {
        return json(200, {
          diff: outcome.diff,
          baseSha: outcome.baseSha,
          headSha: outcome.headSha,
          truncated: outcome.truncated,
          omitted: outcome.omitted,
          moreOmitted: outcome.moreOmitted,
          // What it was measured with, beside it, so a page names and approves the basis of
          // this very diff; with a `sincePatchId`, it is only what this patch adds to that one.
          ...publicBasis(basis),
        });
      }
      case "refused":
        // The forge's verdict on this patch, and final: a bundle gone stays gone.
        return json(outcome.status === 410 ? 410 : 409, { error: outcome.error });
      case "unavailable":
        return json(503, { error: `the forge could not diff the patch: ${outcome.error}` });
    }
  };

  /**
   * The live gate for an action on a patch. The patch names its repo by id, so the row is
   * loaded here and handed to the same check every other repo-reaching route runs.
   */
  const refusePatchRepoPermission = async (
    caller: Principal,
    patch: Patch,
    atLeast: "write" | "admin",
  ): Promise<Response | null> => {
    const repo = await store.getConnectedRepo(patch.connectedRepoId);
    if (!repo) return json(409, { error: "the patch's connected repo no longer resolves" });
    return await refuseRepoPermissionHere(caller, repo, atLeast);
  };

  /**
   * approve/reject/retry share the shape: load, check, transition purely, persist, answer.
   * `atLeast` is the permission the action needs on the patch's repo; null skips the check.
   */
  const patchTransition = (
    atLeast: "write" | "admin" | null,
    transition: (
      patch: Patch,
      caller: Principal,
      at: string,
      context: { decision: PatchDecision | null; provider: ForgeProvider | null },
    ) => ReturnType<typeof approvePatch>,
    /** True for a transition that sends the patch on to the forge (approve, retry). */
    ships = false,
    precheck?: (
      patch: Patch,
      task: Task,
      decision: PatchDecision | null,
    ) => Promise<Response | null>,
  ) =>
  async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "patches:review");
    if (denied) return denied;
    // The decision body, read once: the basis a diff was read on, and the hook files shown.
    const body = await parseBody(req, PatchDecisionSchema.nullable(), {
      maxBytes: MAX_PATCH_DECISION_BODY_BYTES,
      emptyIs: null,
    });
    if (!body.ok) return body.res;
    const decision = body.data;
    const patch = await store.getPatch(params.id);
    const owner = patch === null
      ? null
      : await store.getTask(patch.taskId, await scopeFor(deps, caller, "tasks:read-all"));
    if (!patch || owner === null) return json(404, { error: "no such patch" });
    if (atLeast !== null) {
      const refused = await refusePatchRepoPermission(caller, patch, atLeast);
      if (refused) return refused;
    }
    // A patch whose agent's patches were switched off after it opened goes nowhere: the switch
    // is read live, and a reject stays open so the queue can still be cleared.
    // A patch whose run is gone moves as before, and the sweep fails it for good.
    if (ships && await patchMayShip(store, patch) === "locked") {
      return json(409, { error: "this patch's agent may no longer open patches" });
    }
    if (precheck) {
      const refused = await precheck(patch, owner, decision);
      if (refused) return refused;
    }
    const repo = await store.getConnectedRepo(patch.connectedRepoId);
    const outcome = transition(patch, caller, nowIso(), {
      decision,
      provider: repo?.provider ?? null,
    });
    if (outcome.kind === "refused") return json(409, { error: outcome.why });
    // Over the row exactly as it was read (its version), as the sweep's own writes are: a hook
    // check recorded meanwhile, a delivery that held it again, a merge's landing rule that
    // retired it (replaced, or held with its approval reset), a newer patch superseding it — the
    // person decided on something that is no longer there, and writing over it would undo that
    // (or put the old patch back on its way to where it no longer goes). Its events with it.
    // Nothing is told; they look again.
    if (
      await store.savePatchIfState(
        outcome.patch,
        [patch.state],
        undefined,
        patch.version,
        outcome.events,
      ) === null
    ) {
      return json(409, { code: "patch_changed", error: PATCH_CHANGED_ERROR });
    }
    // Declined by a person: the run's claims about this change are dropped with it. The run
    // hears of either verdict while it is alive to — an agent mid-conversation can revise.
    if (outcome.patch.state === "rejected") {
      await reportPatchFate(deps, outcome.patch, "dropped");
      await notifyPatch(
        deps,
        outcome.patch,
        "rejected",
        `rejected by ${caller.kind === "user" ? caller.userId : "break-glass"}`,
      );
    } else if (outcome.patch.state === "queued" && patch.state === "pending_approval") {
      await notifyPatch(deps, outcome.patch, "approved", null, undefined, {
        provider: repo?.provider ?? null,
      });
    }
    return json(200, { patch: toPublicPatch(outcome.patch, repo?.provider ?? null) });
  };

  // Approve and retry both end in a push and a PR on the upstream, so both need write — the
  // same permission launching a task against the repo needs — and a reject is the same
  // decision taken the other way, so it takes the same permission.
  // An approval made looking at a diff names what that diff was measured against — where it
  // lands, and the commit it was measured from — and is refused if that has moved since: an
  // earlier patch's change request closed, the task retargeted, the branch it lands on
  // force-pushed. Approving would then publish something other than what was read. The diff is
  // measured again for this (the forge keeps it per tip, so an unmoved branch costs one read). A
  // retry publishes too, so it takes the same check. One made without a basis (the queue's own
  // buttons, the API) acts on the patch as it stands.
  const unmovedBasis = async (patch: Patch, task: Task, decision: PatchDecision | null) => {
    if (decision === null || decision.diffBasis === undefined) return null;
    const read = decision.diffBasis;
    const moved = json(409, {
      error: "what this patch would publish has changed since its diff was read",
      code: "diff_basis_moved",
    });
    // As the rows stand, before the forge is asked: a basis that moved is refused from the store.
    const now = publicBasis(await diffBasisOf(patch, task));
    if (now === null) return read === null ? null : moved;
    if (read === null) return moved;
    const differs = (b: NonNullable<typeof now>) =>
      read.mode !== b.mode || read.targetRef !== b.targetRef ||
      read.sincePatchId !== b.sincePatchId;
    if (differs(now)) return moved;
    const measured = await measurePatch(patch, task);
    if (measured instanceof Response) return measured;
    // And as this very measurement used it, so nothing can move between the two.
    const { basis, outcome } = measured;
    if (differs(publicBasis(basis)!)) return moved;
    if (outcome.kind === "refused") {
      return json(outcome.status === 410 ? 410 : 409, { error: outcome.error });
    }
    if (outcome.kind === "unavailable") {
      return json(503, {
        error: `the forge could not confirm what this patch would publish: ${outcome.error}`,
      });
    }
    return outcome.baseSha === read.baseSha ? null : moved;
  };
  // A held patch (docs/patch-lifecycle.md "Landing") is one of two holds. A landing hold
  // (`isLandingHold`): its generation already landed (a sibling merged, the change request
  // merged without one, or a release), so what it would publish may repeat commits that merged.
  // While its run goes on it is not anyone's to send — the run's next submit, once its agent
  // moved its work onto what merged, replaces it; the run may end without one, and the patch then
  // stays held. Or a review hold, any other reason (core/open_patch.ts): its branch is not on
  // where its line merged, it holds another line's commits, or neither could be confirmed —
  // which a person may send while its run goes on. Either way a person may send it only having looked: a decision made without the diff it
  // would publish (the queue's one-click button) is refused, so a hold is never cleared blind.
  const heldGate = async (patch: Patch, task: Task, decision: PatchDecision | null) => {
    // The rule first, every time, over a fresh read: a patch whose generation landed but that no
    // entry point has ruled yet (a birth or a claim that raced the merge, before the reconcile
    // came by) is held now, and a held one a newer patch replaces is replaced — the decision
    // refused either way, rather than made blind. A retry is asked about as the patch it would
    // make (back in the queue): a failure with no clock is not otherwise the rule's.
    const patches = await store.patchesForTask(patch.taskId);
    const read = patches.find((p) => p.id === patch.id) ?? patch;
    const current = read.state === "failed" && read.nextAttemptAt === null
      ? { ...read, nextAttemptAt: nowIso() }
      : read;
    if (await applyLandingRule(deps, current, patches, nowIso())) {
      const now = await store.getPatch(patch.id);
      if (now?.state === "superseded") {
        return json(409, {
          error: "a newer patch of this branch replaced this one",
          code: "superseded",
        });
      }
      if (now !== null && isLandingHold(now) && !isLandingHold(patch)) {
        // Its own reason, whichever hold it is: a sibling merged, the change request merged
        // without one, or a release.
        return json(409, {
          error: `this patch is on hold. ${now.heldReason}`,
          code: "held",
        });
      }
      return json(409, { code: "patch_changed", error: PATCH_CHANGED_ERROR });
    }
    if (patch.heldReason !== null) {
      const run = isLandingHold(patch) ? await store.getRun(patch.runId) : null;
      if (run !== null && !isTerminal(run)) {
        return json(409, {
          error: "this patch is on hold while its run goes on: the run sends a replacement. " +
            "Message the run to have it submit now",
          code: "held_run_live",
        });
      }
      if (decision === null || decision.diffBasis === undefined) {
        return json(409, {
          error: "this patch is held: decide on it from its page, with its diff in view",
          code: "held_needs_diff",
        });
      }
    }
    return await unmovedBasis(patch, task, decision);
  };
  // A `local` patch's approval covers the git hook files the approver was SHOWN (`hookPaths`)
  // that the server also knows it touches — never more than either. The page may have rendered
  // before the check landed or before it changed. Not refused when they differ: the forge holds
  // the patch again for any hook file left out, which puts the warning back in front of a person
  // — the gate is there, not in this route. Other forges carry no hook list, and keep theirs
  // untouched.
  //
  // One case IS refused here: a check that found more hook files than it names (`more`). Those
  // can never be shown, so no approval could cover them, and approving would only send the patch
  // round the forge's hold and back to this queue, forever. Nothing changes and the run is told
  // nothing; rejecting it stays open. Only a `local` patch ever carries a hook check.
  // Then the landing hold (`heldGate`), which ends in the basis check.
  const approvable = async (patch: Patch, task: Task, decision: PatchDecision | null) => {
    if (patch.state === "pending_approval" && patch.hookCheck?.more === true) {
      return json(409, {
        code: "too_many_hook_files",
        error: TOO_MANY_HOOK_FILES_ERROR,
      });
    }
    return await heldGate(patch, task, decision);
  };
  const approve = patchTransition(
    "write",
    (patch, caller, at, { decision, provider }) => {
      if (provider !== "local") return approvePatch(patch, asApprover(caller), at);
      const shown = new Set(decision?.hookPaths ?? []);
      const covered = (patch.hookCheck?.touched ?? []).filter((path) => shown.has(path));
      return approvePatch(patch, asApprover(caller), at, covered);
    },
    true,
    approvable,
  );
  const reject = patchTransition(
    "write",
    (patch, caller, at) => rejectPatch(patch, asApprover(caller), at),
  );
  const retry = patchTransition(
    "write",
    (patch, _caller, at) => retryPatch(patch, at),
    true,
    heldGate,
  );

  return [
    route("GET", "/v1/patches", listPatches),
    route("GET", "/v1/patches/:id", getPatchRoute),
    route("GET", "/v1/patches/:id/diff", getPatchDiff),
    route("POST", "/v1/patches/:id/approve", approve),
    route("POST", "/v1/patches/:id/reject", reject),
    route("POST", "/v1/patches/:id/retry", retry),
  ];
}
