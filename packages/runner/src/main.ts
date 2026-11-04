// The composition root —
// the only file that knows which implementation stands behind each port and how work arrives.
// Wiring changes here; the core does not move.
//
// The adapter behind each port is chosen here:
// changing how the runner talks to the caller, git, memory, or the outside world
// means editing this file and nothing else.
// Everything that varies per run enters as input — the work to do, the context to inject, etc. —
// so a new run is new inputs, not new wiring.
//
// Invariants:
// - this file owns every temp resource it mints (the checkout dir);
//   the core receives paths only and never cleans up what it was handed. The one directory the
//   core mints itself is the run's skills, written after setup and removed when the harness is
//   done (core/run.ts), because it must not exist while setup steps run
// - cleanup runs on every exit path — normal return, throw, or signal — and at most once
// - a disposer is best-effort:
//   a failed cleanup is warned, never allowed to change the run's outcome or exit code

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseArgs } from "@std/cli/parse-args";
import { Logger, LogLevel, setupLoggerFromEnv } from "@ryph/logger";
import type { ZodType } from "@zod/zod";
import { run, type RunCtx } from "./core/run.ts";
import { shadowedAddress } from "./helpers/services.ts";
import { ENV_PREFIX } from "./core/brand.ts";
import type {
  HarnessSpec,
  InjectedContext,
  RunEnvironment,
  RunServices,
  RunSkills,
  WorkItem,
} from "./core/types.ts";
import {
  describeIssues,
  HarnessManifestSchema,
  InjectedContextSchema,
  readRunSkills,
  RunBootstrapSchema,
  RunCredentialsSchema,
  RunSpecSchema,
  WorkItemSchema,
} from "./schema.ts";
import type { Diagnostics } from "./ports/diagnostics.ts";
import type { Harness, HarnessTools } from "./ports/harness.ts";
import type { Inbox } from "./ports/inbox.ts";
import type { Attachments } from "./ports/attachments.ts";
import type { PatchReporter } from "./ports/patch_reporter.ts";
import type { EnvironmentStatus } from "./ports/environment_status.ts";
import type { ArtifactPublisher } from "./ports/artifacts.ts";
import type { ChecksChannel } from "./ports/checks.ts";
import type { RunActions } from "./ports/run_actions.ts";
import type { BackgroundRecords, CommandsUplink } from "./ports/background.ts";
import { loggerDiagnostics } from "./adapters/diagnostics/logger.ts";
import {
  noopEnvironmentStatus,
  noopInbox,
  noopOrchestratorGateway,
  noopPatchReporter,
} from "./adapters/orchestrator/noop.ts";
import {
  exchangeBootstrap,
  fetchRunCredentials,
  fetchRunSpec,
  httpArtifactPublisher,
  httpAttachments,
  httpBackgroundRecords,
  httpChecks,
  httpEnvironmentStatus,
  httpInbox,
  httpOrchestratorGateway,
  httpPatchReporter,
  httpSkillBundles,
  reportBootFailure,
} from "./adapters/orchestrator/http.ts";
import type { OrchestratorGateway } from "./ports/orchestrator_gateway.ts";
import type { RunControl } from "./ports/run_control.ts";
import { startControlApi } from "./adapters/control/http.ts";
import { startLoopbackMcp } from "./adapters/loopback/mcp.ts";
import { runnerPreviews } from "./adapters/orchestrator/previews.ts";
import { type BrowserSidecar, startBrowserSidecar } from "./adapters/browser/sidecar.ts";
import { browserEgressProxy } from "./helpers/environment.ts";
import { commandsSinkUrl, startCommandsUplink } from "./adapters/background/uplink.ts";
import { cliGitTransport } from "./adapters/git/cli.ts";
import { gatewayGitTransport } from "./adapters/git/gateway.ts";
import { echoHarness } from "./adapters/harness/echo.ts";
import { piHarness } from "./adapters/harness/pi.ts";
import { piSubagentHost } from "./adapters/subagents/pi.ts";
import type { SubagentHost } from "./ports/subagents.ts";
import { piModelSeesImages } from "./adapters/harness/pi_vision.ts";
import { consoleNarrator } from "./adapters/narrator/console.ts";
import { historyNarrator, teeNarrator } from "./adapters/narrator/history.ts";
import { historyDiagnostics, teeDiagnostics } from "./adapters/diagnostics/history.ts";
import { httpHistoryEmitter } from "./adapters/history/emitter.ts";
import { specMemoryStore } from "./adapters/memory/spec.ts";
import { errorMessage } from "./helpers/errors.ts";
import { mintToken } from "@ryph/sealed";
import { hostileVariables } from "@ryph/shared/env";
import { runtimeCredentials } from "./helpers/runtime_credentials.ts";

// No default case on purpose: a new HarnessSpec kind then falls off the end and violates the
// Harness return type — a compile error that forces the new kind to be wired here.
function makeHarness(spec: HarnessSpec, modelSeesImages: boolean): Harness {
  switch (spec.kind) {
    case "echo":
      return echoHarness();
    case "pi": {
      // RUNNER_PI_BIN and RUNNER_PI_MCP_EXTENSION relocate pi and the ryph extensions (the MCP
      // one, and the images one beside it) for a checkout that drives pi outside the harness
      // layer (see docs/development.md); an image keeps the adapter's /opt/ryph defaults.
      const bin = process.env["RUNNER_PI_BIN"];
      return piHarness(spec, {
        command: bin ? [bin] : undefined,
        mcpExtension: process.env["RUNNER_PI_MCP_EXTENSION"] || undefined,
        modelSeesImages,
      });
    }
  }
}

