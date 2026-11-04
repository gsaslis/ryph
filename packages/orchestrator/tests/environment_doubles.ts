// Doubles for environments: an in-memory `EnvironmentStore` (the fast double beside
// memory_store.ts — anything asserting on SQL uses the drizzle store instead), a builder the
// test settles by hand, and a log store over a map.

import {
  BUILD_PRIORITY,
  type Environment,
  type Patch,
  type PatchBuild,
} from "../src/core/types.ts";
import { appendRefusal, type EgressRefusalOutcome } from "../src/core/egress.ts";
import { decodeListCursor, encodeListCursor } from "../src/ports/task_store.ts";
import type { BuildGitKey, EnvironmentStore } from "../src/ports/environment_store.ts";
import type {
  AdoptResult,
  AdoptSpec,
  BuildResult,
  BuildSpec,
  EnvironmentBuilder,
  PassSummary,
  RemoveImagesSpec,
} from "../src/ports/environment_builder.ts";
import type { BuildLogStore } from "../src/ports/build_log_store.ts";

/** `patches`: where the unchecked-patch backstop reads patches from (the task store's rows, in
 * the drizzle store the same database); absent, it finds none. */
/** As the drizzle store: a whole-row write never touches the refusals, which the narrow append
 * above owns. Without this the settle would drop every host refused while the build ran. */
function keepRefusals(stored: Environment | undefined, next: Environment): Environment {
  return {
    ...structuredClone(next),
    egressRefusals: stored?.egressRefusals ?? next.egressRefusals,
    imagesRemovedAt: stored?.imagesRemovedAt ?? next.imagesRemovedAt,
  };
}

