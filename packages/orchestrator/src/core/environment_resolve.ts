// Which environment a run gets — `resolveEnvironment`, called by startTask beside the services
// resolution and frozen onto the run as a DIGEST, never a tag. Every row of this table is an arm here:
//
// | The run's checkout                                                   | Uses                                 |
// | -------------------------------------------------------------------- | ------------------------------------ |
// | default branch, or a ref outside the repo (a fork's head)            | newest ready default-branch image    |
// | a branch of the repo whose MACHINE is the default branch's           | the same                             |
// | a branch whose `.ryph/Dockerfile` differs                            | its own image; WAIT while one builds |
// | a branch that dropped the Dockerfile the default branch has          | the default image, no wait           |
// | nothing ready, no `.ryph/Dockerfile`                                 | the default image, no wait           |
// | nothing ready, a `.ryph/Dockerfile`                                  | WAIT for the first build             |
//
// Plus the two things the table assumes. An image on a stale harness layer waits for its
// re-layer (the runner and the control plane are released together and must agree); when that
// re-layer already failed on this harness, the image counts as none, so its arm builds where the
// branch stands now. And when the forge, the builder or the registry cannot be asked, the run
// falls back to the newest ready image and then to the default one, saying so — it refuses only
// where it would otherwise have waited for a build that FAILED, because running an agent on the
// wrong machine only moves the failure somewhere harder to read.
//
// Invariants:
// - wait when the environment would otherwise be WRONG, never when it is merely OLD: a
//   default-branch image a commit behind is as good as a fresh one, the run fetches its own
//   commit either way
// - environments off, or a subject nothing can be built for (manual), is the default
//   image with no event: that is the deployment's configuration, not a fault
// - the answer names an image a run may freeze: an environment's digest, or RYPH_AGENT_IMAGE

import type { ConnectedRepo, Environment, RunEnvironment, RunEvent, Workspace } from "./types.ts";
import {
  byNewestBuilt,
  type EnvironmentService,
  type EnvironmentSubject,
  sameImage,
  type SubjectPlan,
  warningRebuildDue,
} from "./environments.ts";
import { forgeRepoRef } from "./forge_repo.ts";
import { compareWithBaseline, type RyphBaseline } from "./ryph_baseline.ts";
import { normalizeBaseRef } from "@ryph/shared/refs";
import type { Forge } from "../ports/forge.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";

/** An event the run records once it exists. */
export type ResolutionEvent = Pick<RunEvent, "kind" | "detail">;

export type EnvironmentResolution =
  | {
    kind: "launch";
    /** What the run freezes and launches on; null only where no default image is configured
     * (the manual provisioner). */
    image: string | null;
    environment: RunEnvironment | null;
    environmentId: string | null;
    events: ResolutionEvent[];
  }
  | { kind: "wait"; environment: Environment; events: ResolutionEvent[] }
  | {
    kind: "refused";
    status: number;
    error: string;
    about?: { connectedRepoId: string; summary: string };
  };

export interface ResolveEnvironmentDeps {
  environments: EnvironmentService | null;
  forge: Forge | null;
  diag: Diagnostics;
}

export interface ResolveEnvironmentInput {
  /** RYPH_AGENT_IMAGE. */
  agentImage: string | null;
  workspace?: Pick<Workspace, "id">;
  /** The run's checkout, as the door resolved it: the connected repo, the ref, and whether it is
   * a fork's head (`RepoEntry.forkHead`). */
  repos: ReadonlyArray<{ connectedRepo: ConnectedRepo; ref: string; forkHead?: boolean }>;
}

/** The default image as the spec serves it — never baked. */
export function defaultRunEnvironment(agentImage: string): RunEnvironment {
  return {
    id: "default",
    image: agentImage,
    baked: false,
    commits: {},
    builtAt: null,
    toolchains: {},
    ref: null,
  };
}

/** A ready environment as the run freezes it. */
export function runEnvironmentOf(environment: Environment): RunEnvironment {
  return {
    id: environment.id,
    image: environment.image!,
    baked: true,
    commits: { ...environment.commits },
    builtAt: environment.finishedAt,
    toolchains: { ...environment.toolchains },
    ref: environment.ref,
  };
}

const newest = (rows: Environment[]) =>
  rows.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