/** Where a run's subagents come from: a second pi of the run's own for a pi run, nothing for a
 * harness with no child of its own. Relocated by the same env as the run's own pi. */
function makeSubagentHost(
  spec: HarnessSpec,
  modelSeesImages: boolean,
  diag: Diagnostics,
): SubagentHost | undefined {
  switch (spec.kind) {
    case "echo":
      return undefined;
    case "pi": {
      const bin = process.env["RUNNER_PI_BIN"];
      return piSubagentHost(spec, {
        diag,
        command: bin ? [bin] : undefined,
        mcpExtension: process.env["RUNNER_PI_MCP_EXTENSION"] || undefined,
        modelSeesImages,
      });
    }
  }
}

/**
 * The signals the runner ignores under the image's init (`RYPH_INIT=tini`): each one whose
 * default action would end or stop the runner. tini forwards all of them but SIGTTIN and SIGTTOU,
 * which are here for a sender inside the container. Not SIGINT or SIGTERM, which ask for a cancel;
 * not SIGPIPE, SIGURG, SIGWINCH or SIGCONT, whose defaults are harmless already; not the
 * synchronous faults (SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGTRAP, SIGSYS), which tini does
 * not forward and which must not be swallowed. SIGPWR and SIGSTKFLT are Linux's alone.
 */
const STRAY_SIGNALS: readonly NodeJS.Signals[] = [
  "SIGHUP",
  "SIGQUIT",
  "SIGUSR1",
  "SIGUSR2",
  "SIGALRM",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGIO",
  "SIGPWR",
  "SIGSTKFLT",
];

/**
 * The harness layer's manifest (images/harness/Dockerfile) — what the layer this runner shipped
 * in carries. `RUNNER_HARNESS_MANIFEST` relocates it, for a test.
 */
const HARNESS_MANIFEST = "/opt/ryph/harness.json";

/**
 * Why this runner cannot drive `kind`, or null when it can.
 *
 * The orchestrator validates a kind against its own `RYPH_HARNESS_KINDS`, and the image a run
 * lands on is chosen by its repo's environment, not by the kind — so the two can disagree, and
 * this is where that is caught: before any clone, naming the kind and what the layer carries.
 * No manifest at all is a runner started from a checkout (tests, `bun run debug`), where the
 * compiled-in kinds are the whole story; a manifest that is present but unreadable is refused,
 * because an image that says nothing true about itself should not run anything.
 */
export async function harnessRefusal(
  kind: string,
  diag: Diagnostics,
  path: string = process.env["RUNNER_HARNESS_MANIFEST"] || HARNESS_MANIFEST,
): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      diag.debug("harness.manifest.absent", { path });
      return null;
    }
    return `${path}: ${errorMessage(error)}`;
  }
  let manifest;
  try {
    manifest = parseJson(text, path, HarnessManifestSchema);
  } catch (error) {
    return errorMessage(error);
  }
  diag.debug("harness.manifest", { path, ...manifest });
  if (manifest.harnessKinds.includes(kind)) return null;
  return `this image's harness layer carries ${
    manifest.harnessKinds.map((k) => `"${k}"`).join(", ")
  }, not "${kind}" (runner ${manifest.runner})`;
}

/**
 * Where an environment image bakes its checkouts, one directory per repo.
 * A baked run works here instead of in a temp dir, because
 * the warm build is only warm where it was built. `RUNNER_WORK_ROOT` relocates it, for a test.
 */
const BAKED_WORK_ROOT = "/ryph/work";

/**
 * Where the run's virtual MCP token lives between the credentials fetch and the harness spawn:
 * a brand-scoped runtime credential, so the same scrub that hides the run token from
 * repo-authored setup steps hides this one too. The pi adapter reads it by this name and hands
 * it to pi under the harness-facing name its config references; setup steps never see either.
 */
const MCP_TOKEN_ENV = `${ENV_PREFIX}_MCP_TOKEN`;

/**
 * Where the runner's OWN tool server's token lives — the loopback MCP server the harness dials
 * for `submit_patch`, `patches`, `environment_status` and `finish`. Minted here per run, parked brand-scoped for the
 * same reason as the gateway token (setup steps never see it), handed to the harness under its
 * own name at spawn.
 */
const LOOPBACK_TOKEN_ENV = `${ENV_PREFIX}_LOOPBACK_TOKEN`;

/**
 * Where the browser sidecar's bearer lives: minted here, handed to the sidecar on `/configure`,
 * parked brand-scoped like the loopback token, and handed to the harness under its own name.
 */
const BROWSER_TOKEN_ENV = `${ENV_PREFIX}_BROWSER_TOKEN`;

/**
 * Builds the composition root's `RunControl` implementation. Exported so a test can verify it's
 * wired to the live run — get the wiring wrong and every request still type-checks but does nothing.
 */
export function makeRunControl(
  cancelController: AbortController,
  diag: Diagnostics,
  runId: string,
): RunControl {
  return {
    requestCancel: () => {
      diag.debug("control.cancel.requested", { runId });
      cancelController.abort();
    },
  };
}

const USAGE = `flags:
  --work-item <path>              JSON describing the work to do: the harness to run, the
                                  agent's identity, and the task. Required unless the run's
                                  spec is fetched from the orchestrator (the agent-container
                                  contract: ${ENV_PREFIX}_RUN_ID, ${ENV_PREFIX}_ORCHESTRATOR_URL,
                                  and ${ENV_PREFIX}_BOOTSTRAP_TOKEN all set).
  --context <path>                (optional) JSON merged in as injected context. Falls back
                                  to the fetched spec's context, else {}.`;

