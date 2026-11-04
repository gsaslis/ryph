// Build results into a run's inbox. An agent cannot run Docker, and must not be able to, so the
// only way it learns whether the `.ryph/` it wrote describes a working machine is that the platform
// builds it and says. This file is that loop:
//
//   any task's patch reaches the forge as a branch → it changed `.ryph/` since it forked from
//   the default branch → the branch environment is built (core/environments.ts,
//   trigger `patch`) → when the build settles, the result lands in THAT run's inbox as a
//   platform message
//
// The trigger is the patch reaching the forge (`submitted`), not its birth: a branch build clones
// the branch from the forge like any other, and on GitHub the patch's commits are not on a branch
// of the connected repo until then (on Radicle, a change request our own node published counts as
// the repo's branch — forge `branchKind`). So under `require-approval` every round waits for a
// maintainer's yes before it is built, which is the review the policy asks for anyway.
//
// Invariants:
// - a patch asks for a build only when it CHANGED `.ryph/` since its merge base with the default
//   branch (core/ryph_baseline.ts): a branch that merely fell behind a default branch that moved
//   its `.ryph/` describes no machine of its own. "Changed" is the forge's tree id, which
//   leaves out the files no build reads (checks.yml, services.yml, environment.md), so a patch
//   that touched only those builds nothing. Whatever the task: the ryph-environment skill
//   tells any agent that edits `.ryph/` to wait for this result
// - a setup run always hears what its patch came to; any other run hears it only once its patch
//   changed `.ryph/`, so a patch that left `.ryph/` alone sends no message
// - a patch whose `.ryph/` the branch's last patch build already has takes that build instead
//   of queueing one, so a code-only follow-up push never rebuilds; a failed build, and a ready
//   one whose setup.yml step failed, was invalid or left the tree dirty, answers only for its own
//   commit, so the next push retries it (setup.yml can trip on files outside `.ryph/`); an
//   `unreadable` or `discarded` warning alone does not. A run hears one result per build, never an
//   older patch's after a newer one's, and nothing when it last heard of that very build. A
//   patch build ranks with a run's (`BUILD_PRIORITY`), since its run waits for it; any other
//   task's patch is not built at all once its run has ended
// - only the branch's head patch builds, takes a build or supersedes one: a patch the branch has
//   moved past (checked late) leaves the branch's builds alone, and the newer patch answers
// - one check and one result per patch (= per head): the check is CLAIMED (`createPatchBuild`,
//   insert-if-absent, leased) before the forge is read or a build queued, only the lease holder
//   resolves it, and delivery is a compare-and-set on `reportedAt`. A run that already ended is
//   not told — the row, and the environment it names, are the record
// - no check is lost: one the forge could not answer keeps its row and is retried; the build
//   tick's backstop retakes an expired lease, tells results and notes nobody told, and checks a
//   submitted patch whose check was never claimed. A waiting run idles on its inbox, so nothing
//   may wait on the agent asking
// - the platform's words and the build's output never share a line (core/environment_messages.ts
//   composes every message): everything the BUILD wrote
//   (its log tail, its failure text, the toolchain versions it printed) is fenced by a nonce
//   minted per message, and the platform says so before the fence. The runner fences the whole
//   message once more; this fence is what keeps a Dockerfile's `RUN echo` from speaking as the
//   platform inside it
// - never throws for the caller: the submitter and the settle hook are best-effort relays

import type { Environment, EnvironmentPayload, Patch, PatchBuild, Run, Task } from "./types.ts";
import { MAX_MESSAGE_CHARS } from "./types.ts";
import {
  composeBuildResult,
  composeSkippedNote,
  fenceNonce,
  formatDuration,
  patchLabel,
} from "./environment_messages.ts";
import { type EnvironmentService, sameImage } from "./environments.ts";
import { forgeRepoRef, runFacingRepoName } from "./forge_repo.ts";
import { compareWithBaseline, machineTree } from "./ryph_baseline.ts";
import { ENVIRONMENT_SETUP } from "./environment_setup.ts";
import { setupBroke } from "./setup_warnings.ts";
import { type InboxDeps, postMessage } from "./inbox.ts";
import { isTerminal } from "./lifecycle.ts";
import { normalizeBaseRef } from "@ryph/shared/refs";
import type { Forge } from "../ports/forge.ts";
import type { TaskStore } from "../ports/task_store.ts";