export async function resolveEnvironment(
  deps: ResolveEnvironmentDeps,
  input: ResolveEnvironmentInput,
): Promise<EnvironmentResolution> {
  const service = deps.environments ?? null;
  const onDefault = (events: ResolutionEvent[] = []): EnvironmentResolution => ({
    kind: "launch",
    image: input.agentImage,
    // Off, the spec says nothing about an environment at all — phase-1 behaviour exactly.
    environment: service === null || !service.enabled || input.agentImage === null
      ? null
      : defaultRunEnvironment(input.agentImage),
    environmentId: null,
    events,
  });
  if (service === null || !service.enabled) return onDefault();
  if (service.refusedReason !== null || !deps.forge) return onDefault();

  // The subject: the workspace, or the one connected repo a single-repo run checks out.
  let subject: EnvironmentSubject | null = null;
  if (input.workspace !== undefined) {
    subject = await service.loadSubject("workspace", input.workspace.id);
  } else if (input.repos.length === 1) {
    subject = await service.loadSubject("repo", input.repos[0].connectedRepo.id);
  }
  if (subject === null) return onDefault();
  return await resolveForSubject(service, deps.forge, deps.diag, input, subject, onDefault);
}

async function resolveForSubject(
  service: EnvironmentService,
  forge: Forge,
  diag: Diagnostics,
  input: ResolveEnvironmentInput,
  subject: EnvironmentSubject,
  onDefault: (events?: ResolutionEvent[]) => EnvironmentResolution,
): Promise<EnvironmentResolution> {
  const harness = service.config.environments.harnessImage ?? "";
  const envRepo = subject.environmentRepo.repo;
  const entry = input.repos.find((r) => r.connectedRepo.id === envRepo.id);
  const runRef = entry?.ref ?? subject.environmentRepo.ref;
  // The subject's "default branch": the environment repo's ref in it. For a repo that is its
  // default branch; a workspace may pin the repo at another, which is then what its ordinary
  // runs check out and what its shared image is built from.
  const defaultRef = subject.environmentRepo.ref;
  const history = await service.store.listEnvironmentsForSubject(subject.kind, subject.id);
  const readyDefaults = history.filter((r) => r.defaultBranch && r.status === "ready")
    .sort(byNewestBuilt);
  const launchOn = (row: Environment, events: ResolutionEvent[] = []): EnvironmentResolution => ({
    kind: "launch",
    image: row.image,
    environment: runEnvironmentOf(row),
    environmentId: row.id,
    events,
  });

  /**
   * The fallback when something could not be asked: the newest ready default-branch image on
   * the current harness, else the default image — with an event naming why, because a run on an
   * older machine than it should have is exactly what someone reading it later has to know.
   */
  const fallback = (why: string): EnvironmentResolution => {
    diag.warn("environments.fallback", { subject: `${subject.kind}-${subject.id}`, why });
    const usable = readyDefaults.find((r) => sameImage(r.harnessDigest, harness));
    if (usable !== undefined) {
      return launchOn(usable, [{
        kind: "environment.fallback",
        detail: `${why} — this run uses the newest ready environment (${usable.id}, built ` +
          `from ${usable.ref} at ${usable.finishedAt ?? "an unknown time"})`,
      }]);
    }
    return onDefault([{
      kind: "environment.fallback",
      detail: `${why} — this run uses the default image`,
    }]);
  };

  /** A build is due and the run must wait for it — unless the builder is down. */
  const waitFor = async (
    ask: () => Promise<Environment>,
    faultWhy: string,
  ): Promise<EnvironmentResolution> => {
    const fault = service.builderFault();
    if (fault !== null) return fallback(`${faultWhy}, but the builder is not answering (${fault})`);
    let row: Environment;
    try {
      row = await ask();
    } catch (err) {
      return fallback(`${faultWhy}, but it could not be queued (${errText(err)})`);
    }
    if (row.status === "ready") return launchOn(row);
    return {
      kind: "wait",
      environment: row,
      events: [{
        kind: "environment.building",
        detail: `waiting for environment ${row.id} (${row.status}): ${faultWhy}`,
      }],
    };
  };

  /** A build at exactly these inputs already FAILED: refuse, with its log. */
  const refuseFailed = (row: Environment, what: string): EnvironmentResolution => ({
    kind: "refused",
    status: 409,
    error: `${what} failed to build (${row.failure ?? "no reason recorded"}) — the run is not ` +
      `started, because an agent on the wrong machine only fails somewhere harder to read. ` +
      `The build's log ends:\n${row.logTail ?? "(no log)"}`,
    about: {
      connectedRepoId: envRepo.id,
      summary: "has an environment that failed to build, so the run was not started",
    },
  });

  /**
   * An image this run can use, but on an old harness layer: the run waits for its re-layer
   * (stage 4 only, seconds), because the runner inside must speak this control plane's protocol.
   * Null when there is no re-layer to wait for — one already failed on this harness, or the row
   * kept no baked image — so the caller goes on as if nothing were ready.
   */
  const onReady = (
    row: Environment,
  ): Promise<EnvironmentResolution> | EnvironmentResolution | null => {
    if (sameImage(row.harnessDigest, harness)) return launchOn(row);
    const relayer = history.find((r) =>
      (r.status === "queued" || r.status === "building") && sameImage(r.harnessDigest, harness) &&
      r.ref === row.ref && r.defaultBranch === row.defaultBranch && r.definition === row.definition
    );
    if (relayer !== undefined) {
      return {
        kind: "wait",
        environment: relayer,
        events: [{
          kind: "environment.building",
          detail: `waiting for environment ${relayer.id} (${relayer.status}): the harness ` +
            `layer changed, and ${row.id} is being re-layered onto it`,
        }],
      };
    }
    const relayerFailed = history.some((r) =>
      r.status === "failed" && sameImage(r.harnessDigest, harness) &&
      r.plan.relayerOf?.environmentId === row.id
    );
    if (row.bakedImage === null || relayerFailed) return null;
    return waitFor(
      () =>
        service.enqueue({
          subject,
          ref: row.ref,
          defaultBranch: row.defaultBranch,
          checkouts: row.plan.checkouts,
          definition: row.definition,
          dockerfile: row.plan.dockerfileFrom !== null,
          machine: row.plan.machine ?? null,
          trigger: "harness",
          relayerOf: row,
        }),
      `the harness layer changed, and ${row.id} is being re-layered onto it`,
    );
  };

  // Whose branch is the run on? A fork's head — or another peer's patch — is "foreign" and
  // never builds: it gets the default branch's machine, like the default branch itself.
  // A head the door already knows is a fork's is foreign without asking.
  let kind: "default" | "branch" | "foreign";
  try {
    kind = entry?.forkHead === true
      ? "foreign"
      : runRef === defaultRef || normalizeBaseRef(runRef).localBranch === defaultRef
      ? "default"
      : await forge.branchKind(forgeRepoRef(envRepo), envRepo.url, runRef);
  } catch (err) {
    return fallback(`the forge could not say whose branch ${runRef} is (${errText(err)})`);
  }

  if (kind === "branch") {
    let branch: { commit: string; tree: string | null; dockerfile: boolean };
    let onDefaultBranch: { commit: string; tree: string | null; dockerfile: boolean };
    try {
      [branch, onDefaultBranch] = await Promise.all([
        forge.ryphTree(forgeRepoRef(envRepo), envRepo.url, runRef),
        forge.ryphTree(forgeRepoRef(envRepo), envRepo.url, defaultRef),
      ]);
    } catch (err) {
      return fallback(`the forge could not read ${runRef}'s .ryph directory (${errText(err)})`);
    }
    // A DIFFERENT `.ryph/` is not yet a different machine. Only a Dockerfile — on either side —
    // can make the default branch's image the wrong one to run on. A branch that edits
    // `setup.yml` or `environment.md` alone moves nothing a build bakes that the run does not
    // redo: `setup.yml` runs again at run time from the branch's own checkout, and
    // `environment.md` is read from it. So it takes the default branch's machine, like any
    // branch, rather than waiting for a build of its own — the wait rule is "wrong, never merely
    // old", and this is not even old.
    // Nor is a different tree one the branch CHANGED: a branch cut before the default branch
    // moved its `.ryph/` differs without touching it, and merges into the default branch's
    // machine — so that is the one it runs on (core/ryph_baseline.ts).
    let baseline: RyphBaseline | null = null;
    if (
      branch.tree !== onDefaultBranch.tree && (branch.dockerfile || onDefaultBranch.dockerfile)
    ) {
      baseline = await compareWithBaseline({
        forge,
        repo: envRepo,
        ref: runRef,
        head: branch,
        defaultRef,
        onDefault: onDefaultBranch,
        onError: (err) =>
          diag.warn("environments.baseline_unread", { ref: runRef, err: errText(err) }),
      });
    }
    if (baseline !== null && baseline.own) {
      // A branch that describes a machine of its own runs on it — built for it, waited for.
      if (branch.tree === null || !branch.dockerfile) {
        // It describes none, while the default branch does: the universal image is its machine,
        // and the default branch's image is something else.
        return onDefault();
      }
      const ref = normalizeBaseRef(runRef).localBranch;
      // A fork head is left out, so that member is built at its own ref (planFor): its
      // `.ryph/setup.yml` would otherwise run in the builder as a contributor wrote it.
      const refs = new Map(
        input.repos.filter((r) => r.forkHead !== true).map((r) => [r.connectedRepo.id, r.ref]),
      );
      // The branch's whole definition, every member at the run's refs: a branch build is keyed
      // like any other, so its rows are found by what they were built from.
      let plan: SubjectPlan;
      try {
        plan = await service.planFor(subject, runRef, refs);
      } catch (err) {
        const why = `the forge could not read ${runRef}'s .ryph directories (${errText(err)})`;
        // One member the forge cannot read (a slow Radicle seed, say) must not put the run on
        // the universal image while the branch has a machine of its own: its newest ready image,
        // whatever definition it was built from, is nearer than any fallback.
        const known = history.filter((r) =>
          r.ref === ref && !r.defaultBranch && r.status === "ready"
        )
          .sort(byNewestBuilt)[0];
        const onKnown = known === undefined ? null : await onReady(known);
        if (onKnown === null || onKnown.kind === "refused") return fallback(why);
        diag.warn("environments.fallback", { subject: `${subject.kind}-${subject.id}`, why });
        return {
          ...onKnown,
          events: [
            {
              kind: "environment.fallback",
              detail: `${why} — this run uses ${ref}'s newest ready environment (${known!.id}, ` +
                `built at ${known!.finishedAt ?? "an unknown time"})`,
            },
            ...onKnown.events,
          ],
        };
      }
      const own = history.filter((r) =>
        r.ref === ref && !r.defaultBranch && r.definition === plan.definition
      );
      const ready = own.filter((r) => r.status === "ready").sort(byNewestBuilt)[0];
      const live = newest(
        own.filter((r) =>
          (r.status === "queued" || r.status === "building") && sameImage(r.harnessDigest, harness)
        ),
      )[0];
      // A ready image whose setup.yml did not finish still serves this run, which reruns
      // setup.yml and warns again — but it answers only for the commit it was built at: a newer
      // one may be the fix (a lockfile, a script outside `.ryph/`), so it is built behind the
      // run, which does not wait for it. Once per episode (`warningRebuildDue`), as on the
      // default branch: a step that fails at every build must not have every run at a new commit
      // queue another. After that, the branch is built again when its `.ryph/` changes. As there,
      // the decision is the newest build of the definition's, whatever its status: an early
      // build that failed ends the episode too, where only ready images would let every run at a
      // new commit queue another doomed one. Any build still going holds it off, on any harness.
      const latestOwn = newest(own.filter((r) =>
        r.status !== "superseded" && r.plan.relayerOf === null
      ))[0];
      if (
        ready !== undefined && latestOwn?.status === "ready" && warningRebuildDue(ready, own) &&
        !own.some((r) => r.status === "queued" || r.status === "building") &&
        !plan.checkouts.every((c) =>
          ready.plan.checkouts.some((r) => r.path === c.path && r.commit === c.commit)
        ) &&
        service.builderFault() === null
      ) {
        service.enqueue({
          subject,
          ref,
          defaultBranch: false,
          checkouts: plan.checkouts,
          definition: plan.definition,
          dockerfile: plan.dockerfile,
          machine: plan.machine,
          trigger: "run",
          reason: `a run on ${ref} found ${ready.id}'s setup.yml unfinished at an older commit`,
        }).catch((err) => diag.warn("environments.background_build_failed", { err: errText(err) }));
      }
      const onIt = ready === undefined ? null : onReady(ready);
      if (onIt !== null) return onIt;
      if (live !== undefined) {
        return {
          kind: "wait",
          environment: live,
          events: [{
            kind: "environment.building",
            detail: `waiting for environment ${live.id} (${live.status}): ${ref} changed .ryph/`,
          }],
        };
      }
      // A failed RE-LAYER says nothing about this commit's build, which is what comes next.
      const failed = newest(own.filter((r) =>
        r.status === "failed" && r.plan.relayerOf === null
      ))[0];
      if (failed !== undefined && failed.plan.checkouts.some((c) => c.commit === branch.commit)) {
        return refuseFailed(failed, `${ref}'s environment`);
      }
      return waitFor(async () => {
        return await service.enqueue({
          subject,
          ref,
          defaultBranch: false,
          checkouts: plan.checkouts,
          definition: plan.definition,
          dockerfile: plan.dockerfile,
          machine: plan.machine,
          trigger: "run",
          reason: `a run on ${ref} needed it: ${baseline.reason}`,
        });
      }, `${ref} changed .ryph/, so it gets an environment of its own`);
    }
    // The same `.ryph/` as the default branch, or only an older copy of it: the same machine.
  }

  // The default branch's machine: the newest ready one, however old.
  const ready = readyDefaults[0];
  const onIt = ready === undefined ? null : onReady(ready);
  if (onIt !== null) return onIt;

  // Nothing ready. A subject with no Dockerfile runs on the universal image while its first build
  // (if any member has a `.ryph/` at all) happens behind it; one with a Dockerfile would be on
  // the wrong machine, so it waits.
  const live = newest(
    history.filter((r) =>
      r.defaultBranch && (r.status === "queued" || r.status === "building") &&
      sameImage(r.harnessDigest, harness)
    ),
  )[0];
  let head: SubjectPlan;
  try {
    head = await service.planFor(subject, defaultRef);
  } catch (err) {
    const why = `the forge could not read ${defaultRef}'s .ryph directories (${errText(err)})`;
    // One member the forge cannot read (a slow Radicle seed, say) must not take a run off a
    // build already under way: the environment repo alone says whether it has a machine to wait
    // for. Only queueing a new build needs every member.
    let dockerfile = false;
    try {
      dockerfile = (await forge.ryphTree(forgeRepoRef(envRepo), envRepo.url, defaultRef))
        .dockerfile;
    } catch {
      // Not even the environment repo: nothing to wait on is known.
    }
    if (dockerfile && live !== undefined) {
      diag.warn("environments.plan_unreadable", { subject: `${subject.kind}-${subject.id}`, why });
      return {
        kind: "wait",
        environment: live,
        events: [{
          kind: "environment.building",
          detail: `waiting for environment ${live.id} (${live.status}): the repo's first build`,
        }],
      };
    }
    return fallback(why);
  }
  const headCommit = head.checkouts.find((c) => c.connectedRepoId === envRepo.id)?.commit;
  if (!head.dockerfile) {
    if (head.definition !== null && live === undefined && service.builderFault() === null) {
      // Warm it for the next run; this one does not wait.
      service.refreshSubject(subject, "run").catch((err) =>
        diag.warn("environments.background_build_failed", { err: errText(err) })
      );
    }
    return onDefault();
  }
  if (live !== undefined) {
    return {
      kind: "wait",
      environment: live,
      events: [{
        kind: "environment.building",
        detail: `waiting for environment ${live.id} (${live.status}): the repo's first build`,
      }],
    };
  }
  const failed = newest(
    history.filter((r) => r.defaultBranch && r.status === "failed" && r.plan.relayerOf === null),
  )[0];
  if (
    failed !== undefined && failed.definition === head.definition &&
    failed.plan.checkouts.some((c) => c.commit === headCommit)
  ) {
    return refuseFailed(failed, `${envRepo.repoRef}'s environment`);
  }
  return waitFor(async () => {
    return await service.enqueue({
      subject,
      ref: defaultRef,
      defaultBranch: true,
      checkouts: head.checkouts,
      definition: head.definition,
      dockerfile: head.dockerfile,
      machine: head.machine,
      trigger: "run",
    });
  }, `${envRepo.repoRef} has a .ryph/Dockerfile and no environment built yet`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
