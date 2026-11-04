// A `SubagentHost` that runs each stretch of a subagent's work as a second pi in RPC mode, built
// from the run's own pi adapter's parts (adapters/harness/pi.ts): the same model, through the
// same proxy and key, so usage metering and the run's model limits cover it with nothing new.
//
// What differs from the run's own pi is what makes it a subagent:
// - its session persists, in a runner-owned dir (`--session-dir <tmp>/sessions --session-id
//   sa-<n>`), and it always starts at the checkout root, where pi looks the id up: a
//   continuation is a new process that picks up with everything the last one read and said
// - depth 1: its `mcp.json` holds the team's gateway servers and nothing else — no `ryph`
//   loopback (so no subagent tools), none of the platform's chat, forge or memory servers
//   (nothing that speaks for the run as a whole) and no browser (a run has one, and its state
//   is shared)
// - its built-ins are its mode's (`settings.json` `defaultTools`, never `--tools`, which is an
//   allowlist over the MCP tools too): `explore` reads, `work` has the run's own
// - its system prompt is the run's layout and machine blocks and a short framing: no identity,
//   chat or finish block
// - it is spawned DETACHED, the leader of a group of its own, so a stop reaches what it started;
//   and since pi's bash starts each command in a session of its own, a stop also kills the groups
//   of everything below it, read from the process table before pi is killed (process_tree.ts)
//
// Invariants:
// - a stretch is one process and is never left waiting for a prompt: `onSettled` is said once,
//   at the first settle with no prompt of ours unacknowledged (a settle read while one is, is
//   stale: pi starts a turn for it), and the core stops the process
// - a stop is abort first: pi then ends the running tool and records `Command aborted`, which
//   tells the model more on a continuation than a made-up `No result provided`; after a short
//   wait the whole tree is killed whatever happened, since an aborted pi is a settled pi
// - secrets ride the spawn env only (piSpawnEnv), never argv or a config file, as for the run

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextLineStream } from "@std/streams/text-line-stream";
import { type Child, command } from "@ryph/process";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type {
  SubagentContext,
  SubagentHost,
  SubagentStretch,
  SubagentStretchEnd,
  SubagentStretchEvents,
} from "../../ports/subagents.ts";
import type { SubagentMode } from "../../ports/run_actions.ts";
import { signalProcessGroup } from "../../core/background.ts";
import { errorMessage } from "../../helpers/errors.ts";
import { within } from "../../helpers/bounds.ts";
import { runtimeCredentials } from "../../helpers/runtime_credentials.ts";
import {
  assistantMessageOf,
  DEFAULT_TOOLS,
  drainClipped,
  IMAGES_EXTENSION_READY,
  mapEvent,
  MCP_EXTENSION_READY,
  PI_BIN,
  piArgs,
  piExtensions,
  piSpawnEnv,
  type PiSpec,
  PLATFORM_SERVER_SLUGS,
  withoutReadyLines,
  writePiConfigDir,
} from "../harness/pi.ts";
import { descendantGroups, groupExists } from "./process_tree.ts";

type JsonObject = Record<string, unknown>;

/** pi's read-only built-ins: what an `explore` subagent starts with. */
export const EXPLORE_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
/** How long an abort has to settle pi before its tree is killed. */
const ABORT_WAIT_MS = 5_000;
/** How long a settled pi, its stdin closed, has to exit on its own before its tree is killed. */
const EXIT_WAIT_MS = 2_000;
/** How often the process groups below pi are read while a tool runs: what a tool started is no
 * descendant of pi once the tool's own shell has exited, or pi has. */
const SCAN_EVERY_MS = 2_000;
const STDERR_MAX = 16_384;

/** What a subagent is told about being one, after the run's layout and machine blocks. */
export function subagentFraming(mode: SubagentMode): string {
  const tools = mode === "explore"
    ? "You can read the checkout but not change it: your tools are read, grep, find and ls, " +
      "and any the run's tool servers give you."
    : "You share the checkout with the agent that handed you your task, and with any other " +
      "subagents it started: they may be changing files while you work. Change only what your " +
      "task asks for, leave committing to that agent, and say in your answer what you changed.";
  return "## You are a subagent\n\n" +
    "Another agent handed you the task in your first message, and sees nothing of your work " +
    "but your last message: when you stop, your final message is your answer, handed back to " +
    "it, and nobody else reads you. Make that message complete in itself: what you found or " +
    "did, with the paths, names and lines that matter. Nothing waits for you between turns, " +
    "so never stop to wait for something. If you need something from that agent to go on, end " +
    "your turn on the question: the question is your answer, and its reply continues you. A " +
    "later message from it arrives framed as coming from it.\n\n" + tools;
}