export interface EnvironmentFeedbackDeps {
  environments: EnvironmentService;
  forge: Forge;
  store:
    & InboxDeps["store"]
    & Pick<TaskStore, "getTask" | "getPatch" | "patchesForTask" | "getConnectedRepo">;
  diag: InboxDeps["diag"];
  inbox?: InboxDeps["inbox"];
  now(): Date;
  /** The fence token; tests pin it. */
  nonce?: () => string;
}

/** One patch of a run, as `environment_status` reports it. */
export interface RunBuildStatus {
  patchId: string;
  path: string;
  headSha: string;
  patchState: Patch["state"];
  branch: string | null;
  note: string | null;
  environment: Environment | null;
}

export interface EnvironmentFeedback {
  /** A patch reached the forge: check it, and build its branch when it changed `.ryph/`. */
  patchSubmitted(patch: Patch): Promise<void>;
  /** The settle hook: tell every run whose patch this build answers. */
  settled(environment: Environment): Promise<void>;
  /** The backstop, on the build tick: checks whose checker died or whose forge read failed,
   * submitted patches no check ever claimed, and results or notes settled but never told
   * (a replica died between the two, or the build was superseded, which announces nothing). */
  sweep(): Promise<void>;
  /** What the run's patches asked for — retrying a check that is due — and the text the
   * `environment_status` tool answers with. */
  statusForRun(run: Run): Promise<{ builds: RunBuildStatus[]; text: string }>;
}

/** A check's lease: longer than its forge reads and a queued build take, short enough that a
 * checker that died is taken over within minutes. */
const CLAIM_MS = 5 * 60_000;
/** How long a check the forge could not answer waits before the next try. */
const RETRY_MS = 30_000;
/** A check that has failed this long is given up on, with a note — the forge is not coming. */
const GIVE_UP_MS = 24 * 60 * 60_000;
/** How far back the backstop looks for a submitted patch no check ever claimed, and how many
 * it takes per tick. */
const UNCHECKED_WINDOW_MS = 24 * 60 * 60_000;
const UNCHECKED_BATCH = 50;

/** Patches in the order they were made: when, then id, so two made at one instant still order. */
const byMade = (a: Pick<Patch, "id" | "createdAt">, b: Pick<Patch, "id" | "createdAt">) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** A claimed check that has resolved to neither a build nor a note. */
const unresolved = (row: PatchBuild) => row.environmentId === null && row.note === null;

const settledStatus = (env: Environment | null): env is Environment =>
  env !== null && (env.status === "ready" || env.status === "failed" ||
    env.status === "superseded");