/**
 * CLI entrypoint. Bad usage exits 2.
 * A `Result` with status "failure" (the agent didn't deliver)
 * or "error" (the machinery around it broke) is still a normal exit —
 * the runner did its job.
 * Only an uncaught error (a runner bug) exits abnormally.
 */
export async function main(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    string: ["work-item", "context"],
    unknown: (arg) => fail(`unexpected argument: ${arg}`),
  });

  // One shared logger behind both operational voices: `log` carries the human-facing lines,
  // `diag` the machinery's dot-namespaced event story — levels, formatters, and the
  // RYPH_LOG_* knobs in one place (RYPH_LOG_LEVEL=warn drops the debug-level play-by-play,
  // leaving only swallowed-failure warnings). Pinned to stderr so stdout stays clean for the
  // `Result` JSON alone.
  // Created first: fetching the spec below already wants to warn about retries,
  // and a cleanup failure can be warned about even from a signal handler.
  setupLoggerFromEnv({ level: LogLevel.DEBUG, stderr: true });
  const log = new Logger("runner");
  const baseDiag = loggerDiagnostics("runner");

  // The orchestrator contract env, read once: the launch carries the URL, the run id and a
  // one-shot bootstrap bearer, and nothing else. The URL without the bearer is bad config — a
  // silent fallback to the noop gateway would quietly sever the reporting channel.
  const orchestratorUrl = process.env[`${ENV_PREFIX}_ORCHESTRATOR_URL`];
  const envRunId = process.env[`${ENV_PREFIX}_RUN_ID`];
  const bootstrapToken = process.env[`${ENV_PREFIX}_BOOTSTRAP_TOKEN`];
  delete process.env[`${ENV_PREFIX}_BOOTSTRAP_TOKEN`];
  if (orchestratorUrl && !bootstrapToken) {
    fail(`${ENV_PREFIX}_ORCHESTRATOR_URL requires ${ENV_PREFIX}_BOOTSTRAP_TOKEN`);
  }
  if (bootstrapToken) {
    if (!orchestratorUrl || !envRunId) {
      fail(
        `${ENV_PREFIX}_BOOTSTRAP_TOKEN requires ${ENV_PREFIX}_ORCHESTRATOR_URL and ` +
          `${ENV_PREFIX}_RUN_ID`,
      );
    }
    // The run's own contract — its bearers and where they go — held in memory from here on.
    // A failure cannot be reported upstream: the run bearer is what this would have delivered.
    // The reaper's startup grace is what concludes such a run.
    try {
      const body = await exchangeBootstrap({
        baseUrl: orchestratorUrl,
        bootstrapToken,
        runId: envRunId,
        diag: baseDiag,
      });
      const bootstrap = parseJson(body, "the run bootstrap", RunBootstrapSchema, {
        secret: true,
      });
      for (const [name, value] of Object.entries(bootstrap.env)) {
        runtimeCredentials.set(name, value);
      }
    } catch (error) {
      fail(errorMessage(error));
    }
  }
  // Present exactly when the bootstrap was redeemed: its schema refuses an answer without it.
  const runToken = runtimeCredentials.get(`${ENV_PREFIX}_RUN_TOKEN`);

  // Where transcript batches are POSTed. Set only when the historian is a standalone service;
  // unset, it falls back to the orchestrator origin, where the historian is mounted in-process.
  // The run token is the same either way — the historian gates ingest with it in both deployments.
  const historyUrl = runtimeCredentials.get(`${ENV_PREFIX}_HISTORY_URL`) || orchestratorUrl;

  // The forge-gateway contract env, read once with the rest: when the run's repo is served by
  // the gateway, both halves arrive together (the origin to dial and the run-scoped read-only
  // key). Either half alone is bad config — a silent fallback to the direct transport would
  // point a credentialless clone at a URL that demands one.
  const gitOrigin = runtimeCredentials.get(`${ENV_PREFIX}_GIT_ORIGIN`);
  const gitToken = runtimeCredentials.get(`${ENV_PREFIX}_GIT_TOKEN`);
  if (!gitOrigin !== !gitToken) {
    fail(`${ENV_PREFIX}_GIT_ORIGIN and ${ENV_PREFIX}_GIT_TOKEN must be set together`);
  }

  // The history emitter, created as early as the contract env allows so even boot-time diag
  // events (spec retries, credential fetches) reach the run's permanent record. One emitter
  // behind both voices: `diag` below is the tee (logger + history), the narrator gets its leg
  // where the ports are bound. CLI runs (no orchestrator env) get no emitter and behave as before.
  //
  // The emitter warns only through `baseDiag`. Handing it the tee instead would feed its own
  // failures back into the queue that is failing to drain — every retry minting another warning,
  // the batch growing by one each time, for as long as the sink is down.
  //
  // That is not a rule to remember, which is why the order below is what it is: the emitter is
  // built before `diag` exists, so passing it is a compile error ("Block-scoped variable 'diag'
  // used before its declaration"), not a bug to be found later. Keep them in this order.
  const historyEmitter = historyUrl && runToken && envRunId
    ? httpHistoryEmitter({ baseUrl: historyUrl, runToken, runId: envRunId, diag: baseDiag })
    : null;
  const diag = historyEmitter
    ? teeDiagnostics(baseDiag, historyDiagnostics(historyEmitter))
    : baseDiag;

  // A run the control plane launched clones every repo through the gateway: it always sends the
  // pair, so a run without it is a composition bug. Refused rather than left to the CLI
  // transport, which is for hand-run work items only.
  if (orchestratorUrl && runToken && envRunId && !gitOrigin) {
    const reason = `${ENV_PREFIX}_GIT_ORIGIN and ${ENV_PREFIX}_GIT_TOKEN are required for a run ` +
      "the control plane launched: every repo is cloned through the forge's git gateway";
    await reportBootFailure({ baseUrl: orchestratorUrl, runToken, runId: envRunId, reason, diag });
    fail(reason);
  }

  // The run's input arrives one of two ways: a flag naming a file (the CLI contract), or fetched
  // from the orchestrator by run id (the agent-container contract, where a launch passes no
  // argv). The flag wins when both are available. The fetch doubles as the boot handshake: a run
  // that cannot reach or authenticate against the orchestrator dies here, before doing work it
  // could never report.
  let item: WorkItem;
  let fetchedCtx: InjectedContext | null = null;
  // Only an orchestrator-wired run can have services: the flag path is a hand-run work item,
  // where whoever typed it arranged their own environment.
  let services: RunServices | undefined;
  // Likewise the machine: only the control plane resolves one.
  let environment: RunEnvironment | undefined;
  // And whether the platform runs the repos' declared checks: only the control plane does.
  let checksEnabled = false;
  // And the skills it froze onto the run: only the control plane freezes any.
  let frozenSkills: RunSkills | null = null;
  // Its skills section, when this runner could not read it: reported once the gateway is up.
  let skillsRefused: ReturnType<typeof readRunSkills>["refused"] = null;
  if (typeof flags["work-item"] === "string") {
    item = await loadJson(flags["work-item"], WorkItemSchema).catch(failWith);
  } else if (orchestratorUrl && runToken && envRunId) {
    try {
      const body = await fetchRunSpec({
        baseUrl: orchestratorUrl,
        runToken,
        runId: envRunId,
        diag,
      });
      const spec = parseJson(body, "the fetched run spec", RunSpecSchema);
      if (spec.workItem.id !== envRunId) {
        throw new Error(
          `the fetched run spec is for "${spec.workItem.id}", expected "${envRunId}"`,
        );
      }
      item = spec.workItem;
      fetchedCtx = spec.injectedContext;
      services = spec.services ?? undefined;
      environment = spec.environment ?? undefined;
      checksEnabled = spec.checks?.enabled === true;
      const skillsRead = readRunSkills(spec.skills);
      frozenSkills = skillsRead.skills;
      skillsRefused = skillsRead.refused;
    } catch (error) {
      // The credentials are in hand, so even a run that dies assembling its input can usually
      // still conclude upstream immediately instead of waiting out the liveness window.
      const reason = errorMessage(error);
      await reportBootFailure({
        baseUrl: orchestratorUrl,
        runToken,
        runId: envRunId,
        reason,
        diag,
      });
      fail(reason);
    }
  } else {
    fail(
      `--work-item is required unless ${ENV_PREFIX}_RUN_ID, ${ENV_PREFIX}_ORCHESTRATOR_URL, ` +
        `and ${ENV_PREFIX}_BOOTSTRAP_TOKEN are all set to fetch the run's spec from the orchestrator`,
    );
  }
  const injectedCtx: InjectedContext = typeof flags.context === "string"
    ? await loadJson(flags.context, InjectedContextSchema).catch(failWith)
    : fetchedCtx ?? {};
  log.info(`run ${item.id} starting`, {
    harness: item.harness.kind,
    repos: item.repos.map((r) => `${r.path} ← ${r.url}`),
  });

  // Before anything is fetched or cloned: a kind the harness layer does not carry can only fail,
  // and the sooner it says so, the less it costs. Reported upstream like any boot failure.
  const refusal = await harnessRefusal(item.harness.kind, diag);
  if (refusal !== null) {
    if (orchestratorUrl && runToken && envRunId) {
      await reportBootFailure({
        baseUrl: orchestratorUrl,
        runToken,
        runId: envRunId,
        reason: refusal,
        diag,
      });
    }
    fail(refusal);
  }

  // Fetch model and MCP credentials using the in-memory run bearer from bootstrap. They stay
  // in private runtime configuration, NEVER process.env; adapters build explicit child envs at
  // spawn. The core carries only lookup names, not secrets. Brand-scoped MCP and custom-model
  // keys stay out of setup children and are handed only to the harness that needs them.
  // A failure is a boot failure: never run keyless and fail opaquely mid-harness.
  let tools: HarnessTools | undefined;
  let credentialEnv: Record<string, string> = {};
  if (orchestratorUrl && runToken && envRunId) {
    try {
      const body = await fetchRunCredentials({
        baseUrl: orchestratorUrl,
        runToken,
        runId: envRunId,
        diag,
      });
      if (body === null) {
        // An orchestrator predating the credentials endpoint: nothing to export, not an error.
        diag.debug("credentials.absent", { runId: envRunId });
      } else {
        const credentials = parseJson(body, "the fetched run credentials", RunCredentialsSchema);
        credentialEnv = credentials.env;
        for (const [name, value] of Object.entries(credentials.env)) {
          runtimeCredentials.set(name, value);
        }
        if (credentials.mcp) {
          runtimeCredentials.set(MCP_TOKEN_ENV, credentials.mcp.token);
          tools = { servers: credentials.mcp.servers, tokenEnv: MCP_TOKEN_ENV };
        }
        diag.debug("credentials.fetched", {
          runId: envRunId,
          vars: Object.keys(credentials.env),
          mcpServers: credentials.mcp?.servers.map((s) => s.slug) ?? [],
        });
      }
    } catch (error) {
      const reason = errorMessage(error);
      await reportBootFailure({
        baseUrl: orchestratorUrl,
        runToken,
        runId: envRunId,
        reason,
        diag,
      });
      fail(reason);
    }
  }

  // Before the harness is handed a key to send anywhere: a service named after the host of an
  // address this run dials would answer in that host's place. The control plane refused the
  // addresses it hands out before launch; the credentials carry the ones only this process sees
  // — the model endpoints in their env, and the MCP servers the harness dials with the tool
  // token.
  if (services && orchestratorUrl && runToken && envRunId) {
    const reason = shadowedAddress(services.list, {
      ...credentialEnv,
      ...Object.fromEntries(
        (tools?.servers ?? []).map((server) => [`MCP server "${server.slug}"`, server.url]),
      ),
      [`${ENV_PREFIX}_ORCHESTRATOR_URL`]: orchestratorUrl,
      [`${ENV_PREFIX}_HISTORY_URL`]: historyUrl,
      [`${ENV_PREFIX}_GIT_ORIGIN`]: gitOrigin,
    });
    if (reason !== null) {
      await reportBootFailure({
        baseUrl: orchestratorUrl,
        runToken,
        runId: envRunId,
        reason,
        diag,
      });
      fail(reason);
    }
  }

  // The cleanup machinery for the resource-lifecycle invariant above:
  // disposers accumulate as resources are minted,
  // and dispose() drains them at most once
  // (so the finally below and the signal handlers can both call it safely).
  // RUNNER_KEEP_TEMP=1 keeps the temp files for inspection after a failed run
  // (pairs with RYPH_LOG_LEVEL=debug); it gates only the file-removal disposers,
  // so non-file teardown like the control server still runs.
  const keepTemp = process.env["RUNNER_KEEP_TEMP"] === "1";
  const disposers: Array<() => Promise<void>> = [];
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const d of disposers) {
      await d().catch((err) => diag.warn("dispose.failed", { runId: item.id, err }));
    }
    // The history emitter drains LAST, outside the disposers, so the teardown's own diag
    // events (a failed cleanup is exactly what an inspection wants to see) still make the
    // final batch. Result delivery happened inside run(), so a slow flush delays no verdict.
    await historyEmitter?.shutdown();
  };

  // Handle a kill. Ctrl-C sends SIGINT, `docker stop` sends SIGTERM; both are treated the same.
  // `cancelController` is the one place every cancel source converges — the signal listeners here,
  // the inbound control endpoint wired below, and a heartbeat answered with `{ cancel: true }`
  // all abort it, and run() sees only the single `cancelSignal`, so the core never learns who
  // asked to stop.
  //
  // The FIRST signal asks for a graceful cancel:
  // it aborts `cancelController`, whose signal is handed to run() as its `cancelSignal`.
  // The core forwards that straight into the harness —
  // independent of whatever orchestrator gateway is wired in —
  // so the harness stops at a coherent point, whatever work exists is committed and pushed,
  // and a "cancelled" `Result` is reported.
  // The process then exits normally, so the finally below cleans up as usual.
  //
  // A SECOND OS signal forces the exit — for when the graceful path is stuck or too slow.
  // It runs dispose() directly and exits 130. The escalation tracks OS signals specifically, not
  // whether `cancelController` is already aborted: a control /cancel or a heartbeat's cancel flag
  // aborts that controller too, and the platform's routine SIGTERM backstop must not then be
  // mistaken for the operator's second kill and force-cut the in-flight commit and push.
  //
  // Registered before the checkout root is created,
  // so a kill that lands during setup still cleans up.
  // SIGKILL and SIGSTOP escape this: they can't be caught. A killed or stopped runner reports
  // nothing more, so the orchestrator sees its heartbeat stop; a killed one leaves the temp dir
  // behind until the OS cleans it up.
  const cancelController = new AbortController();
  let osSignalSeen = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      diag.debug("signal.received", { sig, forced: osSignalSeen });
      if (osSignalSeen) {
        dispose().finally(() => process.exit(130));
        return;
      }
      osSignalSeen = true;
      cancelController.abort();
    });
  }
  // Under the image's init (the image sets RYPH_INIT=tini), tini forwards nearly every signal it
  // gets to the runner, and most would end or stop it with no cancel, dispose or finalization.
  // The kernel ignored them while the runner was PID 1 itself; this keeps that for the catchable
  // ones. It does not bring back the rest of PID 1's shelter: a process in the run (same uid) can
  // now SIGKILL or SIGSTOP the runner, say a test's `kill -9 -1` or `pkill -f ryph`, and a
  // broadcast SIGTERM reaches it and starts a cancel. Each is tried on its own, so a signal this
  // OS does not have never stops the runner starting. A runner started by hand keeps the
  // defaults, so closing its terminal still ends it.
  if (process.env[`${ENV_PREFIX}_INIT`] === "tini") {
    for (const sig of STRAY_SIGNALS) {
      try {
        process.on(sig, () => diag.debug("signal.ignored", { sig }));
      } catch {
        // Not a signal this runtime can listen for on this OS.
      }
    }
  }

  // Registered before the try so the finally sweeps it
  // even if a later step (wiring the run) throws before we reach run().
  // The checkout root: one subdirectory per repo of the work item lands under it, and the
  // harness runs at it. Nothing above it may carry a context file (an AGENTS.md at the mount
  // root or in $HOME) — the harness walks its ancestors for one, and would take it as the
  // run's; the agent image keeps its filesystem clean of them.
  //
  // A baked environment is the exception: its root is the image's own, holding the warm
  // checkouts the core adopts. It is not a temp resource of ours — the container it lives in
  // goes with the run — so nothing disposes of it. A root that is not there (the spec says
  // baked, the image is not the one it named) degrades to a temp dir and ordinary clones.
  const bakedRoot = environment?.baked ? await bakedWorkRoot(diag) : null;
  let checkoutRoot: string;
  if (bakedRoot !== null) {
    checkoutRoot = bakedRoot;
    diag.debug("checkout.baked", { dir: checkoutRoot, environment: environment?.id });
  } else {
    // mkdtemp appends its random part to the prefix: an empty one still names a child of the
    // root, never a sibling.
    const parent = (process.env.RUNNER_CHECKOUT_ROOT || tmpdir()).replace(/\/+$/, "");
    const dir = await mkdtemp(
      `${parent}/${process.env.RUNNER_CHECKOUT_PREFIX ?? "runner-checkout-"}`,
    );
    checkoutRoot = dir;
    diag.debug("checkout.created", { dir, keepTemp });
    if (!keepTemp) disposers.push(() => rm(dir, { recursive: true }));
  }

  // The finally is the guaranteed sweep on every normal exit
  // (success, failure, error, or a throw setting up the run);
  // the signal listeners cover a kill.
  // Everything that mints a temp resource lives inside
  // so nothing can leak between its creation and the disposal.
  try {
    const controlToken = runtimeCredentials.get(`${ENV_PREFIX}_CONTROL_TOKEN`);
    let controlApiUrl: string | undefined;
    if (controlToken) {
      const controlApi = await startControlApi(makeRunControl(cancelController, diag, item.id), {
        token: controlToken,
        port: readPort(`${ENV_PREFIX}_PORT`, 8080),
        diag,
      });
      disposers.push(() => controlApi.shutdown());
      controlApiUrl = controlApi.url;
      diag.debug("control.api", { runId: item.id, url: controlApi.url });
    }

    // The runner's own tool server, on loopback, on every run: the agent's capabilities over
    // its own run. Its token is minted here and parked brand-scoped; the core binds the actions
    // once the clones exist, and the server answers "not ready" until then.
    const loopbackToken = mintToken();
    runtimeCredentials.set(LOOPBACK_TOKEN_ENV, loopbackToken);
    let actions: RunActions | null = null;
    // Whether the agent is told about checks: settled by the core as the harness starts.
    let checksTold = false;
    // The runner's own listeners, which no preview may front. The tool server's port is known
    // only once it binds, just below.
    const reservedPorts = new Set<number>();
    if (controlApiUrl) reservedPorts.add(Number(new URL(controlApiUrl).port));
    if (item.browser !== undefined) reservedPorts.add(item.browser.port);
    const previews = orchestratorUrl && runToken
      ? await runnerPreviews({
        baseUrl: orchestratorUrl,
        runToken,
        runId: item.id,
        reserved: () => reservedPorts,
      })
      : undefined;
    if (previews) {
      disposers.push(() => {
        previews.close();
        return Promise.resolve();
      });
    }
    const loopback = await startLoopbackMcp({
      previews,
      token: loopbackToken,
      actions: () => actions,
      diag,
      checks: () => checksTold,
      patches: item.canOpenPatches,
      unattended: item.unattended === true,
      interactive: item.interactive === true,
      artifacts: item.canPublishArtifacts,
      repos: item.repos,
    });
    disposers.push(() => loopback.shutdown());
    reservedPorts.add(Number(new URL(loopback.url).port));
    diag.debug("loopback.api", { runId: item.id, url: loopback.url });
    tools = {
      servers: tools?.servers ?? [],
      tokenEnv: tools?.tokenEnv ?? MCP_TOKEN_ENV,
      loopback: { url: loopback.url, tokenEnv: LOOPBACK_TOKEN_ENV },
    };

    // The browser sidecar, when the platform launched one: brought up NOW, so its wait (a
    // minute at most) runs beside the clone and setup rather than after them. Never fatal — the
    // core is handed its answer, ready or failed, just before the harness starts. Its live
    // stream goes to the historian under the run token, which the sidecar itself never holds.
    // Whether the run's model can see images: decided once, here, so the browser (configured
    // now, before pi starts) and pi agree (adapters/harness/pi_vision.ts).
    const modelSeesImages = item.harness.kind === "pi"
      ? await piModelSeesImages(
        item.harness,
        (name) => runtimeCredentials.get(name),
        undefined,
        undefined,
        diag,
      )
      : true;
    diag.debug("model.sees_images", { runId: item.id, sees: modelSeesImages });
    let browser: BrowserSidecar | undefined;
    if (item.browser !== undefined) {
      const browserToken = mintToken();
      runtimeCredentials.set(BROWSER_TOKEN_ENV, browserToken);
      // The run's own way out, and its own direct hosts: loopback and the services it was
      // provisioned, which the browser resolves by name exactly as the agent's shell does. Never
      // the platform's hosts — a page's JavaScript is untrusted, and the proxy refuses them.
      const proxy = browserEgressProxy((services?.list ?? []).map((service) => service.name));
      const sidecar = startBrowserSidecar({
        port: item.browser.port,
        token: browserToken,
        tokenEnv: BROWSER_TOKEN_ENV,
        proxy: proxy === null ? null : { ...proxy, bypass: proxy.bypass.join(",") },
        vision: modelSeesImages,
        live: historyUrl && runToken ? { historyUrl, runToken, runId: item.id } : null,
        signal: cancelController.signal,
        diag,
        log,
      });
      disposers.push(() => sidecar.stop());
      browser = sidecar;
    }

    // The upstream reporting channel, wired from the contract env read above — and, for a run
    // that can be spoken to, the inbox it pulls and the reporter its mid-run patches land on.
    let orchestrator: OrchestratorGateway = noopOrchestratorGateway();
    let inbox: Inbox = noopInbox();
    let patchReporter: PatchReporter = noopPatchReporter();
    let environmentStatus: EnvironmentStatus = noopEnvironmentStatus();
    // Nor here: a run with no control plane has nowhere to fetch an image from, and the core
    // tells the agent so.
    let attachments: Attachments | undefined;
    // No stand-in here: a run the platform runs no checks for is TOLD so, and uploads nothing.
    let checks: ChecksChannel | undefined;
    // Nor here: a run with no control plane has nowhere to publish an artifact, and the tool
    // says so.
    let artifacts: ArtifactPublisher | undefined;
    // Nor here: a run with no control plane keeps no record of its background commands, and one
    // with no historian streams them nowhere.
    let backgroundRecords: BackgroundRecords | undefined;
    let commandsUplink: CommandsUplink | undefined;
    if (historyUrl && runToken) {
      const uplink = startCommandsUplink({
        url: commandsSinkUrl(historyUrl, item.id),
        runToken,
        diag,
      });
      disposers.push(() => uplink.close());
      commandsUplink = uplink;
    }
    // Nor here: a run frozen with no skills section has none. One frozen with an empty section
    // (every skill turned off, working repos too) still goes in, because its empty report is
    // what settles the run page's "none yet".
    let skills: RunCtx["skills"];
    if (orchestratorUrl && runToken) {
      if (frozenSkills !== null) {
        skills = {
          spec: frozenSkills,
          bundles: httpSkillBundles({ baseUrl: orchestratorUrl, runToken, runId: item.id, diag }),
        };
      }
      if (checksEnabled) {
        checks = httpChecks({ baseUrl: orchestratorUrl, runToken, runId: item.id, diag });
      }
      environmentStatus = httpEnvironmentStatus({
        baseUrl: orchestratorUrl,
        runToken,
        runId: item.id,
        diag,
      });
      inbox = httpInbox({ baseUrl: orchestratorUrl, runToken, runId: item.id, diag });
      attachments = httpAttachments({ baseUrl: orchestratorUrl, runToken, runId: item.id, diag });
      backgroundRecords = httpBackgroundRecords({
        baseUrl: orchestratorUrl,
        runToken,
        runId: item.id,
        diag,
      });
      patchReporter = httpPatchReporter({
        baseUrl: orchestratorUrl,
        runToken,
        runId: item.id,
        diag,
      });
      if (item.canPublishArtifacts) {
        artifacts = httpArtifactPublisher({
          baseUrl: orchestratorUrl,
          runToken,
          runId: item.id,
          diag,
        });
      }
      const gateway = httpOrchestratorGateway({
        baseUrl: orchestratorUrl,
        runToken,
        runId: item.id,
        heartbeatIntervalMs: readMillis("RUNNER_HEARTBEAT_INTERVAL_MS", 10_000),
        // The third cancel source, converging on the same controller as the other two. It is
        // the one that works when nothing can reach this container: the beat is outbound, so it
        // crosses whatever the push could not.
        onCancelRequested: () => {
          diag.debug("heartbeat.cancel.requested", { runId: item.id });
          cancelController.abort();
        },
        diag,
      });
      disposers.push(() => Promise.resolve(gateway.shutdown()));
      orchestrator = gateway;
    }
    if (skillsRefused !== null) {
      diag.warn("skills.spec_refused", { runId: item.id, reason: skillsRefused.reason });
      // Reported even when nothing could be named, so the run's page stops waiting on it.
      orchestrator.reportSkills({ root: null, loaded: [], dropped: skillsRefused.dropped });
    }

    // The adapter behind each port, bound in one place.
    // Swapping an implementation — a fake for a test, a different transport —
    // is an edit to this block and nothing else.
    const result = await run(item, {
      orchestrator,
      harness: makeHarness(item.harness, modelSeesImages),
      // The transport: through the forge gateway when its contract env is present (clone with
      // the run's read-only key, work leaves as a bundle), else the credential-free clone of the
      // URL, for a hand-run work item. The core never learns which.
      git: gitOrigin && gitToken
        ? gatewayGitTransport(diag, { origin: gitOrigin, token: gitToken, runId: item.id })
        : cliGitTransport(diag),
      narrator: historyEmitter
        ? teeNarrator(consoleNarrator(), historyNarrator(historyEmitter))
        : consoleNarrator(),
      // The brief came with the spec (or the --context file); the staleness check's findings
      // are the one thing that goes back, through the orchestrator gateway like progress.
      memory: specMemoryStore(injectedCtx.brief),
      diag,
      injectedCtx: injectedCtx,
      tools,
      services,
      // Baked only where the root really is the image's: a run that fell back to a temp dir
      // clones, and is told it is on a machine nothing was prepared on.
      environment: environment === undefined
        ? undefined
        : { ...environment, baked: bakedRoot !== null },
      checkoutRoot,
      cancelSignal: cancelController.signal,
      inbox,
      patchReporter,
      artifacts,
      attachments,
      environmentStatus,
      checks,
      skills,
      onActions: (bound) => {
        actions = bound;
      },
      onChecksTold: (told) => {
        checksTold = told;
      },
      backgroundRecords,
      commandsUplink,
      // First among the disposers: a forced exit stops the agent's background commands before
      // anything they may be using is torn down.
      onBackground: (stopAll) => {
        disposers.unshift(stopAll);
      },
      subagents: makeSubagentHost(item.harness, modelSeesImages, diag),
      // ...and its subagents, whose tools may be using the same.
      onSubagents: (stopAll) => {
        disposers.unshift(stopAll);
      },
      ...(browser === undefined ? {} : { browser }),
    });
    log.info(`run ${item.id} finished`, { status: result.status });

    // Print the `Result` as JSON on stdout so whoever invoked this binary can parse it
    // (all logging goes to stderr, so stdout stays clean JSON).
    // This is the CLI caller's view of the result;
    // the real delivery channel for the orchestrator is via orchestrator.reportResult
    // which is already called inside run().
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await dispose();
  }
}

