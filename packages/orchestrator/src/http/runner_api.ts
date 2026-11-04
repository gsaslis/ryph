// The runner surface: heartbeat in, result in (ack out), spec out.
// Authenticated per run: the bearer must hash to the run's tokenHash, so a container can
// speak for its own run and nothing else.
//
// ONE thing an answer here carries: `{ cancel: true }` on a heartbeat, when the run's desired
// state is cancelled. That is a deliberate reversal of "nothing the orchestrator answers drives
// a run", and it is the reversal because the old rule could not be kept honestly:
//
// - The push channel needs to DIAL the container, which the single-process deployment can never
//   do — a `ryph` binary on a laptop has no route to a container's address — so every cancel
//   there waited out the full grace period and then arrived as a SIGKILL. What the user asked
//   for was "stop"; what they got was "stop in two minutes, violently".
// - With replicas the push is also a lottery: the replica taking the cancel is rarely the one
//   that launched the run, and the run network may not be reachable from the control plane's
//   at all.
//
// Both channels are kept. The push stays the FAST path — a cancel lands within a request rather
// than within a heartbeat interval — and this is the one that always arrives. See
// docs/cancellation.md.
//
// The other reversal is the INBOX: `GET /v1/runs/:id/messages` is a pull the runner makes, and
// what it pulls is never work — a message is text the agent reads, framed as untrusted, and
// nothing in it can widen the run's scope. It is a second, explicit channel with its own cursor
// (`after`, the seq of the last message seen, which is also the acknowledgement), held open for
// up to MAX_WAIT_S so a message reaches the agent within a second of being posted. Heartbeats
// carry no messages: they are the run's gauge, and what the agent said about the run (its
// declared outcome, that it finished), and the one thing they hear back is the cancel. The inbox
// is its own pull, and it works on every deployment shape because nothing dials the container.

import type { z } from "@zod/zod";
import { concludeRun, patchUrlOf } from "../core/conclude_run.ts";
import { applyHeartbeat, applyResult, isTerminal } from "../core/lifecycle.ts";
import { openPatchForRun } from "../core/open_patch.ts";
import { agentMayOpenPatches } from "../core/patch_permission.ts";
import { submissionTarget } from "../core/patch_lifecycle.ts";
import { openProgressComment } from "../core/reaper.ts";
import { changeRequestTarget, mergeTargetOf } from "../core/thread_context.ts";
import { forgeRepoRef, runFacingRepoName } from "../core/forge_repo.ts";
import { normalizeBaseRef } from "@ryph/shared/refs";
import { worksForkHead } from "../core/repo_entries.ts";
import type { Run, RunEvent, RunMessage, RunnerResult } from "../core/types.ts";
import { bearerToken, mintId, sha256Hex, unauthorized } from "@ryph/sealed";
import { openBootstrap } from "../core/bootstrap.ts";
import { legacyRefusal } from "../core/legacy.ts";
import { checksOffText } from "../core/check_feedback.ts";
import { DECLARED_UNKNOWN, MAX_STATUS_COMMITS, type RunCommit } from "../core/checks.ts";
import { CHECK_NAME } from "../core/check_types.ts";
import { describeDrops, RESERVED_PREFIX } from "../core/skills.ts";
import {
  HeartbeatSchema,
  ImageRefsResolveSchema,
  RunnerArtifactSchema,
  RunnerChecksSchema,
  RunnerPatchSchema,
  RunnerResultSchema,
  RunnerSkillsReportSchema,
  RunnerTargetSchema,
  SetupFailuresSchema,
  StaleBasesSchema,
  StaleMemoriesSchema,
} from "../schema.ts";
import type { McpRunCredentials, WiredDeps } from "./app.ts";
import {
  describeIssues,
  json,
  parseBody,
  readCappedBytes,
  type Route,
  route,
} from "@ryph/shared/http";
import { runTokenMatches } from "./auth.ts";
import { serveAttachment } from "./attachments_api.ts";
import {
  agentAttachmentRoom,
  MAX_ATTACHMENT_BYTES,
  storeAgentAttachment,
} from "../core/attachments.ts";
import {
  cleanSetupWarning,
  describeSetupWarning,
  ownSetupWarnings,
} from "../core/setup_warnings.ts";
import { checkImageRefs, IMAGE_REF, resolveImageRefs, resultImages } from "../core/image_refs.ts";
import {
  artifactPublishedDetail,
  fetchArtifactForRun,
  MAX_ARTIFACT_HTML_BYTES,
  publishArtifact,
} from "../core/artifacts.ts";
import { processArtifactHtml } from "../adapters/artifact_html/process_preparer.ts";

/** The largest publish body: a document at its cap, every character of it escaped once by the
 * JSON around it, and room for the title. */
const MAX_ARTIFACT_BODY_BYTES = 2 * MAX_ARTIFACT_HTML_BYTES + 64 * 1024;

// What each runner door reads, at most, while it streams — sized to what a real runner sends,
// with headroom, because everything under a cap is buffered and parsed on the control plane's one
// event loop and a run token may be in an untrusted fork PR's hands. A body past its cap is 413.

/** Target claims and ref lookups are small. */
export const MAX_RUNNER_CONTROL_BYTES = 64 * 1024;
/** A heartbeat's message is the runner's clipped 4 000 characters (MAX_PROGRESS_MESSAGE); the
 * room is the schema's 100k characters, JSON-escaped. */
export const MAX_RUNNER_HEARTBEAT_BYTES = 1024 * 1024;
/** Checks asks, skills reports and stale bases: short lists of short fields. */
export const MAX_RUNNER_REPORT_BYTES = 4 * 1024 * 1024;
/** One shipped branch (POST …/patches). The branch's bytes travel as a bundle through the
 * gateway, never here: this is its metadata — commit shas and subjects (one line each; a run's
 * own commits are tens, and 10 000 of them at ~200 bytes is 2 MB) and the agent's description
 * (100k characters). */
export const MAX_RUNNER_PATCH_BYTES = 4 * 1024 * 1024;
/** The result: the same branch metadata for every shipped line, a summary and a reason. Twice a
 * patch's room, since a run's branches share its commits rather than multiplying them. */
export const MAX_RUNNER_RESULT_BYTES = 8 * 1024 * 1024;
/** Staleness findings: one entry per briefed memory whose evidence changed. A brief is a
 * 2 000-token budget, so it names a few dozen memories; the runner sends at most 50 changed paths
 * each (memory keeps no more). 200 entries of 50 paths at ~100 bytes is 1 MB; a report past it is
 * a signal lost, never a run held up. */
export const MAX_RUNNER_STALE_MEMORY_BYTES = 1024 * 1024;
/** Setup warnings at the runner's own bounds (SETUP_FAILURE_LIMITS): 64 entries, each a 200-
 * character label and a 4 096-character tail or error, or 64 file names of 200 characters.
 * The widest, 64 × 64 × 200 characters of three-byte UTF-8, is 2.4 MB. */
export const MAX_RUNNER_SETUP_FAILURE_BYTES = 4 * 1024 * 1024;

/**
 * How many bodies one run may have being read and parsed at once, across every runner door that
 * takes JSON (tool-image uploads keep their own, tighter count), and the most bytes those reads
 * may hold between them — the sum of their caps, reserved as each read starts. Past either the
 * door answers 429 before reading a byte. A real runner has a heartbeat, a report or two and at
 * most a patch and a result in flight; this bounds what a run token held by somebody else can
 * make this process buffer to 24 MiB per run rather than dozens of maximum bodies.
 */
export const MAX_RUNNER_BODIES_IN_FLIGHT = 8;
export const MAX_RUNNER_BODY_BYTES_IN_FLIGHT = 24 * 1024 * 1024;
/** How long any runner body may take to arrive. The runner's own requests time out in seconds;
 * this is what stops a slow drip from holding a slot (and the bytes it has sent) indefinitely. */
export const RUNNER_BODY_DEADLINE_MS = 30_000;