export function makeEnvironmentFeedback(deps: EnvironmentFeedbackDeps): EnvironmentFeedback {
  const { environments: service, forge, store, diag } = deps;
  const nonce = deps.nonce ?? fenceNonce;
  const nowIso = () => deps.now().toISOString();
  const errText = (err: unknown) => err instanceof Error ? err.message : String(err);

  /** Posts a platform message to a live run; a lost post is a lost note (the row still says). */
  const tell = async (runId: string, text: string, payload: EnvironmentPayload): Promise<void> => {
    const run = await store.getRun(runId);
    if (run === null || isTerminal(run)) return;
    const outcome = await postMessage(
      { store, diag, inbox: deps.inbox ?? null, now: deps.now },
      run,
      { kind: "system", sender: { kind: "platform" }, text, payload },
    ).catch((err) => ({ kind: "refused" as const, error: errText(err) }));
    if (outcome.kind === "refused") {
      diag.warn("environments.feedback_post_failed", { runId, err: outcome.error });
    }
  };

  /**
   * Whether the run has moved past `row`'s build: a newer patch of the run took a build (this
   * one included), whose result is the one to tell. So a run hears one result per build and
   * never an older patch's after a newer one's, superseded or not.
   */
  const movedPast = async (patch: Patch): Promise<boolean> => {
    const newer = new Set((await newerPatches(patch)).map((p) => p.id));
    return (await service.store.listPatchBuildsForRun(patch.runId))
      .some((other) => newer.has(other.patchId) && other.environmentId !== null);
  };

  /**
   * Tells one patch's run what its check came to — once: a settled build, or the note saying
   * why none was due, which is unreported only when its run would otherwise wait
   * (`resolveSkip`). Anything else — a build still running, a check still unresolved — waits
   * for the next caller.
   */
  const deliver = async (row: PatchBuild, env: Environment | null): Promise<void> => {
    if (row.environmentId === null ? row.note === null : !settledStatus(env)) return;
    if (!await service.store.markPatchBuildReported(row.patchId, nowIso())) return;
    const [patch, run] = await Promise.all([
      store.getPatch(row.patchId),
      store.getRun(row.runId),
    ]);
    if (patch === null || run === null || isTerminal(run)) return;
    if (env !== null && await movedPast(patch)) return;
    const payload = {
      kind: "environment" as const,
      patchId: patch.id,
      path: patch.path,
      headSha: patch.headSha,
    };
    if (env === null) {
      await tell(run.id, composeSkippedNote(patch, row.branch, row.note!), {
        ...payload,
        environmentId: null,
        status: "skipped",
      });
      return;
    }
    await tell(
      run.id,
      composeBuildResult({ patch, branch: row.branch, environment: env, nonce: nonce() }),
      {
        ...payload,
        environmentId: env.id,
        status: env.status as "ready" | "failed" | "superseded",
      },
    );
    diag.debug("environments.feedback_delivered", {
      runId: run.id,
      patchId: patch.id,
      environmentId: env.id,
      status: env.status,
    });
  };

  /** The run's live patches newer than `patch`, by when each was made. */
  const newerPatches = async (patch: Pick<Patch, "id" | "runId" | "taskId" | "createdAt">) =>
    (await store.patchesForTask(patch.taskId)).filter((p) =>
      p.runId === patch.runId && byMade(p, patch) > 0 && p.state !== "rejected" &&
      p.state !== "superseded"
    );

  /** The build the run's newest other patch with a build took, if any: what it last heard of. */
  const lastBuildOf = async (patch: Patch): Promise<string | null> => {
    const rows = (await service.store.listPatchBuildsForRun(patch.runId))
      .filter((row) => row.patchId !== patch.id && row.environmentId !== null);
    const made = new Map((await store.patchesForTask(patch.taskId)).map((p) => [p.id, p]));
    const of = (row: PatchBuild) => made.get(row.patchId) ?? { id: row.patchId, createdAt: "" };
    return rows.sort((a, b) => byMade(of(b), of(a)))[0]?.environmentId ?? null;
  };

  /** What examining a claimed patch came to. `tell`: whether the run hears a skip. */
  type Examined =
    | { kind: "skip"; tell: boolean; branch: string | null; note: string }
    | { kind: "build"; task: Task; branch: string; environment: Environment }
    | { kind: "retry"; err: string };

  /**
   * The check itself, for a patch whose check this caller holds: the forge reads and, when its
   * `.ryph/` differs, the build. Writes nothing of its own; the caller resolves the claim.
   */
  const examine = async (patch: Patch): Promise<Examined> => {
    const [task, repo] = await Promise.all([
      store.getTask(patch.taskId),
      store.getConnectedRepo(patch.connectedRepoId),
    ]);
    // Who hears that nothing was built: a setup run always, since it idles on its inbox for the
    // answer; any other run only once its patch is known to have changed `.ryph/`, which is when
    // the skill tells its agent to wait. A patch that left `.ryph/` alone is no news to anyone.
    const setup = task?.purpose === ENVIRONMENT_SETUP;
    const skip = (note: string, branch: string | null = null, changed = false): Examined => ({
      kind: "skip",
      tell: setup || changed,
      branch,
      note,
    });
    if (task === null) return skip("its task no longer exists");
    if (repo === null || repo.archivedAt !== null) return skip("its repo is no longer connected");
    if (patch.state !== "submitted" || patch.forgeRef === null) {
      return skip(`it is no longer open at the forge (${patch.state})`);
    }
    // Where the submission left its commits, as it recorded it (core/patch_lifecycle.ts
    // `forgeBranchOf`) — never re-derived from the task, whose change request is landed once it
    // merges.
    const branch = patch.forgeBranch;
    if (branch === null) return skip("the branch it landed on could not be named");
    if (!setup) {
      // A one-shot run has usually ended by the time its patch reaches the forge, and then
      // nobody would hear the result. A setup task's build is queued even so: an ended run is
      // not told, but the task page lists the build (http/user/tasks.ts), and a person reads it.
      const run = await store.getRun(patch.runId);
      if (run === null || isTerminal(run)) {
        return skip("its run had ended, so nobody would hear a build's result", branch);
      }
    }

    const subject = task.workspaceId !== null
      ? await service.loadSubject("workspace", task.workspaceId)
      : await service.loadSubject("repo", repo.id);
    if (subject === null) return skip("its repo or workspace no longer resolves", branch);
    const member = subject.members.find((m) => m.repo.id === repo.id);
    if (member === undefined) return skip("its repo is not a member of the workspace", branch);

    // Two reads for every submitted patch, and for most of them that is all: the head's
    // `.ryph/` tree and the default branch's. The branch is read by name first — the path every
    // run's clone takes — and by commit only when the branch has already moved past the patch,
    // which then builds and supersedes nothing: the branch's newest patch answers for it.
    // The forge's tree id leaves out what no build reads, so a patch that changed only
    // checks.yml, services.yml or environment.md reads as unchanged here.
    const ref = forgeRepoRef(repo);
    /** Where the branch is now, when that is past the patch. */
    let tip: string | null = null;
    let head: { commit: string; tree: string | null; fullTree: string | null; dockerfile: boolean };
    let onDefault: { commit: string; tree: string | null; fullTree: string | null };
    try {
      [head, onDefault] = await Promise.all([
        forge.ryphTree(ref, repo.url, branch),
        forge.ryphTree(ref, repo.url, member.ref),
      ]);
      if (head.commit !== patch.headSha) {
        tip = head.commit;
        head = await forge.ryphTree(ref, repo.url, patch.headSha);
      }
    } catch (err) {
      return { kind: "retry", err: `the forge could not be read: ${errText(err)}` };
    }
    const localRef = normalizeBaseRef(branch).localBranch;
    // The branch's newest patch building nothing: what the branch was building is moot, and its
    // result would only arrive after this. Only the environment repo's branch is the subject's.
    const retire = async () => {
      if (tip !== null || subject.environmentRepo.repo.id !== repo.id) return;
      await service.supersedeBranch(
        subject,
        localRef,
        null,
        "the branch's newest patch builds nothing",
      );
    };
    if (machineTree(head.tree) === machineTree(onDefault.tree)) {
      await retire();
      return skip(
        head.fullTree === onDefault.fullTree
          ? `its .ryph/ is the same as ${member.ref}'s, so runs on it use the default branch's ` +
            "environment"
          : `its .ryph/ differs from ${member.ref}'s only in files no build uses (checks.yml, ` +
            "services.yml, environment.md); they are checked when a run starts",
        branch,
      );
    }
    // Different from the default branch's head is not yet changed: a branch cut before the
    // default branch moved its `.ryph/` differs without having touched it (core/ryph_baseline.ts).
    const baseline = await compareWithBaseline({
      forge,
      repo,
      ref: branch,
      head,
      defaultRef: member.ref,
      onDefault,
      onError: (err) =>
        diag.warn("environments.feedback_baseline_unread", {
          patchId: patch.id,
          err: errText(err),
        }),
    });
    if (!baseline.own) {
      await retire();
      return skip(
        `it did not change .ryph/ since it forked from ${member.ref} (${
          baseline.mergeBase?.mergeBase?.slice(0, 10) ?? "its merge base"
        }), so runs on it use the default branch's environment`,
        branch,
      );
    }
    // From here on the patch changed `.ryph/`, so its run is told whatever comes of it, unless
    // a newer patch of its own will be.
    if (tip !== null) {
      return skip(
        `the branch has moved past it, to ${tip.slice(0, 10)}; a newer push there is built if ` +
          "it changes .ryph/",
        branch,
        (await newerPatches(patch)).length === 0,
      );
    }
    if (machineTree(head.tree) === null) {
      await retire();
      return skip(
        "it leaves nothing in .ryph/ that a build uses, so runs on it use the default image",
        branch,
        true,
      );
    }
    if (subject.environmentRepo.repo.id !== repo.id) {
      // Every member's setup.yml runs in the workspace's image, but a build takes the other
      // members at the refs the task checked out: a member's own patch changes nothing a build
      // here would run, so it is not built, and the note says its setup.yml went unverified.
      return skip(
        `the workspace's machine is described by ${
          runFacingRepoName(subject.environmentRepo.repo)
        }'s ` +
          ".ryph/, and its builds take the other members at the refs this task checked out, " +
          `so ${
            runFacingRepoName(repo)
          }'s .ryph/setup.yml is not run by a build until it is merged`,
        branch,
        true,
      );
    }
    let kind;
    try {
      kind = await forge.branchKind(ref, repo.url, branch);
    } catch (err) {
      return { kind: "retry", err: `the forge could not be read: ${errText(err)}` };
    }
    if (kind !== "branch") {
      return skip(
        kind === "default"
          ? "it landed on the default branch, which builds on its own"
          : "its branch is not one of the repo's own, and only the repo's own branches build",
        branch,
        true,
      );
    }

    try {
      const refs = new Map(
        // A fork head never enters a build: that member is taken at its own ref instead.
        task.repos.flatMap((r) =>
          r.connectedRepoId === null || r.forkHead === true
            ? []
            : [[r.connectedRepoId, r.ref] as const]
        ),
      );
      const plan = await service.planFor(subject, branch, refs, patch.headSha);
      const harness = service.config.environments.harnessImage ?? "";
      const base = service.config.environments.baseImage ?? "";
      // The build that already answers for this patch: the newest cold patch build of this
      // branch from the same `.ryph/` and the same other members, whatever the environment
      // repo's commit, so a code-only follow-up push queues nothing. A failed build answers only
      // for the commit it was built at: a failure can be a flake, or a cause outside `.ryph/`
      // that setup.yml runs, so the next push builds again. So does a ready build whose own
      // setup broke (a step failed, setup.yml invalid) or left a tree dirty: the step may have
      // failed on a lockfile or a script the next push fixed, and a dirty tree may be fixed by a
      // `.gitignore` outside `.ryph/`; that push must hear what setup.yml does now. An
      // `unreadable` record (the platform's) or a `discarded` alone (riding beside another
      // member's failure, answered when that member's tree changes) is no reason to: the build
      // still answers for the patch.
      const answersOneCommit = (r: Environment) =>
        (r.setupWarnings ?? []).some((w) => setupBroke(w) || w.kind === "dirty");
      const builtAt = (r: Environment) =>
        r.plan.checkouts.find((c) => c.connectedRepoId === repo.id)?.commit;
      const others = (checkouts: Environment["plan"]["checkouts"]) =>
        checkouts.filter((c) => c.connectedRepoId !== repo.id)
          .map((c) => `${c.path}\u0000${c.connectedRepoId}\u0000${c.commit}`).join("\u0001");
      const answering = (await service.store.listEnvironmentsForSubject(
        subject.kind,
        subject.id,
        { ref: localRef },
      ))
        .filter((r) =>
          r.trigger === "patch" && !r.defaultBranch &&
          r.plan.warmFrom === null && r.definition === plan.definition &&
          others(r.plan.checkouts) === others(plan.checkouts) &&
          sameImage(r.harnessDigest, harness) && sameImage(r.baseDigest, base) &&
          (r.status === "queued" || r.status === "building" ||
            (r.status === "ready" && r.imagesRemovedAt === null &&
              (!answersOneCommit(r) || builtAt(r) === patch.headSha)) ||
            // A failed build's verdict stands once retention has swept what it pushed.
            (r.status === "failed" && builtAt(r) === patch.headSha))
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
      if (answering !== undefined) {
        const last = await lastBuildOf(patch);
        // The branch is back on this definition: a build of another one still under way is
        // what it moved past, as when a build is queued.
        await service.supersedeBranch(
          subject,
          localRef,
          answering,
          "a newer patch of this branch takes an earlier build",
        );
        // A run that last heard of this very build hears nothing new. A setup run that
        // resubmitted is told its answer again.
        if (!setup && last === answering.id) {
          return skip(
            `its .ryph/ is the same as that of ${answering.id}, the last build of ${branch}, ` +
              "whose result this run already has",
            branch,
          );
        }
        return { kind: "build", task, branch, environment: answering };
      }
      const environment = await service.enqueue({
        subject,
        ref: localRef,
        defaultBranch: false,
        checkouts: plan.checkouts,
        definition: plan.definition,
        dockerfile: plan.dockerfile,
        machine: plan.machine,
        trigger: "patch",
        reason: `task ${task.id}'s patch ${patch.id}: ${baseline.reason}`,
      });
      return { kind: "build", task, branch, environment };
    } catch (err) {
      return { kind: "retry", err: `the build could not be queued: ${errText(err)}` };
    }
  };

  /**
   * Checks one submitted patch, once. The check is CLAIMED first — a row with neither build nor
   * note, leased to this caller — so two callers never both read the forge and queue a build;
   * the loser answers the row as it stands. A check that failed keeps its row, released for a
   * retry by the tick's backstop or the run's status read, until one resolves it (or it has
   * failed for GIVE_UP_MS). Null only when environments are not built here, or for a patch
   * that is not at the forge and was never claimed.
   */
  const check = async (patch: Patch): Promise<PatchBuild | null> => {
    if (!service.enabled || service.refusedReason !== null) return null;
    const now = deps.now();
    const at = now.toISOString();
    const lease = new Date(now.getTime() + CLAIM_MS).toISOString();
    let row = await service.store.getPatchBuild(patch.id);
    if (row === null) {
      if (patch.state !== "submitted" || patch.forgeRef === null) return null;
      const claim: PatchBuild = {
        patchId: patch.id,
        runId: patch.runId,
        environmentId: null,
        branch: null,
        note: null,
        checkedAt: at,
        claimedUntil: lease,
        reportedAt: null,
      };
      if (!await service.store.createPatchBuild(claim)) {
        return await service.store.getPatchBuild(patch.id);
      }
      row = claim;
    } else {
      if (!unresolved(row) || row.claimedUntil! > at) return row;
      const retaken = { ...row, claimedUntil: lease };
      if (!await service.store.updatePatchBuildIfClaimed(retaken, row.claimedUntil!)) {
        return await service.store.getPatchBuild(patch.id);
      }
      row = retaken;
    }

    const held = row;
    /** The lease holder's write; answers the row as it now stands, and whether it was this. */
    const resolve = async (next: PatchBuild) =>
      await service.store.updatePatchBuildIfClaimed(next, lease)
        ? { row: next, landed: true }
        : { row: await service.store.getPatchBuild(patch.id), landed: false };
    const examined = await examine(patch).catch((err): Examined => ({
      kind: "retry",
      err: errText(err),
    }));

    if (examined.kind === "retry") {
      diag.warn("environments.feedback_unchecked", { patchId: patch.id, err: examined.err });
      if (now.getTime() - Date.parse(held.checkedAt) >= GIVE_UP_MS) {
        return await resolveSkip(resolve, held, false, null, "it could not be checked for a day");
      }
      // Released for the next ask: the tick's backstop, or the run's status read.
      return (await resolve({
        ...held,
        claimedUntil: new Date(now.getTime() + RETRY_MS).toISOString(),
      })).row;
    }
    if (examined.kind === "skip") {
      return await resolveSkip(resolve, held, examined.tell, examined.branch, examined.note);
    }
    const { branch, environment } = examined;
    const built = await resolve({
      ...held,
      environmentId: environment.id,
      branch,
      claimedUntil: null,
    });
    if (!built.landed) return built.row;
    diag.debug("environments.feedback_building", {
      patchId: patch.id,
      environmentId: environment.id,
      status: environment.status,
    });
    // Built before: the same inputs already have an image, so the answer is now.
    await deliver(built.row!, environment);
    return built.row;
  };

  /** Why no build: recorded, and told to the run when `tell` says it would otherwise wait. */
  const resolveSkip = async (
    resolve: (next: PatchBuild) => Promise<{ row: PatchBuild | null; landed: boolean }>,
    held: PatchBuild,
    tell: boolean,
    branch: string | null,
    note: string,
  ): Promise<PatchBuild | null> => {
    const skipped = await resolve({
      ...held,
      branch,
      note,
      claimedUntil: null,
      // A run nobody tells has the row as its whole record.
      reportedAt: tell ? null : nowIso(),
    });
    if (skipped.landed && tell) await deliver(skipped.row!, null);
    return skipped.row;
  };

  const statusText = (builds: RunBuildStatus[]): string => {
    if (builds.length === 0) {
      return "This run has submitted no patches yet. Once a patch that changes .ryph/ reaches " +
        "the forge, the platform builds its agent environment and tells you the result here " +
        "and in a message. A change to only checks.yml, services.yml or environment.md is not " +
        "built.";
    }
    const lines = ["Environment builds for this run's patches, oldest first:", ""];
    const newestSettled = [...builds].reverse().find((b) => settledStatus(b.environment));
    const asPatch = (b: RunBuildStatus) => ({ id: b.patchId, path: b.path, headSha: b.headSha });
    for (const b of builds) {
      const label = patchLabel(asPatch(b), b.branch);
      if (b.environment === null) {
        lines.push(
          b.note !== null
            ? `- ${label}: no build — ${b.note}.`
            : b.patchState === "submitted"
            ? `- ${label}: not checked yet — the platform is reading it from the forge, or ` +
              "could not and retries on its own; the result comes as a message either way."
            : `- ${label}: ${b.patchState} — it is built once it reaches the forge as a branch.`,
        );
      } else if (b !== newestSettled) {
        const env = b.environment;
        lines.push(
          `- ${label}: environment ${env.id} is ${env.status}${
            env.status === "building" && env.startedAt !== null
              ? ` (for ${formatDuration(deps.now().getTime() - Date.parse(env.startedAt))} so far)`
              : ""
          }.`,
        );
      }
    }
    if (newestSettled !== undefined) {
      lines.push(
        "",
        "The newest settled build:",
        "",
        composeBuildResult({
          patch: asPatch(newestSettled),
          branch: newestSettled.branch,
          environment: newestSettled.environment!,
          nonce: nonce(),
        }),
      );
    }
    const text = lines.join("\n");
    return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text;
  };

  return {
    async patchSubmitted(patch) {
      await check(patch).catch((err) =>
        diag.warn("environments.feedback_failed", { patchId: patch.id, err: errText(err) })
      );
    },
    async settled(environment) {
      if (!settledStatus(environment)) return;
      for (const row of await service.store.listPatchBuildsForEnvironment(environment.id)) {
        if (row.reportedAt !== null) continue;
        await deliver(row, environment).catch((err) =>
          diag.warn("environments.feedback_failed", { patchId: row.patchId, err: errText(err) })
        );
      }
    },
    async sweep() {
      if (!service.enabled || service.refusedReason !== null) return;
      const now = deps.now();
      const at = now.toISOString();
      for (const row of await service.store.listUnreportedPatchBuilds()) {
        try {
          if (unresolved(row)) {
            // A check nobody holds any more: its checker died, or its forge read failed.
            if (row.claimedUntil! > at) continue;
            const patch = await store.getPatch(row.patchId);
            if (patch !== null) await check(patch);
          } else {
            // A result, or a note for a waiting run, that was never told.
            const env = row.environmentId === null
              ? null
              : await service.store.getEnvironment(row.environmentId);
            await deliver(row, env);
          }
        } catch (err) {
          diag.warn("environments.feedback_failed", { patchId: row.patchId, err: errText(err) });
        }
      }
      // A patch whose check was never even claimed: the replica submitting it died first.
      const since = new Date(now.getTime() - UNCHECKED_WINDOW_MS).toISOString();
      for (const patch of await service.store.listUncheckedPatches(since, UNCHECKED_BATCH)) {
        await check(patch).catch((err) =>
          diag.warn("environments.feedback_failed", { patchId: patch.id, err: errText(err) })
        );
      }
    },
    async statusForRun(run) {
      if (!service.enabled || service.refusedReason !== null) {
        return {
          builds: [],
          text: "The platform is not building environments on this deployment " +
            `(${service.refusedReason ?? "environments are off"}), so no patch of this run is ` +
            "built: runs start on the default image. Asking again will not change that.",
        };
      }
      const patches = (await store.patchesForTask(run.taskId))
        .filter((p) => p.runId === run.id && p.state !== "superseded" && p.state !== "rejected");
      const builds: RunBuildStatus[] = [];
      for (const patch of patches) {
        const row = patch.state === "submitted"
          ? await check(patch).catch(() => null)
          : await service.store.getPatchBuild(patch.id);
        const environment = row?.environmentId
          ? await service.store.getEnvironment(row.environmentId)
          : null;
        builds.push({
          patchId: patch.id,
          path: patch.path,
          headSha: patch.headSha,
          patchState: patch.state,
          branch: row?.branch ?? null,
          note: row?.note ?? null,
          environment,
        });
      }
      return { builds, text: statusText(builds) };
    },
  };
}