export interface PiSubagentHostOptions {
  diag: Diagnostics;
  /** Overrides the executable, as for the run's own pi (adapters/harness/pi.ts). */
  command?: string[];
  mcpExtension?: string;
  /** As for the run's own pi; defaults to true. */
  modelSeesImages?: boolean;
  /** Where the sessions and configs live; default a fresh dir under the OS temp dir. */
  makeDir?: () => Promise<string>;
  /** Tests shrink these. */
  abortWaitMs?: number;
  exitWaitMs?: number;
}

export function piSubagentHost(spec: PiSpec, opts: PiSubagentHostOptions): SubagentHost {
  const [bin, ...binArgs] = opts.command ?? [PI_BIN];
  const extensions = piExtensions(opts.mcpExtension);
  const seesImages = opts.modelSeesImages ?? true;
  const abortWaitMs = opts.abortWaitMs ?? ABORT_WAIT_MS;
  const exitWaitMs = opts.exitWaitMs ?? EXIT_WAIT_MS;
  const diag = opts.diag;
  const makeDir = opts.makeDir ?? (() => mkdtemp(join(tmpdir(), "ryph-subagents-")));
  let root: Promise<string> | null = null;
  const sessionsDir = async () => {
    root ??= makeDir().then(async (dir) => {
      await mkdir(join(dir, "sessions"), { recursive: true });
      return dir;
    });
    try {
      return join(await root, "sessions");
    } catch (err) {
      root = null;
      throw err;
    }
  };
  const live = new Set<SubagentStretch>();

  return {
    async hasSession(id) {
      if (root === null) return false;
      try {
        // pi names a session file `<timestamp>_<id>.jsonl` (pi 1.0.0, measured).
        return (await readdir(await sessionsDir())).some((name) => name.endsWith(`_${id}.jsonl`));
      } catch {
        return false;
      }
    },

    async start(request, events) {
      const { context } = request;
      const servers = (context.tools?.servers ?? []).filter((s) =>
        !PLATFORM_SERVER_SLUGS.has(s.slug)
      );
      const gatewayToken = servers.length > 0
        ? runtimeCredentials.get(context.tools!.tokenEnv)
        : undefined;
      if (servers.length > 0 && !gatewayToken) {
        throw new Error(`the run has tool access but ${context.tools!.tokenEnv} is unset`);
      }
      const sessions = await sessionsDir();
      const tools = { servers, tokenEnv: context.tools?.tokenEnv ?? "" };
      const config = await writePiConfigDir(
        spec,
        {
          appendix: appendixOf(context, request.mode),
          defaultTools: request.mode === "explore" ? EXPLORE_TOOLS : DEFAULT_TOOLS,
          tools,
        },
        diag,
        `pi-${request.id}-`,
      );
      const args = [
        ...binArgs,
        ...piArgs(spec, {
          session: { dir: sessions, id: request.id },
          skillFiles: [],
          extensions,
          mcp: servers.length > 0,
          appendixPath: config.appendixPath,
        }),
      ];
      const env = piSpawnEnv(spec, {
        serviceHosts: context.serviceHosts,
        tools,
        configEnv: config.env,
        tokens: { gateway: gatewayToken },
        seesImages,
      });
      diag.debug("subagent.spawn", { id: request.id, bin, args });
      let proc: Child;
      try {
        proc = await command(bin, {
          args,
          cwd: context.checkoutDir,
          env,
          clearEnv: true,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          detached: true,
        }).spawn();
      } catch (err) {
        await rm(config.dir, { recursive: true }).catch(() => {});
        throw err;
      }
      const stretch = driveStretch(proc, request.id, request.prompt, events, {
        diag,
        abortWaitMs,
        exitWaitMs,
        mcp: servers.length > 0,
        extensions,
      });
      live.add(stretch);
      void stretch.ended.finally(async () => {
        live.delete(stretch);
        await rm(config.dir, { recursive: true }).catch(() => {});
      });
      return stretch;
    },

    async close() {
      await Promise.all([...live].map((stretch) => stretch.stop()));
      if (root === null) return;
      const dir = await root.catch(() => null);
      root = null;
      if (dir !== null) await rm(dir, { recursive: true }).catch(() => {});
    },
  };
}