/** The longest a poll is held open: under every proxy's idle timeout, above one heartbeat. */
const MAX_WAIT_S = 25;
/** How often a held poll re-reads the store, so a message posted on another replica — which
 * this replica's in-process signal never hears about — still arrives within a second. */
const POLL_REREAD_MS = 1_000;
/** How many tool-image uploads one run may have in flight at once; the next answers 429. Each
 * buffers up to 5 MiB here while it is read and stored, so this bounds a run's share of memory. */
export const MAX_AGENT_UPLOADS_IN_FLIGHT = 2;

export function runnerRoutes(deps: WiredDeps): Route[] {
  const { store, diag } = deps;
  const nowIso = () => deps.now().toISOString();
  const refDeps = { store, appUrl: deps.config.appUrl };
  // A publish's served document is made off the event loop, in a process killed at its deadline.
  const artifactHtml = deps.artifactHtml ?? processArtifactHtml();
  const bodyDeadlineMs = deps.runnerBodyDeadlineMs ?? RUNNER_BODY_DEADLINE_MS;

  /**
   * Whether this beat's answer should tell the runner to stop.
   *
   * `desiredState` and not "has a cancel been pushed": the push may have failed, may never have
   * been possible, or may have gone to a container that has since been replaced. What the user
   * asked for is durable, and this reads it.
   */
  const wantsCancel = (run: Run): boolean => run.desiredState === "cancelled";

  /** 404 before 401 would confirm which run ids exist; auth failures answer both the same. */
  const authedRun = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Run | Response> => {
    const run = await store.getRun(params.id);
    if (!run || !(await runTokenMatches(req, run))) return unauthorized();
    return run;
  };

  /**
   * The bodies each run has being read in THIS process, for MAX_RUNNER_BODIES_IN_FLIGHT and
   * MAX_RUNNER_BODY_BYTES_IN_FLIGHT. In memory, like the upload count below: the control plane
   * runs as one replica, and a second would give each run that much per replica, still bounded.
   */
  const bodiesInFlight = new Map<string, { count: number; bytes: number }>();

  /** A slot for one body of at most `maxBytes`, or null when the run has no room for it. */
  const admitBody = (runId: string, maxBytes: number): (() => void) | null => {
    const held = bodiesInFlight.get(runId) ?? { count: 0, bytes: 0 };
    if (
      held.count >= MAX_RUNNER_BODIES_IN_FLIGHT ||
      held.bytes + maxBytes > MAX_RUNNER_BODY_BYTES_IN_FLIGHT
    ) {
      return null;
    }
    held.count += 1;
    held.bytes += maxBytes;
    bodiesInFlight.set(runId, held);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.count -= 1;
      held.bytes -= maxBytes;
      if (held.count === 0) bodiesInFlight.delete(runId);
    };
  };

  /** A refusal before the body is read: the rest of it is cancelled, never buffered. */
  const refuseUnread = async (req: Request, res: Response): Promise<Response> => {
    await req.body?.cancel().catch(() => {});
    return res;
  };

  const tooManyBodies = (req: Request, run: Run, maxBytes: number) => {
    diag.warn("run.body_throttled", {
      runId: run.id,
      path: new URL(req.url).pathname,
      maxBytes,
    });
    return json(429, { error: "too many requests in flight for this run" });
  };

  // Called only after authedRun: neither body reads nor attributed diagnostics precede auth.
  const parseRunnerBody = async <T>(
    req: Request,
    schema: z.ZodType<T>,
    run: Run,
    maxBytes: number,
  ): Promise<{ ok: true; data: T } | { ok: false; res: Response }> => {
    const release = admitBody(run.id, maxBytes);
    if (release === null) {
      return { ok: false, res: await refuseUnread(req, tooManyBodies(req, run, maxBytes)) };
    }
    let body;
    try {
      body = await parseBody(req, schema, {
        maxBytes,
        signal: AbortSignal.timeout(bodyDeadlineMs),
      });
    } finally {
      release();
    }
    if (!body.ok && (body.res.status === 413 || body.res.status === 408)) {
      diag.warn(body.res.status === 413 ? "run.body_too_large" : "run.body_too_slow", {
        runId: run.id,
        path: new URL(req.url).pathname,
        maxBytes,
      });
    }
    return body;
  };

  const heartbeat = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    const body = await parseRunnerBody(req, HeartbeatSchema, run, MAX_RUNNER_HEARTBEAT_BYTES);
    if (!body.ok) return body.res;

    const outcome = applyHeartbeat(run, body.data, nowIso());
    switch (outcome.kind) {
      case "terminal":
        // A zombie: the control plane already concluded this run. The 409 is a diagnosis, not a
        // command — stopping it is the reaper's job, not this answer's.
        return json(409, { error: `run is terminal (${run.state})` });
      case "stale":
        // Reordered or duplicated beat: answered but never applied, state cannot roll back. The
        // cancel flag still rides it — a beat this replica considers old is still a live runner
        // asking, and making it wait for a beat we happen to like would be arbitrary.
        return json(200, { cancel: wantsCancel(run) });
      case "applied": {
        const landed = await store.saveHeartbeat(outcome.run);
        if (landed !== null) {
          for (const event of outcome.events) await store.appendEvent(event);
          // From the row as written, not the copy read before it: a cancel that landed in
          // between rides this beat rather than the next one.
          return json(200, { cancel: landed.desiredState === "cancelled" });
        }
        // Declined: the row moved on since `authedRun` read it — concluded, or a newer beat
        // landed first — and nothing was written. Answer from the row as it is now, so a run
        // that just ended hears the 409 and a cancel that just landed rides this beat.
        const now = await store.getRun(run.id);
        if (now === null || isTerminal(now)) {
          return json(409, { error: `run is terminal (${now?.state ?? "gone"})` });
        }
        return json(200, { cancel: wantsCancel(now) });
      }
    }
  };

  const result = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    const body = await parseRunnerBody(req, RunnerResultSchema, run, MAX_RUNNER_RESULT_BYTES);
    if (!body.ok) return body.res;

    // The images the summary shows, read out of it here: the page renders them beside the
    // agent's words, which are kept as written. A ref naming nothing is left out, not refused —
    // the run is over and there is no tool call left to fail.
    let reported: RunnerResult = body.data;
    if ("summary" in reported && run.result === null) {
      const images = await resultImages(refDeps, run, reported.summary);
      if (images.length > 0) reported = { ...reported, images };
    }
    const outcome = applyResult(run, reported, nowIso());
    if (outcome.kind === "applied") {
      const landed = await store.saveRunResult(outcome.run);
      // A concurrent report or terminal verdict won. Re-ack without repeating its events,
      // patches or conclusion. A late report for `lost` is still accepted by the store.
      if (landed === null) return json(200, { ack: "Accepted" });
      for (const event of outcome.events) await store.appendEvent(event);
      diag.debug("result.received", { runId: run.id, status: body.data.status });
      // The patches are born HERE — one per shipped branch, all sharing one set id — and
      // best-effort for the same reason revocation is: the work is already durable (every
      // bundle preceded this report through the gateway), so a failure to open a row must not
      // un-deliver the result. Each one on its own, so one repo's trouble opens the others. A
      // branch the run already reported mid-run (POST …/patches) adopts its row by head.
      //
      // BEFORE the conclusion: memory binds a run's still-unbound claims to its last patch at
      // the outcome, so a patch born from the result must be on record when the outcome lands.
      const task = await store.getTask(run.taskId);
      if (task !== null && body.data.branches.length > 0) {
        const setId = mintId("ps");
        for (const branch of body.data.branches) {
          await openPatchForRun(
            deps,
            landed,
            task,
            { branch, baseSha: branch.baseSha ?? null, title: null, description: null },
            setId,
            false, // Unreported leftovers require approval, even from a successful run.
            nowIso(),
          ).catch((err) =>
            diag.warn("patch.open_failed", {
              runId: run.id,
              path: branch.path,
              line: branch.line,
              err: String(err),
            })
          );
        }
      }
      // The run concluded, so its credentials die with it — model keys, the MCP virtual token
      // and the git virtual key alike — memory hears how it ended, and its response closes.
      // The same helper the reaper calls on a lost verdict: a terminal run is terminal whoever
      // declared it. Best-effort inside, by contract.
      await concludeRun({ ...deps, appUrl: deps.config.appUrl }, landed, nowIso());
    }
    // Duplicates are re-acked, not errored: that is what makes the runner's report idempotent
    // under retry. The ack vocabulary matches the runner's ResultAck.
    return json(200, { ack: "Accepted" });
  };

  /**
   * A patch submitted while the run goes on: the runner already committed, bundled and
   * uploaded (the gateway holds the bundle), and reports the branch here exactly as a result
   * does — the patch is born the same way, through the same rules, and answers its id and the
   * state it was born into. What happens next reaches the agent through the inbox as `system`
   * messages, so it can follow up, wait, or revise without polling.
   *
   * Explicit submissions may skip approval on an `auto` repo. Finalization reports set
   * `requiresApproval`: they retain work the agent never explicitly shipped, regardless of
   * how the run ends. Cancellation intent also keeps new patches behind approval.
   */
  const submitPatch = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) {
      return await refuseUnread(req, json(409, { error: `run is terminal (${run.state})` }));
    }
    const body = await parseRunnerBody(req, RunnerPatchSchema, run, MAX_RUNNER_PATCH_BYTES);
    if (!body.ok) return body.res;
    // The description's image refs must name this run's images; the runner waited on its own
    // uploads before it asked, so nothing is waited on here.
    const refused = body.data.description === undefined
      ? null
      : await checkImageRefs(refDeps, run, body.data.description, { wait: false });
    if (refused !== null) return json(400, { error: refused });
    const task = await store.getTask(run.taskId);
    if (task === null) return json(409, { error: "the run's task no longer resolves" });
    const outcome = await openPatchForRun(
      deps,
      run,
      task,
      {
        branch: body.data.branch,
        baseSha: body.data.baseSha,
        title: body.data.title ?? null,
        description: body.data.description ?? null,
      },
      mintId("ps"),
      body.data.requiresApproval !== true,
      nowIso(),
    );
    if (outcome.kind === "refused") return json(400, { error: outcome.reason });
    // Resolve the same destination as the submit sweep, not the last CR this run happened
    // to open: an older generation or another line must never look like an update.
    let forgeRef = outcome.patch.forgeRef;
    let forgeUrl = outcome.patch.forgeUrl;
    if (forgeRef === null) {
      const freshTask = await store.getTask(task.id);
      const repo = await store.getConnectedRepo(outcome.patch.connectedRepoId);
      if (freshTask !== null && repo !== null) {
        const target = submissionTarget(
          freshTask,
          await store.patchesForTask(task.id),
          outcome.patch,
          "", // Only the CR identity is needed, not the staging branch.
          repo.provider,
        );
        forgeRef = target.changeRequest;
        if (target.changeRequest !== null) {
          if (target.earlier?.forgeRef === target.changeRequest) {
            forgeUrl = target.earlier.forgeUrl;
          } else if (deps.forge) {
            // A targeted CR may predate this run's first patch. Failure to read its URL must
            // not fail a report already recorded durably.
            const fetched = await deps.forge.fetchThread(forgeRepoRef(repo), {
              kind: "change_request",
              ref: target.changeRequest,
            }).catch(() => null);
            if (fetched?.kind === "thread") {
              const head = fetched.thread.changeRequest;
              if (head?.state === "open" && !head.merged) forgeUrl = head.url;
            }
          }
        }
      }
    }
    // `url`: the patch's page, where a person approves it — so an agent whose patch waits can
    // hand that person a link instead of a bare id. Null where the deployment does not know
    // its own address (RYPH_APP_URL); a runner a version behind ignores it.
    return json(outcome.adopted ? 200 : 201, {
      patchId: outcome.patch.id,
      state: outcome.patch.state,
      url: patchUrlOf(deps.config.appUrl, outcome.patch.id),
      forgeUrl,
      forgeRef,
    });
  };

  /**
   * The claim behind the agent's `checkout_change_request` tool: this run's checkout of one repo
   * has moved onto a change request, and from here its commits belong on that change request.
   *
   * The runner has already warmed the gateway's cache and fetched the head when it asks — so a
   * change request nobody can serve never re-targets a task — but it has NOT moved its branch
   * yet: a refusal here has to leave the checkout exactly as it was. Everything below therefore
   * decides before anything is written, and what is written is `core/retarget.ts`'s.
   *
   * The interesting rung is the claim. Two runs pushing onto one change request race at the
   * submit sweep, and the loser's push is rejected terminally (`merge-base --is-ancestor`
   * against a head that moved) while its thread still reads as a success — so a change request
   * another live run is working is refused out loud, exactly as a second `/ryph` in a thread is.
   *
   * A 5xx is "may or may not have been recorded" to the runner, which is the honest reading of a
   * failure anywhere past the writes. The two refusals decided BEFORE any write say so out loud
   * with `recorded: false`: nothing was written, so the runner can retry them without first
   * having to find out what this orchestrator did.
   */
  const target = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    const body = await parseRunnerBody(req, RunnerTargetSchema, run, MAX_RUNNER_CONTROL_BYTES);
    if (!body.ok) return body.res;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    const task = await store.getTask(run.taskId);
    if (task === null) return json(409, { error: "the run's task no longer resolves" });
    const { path, changeRequest } = body.data;

    // A run on a fork's head has run the contributor's code, and from then on anything it asks is
    // as much theirs as the agent's: moved onto another change request, it would carry that into
    // a branch of this repo. It delivers onto its own pull request, or nothing. Decided before
    // any write, so `recorded: false`.
    if (worksForkHead(task.repos)) {
      return json(409, {
        error: "this run works a pull request from a fork, so its checkout cannot move onto " +
          "another change request: run the code it was given, and answer in its own thread",
        recorded: false,
      });
    }

    const entry = task.repos.find((r) => r.path === path);
    if (entry === undefined) return json(400, { error: `this run checks out no repo at ${path}` });
    if (entry.connectedRepoId === null) return json(400, { error: legacyRefusal(entry) });
    const repo = await store.getConnectedRepo(entry.connectedRepoId);
    if (repo === null || repo.archivedAt !== null) {
      return json(400, { error: `${path}'s repo is no longer connected to ryph` });
    }

    // One change request per task, because `targetChangeRequest` is one field: re-targeting a
    // SECOND repo would overwrite the first repo's target, and that repo's next patch would
    // quietly open a pull request of its own while the change request it was working is
    // abandoned. The same repo again is the re-swap the design allows.
    const targeted = task.targetChangeRequest;
    if (targeted !== null && targeted.connectedRepoId !== repo.id) {
      const other = await store.getConnectedRepo(targeted.connectedRepoId);
      return json(409, {
        error: `this run is already working #${targeted.thread} in ` +
          `${
            other === null ? "another repo" : runFacingRepoName(other)
          }; one change request per run`,
      });
    }

    // Once this repo has shipped, the swap would strand what shipped: the patch already names a
    // base and (for a second patch in the same generation) a change request of its own, and the
    // branch the agent would be moved onto is not the one those commits sit on.
    const shipped = (await store.patchesForTask(task.id))
      .some((p) => p.runId === run.id && p.connectedRepoId === repo.id);
    if (shipped) {
      return json(409, {
        error: `this run already submitted a patch for ${path}, so its checkout cannot move ` +
          "onto a change request any more — that work would be left behind",
      });
    }

    if (!deps.forge) {
      return json(503, {
        error: "the forge is not configured on this orchestrator",
        recorded: false,
      });
    }
    const fetched = await deps.forge.fetchThread(
      forgeRepoRef(repo),
      { kind: "change_request", ref: changeRequest },
    );
    if (fetched.kind === "gone") {
      return json(404, {
        error: `${runFacingRepoName(repo)} has no change request #${changeRequest}`,
      });
    }
    if (fetched.kind === "unavailable") {
      return json(503, {
        error: "the forge did not answer about the change request — try again",
        recorded: false,
      });
    }
    // The same rules a `/ryph` command in the thread is held to (open, not a fork's, not the
    // default branch, a name every hop can carry) — asked again here, because this one is asked
    // hours into a run where every answer may have changed.
    const resolved = changeRequestTarget(fetched.thread, repo);
    if (resolved.kind === "refused") return json(400, { error: resolved.why });
    const head = resolved.head;
    // The FORGE's own address for the thread, never the agent's spelling of it. Radicle resolves
    // a unique PREFIX of a patch id, so an agent that typed seven characters would otherwise have
    // the abbreviation recorded — and a webhook arriving later with the full id would match
    // nothing, start a second run, and put two agents on one patch.
    const thread = head.ref;
    // The branch as a NAME, which is the spelling every hop past here uses: the gateway's cache
    // serves a base as a local branch, the reaper anchors the pull request on
    // `normalizeBaseRef(entry.ref).localBranch`, and the runner refuses a claim whose ref is not
    // the one it was served. A forge that answers `refs/heads/foo` would otherwise re-target the
    // task onto a spelling nothing serves, and every retry would meet the same mismatch.
    // `changeRequestTarget` has already proved this does not throw.
    const ref = normalizeBaseRef(head.headRef).localBranch;
    // What it merges into, spelled the same way — the runner merges it to catch the change
    // request up, and the gateway refreshes it beside the head.
    const merge = mergeTargetOf(head);
    const targetRef = merge === undefined ? undefined : normalizeBaseRef(merge).localBranch;

    // A run told it may not open patches only READS the change request: nothing it does can
    // land there, so it claims nothing — no re-target, no progress comment, no hold of its own.
    // Keyed on what the run was TOLD, the frozen copy its runner acts on: a run started with
    // patches on still claims, and its patches meet the live refusal at birth instead. Absent
    // (a run from before the switch existed) is allowed, as the runner defaults it. The
    // runner moves its checkout on this answer. The cost: no origin either, so forge tools
    // scoped to the origin thread cannot reach this change request.
    if (run.workItem.canOpenPatches === false) {
      return json(200, {
        connectedRepoId: repo.id,
        thread,
        ref,
        ...(targetRef === undefined ? {} : { targetRef }),
        headSha: head.headSha,
        url: head.url,
      });
    }

    const held = await store.findLiveRunOnChangeRequest(repo.id, thread);
    if (held !== null && held.id !== run.id) {
      return json(409, { error: `run ${held.id} is already working #${thread}` });
    }

    // Decided over the rows as they stand, locked, in one transaction: a live forge round trip
    // sits just above, and the run and task read before it may have been cancelled, spoken to
    // or concluded meanwhile, or a landing may have moved another repo of the task — copies read
    // before it would put every one of those back.
    const applied = await store.applyRetarget({
      taskId: task.id,
      runId: run.id,
      path,
      connectedRepoId: repo.id,
      thread,
      headRef: ref,
      headSha: head.headSha,
      targetRef,
      at: nowIso(),
    });
    if (applied === null) return json(404, { error: "no such run" });
    // Asked again over the locked rows: what the checks above read may have moved during the
    // forge round trip. Nothing was written.
    if ("kind" in applied) {
      return json(409, {
        error: applied.why === "shipped"
          ? `this run already submitted a patch for ${path}, so its checkout cannot move onto a ` +
            "change request any more — that work would be left behind"
          : "this run is already working a change request in another repo; one change request " +
            "per run",
        recorded: false,
      });
    }
    // Best-effort, and last: the claim has landed, the runner is about to move its branch on the
    // strength of this answer, and a trail row that would not insert must not turn a completed
    // re-target into a failure the runner reports as "not checked out".
    await store.appendEvent(applied.event).catch((err) =>
      diag.warn("run.retarget_event_failed", { runId: run.id, err: String(err) })
    );
    // A run that has just gained a forge thread has no comment on it: it was commanded from a
    // chat room or the app, so neither intake opened one. Without it a later `/ryph` on the
    // change request joins the run, reacts 👀 and then says nothing more, because the progress
    // sweep and the final report both write through this row. Best-effort inside, and only in
    // the gained-origin case — a run that already came from a forge thread keeps the comment it
    // already has, which this upsert (keyed by run) would otherwise replace.
    //
    // Not awaited: it dials the forge, and the runner holds this claim to a 30s timeout — a slow
    // forge must not turn a claim that LANDED into one the runner reports as unconfirmed. It
    // swallows its own failures; the catch is only so a rejection cannot escape unhandled.
    //
    // FOLLOW-UP: a run with no forge scope at all (an agent with no forge policy) gains no
    // origin here and so gets no comment, and a later `/ryph` joining it still answers silence.
    const gainedOrigin = (run.forgeScope?.origin ?? null) === null &&
      (applied.run.forgeScope?.origin ?? null) !== null;
    if (gainedOrigin) {
      openProgressComment(
        { store, forge: deps.forge, diag, now: deps.now, appUrl: deps.config.appUrl },
        {
          repo,
          thread: { kind: "change_request", ref: thread },
          runId: run.id,
          taskId: task.id,
          agentName: run.workItem.agent.name,
          state: run.state,
        },
      ).catch((err) =>
        diag.warn("run.retarget_progress_failed", { runId: run.id, err: String(err) })
      );
    }
    diag.debug("run.retargeted", {
      runId: run.id,
      path,
      connectedRepoId: repo.id,
      thread,
      ref,
    });
    return json(200, {
      connectedRepoId: repo.id,
      thread,
      ref,
      ...(targetRef === undefined ? {} : { targetRef }),
      headSha: head.headSha,
      url: head.url,
    });
  };

  /**
   * The inbox pull. `after` is the seq of the last message the runner saw — and its
   * acknowledgement: everything up to it is stamped delivered before the batch past it is
   * answered. The request is held until such a message exists or `wait` elapses; the wait ends
   * early on this replica's own signal, and re-reads on a clock for every other replica's.
   *
   * `ack=0` (or `ack=false`) is a read that acknowledges nothing: the runner's look for patch
   * cues past what it acknowledged, which must not stamp a person's unread message as delivered
   * to an agent that never saw it. Anything but 0/1/false/true is refused, so a misspelt
   * read-only look cannot acknowledge by accident.
   */
  const messages = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    const query = new URL(req.url).searchParams;
    const after = Number(query.get("after") ?? "-1");
    const wait = Number(query.get("wait") ?? "0");
    if (!Number.isInteger(after) || after < -1) {
      return json(400, { error: "after: expected an integer seq, or -1" });
    }
    if (!Number.isFinite(wait) || wait < 0) {
      return json(400, { error: "wait: expected seconds, 0 or more" });
    }
    const ackParam = query.get("ack");
    if (ackParam !== null && !["0", "1", "false", "true"].includes(ackParam)) {
      return json(400, { error: "ack: expected 0, 1, false or true" });
    }
    const ack = ackParam !== "0" && ackParam !== "false";
    if (ack && after >= 0) await store.markRunMessagesDelivered(run.id, after, nowIso());
    const deadline = deps.now().getTime() + Math.min(wait, MAX_WAIT_S) * 1_000;
    let batch: RunMessage[] = await store.listRunMessages(run.id, after);
    while (batch.length === 0) {
      const left = deadline - deps.now().getTime();
      if (left <= 0) break;
      await deps.inbox.wait(run.id, Math.min(left, POLL_REREAD_MS), req.signal);
      if (req.signal.aborted) break;
      batch = await store.listRunMessages(run.id, after);
    }
    return json(200, { messages: batch });
  };

  /**
   * An image the run was handed — with its task, or on a message — as its bytes, so the runner
   * can save it beside the checkout and hand it to the agent (core/attachments.ts). Only this
   * run's, and only one already handed over: an upload no message has carried yet is not the
   * run's to read. Its own path rather than the user door's: both are GETs, and the router takes
   * the first route that matches.
   */
  const attachment = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    const found = await store.getAttachment(params.attachmentId);
    if (
      found === null || found.runId !== run.id || found.claimedBy === null ||
      !deps.attachmentStore
    ) {
      return json(404, { error: "no such attachment" });
    }
    return await serveAttachment(deps.attachmentStore, found);
  };

  /**
   * How many tool-image uploads each run has in flight in THIS process, for
   * MAX_AGENT_UPLOADS_IN_FLIGHT. In memory, not in the database: the control plane runs as one
   * replica, so this process sees every upload a run makes. A second replica would give each
   * run that many per replica, still bounded.
   */
  const agentUploadsInFlight = new Map<string, number>();

  /**
   * An image one of the agent's tools returned (a browser screenshot, a file its read tool
   * opened), uploaded by the runner before it narrates the tool's result, so the transcript names
   * it by id rather than carrying its bytes (core/attachments.ts `storeAgentAttachment`). Raw
   * body, read under the 5 MiB cap while it streams, sniffed like every other door. Stored
   * already claimed, so both read doors serve it. A run at MAX_AGENT_ATTACHMENTS answers 409
   * `{error: "cap"}`, and an image past what is left of its byte budget 409 `{error: "bytes"}`
   * (a smaller one may still fit, so the runner keeps trying) — both looked at BEFORE the body
   * is read, so a capped run costs a count and nothing else; a run with MAX_AGENT_UPLOADS_IN_FLIGHT uploads still being
   * read or stored answers 429, which the runner retries; a terminal run 409 as every runner
   * door does.
   */
  const uploadAttachment = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const refuse = async (res: Response) => {
      await req.body?.cancel().catch(() => {});
      return res;
    };
    const run = await authedRun(req, params);
    if (run instanceof Response) return await refuse(run);
    if (isTerminal(run)) {
      return await refuse(json(409, { error: `run is terminal (${run.state})` }));
    }
    const ref = new URL(req.url).searchParams.get("ref") ?? "";
    if (!IMAGE_REF.test(ref)) {
      return await refuse(json(400, { error: "ref must be img- and 12 hex characters" }));
    }
    // The same image again is the row already kept, its body never read: no cap is spent on it.
    const [same] = await store.agentAttachmentsByRefs(run.id, [ref]);
    if (same !== undefined) {
      return await refuse(json(200, { id: same.id, mime: same.mime, bytes: same.bytes }));
    }
    const inFlight = agentUploadsInFlight.get(run.id) ?? 0;
    if (inFlight >= MAX_AGENT_UPLOADS_IN_FLIGHT) {
      return await refuse(json(429, { error: "too many uploads in flight for this run" }));
    }
    agentUploadsInFlight.set(run.id, inFlight + 1);
    try {
      const declared = Number(req.headers.get("content-length") ?? "");
      const room = await agentAttachmentRoom(
        store,
        run.id,
        Number.isFinite(declared) && declared > 0 ? declared : 0,
      );
      if (room !== null) return await refuse(json(409, { error: room.reason ?? "cap" }));
      const read = await readCappedBytes(req, MAX_ATTACHMENT_BYTES);
      if (!read.ok) {
        return json(413, { error: `an image is at most ${MAX_ATTACHMENT_BYTES} bytes (5 MiB)` });
      }
      const outcome = await storeAgentAttachment(deps, run, read.bytes, ref);
      if (outcome.kind === "refused") {
        const agentLimit = outcome.reason === "cap" || outcome.reason === "bytes";
        return json(outcome.status, { error: agentLimit ? outcome.reason : outcome.error });
      }
      const { id, mime, bytes } = outcome.attachment;
      return json(201, { id, mime, bytes });
    } finally {
      const left = (agentUploadsInFlight.get(run.id) ?? 1) - 1;
      if (left <= 0) agentUploadsInFlight.delete(run.id);
      else agentUploadsInFlight.set(run.id, left);
    }
  };

  /**
   * Whether the image refs in something the agent is about to write name this run's images —
   * the runner asks before it records a summary its finish or report_outcome gave, or ships a
   * patch whose description shows any. No wait: the runner has already waited on its own
   * uploads, and a ref still missing is one no tool returned.
   */
  const resolveRefs = async (req: Request, params: Record<string, string>) => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    const body = await parseRunnerBody(req, ImageRefsResolveSchema, run, MAX_RUNNER_CONTROL_BYTES);
    if (!body.ok) return body.res;
    return json(200, await resolveImageRefs(refDeps, run, body.data.refs, { wait: false }));
  };

  /**
   * The agent's `environment_status` tool: what the environment builds its run's patches asked
   * for came to, as text the runner hands the agent verbatim — the build's own output already
   * fenced (core/environment_feedback.ts). A read, like the inbox, and one more way to learn the
   * same thing a build-result message says; it also retries the check of a submitted patch the
   * forge could not be asked about when it landed.
   */
  const environment = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    const feedback = deps.environmentFeedback ?? null;
    if (feedback === null) {
      return json(200, {
        text: "Environments are not built on this deployment, so no patch of this run asks for " +
          "a build: every run starts on the default image.",
      });
    }
    const { text } = await feedback.statusForRun(run);
    return json(200, { text });
  };

  /**
   * The agent's `run_checks` tool: a commit the runner just uploaded through forge intake as a
   * check candidate becomes a suite (core/checks.ts) — or joins the one its commit, declaration
   * and image already have. The answer is text the runner hands the agent verbatim; a refusal is
   * `{error}` with a status, as every runner route's is.
   */
  const requestChecks = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    // Checks gate patches, and the run was told of none: one that asks anyway is refused.
    if (!await agentMayOpenPatches(store, run.agentId)) {
      return json(409, { error: "this run's agent may not open patches, so it runs no checks" });
    }
    const body = await parseRunnerBody(req, RunnerChecksSchema, run, MAX_RUNNER_REPORT_BYTES);
    if (!body.ok) return body.res;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    const checks = deps.checks ?? null;
    if (checks === null) {
      return json(200, {
        suiteId: null,
        state: null,
        reused: false,
        text: checksOffText(null),
      });
    }
    const answer = await checks.requestForRun(run, body.data);
    if (answer.status !== 200 && answer.status !== 202) {
      return json(answer.status, { error: answer.text });
    }
    return json(answer.status, {
      suiteId: answer.suiteId,
      state: answer.state,
      reused: answer.reused,
      text: answer.text,
    });
  };

  /** The agent's `check_status` tool: where this run's suites stand, as text — each check's
   * own output already fenced. A read, like `environment`. `awaiting` beside it counts the
   * verdicts this run is still owed. `?awaiting=1` is the runner's, not the agent's: it answers
   * `owed`, WHICH verdicts are still owed (core/check_awaiting.ts), and builds no text — the
   * runner holds a stop on those it has not given up on. */
  const checkStatus = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    const checks = deps.checks ?? null;
    // Owed only while the service runs: one that is off or refused settles nothing, so a stop
    // held on its verdicts would only wait out the hold.
    const active = checks !== null && checks.enabled && checks.refusedReason === null;
    const owed = async () => active ? await deps.checksAwaiting?.(run.id) ?? [] : [];
    if (new URL(req.url).searchParams.get("awaiting") === "1") {
      return json(200, { owed: await owed() });
    }
    if (checks === null) {
      return json(200, { text: checksOffText(null), awaiting: 0 });
    }
    const at = commitsOf(new URL(req.url).searchParams);
    if (at instanceof Response) return at;
    const { text } = await checks.statusForRun(run, at);
    const awaiting = (await owed()).length;
    return json(200, { text, awaiting });
  };

  /** The agent's `check_log` tool: one check's whole stored log, as text — the check's own
   * output, which the runner saves to a file for the agent and never reads. A suite this run may
   * not read answers 404 as one that does not exist. */
  const checkLog = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    const query = new URL(req.url).searchParams;
    const check = query.get("check") ?? "";
    if (!CHECK_NAME.test(check)) return json(400, { error: "check: a check's name" });
    const rawGeneration = query.get("generation");
    const generation = rawGeneration === null ? undefined : Number(rawGeneration);
    if (generation !== undefined && (!Number.isInteger(generation) || generation < 1)) {
      return json(400, { error: "generation: a suite generation, 1 or more" });
    }
    const checks = deps.checks ?? null;
    if (checks === null) return json(409, { error: checksOffText(null) });
    const answer = await checks.logForRun(run, {
      suiteId: params.suite,
      check,
      ...(generation === undefined ? {} : { generation }),
    });
    if (answer.kind === "refused") return json(answer.status, { error: answer.why });
    return new Response(answer.text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-ryph-check-generation": String(answer.generation),
        // What a check printed is the head's words, as on the people's log route.
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  };

  /**
   * What each of the run's repos declares in `.ryph/checks.yml` at its base, for the prompt.
   * Its own route so the boot's spec fetch never waits on the forge: the read is bounded, a repo
   * not read in time is named in `unread` (`["*"]` when the repos could not be listed), and a
   * forge that fails never makes it a 5xx.
   */
  const declaredChecks = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    const checks = deps.checks ?? null;
    if (checks === null || !checks.enabled || checks.refusedReason !== null) {
      return json(200, { declared: [], unread: [] });
    }
    const answer = await checks.declaredForRun(run).catch(() => ({
      declared: [],
      unread: [DECLARED_UNKNOWN],
    }));
    return json(200, answer);
  };

  // The one route the launch's single-use bearer opens, and the only one it opens: it trades
  // that bearer for the run's own contract, which the launch environment never carries. The
  // bundle is opened BEFORE the bearer is spent — one that does not open is a clean 409 with the
  // row left as it was, never a 500 after the DELETE — and the bearer is spent with the row, so
  // nothing after the DELETE may fail the answer; the event is best-effort. A lost answer is not
  // retried into a second success.
  const bootstrap = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const token = bearerToken(req);
    const run = await store.getRun(params.id);
    if (!token || !run || isTerminal(run) || run.desiredState === "cancelled") {
      return unauthorized();
    }
    const tokenHash = await sha256Hex(token);
    const held = await store.readBootstrap(run.id, tokenHash, nowIso());
    if (held === null) return unauthorized();
    let env: Record<string, string>;
    try {
      env = await openBootstrap(token, run.id, held);
    } catch {
      diag.warn("bootstrap.unreadable", { runId: run.id });
      return json(409, {
        error: "this run's launch credentials cannot be opened; it cannot start",
        code: "bootstrap_unreadable",
      });
    }
    // The one success: whoever's DELETE takes the row. The bundle is one per run, so what it
    // returns is the bundle opened above.
    if (await store.consumeBootstrap(run.id, tokenHash, nowIso()) === null) return unauthorized();
    // Not awaited: the answer must not wait on a write it can do without.
    void store.appendEvent({ runId: run.id, at: nowIso(), kind: "bootstrap-redeemed" })
      .catch((err) => diag.warn("bootstrap.event_failed", { runId: run.id, err: String(err) }));
    return new Response(JSON.stringify({ env }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };

  const spec = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    // Fetch-on-boot: serves the run's complete input — the work item plus the injected
    // context — frozen at provision time, never recomposed from live rows, so editing an agent
    // cannot change an in-flight run's ask. The fetch doubles as the runner's reachability/auth
    // handshake.
    //
    // The services half is NARROWED here rather than served whole: the runner needs the name,
    // the port and something to show the agent, and has no use for the digest-pinned ref's
    // capability set or resource caps. Adding a key is compatible in both directions — the
    // runner's RunSpecSchema strips what it does not know and defaults this to null — so a
    // rolling deploy in either order is a run with no services, never a run that will not boot.
    // On for a run that may not open patches too: it runs no checks (`requestChecks` refuses
    // it), but reads them — a reviewer looks up a change request's checks.
    const checksOn = deps.checks !== undefined && deps.checks !== null &&
      deps.checks.enabled && deps.checks.refusedReason === null;
    return json(200, {
      workItem: run.workItem,
      injectedContext: run.injectedContext,
      services: run.services === null ? null : {
        list: run.services.services.map((s) => ({
          name: s.name,
          port: s.port,
          image: s.image,
        })),
        stale: run.services.stale,
      },
      // The machine the run is on, frozen at launch: `baked` tells the runner to adopt the
      // checkout the image carries instead of cloning. Null where environments are off, and a
      // runner that predates the key defaults it to null the same way `services` is defaulted.
      environment: run.environment,
      // Whether the platform runs `.ryph/checks.yml` here — what turns the prompt's checks
      // paragraph on. Null where this orchestrator has no checks at all; a runner that predates
      // the key strips it. What the checks declare is its own route (`checks/declared`), so
      // this fetch never waits on the forge.
      checks: deps.checks ? { enabled: checksOn } : null,
      // The skills the run was given, narrowed like the services: the runner needs each name,
      // description, source and digest, whether it may add the repos' own and what budget is
      // left for them — not which org repo version they came from, which is the trail's. The
      // content is its own route (`skills/:digest`), so this fetch stays small. A runner that
      // predates the key strips it; one that postdates this orchestrator defaults it to null.
      skills: run.skills === null ? null : {
        skills: run.skills.skills,
        workingRepos: run.skills.workingRepos,
        budget: run.skills.budget,
      },
    });
  };

  /**
   * One frozen skill's files, by the digest the run was frozen with. A container cannot read a
   * bundle its run was never given, whatever digest it asks for: a digest outside the run's own
   * list answers 404, exactly as one nothing ever stored does. The catalogue this process booted
   * with answers first, from memory; the store holds every version any process stored, so a run
   * frozen before a deploy still finds the catalogue it was frozen with.
   */
  const skillBundle = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    const digest = params.digest;
    if (!(run.skills?.skills.some((s) => s.digest === digest) ?? false)) {
      return json(404, { error: "this run was given no skill with that digest" });
    }
    const bundle = deps.skillCatalogue?.bundle(digest) ?? await deps.skills?.bundle(digest) ??
      null;
    if (bundle === null) return json(404, { error: "no stored skill has that digest" });
    return json(200, { files: bundle.files });
  };

  /**
   * The runner's half of the skills trail: the working-repo skills it loaded, and the skills it
   * could not give the agent (a bundle it could not fetch or validate, a repo skill that lost a
   * collision or did not fit the cap). Only what THIS run could hold: a repo path it never
   * checked out, a frozen skill it was never given, any repo skill at all on a run whose policy
   * (or harness) gives it none, a loaded name reserved for the catalogue, frozen onto the run or
   * loaded twice, and loaded skills past the count frozen for them are all dropped here, so a
   * container cannot put a claim on the trail that the run was never allowed to make. The listing
   * byte budget is the runner's alone to hold: a report names skills, not their descriptions, so
   * this side cannot price them. One report
   * per run: every report after the first is refused whole. Best-effort on the runner's side,
   * like the stale reports.
   */
  const skillsReport = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    const body = await parseRunnerBody(req, RunnerSkillsReportSchema, run, MAX_RUNNER_REPORT_BYTES);
    if (!body.ok) return body.res;
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    // A run with no skills, or one whose working repos are off, has no repo skill to speak of.
    const paths = new Set(
      run.skills?.workingRepos === true ? run.workItem.repos.map((r) => r.path) : [],
    );
    const frozen = new Map((run.skills?.skills ?? []).map((s) => [s.name, s.source]));
    // A name the run was frozen with outranks every repo skill, and a name loads once: the
    // runner's own precedence never lets a repo skill shadow either.
    const seen = new Set<string>();
    const loaded = body.data.loaded
      .filter((s) => {
        if (!paths.has(s.path) || s.name.startsWith(RESERVED_PREFIX)) return false;
        if (frozen.has(s.name) || seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
      })
      .slice(0, run.skills?.budget.skills ?? 0);
    const dropped = body.data.dropped.filter((d) =>
      d.source === "repo" ? paths.has(d.path) : frozen.get(d.name) === d.source
    );
    const events: Pick<RunEvent, "kind" | "detail">[] = [];
    if (body.data.root !== null) events.push({ kind: "skills.root", detail: body.data.root });
    if (loaded.length > 0) {
      events.push({
        kind: "skills.repo",
        detail: loaded.map((s) => `${s.name} (\`${s.path}/\`)`).join("\n"),
      });
    }
    if (dropped.length > 0) events.push({ kind: "skills.dropped", detail: describeDrops(dropped) });
    // The runner sends one report per run, and the store holds it to one: a second report (a
    // container restarted within the run, or one posting on its own) is refused whole, or each
    // post would add a full budget of claims. Claimed even when nothing survives the filters,
    // so an empty first report still closes the door.
    const recorded = await store.recordSkillsReport(run.id, nowIso(), events);
    if (!recorded) return json(409, { error: "this run already reported its skills" });
    return new Response(null, { status: 204 });
  };

  const credentials = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    // Serves only live runs: a run token that leaks after the run concludes mints nothing.
    if (isTerminal(run)) return json(409, { error: `run is terminal (${run.state})` });
    // No scope of either kind, nothing to mint — the boot fetch is unconditional, so the empty
    // map is a normal answer (echo agents, policy-less agents), not an error.
    if (run.modelScope === null && run.toolScope === null) return json(200, { env: {} });
    if (run.modelScope !== null && !deps.modelAccess) {
      return json(503, { error: "model access is not configured on this orchestrator" });
    }
    if (run.toolScope !== null && !deps.toolAccess) {
      return json(503, { error: "tool access is not configured on this orchestrator" });
    }
    // A run is issued a model credential a bounded number of times over its life: the runner
    // asks once at boot, and a container restarted within the run asks again — a loop asking
    // forever is minting a pile of working keys. Counted off the run's own trail, which is what
    // the orchestrator holds; the proxy's rows are the proxy's. 4xx is definitive to the runner.
    //
    // Reserved here, atomically, rather than counted-then-appended-later: two boot-credential
    // requests racing for this run (a flaky first attempt retried before it fails, say) would
    // otherwise both read the same count before either's append lands, and both pass a cap that
    // had room for one. The reservation is undone below if the mint that follows it fails, so a
    // failed attempt still costs nothing — the cap only ever charges for credentials issued.
    let reservedSeq: number | null = null;
    if (run.modelScope !== null) {
      const slot = await store.reserveCredentialSlot(
        run.id,
        { at: nowIso(), detail: run.modelScope.providerKeyId },
        deps.config.limits.maxCredentials,
      );
      if (!slot.reserved) {
        return json(429, {
          error: `this run has already been issued ${slot.issued} model credentials ` +
            "(RYPH_RUN_MAX_CREDENTIALS)",
          code: "limit_reached",
          limit: "credentials",
          max: deps.config.limits.maxCredentials,
        });
      }
      reservedSeq = slot.seq;
    }
    // Two halves, one answer. Both are minted before either is returned, so a half that fails
    // fails the whole fetch and the runner retries the pair: the half that did land is one more
    // TTL'd row that revocation on conclusion sweeps up with the rest, not a leaked credential.
    // The tool half goes first and the model half last: a tool gateway that blinks then mints no
    // model key, and — since the reservation above already stands in for the model half's trail
    // entry — a retried pair costs one reservation per attempt but only ever holds the one from
    // whichever attempt actually mints, the rest released in the catch below.
    const body: { env: Record<string, string>; mcp?: McpRunCredentials } = { env: {} };
    try {
      if (run.toolScope !== null) {
        body.mcp = await deps.toolAccess!.issueRunCredentials({
          runId: run.id,
          servers: run.toolScope.servers,
        });
      }
      if (run.modelScope !== null) {
        body.env = await deps.modelAccess!.issueRunCredentials({
          runId: run.id,
          agentId: run.agentId,
          taskId: run.taskId,
          providerKeyId: run.modelScope.providerKeyId,
          provider: run.modelScope.provider,
          allowedModels: run.modelScope.allowedModels,
          spendUsd: run.limits.spendUsd,
          callsInFlight: run.limits.callsInFlight,
        });
      }
      if (body.mcp !== undefined) {
        await store.appendEvent({
          runId: run.id,
          at: nowIso(),
          kind: "credentials-issued",
          detail: `mcp: ${body.mcp.servers.map((s) => s.slug).join(", ")}`,
        });
      }
      // The raw virtual tokens ride this response and the container's memory, nowhere else —
      // the same rule as the run token itself, which authenticated this very request.
      return json(200, body);
    } catch (err) {
      // E.g. the backing key or a scoped server was archived between provision and boot: the
      // run could never call it, so failing its boot here is the honest outcome. 503 keeps the
      // runner's retry semantics (5xx retries, 4xx is definitive) pointed the right way for
      // transient store failures; a truly dead scope exhausts the retries and boot-fails. The
      // reservation above did not become a credential, so it is released rather than charged.
      if (reservedSeq !== null) {
        await store.releaseCredentialSlot(run.id, reservedSeq).catch((releaseErr) =>
          diag.warn("credentials.release_failed", { runId: run.id, err: String(releaseErr) })
        );
      }
      diag.warn("credentials.issue_failed", { runId: run.id, err: String(err) });
      return json(503, { error: "could not issue run credentials" });
    }
  };

  // The staleness check, relayed: the runner ran `git diff` for every briefed memory with
  // evidence and found these changed. Memory hears it through the port and the run's trail
  // records it; the runner keeps talking to one host and never acts as the agent. Best-effort
  // like the outcome: a report memory could not take is a signal lost, and the runner's
  // answer is a 204 either way — the run must not stall on a memory hiccup.
  const stale = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) {
      return await refuseUnread(req, json(409, { error: `run is terminal (${run.state})` }));
    }
    const body = await parseRunnerBody(
      req,
      StaleMemoriesSchema,
      run,
      MAX_RUNNER_STALE_MEMORY_BYTES,
    );
    if (!body.ok) return body.res;
    // Only what THIS run was briefed with: a container cannot cast doubt on memories its brief
    // never carried, whatever ids it sends.
    const briefed = new Set(run.injectedContext?.brief?.memoryIds ?? []);
    const known = body.data.stale.filter((s) => briefed.has(s.memoryId));
    if (known.length > 0) {
      await store.appendEvent({
        runId: run.id,
        at: nowIso(),
        kind: "memory-stale",
        detail: known.map((s) => s.memoryId).join(", "),
      });
      if (deps.memoryAccess) {
        await deps.memoryAccess.reportStale(run.id, known).catch((err) =>
          diag.warn("memory.stale_failed", { runId: run.id, err: String(err) })
        );
      }
    }
    return new Response(null, { status: 204 });
  };

  /**
   * The agent's `publish_artifact` tool (core/artifacts.ts): the document the runner read from
   * the workspace, kept as a new artifact (201) or the next version of one this run may update
   * (200), and a run event saying so in prose (the app reads the ids off the task's artifacts,
   * which list each version's run); the same title and document again answer the current
   * version with `unchanged: true` (200) and no event. The body is read under its cap while it
   * streams; the refusals carry the core's words, which the runner hands the agent.
   */
  const publishArtifactRoute = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) {
      await req.body?.cancel().catch(() => {});
      return run;
    }
    const artifacts = deps.artifacts ?? null;
    if (artifacts === null) {
      await req.body?.cancel().catch(() => {});
      return json(503, { error: "this deployment keeps no artifacts" });
    }
    const release = admitBody(run.id, MAX_ARTIFACT_BODY_BYTES);
    if (release === null) {
      return await refuseUnread(req, tooManyBodies(req, run, MAX_ARTIFACT_BODY_BYTES));
    }
    let read;
    try {
      read = await readCappedBytes(
        req,
        MAX_ARTIFACT_BODY_BYTES,
        AbortSignal.timeout(bodyDeadlineMs),
      );
    } finally {
      release();
    }
    if (!read.ok) {
      return read.reason === "timeout"
        ? json(408, { error: "the body took too long to arrive" })
        : json(413, { error: `an artifact is at most ${MAX_ARTIFACT_HTML_BYTES} bytes (2 MiB)` });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return json(400, { error: "body is not valid JSON" });
    }
    const body = RunnerArtifactSchema.safeParse(raw);
    if (!body.success) return json(400, { error: describeIssues(body.error) });
    const outcome = await publishArtifact(
      {
        store,
        artifacts,
        html: artifactHtml,
        appUrl: deps.config.appUrl,
        now: deps.now,
        mintId: () => mintId("art"),
      },
      run,
      body.data,
    );
    if (outcome.kind === "refused") return json(outcome.status, { error: outcome.error });
    if (outcome.unchanged) {
      return json(200, {
        id: outcome.id,
        version: outcome.version,
        url: outcome.url,
        unchanged: true,
      });
    }
    // Best-effort, and after: the artifact exists whether or not its trail row lands.
    await store.appendEvent({
      runId: run.id,
      at: nowIso(),
      kind: "artifact-published",
      detail: artifactPublishedDetail(outcome.title, outcome.version),
    }).catch((err) => diag.warn("run.artifact_event_failed", { runId: run.id, err: String(err) }));
    return json(outcome.created ? 201 : 200, {
      id: outcome.id,
      version: outcome.version,
      url: outcome.url,
    });
  };

  /**
   * The agent's `fetch_artifact` tool (core/artifacts.ts `fetchArtifactForRun`): the current
   * version of one of this agent's artifacts, as published, for the agent to edit and publish
   * again. `{ id, title, version, html }`; 404 for anything this run may not version.
   */
  const fetchArtifactRoute = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    const artifacts = deps.artifacts ?? null;
    if (artifacts === null) return json(503, { error: "this deployment keeps no artifacts" });
    const outcome = await fetchArtifactForRun({ store, artifacts }, run, params.artifactId);
    if (outcome.kind === "refused") return json(outcome.status, { error: outcome.error });
    return json(200, {
      id: outcome.id,
      title: outcome.title,
      version: outcome.version,
      html: outcome.html,
    });
  };

  // The clone's freshness, relayed to the trail: the forge served these bases from its cache
  // because the upstream could not be reached. The run may be behind upstream, and will look
  // inexplicable later if upstream moved in between. Only paths THIS run was given:
  // a container cannot forge an event about a repo it never had, whatever paths it sends.
  const staleBase = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    if (isTerminal(run)) {
      return await refuseUnread(req, json(409, { error: `run is terminal (${run.state})` }));
    }
    const body = await parseRunnerBody(req, StaleBasesSchema, run, MAX_RUNNER_REPORT_BYTES);
    if (!body.ok) return body.res;
    const repos = new Map(run.workItem.repos.map((r) => [r.path, r]));
    for (const base of body.data.bases) {
      const repo = repos.get(base.path);
      if (repo === undefined) continue;
      await store.appendEvent({
        runId: run.id,
        at: nowIso(),
        kind: "base-stale",
        detail: `\`${repo.path}/\` (${repo.name}) started from \`${repo.ref}\` at ` +
          `${base.commit.slice(0, 7)}, served from the forge's cache: every refresh from ` +
          `upstream since ${base.since} has failed, so it may be behind upstream.`,
      });
    }
    return new Response(null, { status: 204 });
  };

  // A repo's setup did not finish (a step failed, or setup.yml was invalid), or what setup left
  // in a tree was discarded, and the run went on: the warning a person reading the run must
  // see, since the agent may be working on a machine that is not what the repo meant it to be.
  // One event per repo and kind, and only for paths THIS run was given (a discard's mention of
  // other repos held to them too), so a container cannot put a warning about a repo it never
  // had on the trail. The text is cleaned before it is stored (no escapes, controls or credentials: a
  // step runs with the egress claim in its proxy URL). One report per run, as the skills report
  // is: the runner sends one, so a second (a retry, or the agent posting with the run token) is
  // refused whole rather than repeating the warnings.
  const setupFailed = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await authedRun(req, params);
    if (run instanceof Response) return run;
    // Both refusals before the body: a terminal run, or one that already reported, costs a
    // lookup and nothing is read.
    if (isTerminal(run)) {
      return await refuseUnread(req, json(409, { error: `run is terminal (${run.state})` }));
    }
    if (await store.hasRunEvent(run.id, "setup.failed")) {
      return await refuseUnread(
        req,
        json(409, { error: "this run already reported its setup failures" }),
      );
    }
    const body = await parseRunnerBody(
      req,
      SetupFailuresSchema,
      run,
      MAX_RUNNER_SETUP_FAILURE_BYTES,
    );
    if (!body.ok) return body.res;
    // Asked again after the read: a second report racing this one may have landed meanwhile.
    if (await store.hasRunEvent(run.id, "setup.failed")) {
      return json(409, { error: "this run already reported its setup failures" });
    }
    const reported = body.data.failures.flatMap((f) => f === null ? [] : [cleanSetupWarning(f)]);
    for (const warning of ownSetupWarnings(reported, run.workItem.repos.map((r) => r.path))) {
      await store.appendEvent({
        runId: run.id,
        at: nowIso(),
        kind: "setup.failed",
        detail: describeSetupWarning(warning),
      });
    }
    return new Response(null, { status: 204 });
  };

  return [
    route("POST", "/v1/runs/:id/heartbeat", heartbeat),
    route("POST", "/v1/runs/:id/result", result),
    route("POST", "/v1/runs/:id/patches", submitPatch),
    route("POST", "/v1/runs/:id/artifacts", publishArtifactRoute),
    route("GET", "/v1/runs/:id/artifacts/:artifactId", fetchArtifactRoute),
    route("POST", "/v1/runs/:id/target", target),
    route("GET", "/v1/runs/:id/messages", messages),
    route("GET", "/v1/runs/:id/runner/attachments/:attachmentId", attachment),
    route("POST", "/v1/runs/:id/runner/attachments", uploadAttachment),
    route("POST", "/v1/runs/:id/runner/images/resolve", resolveRefs),
    route("GET", "/v1/runs/:id/environment", environment),
    route("POST", "/v1/runs/:id/checks", requestChecks),
    route("GET", "/v1/runs/:id/checks", checkStatus),
    route("GET", "/v1/runs/:id/checks/:suite/log", checkLog),
    route("GET", "/v1/runs/:id/checks/declared", declaredChecks),
    route("POST", "/v1/runs/:id/memory/stale", stale),
    route("POST", "/v1/runs/:id/base/stale", staleBase),
    route("POST", "/v1/runs/:id/setup/failed", setupFailed),
    route("POST", "/v1/runs/:id/bootstrap", bootstrap),
    route("GET", "/v1/runs/:id/spec", spec),
    route("GET", "/v1/runs/:id/skills/:digest", skillBundle),
    route("POST", "/v1/runs/:id/skills/report", skillsReport),
    route("GET", "/v1/runs/:id/credentials", credentials),
  ];
}

/** A commit SHA as git spells it: SHA-1 or SHA-256, lowercase. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_COMMIT_PATH_CHARS = 256;

/**
 * The commits `check_status` asks about: `at=<sha>:<path>`, once per commit, the SHA first so a
 * colon in the path stays the path's; `named=1` when the agent named the commit. None, and the
 * answer is the run's own asks alone.
 */
function commitsOf(
  query: URLSearchParams,
): { commits: RunCommit[]; named: boolean } | undefined | Response {
  const raw = query.getAll("at");
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_STATUS_COMMITS) {
    return json(400, { error: `at: at most ${MAX_STATUS_COMMITS} commits` });
  }
  const commits: RunCommit[] = [];
  for (const value of raw) {
    const colon = value.indexOf(":");
    const commit = value.slice(0, colon);
    const path = value.slice(colon + 1);
    if (
      colon < 0 || !COMMIT_SHA.test(commit) || path === "" ||
      path.length > MAX_COMMIT_PATH_CHARS
    ) {
      return json(400, { error: "at: <commit sha>:<repo path>" });
    }
    commits.push({ path, commit });
  }
  return { commits, named: query.get("named") === "1" };
}