/** The baked checkout root, or null — warned — when this container has none to work in. */
async function bakedWorkRoot(diag: Diagnostics): Promise<string | null> {
  const root = process.env["RUNNER_WORK_ROOT"] || BAKED_WORK_ROOT;
  try {
    if ((await stat(root)).isDirectory()) return root;
    diag.warn("checkout.baked_root_missing", { dir: root });
  } catch (err) {
    diag.warn("checkout.baked_root_missing", { dir: root, err });
  }
  return null;
}

/** Reads, parses, and validates a JSON file. Any failure throws, the path named. */
async function loadJson<T>(path: string, schema: ZodType<T>): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${path}: ${errorMessage(error)}`);
  }
  return parseJson(text, path, schema);
}

/** Parses and validates JSON text. Any failure throws, `source` named. With `secret` the text is
 * credentials, so a syntax error is not quoted — the parser's message echoes its input. Schema
 * issues name paths and rules, never values, and are kept. */
function parseJson<T>(
  text: string,
  source: string,
  schema: ZodType<T>,
  { secret = false }: { secret?: boolean } = {},
): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: ${secret ? "not JSON" : errorMessage(error)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${source}: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

/** Converts a thrown input failure into bad usage: exit 2, the source already named. */
function failWith(error: unknown): never {
  fail(errorMessage(error));
}

/**
 * Reads a port from the environment. An unset var falls back to `fallback`; any set value must be
 * an integer in 0-65535 (0 lets the OS pick a free port), else it is bad config: exit 2, var named.
 * A silent fallback would bind the wrong port and quietly sever the control channel.
 */
function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`${name}: expected a port in 0-65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * Reads a millisecond duration from the environment. An unset var falls back to `fallback`; any
 * set value must be a positive integer, else it is bad config: exit 2, var named. A silent
 * fallback would beat at the wrong cadence and quietly skew the liveness gauge upstream.
 */