/** The subagent's system-prompt appendix: the run's layout, its machine, and the framing. */
function appendixOf(context: SubagentContext, mode: SubagentMode): string {
  return [context.layout, context.machine, subagentFraming(mode)].filter(Boolean).join("\n\n");
}

/** One stretch's process, from its first prompt to its exit: the read loop, steers, the stop. */
function driveStretch(
  proc: Child,
  id: string,
  prompt: string,
  events: SubagentStretchEvents,
  opts: {
    diag: Diagnostics;
    abortWaitMs: number;
    exitWaitMs: number;
    /** Whether it was given the MCP extension, whose ready line then says its tools loaded. */
    mcp: boolean;
    extensions: { mcp: string; images: string };
  },
): SubagentStretch {
  const { diag } = opts;
  const stderr = drainClipped(proc.stderr, STDERR_MAX);
  const writer = proc.stdin.getWriter();
  const encoder = new TextEncoder();
  let writing: Promise<void> = Promise.resolve();
  /** One RPC command, in order after the ones before; a write to a pi that is gone is nothing. */
  const send = (msg: JsonObject) => {
    writing = writing.then(() => writer.write(encoder.encode(JSON.stringify(msg) + "\n")))
      .catch((err) => diag.debug("subagent.write_failed", { id, err: errorMessage(err) }));
    return writing;
  };

  let promptSeq = 0;
  /** Prompts of ours pi has not acknowledged yet: a settle read while one is, is stale. */
  const unacknowledged = new Set<string>();
  /** Prompts sent and not yet seen handed to the model, in order, and whether each is a steer. */
  const handing: Array<{ text: string; steer: boolean }> = [];
  const sendPrompt = (message: string, steer: boolean) => {
    const pid = `p-${promptSeq++}`;
    unacknowledged.add(pid);
    handing.push({ text: message, steer });
    void send({
      type: "prompt",
      id: pid,
      message,
      ...(steer ? { streamingBehavior: "steer" } : {}),
    });
  };

  let settled = false;
  let stopping: Promise<void> | null = null;
  let exited = false;
  let error: string | null = null;
  /** The last assistant text, and the last that was not empty: the answer. */
  let answer = "";
  /** The tools running now, by call id, in the order they started. */
  const running = new Map<string, string>();
  /** The process groups seen below pi while it ran: killed with it however it ends. */
  const groups = new Set<number>();
  /** Reads them while a tool runs; stopped once none does. */
  let scan: ReturnType<typeof setInterval> | undefined;
  let onSettle!: () => void;
  const settledOrExited = new Promise<void>((resolve) => (onSettle = resolve));

  /** Adds the groups below pi now, and forgets those no process is in any more: a group id
   * that has gone free may be taken by an unrelated process, which a kill must never reach. */
  const scanGroups = async () => {
    const below = new Set(await descendantGroups(proc.pid));
    for (const group of below) groups.add(group);
    for (const group of groups) if (!below.has(group) && !groupExists(group)) groups.delete(group);
  };

  const read = (async () => {
    const lines = proc.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(
      new TextLineStream(),
    );
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: JsonObject;
      try {
        event = JSON.parse(line);
      } catch {
        error = `pi emitted a non-JSON line: ${line.slice(0, 300)}`;
        void stop();
        continue;
      }
      if (event.type === "response") {
        if (typeof event.id === "string") unacknowledged.delete(event.id);
        if (event.success !== true) {
          const why = typeof event.error === "string" ? event.error : "unknown error";
          diag.warn("subagent.command_rejected", { id, command: event.command, why });
          // A refused opening prompt leaves a pi with nothing to do: it is a failure.
          if (event.id === "p-0") {
            error = `pi refused the task: ${why}`;
            void stop();
          }
        }
        continue;
      }
      const message = event.message as JsonObject | undefined;
      if (event.type === "message_end" && message?.role === "user") {
        // A prompt of ours reached the model: a steer's hand-over is the core's to record.
        const text = userText(message);
        const at = handing.findIndex((h) => h.text === text);
        if (at !== -1) {
          const [handed] = handing.splice(at, 1);
          if (handed.steer) events.onSteerDelivered(handed.text);
        }
        continue;
      }
      if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
        running.set(event.toolCallId, String(event.toolName ?? "a tool"));
        scan ??= setInterval(() => void scanGroups(), SCAN_EVERY_MS);
      }
      if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
        running.delete(event.toolCallId);
        if (running.size === 0 && scan !== undefined) {
          clearInterval(scan);
          scan = undefined;
        }
      }
      const said = assistantMessageOf(event);
      if (said !== null && said.text.trim() !== "") answer = said.text;
      if (event.type === "agent_settled") {
        if (settled || unacknowledged.size > 0) continue;
        settled = true;
        onSettle();
        try {
          events.onSettled();
        } catch (err) {
          diag.warn("subagent.on_settled_failed", { id, err });
        }
        continue;
      }
      for (const chunk of mapEvent(event)) {
        try {
          events.onTranscript(chunk);
        } catch (err) {
          diag.warn("subagent.narrate_failed", { id, err });
        }
      }
    }
  })().catch((err) => {
    error ??= `pi's output could not be read: ${errorMessage(err)}`;
  });

  /** Kills pi's group and every group seen below it that still exists, checked at the kill. pi's
   * own too: once pi is reaped and its group empty, its id may be another process's. */
  const killTree = async () => {
    for (const group of [proc.pid, ...groups]) {
      if (!groupExists(group)) continue;
      const failed = await signalProcessGroup(group, "SIGKILL");
      if (failed !== null) diag.warn("subagent.kill_failed", { id, ...failed });
    }
  };

  const ended: Promise<SubagentStretchEnd> = (async () => {
    const status = await proc.status;
    exited = true;
    onSettle();
    if (scan !== undefined) clearInterval(scan);
    scan = undefined;
    // However it ended, nothing it started outlives it.
    if (stopping === null) {
      await killTree();
      if (!settled) {
        const err = withoutReadyLines(await stderr.catch(() => "")).trim().slice(0, 500);
        error ??= `pi exited (code ${status.code}) before answering${err ? `: ${err}` : ""}`;
      }
    } else await stopping;
    await read;
    const tail = (await stderr.catch(() => "")).trim();
    if (tail) diag.debug("subagent.stderr", { id, text: tail.slice(0, 2_000) });
    // As for the run's own pi: one that worked a turn and never said its extensions were ready
    // ran without them — its tools, or the bound on what each request carries.
    if (settled && opts.mcp && !tail.includes(MCP_EXTENSION_READY)) {
      diag.warn("subagent.mcp_extension.silent", { id, extension: opts.extensions.mcp });
    }
    if (settled && !tail.includes(IMAGES_EXTENSION_READY)) {
      diag.warn("subagent.images_extension.silent", { id, extension: opts.extensions.images });
    }
    return { answer, settled, error: settled ? null : error };
  })();

  function stop(): Promise<void> {
    stopping ??= (async () => {
      if (!settled && !exited) {
        void send({ type: "abort", id: "abort" });
        await within(settledOrExited, opts.abortWaitMs);
      }
      // Settled, or as settled as it will get. What is below it is read while it is still their
      // ancestor; then it may exit, and its whole tree goes.
      await scanGroups().catch(() => {});
      await within(writing, opts.exitWaitMs);
      void writer.close().catch(() => {});
      await within(proc.status, opts.exitWaitMs);
      await killTree();
      await proc.status;
    })().catch((err) => diag.warn("subagent.stop_failed", { id, err }));
    return stopping;
  }

  sendPrompt(prompt, false);

  return {
    steer(text) {
      if (settled || stopping !== null || exited) return false;
      sendPrompt(text, true);
      return true;
    },
    runningTool() {
      return [...running.values()].at(-1) ?? null;
    },
    stop,
    ended,
  };
}

/** A user message's text, as pi records a prompt. */
function userText(message: JsonObject): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as JsonObject[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}