export function memoryEnvironmentStore(opts: { patches?: () => Promise<Patch[]> } = {}):
  & EnvironmentStore
  & {
    rows: Map<string, Environment>;
    patchBuilds: Map<string, PatchBuild>;
  } {
  const rows = new Map<string, Environment>();
  const patchBuilds = new Map<string, PatchBuild>();
  const byChecked = (a: PatchBuild, b: PatchBuild) =>
    a.checkedAt.localeCompare(b.checkedAt) || a.patchId.localeCompare(b.patchId);
  const keys = new Map<string, BuildGitKey>();
  const newestFirst = (
    a: Pick<Environment, "createdAt" | "id">,
    b: Pick<Environment, "createdAt" | "id">,
  ) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  return {
    rows,
    patchBuilds,
    createEnvironment(environment) {
      rows.set(environment.id, structuredClone(environment));
      return Promise.resolve();
    },
    getEnvironment(id) {
      const row = rows.get(id);
      return Promise.resolve(row ? structuredClone(row) : null);
    },
    saveEnvironment(environment) {
      rows.set(environment.id, keepRefusals(rows.get(environment.id), environment));
      return Promise.resolve();
    },
    saveEnvironmentIfStatus(environment, expected) {
      const stored = rows.get(environment.id);
      if (!stored || !expected.includes(stored.status)) return Promise.resolve(false);
      rows.set(environment.id, keepRefusals(stored, environment));
      return Promise.resolve(true);
    },
    recordEnvironmentEgressRefusal(environmentId, refusal) {
      const stored = rows.get(environmentId);
      if (!stored) return Promise.resolve<EgressRefusalOutcome>("ended");
      if (stored.status !== "queued" && stored.status !== "building") {
        return Promise.resolve<EgressRefusalOutcome>("ended");
      }
      const next = appendRefusal(stored.egressRefusals, refusal);
      if (next === null) return Promise.resolve<EgressRefusalOutcome>("duplicate");
      rows.set(environmentId, { ...stored, egressRefusals: next });
      return Promise.resolve<EgressRefusalOutcome>("recorded");
    },
    listEnvironmentsForSubject(subjectKind, subjectId, opts = {}) {
      const found = [...rows.values()]
        .filter((r) =>
          r.subjectKind === subjectKind && r.subjectId === subjectId &&
          (opts.ref === undefined || r.ref === opts.ref)
        )
        .sort(newestFirst)
        .slice(0, opts.limit ?? 200);
      return Promise.resolve(structuredClone(found));
    },
    listEnvironments(query) {
      const after = decodeListCursor(query.cursor);
      const found = [...rows.values()]
        .filter((r) =>
          (query.statuses === undefined || query.statuses.includes(r.status)) &&
          (query.subject === undefined ||
            (r.subjectKind === query.subject.kind && r.subjectId === query.subject.id)) &&
          (query.subjectKinds === undefined || query.subjectKinds.includes(r.subjectKind)) &&
          (query.branchBuildsFor === undefined || r.defaultBranch ||
            (r.plan.checkouts.length > 0 &&
              r.plan.checkouts.every((c) => query.branchBuildsFor!.includes(c.connectedRepoId)))) &&
          (after === null || newestFirst(r, after) > 0)
        )
        .sort(newestFirst);
      const page = found.slice(0, query.limit);
      const last = page.at(-1);
      return Promise.resolve({
        environments: structuredClone(page),
        nextCursor: found.length > query.limit && last !== undefined
          ? encodeListCursor(last)
          : null,
      });
    },
    listEnvironmentsByStatus(statuses) {
      const found = [...rows.values()].filter((r) => statuses.includes(r.status))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return Promise.resolve(structuredClone(found));
    },
    listImagesToRemove(before, limit, after) {
      const found = [...rows.values()]
        .filter((r) =>
          (r.status === "superseded" || r.status === "failed") && !r.imagesRemovedAt &&
          r.updatedAt < before &&
          (after === undefined || r.updatedAt > after.updatedAt ||
            (r.updatedAt === after.updatedAt && r.id > after.id))
        )
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
      return Promise.resolve(structuredClone(found));
    },
    listEnvironmentsNamingDigests(digests) {
      const names = (ref: string | null) => digests.some((d) => ref?.endsWith(`@${d}`) ?? false);
      return Promise.resolve(structuredClone(
        [...rows.values()].filter((r) =>
          names(r.image) || names(r.bakedImage) || names(r.machineImage)
        ),
      ));
    },
    listEnvironmentsByBakedImage(image) {
      return Promise.resolve(
        structuredClone([...rows.values()].filter((r) => r.bakedImage === image)),
      );
    },
    markEnvironmentImagesRemoved(id, at) {
      const stored = rows.get(id);
      if (stored?.status === "superseded" || stored?.status === "failed") {
        rows.set(id, { ...stored, imagesRemovedAt: at });
      }
      return Promise.resolve();
    },
    claimNextBuild(at, maxInFlight) {
      const building = [...rows.values()].filter((r) => r.status === "building").length;
      if (building >= maxInFlight) return Promise.resolve(null);
      const next = [...rows.values()].filter((r) => r.status === "queued")
        .sort((a, b) =>
          BUILD_PRIORITY[a.trigger] - BUILD_PRIORITY[b.trigger] ||
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
        )[0];
      if (next === undefined) return Promise.resolve(null);
      const claimed: Environment = { ...next, status: "building", startedAt: at, updatedAt: at };
      rows.set(next.id, structuredClone(claimed));
      return Promise.resolve(structuredClone(claimed));
    },
    touchBuild(id, at) {
      const stored = rows.get(id);
      if (stored !== undefined && stored.status === "building") stored.updatedAt = at;
      return Promise.resolve();
    },
    claimStrandedBuild(id, untouchedSince, at) {
      const stored = rows.get(id);
      if (
        stored === undefined || stored.status !== "building" ||
        stored.updatedAt !== untouchedSince
      ) return Promise.resolve(null);
      stored.updatedAt = at;
      return Promise.resolve(structuredClone(stored));
    },
    createBuildGitKey(key) {
      keys.set(key.id, structuredClone(key));
      return Promise.resolve();
    },
    getBuildGitKeyByTokenHash(tokenHash) {
      const key = [...keys.values()].find((k) => k.tokenHash === tokenHash);
      return Promise.resolve(key ? structuredClone(key) : null);
    },
    revokeBuildGitKeys(environmentId, at) {
      for (const key of keys.values()) {
        if (key.environmentId === environmentId && key.revokedAt === null) key.revokedAt = at;
      }
      return Promise.resolve();
    },
    createPatchBuild(row) {
      if (patchBuilds.has(row.patchId)) return Promise.resolve(false);
      patchBuilds.set(row.patchId, structuredClone(row));
      return Promise.resolve(true);
    },
    updatePatchBuildIfClaimed(row, claimedUntil) {
      const stored = patchBuilds.get(row.patchId);
      if (
        !stored || stored.environmentId !== null || stored.note !== null ||
        stored.claimedUntil !== claimedUntil
      ) return Promise.resolve(false);
      patchBuilds.set(row.patchId, structuredClone(row));
      return Promise.resolve(true);
    },
    getPatchBuild(patchId) {
      const row = patchBuilds.get(patchId);
      return Promise.resolve(row ? structuredClone(row) : null);
    },
    listPatchBuildsForRun(runId) {
      return Promise.resolve(
        structuredClone([...patchBuilds.values()].filter((b) => b.runId === runId).sort(byChecked)),
      );
    },
    listPatchBuildsForEnvironment(environmentId) {
      return Promise.resolve(structuredClone(
        [...patchBuilds.values()].filter((b) => b.environmentId === environmentId).sort(byChecked),
      ));
    },
    listUnreportedPatchBuilds() {
      return Promise.resolve(structuredClone(
        [...patchBuilds.values()].filter((b) => b.reportedAt === null).sort(byChecked),
      ));
    },
    async listUncheckedPatches(since, limit) {
      const all = opts.patches ? await opts.patches() : [];
      return structuredClone(
        all.filter((p) => p.state === "submitted" && p.updatedAt >= since && !patchBuilds.has(p.id))
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
          .slice(0, limit),
      );
    },
    markPatchBuildReported(patchId, at) {
      const row = patchBuilds.get(patchId);
      if (!row || row.reportedAt !== null) return Promise.resolve(false);
      row.reportedAt = at;
      return Promise.resolve(true);
    },
  };
}