function readMillis(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const ms = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(ms) || ms <= 0) {
    fail(`${name}: expected a positive integer of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return ms;
}

function fail(message: string): never {
  console.error(`error: ${message}\n${USAGE}`);
  process.exit(2);
}

/**
 * The binary's whole life: `main`, then an explicit exit once it has reported and disposed. Left
 * to the event loop, the process would live as long as anything still holds it — a child that
 * ignored every signal, a pipe a stray process still holds — after the run is over and its
 * result out, and the run's pod with it. Everything that has to go out is out by then: the result
 * is reported inside run() and printed synchronously, and dispose() drains the history last. A
 * throw is left to the runtime, which ends the process on an uncaught error whatever is pending.
 */
export async function runToExit(args: string[]): Promise<never> {
  await main(args);
  process.exit(0);
}

/**
 * Exits 2 when @ryph/shared/env refuses this process's environment, after saying why on the run
 * when it safely can. An environment image's ENV reaches the runner, and the one an image
 * sets by accident is NODE_TLS_REJECT_UNAUTHORIZED=0 (built for a TLS-intercepting proxy): left
 * to the pod's log, every run of it would just die. With that the only refusal, the variable is
 * dropped first (Bun reads it per request, so fetch verifies again, measured on 1.4.2), then the
 * bootstrap is redeemed and the reason posted as the run's boot failure. Under any other the
 * process is already changed (a preload ran, a debugger listens, headers are logged), so it
 * redeems nothing and the reaper's startup grace concludes the run.
 */
export async function refuseHostileStart(): Promise<void> {
  const found = hostileVariables(process.env, { fromImage: true });
  if (found.length === 0) return;
  const why = found[0].message;
  const url = process.env[`${ENV_PREFIX}_ORCHESTRATOR_URL`];
  const runId = process.env[`${ENV_PREFIX}_RUN_ID`];
  const bootstrapToken = process.env[`${ENV_PREFIX}_BOOTSTRAP_TOKEN`];
  const tlsOnly = found.length === 1 && found[0].name === "NODE_TLS_REJECT_UNAUTHORIZED";
  if (tlsOnly && url && runId && bootstrapToken) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const diag = loggerDiagnostics("runner");
    try {
      const body = await exchangeBootstrap({ baseUrl: url, bootstrapToken, runId, diag });
      const { env } = parseJson(body, "the run bootstrap", RunBootstrapSchema, { secret: true });
      const runToken = env[`${ENV_PREFIX}_RUN_TOKEN`];
      await reportBootFailure({ baseUrl: url, runToken, runId, reason: why, diag });
    } catch (err) {
      diag.warn("runner.hostileStart.unreported", { err: errorMessage(err) });
    }
  }
  console.error(`ryph-runner: refusing to start: ${why}`);
  process.exit(2);
}

if (import.meta.main) {
  await refuseHostileStart();
  await runToExit(process.argv.slice(2));
}