/** One build the fake builder was handed, still waiting for the test to settle it. */
export interface PendingBuild {
  spec: BuildSpec;
  signal: AbortSignal;
  settle(result: BuildResult): void;
  succeed(image?: string, extra?: Partial<Extract<BuildResult, { ok: true }>>): void;
  fail(message?: string, kind?: "failed" | "timeout" | "refused"): void;
}

/**
 * A builder the test drives: every `build` parks until the test settles it (or its signal
 * aborts it, which settles it as a failure — what a real adapter must do). `auto` settles every
 * build at once with its answer instead.
 */
const NOTHING_DONE: PassSummary = { candidates: 0, deleteRequested: 0, failures: 0 };

export function fakeBuilder(
  opts: {
    kind?: EnvironmentBuilder["kind"];
    auto?: (spec: BuildSpec) => BuildResult;
    /** What the backend says about a build this process did not start. The default is the answer
     * a backend with no durable record gives, and the one the docker adapter always gives. */
    adopt?: (spec: AdoptSpec) => AdoptResult | Promise<AdoptResult>;
    /** Called as the record is dropped, for a test that cares WHEN that happens. */
    discard?: (environmentId: string) => void | Promise<void>;
    /** What a running build has logged so far, per environment id. */
    liveLogs?: Map<string, string>;
    /** Whether removing a build's images worked; true by default. */
    removeImages?: (spec: RemoveImagesSpec) => boolean | Promise<boolean>;
    /** Called for every layer-cache prune the core asks for. */
    pruneCache?: (opts: { retiredForMs: number }) => void;
    /** What a prune and a reconcile answer, and how many deletions each removal asks for. */
    summaries?: { prune?: PassSummary; reconcile?: PassSummary; deletesPerRemoval?: number };
  } = {},
) {
  const pending: PendingBuild[] = [];
  const specs: BuildSpec[] = [];
  const adopted: AdoptSpec[] = [];
  const aborted: string[] = [];
  const discarded: string[] = [];
  const removed: RemoveImagesSpec[] = [];
  const pruned: number[] = [];
  const reconciled: Array<Parameters<NonNullable<EnvironmentBuilder["reconcileImages"]>>[0]> = [];
  const builder: EnvironmentBuilder = {
    kind: opts.kind ?? "docker",
    async removeImages(spec) {
      removed.push(spec);
      return await opts.removeImages?.(spec) ?? true;
    },
    pruneCache(prune) {
      pruned.push(prune.retiredForMs);
      opts.pruneCache?.(prune);
      return Promise.resolve(opts.summaries?.prune ?? NOTHING_DONE);
    },
    reconcileImages(reconcile) {
      reconciled.push(reconcile);
      return Promise.resolve(opts.summaries?.reconcile ?? NOTHING_DONE);
    },
    removalStats() {
      return { versionsDeleteRequested: removed.length * (opts.summaries?.deletesPerRemoval ?? 0) };
    },
    async discard(environmentId) {
      discarded.push(environmentId);
      await opts.discard?.(environmentId);
    },
    liveLog(spec) {
      return Promise.resolve(opts.liveLogs?.get(spec.environmentId) ?? null);
    },
    async adopt(spec, { signal }) {
      adopted.push(spec);
      if (opts.adopt === undefined) return { kind: "gone" };
      const answer = await opts.adopt(spec);
      // A watcher that was told to stop while it watched says so, exactly as a real one does.
      if (signal.aborted && answer.kind === "settled") {
        return {
          kind: "settled",
          result: {
            ok: false,
            kind: "failed",
            message: "the build was cancelled",
            logTail: "cancelled",
            log: "cancelled\n",
          },
        };
      }
      return answer;
    },
    build(spec, { signal }) {
      specs.push(spec);
      if (opts.auto) return Promise.resolve(opts.auto(spec));
      return new Promise<BuildResult>((resolve) => {
        let done = false;
        const settle = (result: BuildResult) => {
          if (done) return;
          done = true;
          const at = pending.findIndex((p) => p.spec === spec);
          if (at !== -1) pending.splice(at, 1);
          resolve(result);
        };
        signal.addEventListener("abort", () => {
          aborted.push(spec.environmentId);
          settle({
            ok: false,
            kind: "failed",
            message: "aborted",
            logTail: "aborted",
            log: "aborted\n",
          });
        });
        pending.push({
          spec,
          signal,
          settle,
          succeed: (
            image = `registry.test/ryph-envs/${spec.subjectKey}@sha256:${"e".repeat(64)}`,
            extra = {},
          ) =>
            settle({
              ok: true,
              image,
              // A re-layer answers the baked image it was given, as the adapters do.
              bakedImage: spec.relayerFrom ??
                `registry.test/ryph-envs/${spec.subjectKey}@sha256:${"d".repeat(64)}`,
              sizeBytes: 3 * 1024 ** 3,
              toolchains: { rustc: "1.97.1" },
              log: "step 1\nstep 2\nbuilt\n",
              ...extra,
            }),
          fail: (message = "RUN cargo install failed", kind = "failed") =>
            settle({
              ok: false,
              kind,
              message,
              logTail: `error: ${message}`,
              log: `step 1\nerror: ${message}\n`,
            }),
        });
      });
    },
  };
  /** Resolves once `n` builds are parked, counting only those `where` picks when it is given. */
  const parked = async (
    n: number,
    where: (build: PendingBuild) => boolean = () => true,
  ): Promise<PendingBuild[]> => {
    const picked = () => pending.filter(where);
    for (let i = 0; i < 200 && picked().length < n; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    if (picked().length < n) {
      throw new Error(`expected ${n} parked builds, have ${picked().length}`);
    }
    return picked();
  };
  return {
    builder,
    pending,
    specs,
    adopted,
    aborted,
    discarded,
    removed,
    pruned,
    reconciled,
    parked,
  };
}

export function memoryBuildLogs(): BuildLogStore & { logs: Map<string, string> } {
  const logs = new Map<string, string>();
  return {
    logs,
    put(key, text) {
      logs.set(key, text);
      return Promise.resolve();
    },
    get(key) {
      return Promise.resolve(logs.get(key) ?? null);
    },
  };
}

/** Lets queued microtasks and timers-at-zero run: a pump, a settle hook. */
export async function settleAsync(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}
