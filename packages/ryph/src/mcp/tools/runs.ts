// Watching a run: its transcript (and each subagent's), its background commands, its previews,
// what it did beyond the transcript, and a bounded wait for it to move. Every tool here finds the
// run by its task (task_detail.ts), which is also where the run's read grants come from.
//
// Invariants:
// - every read is bounded: a page of history, a log's tail, a few seconds of a live stream, a
//   wait of at most WAIT_MAX_S; a tool that cut something says how to get the rest
// - a section that could not be read (a service this deployment does not run, a capability the
//   token lacks) is named as unavailable, and the rest of the answer still comes back

import { ApiError, type RyphClient, UsageError } from "../../api/client.ts";
import { type Args, needString, optBool, optEnum, optInt, optString, seg } from "../args.ts";
import { fence } from "@ryph/shared/markdown";
import { ago, clip, cut, duration, lastLines, lines } from "../format.ts";
import { bool, int, object, oneOf, READ, str, type Tool, WRITE } from "../tool.ts";
import { eventInFull, type HistoryEvent, summarize } from "../transcript.ts";
import {
  type ResolvedRun,
  resolveRun,
  RUN_ARGS,
  runState,
  type RunView,
  TERMINAL_STATES,
  withGrant,
} from "./task_detail.ts";

/** "The newest page": a cursor past any seq (the historian clamps it). */
const PAST_THE_END = Number.MAX_SAFE_INTEGER;
const WAIT_MAX_S = 300;
const LIVE_READ_MS = 5_000;

interface HistoryPage {
  events: HistoryEvent[];
  firstSeq: number;
  lastSeq: number;
  hasMore: boolean;
}

function readHistory(
  api: RyphClient,
  run: RunView,
  query: { lane?: string; before?: number; after?: number; limit: number },
  signal?: AbortSignal,
): Promise<HistoryPage> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.before !== undefined) params.set("before", String(query.before));
  else params.set("after", String(query.after ?? -1));
  if (query.lane) params.set("lane", query.lane);
  return api.json<HistoryPage>(
    "GET",
    withGrant(`/v1/runs/${seg(run.id)}/events?${params}`, run.grants?.history),
    undefined,
    signal,
  );
}

/** A section's text, or a line saying why it is missing. */
async function section(name: string, read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof ApiError) return `${name}: unavailable (${err.message})`;
    throw err;
  }
}

const runTranscript: Tool = {
  name: "run_transcript",
  description: "Read a run's transcript, one line per step: assistant messages, tool calls " +
    "folded with their results, inbound messages, subagent starts and ends. Newest page by " +
    "default; page with before/after. Lines start with #seq; pass seq to read one event in " +
    "full. lane reads a subagent's transcript (see run_subagents).",
  inputSchema: object({
    ...RUN_ARGS,
    lane: str("A subagent's lane (sa-1, …); default the run's own (\"\")."),
    before: int("Events older than this seq."),
    after: int("Events newer than this seq."),
    limit: int("Events per page, default 150.", 1, 1000),
    seq: int("Read this one event in full (a tool call with its whole arguments and result)."),
    thinking: bool("Include the model's thinking."),
    diag: bool("Include the runner's diagnostic events (warnings always show)."),
    full: bool("Longer excerpts per line."),
  }, ["taskId"]),
  annotations: READ,
  needs: ["tasks:read"],
  routes: [["GET", "/v1/tasks/{taskId}"], ["GET", "/v1/runs/{runId}/events"]],
  run: async (args, ctx) => {
    const lane = optString(args, "lane") ?? "";
    const seq = optInt(args, "seq", 0, Number.MAX_SAFE_INTEGER);
    const before = optInt(args, "before", 0, Number.MAX_SAFE_INTEGER);
    const after = optInt(args, "after", -1, Number.MAX_SAFE_INTEGER);
    if (before !== undefined && after !== undefined) {
      throw new UsageError("before and after: one or the other");
    }
    const { api, run } = await resolveRun(args, ctx);
    if (seq !== undefined) {
      const page = await readHistory(api, run, { lane, after: seq - 1, limit: 200 });
      const event = page.events.find((e) => e.seq === seq);
      if (event === undefined) return `No event #${seq} in lane "${lane}" of run ${run.id}.`;
      return eventInFull(event, page.events);
    }
    const limit = optInt(args, "limit", 1, 1000) ?? 150;
    const backwards = after === undefined;
    const page = await readHistory(api, run, {
      lane,
      limit,
      ...(backwards ? { before: before ?? PAST_THE_END } : { after }),
    });
    const full = optBool(args, "full") === true;
    const { lines: body, hidden } = summarize(page.events, {
      thinking: optBool(args, "thinking"),
      diag: optBool(args, "diag"),
      textChars: full ? 6000 : 1200,
      resultChars: full ? 2000 : 300,
    });
    const first = page.events[0]?.seq;
    const last = page.events.at(-1)?.seq;
    const older = backwards ? page.hasMore : (first ?? 0) > 0;
    const newer = backwards ? before !== undefined : page.hasMore;
    const hiddenNote = [
      hidden.thinking > 0 && `${hidden.thinking} thinking`,
      hidden.diag > 0 && `${hidden.diag} diag`,
    ].filter(Boolean).join(", ");
    return lines(
      `Run ${run.id}${lane ? `, subagent ${lane}` : ""}: ${runState(run)}.`,
      page.events.length === 0
        ? "No events in this range."
        : `Events #${first}–#${last}${hiddenNote ? ` (${hiddenNote} hidden)` : ""}:`,
      body,
      older && first !== undefined && `Older: run_transcript {before: ${first}}`,
      newer && last !== undefined && `Newer: run_transcript {after: ${last}}`,
    );
  },
};

interface Lane {
  lane: string;
  start: HistoryEvent;
  resume: HistoryEvent | null;
  end: HistoryEvent | null;
  ranMs: number;
}

const runSubagents: Tool = {
  name: "run_subagents",
  description: "List a run's subagents (in-run helper agents, each with its own transcript " +
    "lane): label, mode, whether it is still working, how long it ran. Read one with " +
    "run_transcript {lane}.",
  inputSchema: object(RUN_ARGS, ["taskId"]),
  annotations: READ,
  needs: ["tasks:read"],
  routes: [["GET", "/v1/tasks/{taskId}"], ["GET", "/v1/runs/{runId}/lanes"]],
  run: async (args, ctx) => {
    const { api, run } = await resolveRun(args, ctx);
    const { lanes } = await api.json<{ lanes: Lane[] }>(
      "GET",
      withGrant(`/v1/runs/${seg(run.id)}/lanes`, run.grants?.history),
    );
    if (lanes.length === 0) return `Run ${run.id} started no subagents.`;
    return lines(
      `Run ${run.id}'s subagents:`,
      lanes.map((l) => {
        const p = (l.start.payload ?? {}) as Record<string, unknown>;
        const ended = l.end !== null &&
          (l.resume === null || l.end.seq > l.resume.seq);
        const endP = (l.end?.payload ?? {}) as Record<string, unknown>;
        const status = ended ? `ended (${String(endP.reason ?? "?")})` : "working";
        return `- ${l.lane} "${clip(String(p.label ?? l.start.text ?? ""), 80)}"${
          p.mode ? ` (${String(p.mode)})` : ""
        } · ${status}${
          // A working subagent's ranMs is not counted yet; "started … ago" says how long.
          ended ? ` · ran ${duration(l.ranMs)}` : ""} · started ${ago(l.start.at)}${
          typeof p.task === "string" ? ` · task: ${clip(p.task, 200)}` : ""
        }`;
      }),
      `Read one: run_transcript {taskId, lane: "${lanes[0].lane}"}`,
    );
  },
};

interface Job {
  id: string;
  label: string;
  command: string;
  cwd: string;
  service: boolean;
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
  exitCode: number | null;
  signal: string | null;
  logBytes: number;
  logTail: string | null;
  hasLog: boolean;
}

interface LiveJob {
  id: string;
  status: "running" | "ended";
  tail: string;
}

type SseFrame = { event: string | undefined; data: string };

/**
 * Reads server-sent-event frames off a stream chunk by chunk. Lines may end in \r\n, \r or \n,
 * so each chunk is folded to \n as it arrives; a \r at a chunk's very end is held back, since the
 * \n of the same line ending may be the next chunk's first character. Only the new text is
 * scanned for a frame's end, so a long frame costs its length once, not once per chunk.
 */
export class FrameReader {
  /** Folded text after the last whole frame. */
  #pending = "";
  /** Where in `#pending` a frame's end may still begin: everything before it was scanned. */
  #scanned = 0;
  #held = "";

  /** What is buffered and not yet a whole frame, in characters. */
  get size(): number {
    return this.#pending.length + this.#held.length;
  }

  /** What is buffered and not yet a whole frame. */
  get rest(): string {
    return this.#pending + this.#held;
  }

  /** The frames `chunk` completes. */
  push(chunk: string): SseFrame[] {
    let text = this.#held + chunk;
    this.#held = text.endsWith("\r") ? "\r" : "";
    text = text.slice(0, text.length - this.#held.length).replace(/\r\n?/g, "\n");
    this.#pending += text;
    const frames: SseFrame[] = [];
    // A "\n\n" may straddle the old text and the new: start one character back.
    let from = Math.max(0, this.#scanned - 1);
    let start = 0;
    let end: number;
    while ((end = this.#pending.indexOf("\n\n", from)) >= 0) {
      frames.push(parseFrame(this.#pending.slice(start, end)));
      start = from = end + 2;
    }
    if (start > 0) this.#pending = this.#pending.slice(start);
    this.#scanned = this.#pending.length;
    return frames;
  }
}

function parseFrame(frame: string): SseFrame {
  return {
    event: /^event: ?(.*)$/m.exec(frame)?.[1],
    data: frame.split("\n").filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(l.startsWith("data: ") ? 6 : 5)).join("\n"),
  };
}

/** The whole server-sent-event frames at the front of `buffer`, and what is left of it. */
export function takeFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const reader = new FrameReader();
  const frames = reader.push(buffer);
  return { frames, rest: reader.rest };
}

/** The most of a stream read for its snapshot: past it, the stream is not one worth waiting on. */
export const LIVE_SNAPSHOT_MAX_CHARS = 1024 * 1024;

/**
 * The live room's snapshot of the run's background commands: the first `snapshot` frame of the
 * stream, then the stream is hung up. Null when none came in time (no uplink, an older app), when
 * more than `LIVE_SNAPSHOT_MAX_CHARS` came without one, or when it is not readable JSON.
 */
async function liveSnapshot(api: RyphClient, run: RunView): Promise<LiveJob[] | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LIVE_READ_MS);
  try {
    const res = await api.send(
      "GET",
      withGrant(`/v1/runs/${seg(run.id)}/live/commands/stream`, run.grants?.history),
      undefined,
      abort.signal,
    );
    if (!res.ok || res.body === null) {
      await res.body?.cancel();
      return null;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    const frames = new FrameReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        for (const { event, data } of frames.push(value)) {
          if (event === "snapshot") return snapshotJobs(data);
          if (event === "done") return null;
        }
        if (frames.size > LIVE_SNAPSHOT_MAX_CHARS) return null;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (err) {
    if (abort.signal.aborted) return null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A snapshot frame's jobs, or null for one that is not the JSON it should be. */
function snapshotJobs(data: string): LiveJob[] | null {
  try {
    const jobs = (JSON.parse(data) as { jobs?: unknown } | null)?.jobs;
    return Array.isArray(jobs) ? jobs as LiveJob[] : null;
  } catch {
    return null;
  }
}

function jobLine(j: Job): string {
  const status = j.endedAt === null
    ? "running"
    : `${j.reason ?? "ended"}${j.exitCode !== null ? ` (exit ${j.exitCode})` : ""}${
      j.signal ? ` (${j.signal})` : ""
    }`;
  return `- ${j.id} "${clip(j.label, 60)}"${j.service ? " [service]" : ""} · ${status} · started ${
    ago(j.startedAt)
  } · $ ${clip(j.command, 160)}`;
}

const runBackground: Tool = {
  name: "run_background",
  description: "List a run's background commands (long-running shells and services its agent " +
    "started), or with jobId read one's output: the stored log once it ended, its live output " +
    "while it runs.",
  inputSchema: object({
    ...RUN_ARGS,
    jobId: str("A command's id (bg-1, …) to read its output."),
    tailLines: int("How many of the output's last lines, default 120.", 1, 5000),
  }, ["taskId"]),
  annotations: READ,
  needs: ["tasks:read"],
  routes: [["GET", "/v1/tasks/{taskId}"], ["GET", "/v1/runs/{runId}/background"], [
    "GET",
    "/v1/runs/{runId}/background/{jobId}/log",
  ], ["GET", "/v1/runs/{runId}/live/commands/stream"]],
  run: async (args, ctx) => {
    const { api, run } = await resolveRun(args, ctx);
    const { jobs } = await api.json<{ jobs: Job[] }>(
      "GET",
      `/v1/runs/${seg(run.id)}/background`,
    );
    const jobId = optString(args, "jobId");
    if (jobId === undefined) {
      if (jobs.length === 0) return `Run ${run.id} started no background commands.`;
      return lines(
        `Run ${run.id}'s background commands:`,
        jobs.map(jobLine),
        `Output: run_background {taskId, jobId: "${jobs[0].id}"}`,
      );
    }
    const job = jobs.find((j) => j.id === jobId);
    if (job === undefined) return `Run ${run.id} has no background command ${jobId}.`;
    const n = optInt(args, "tailLines", 1, 5000) ?? 120;
    let output: string | null = null;
    let source = "";
    if (job.endedAt !== null && job.hasLog) {
      output = await api.text(`/v1/runs/${seg(run.id)}/background/${seg(job.id)}/log`);
      source = "stored log";
    }
    if (output === null && job.endedAt === null) {
      const live = await liveSnapshot(api, run).catch(() => null);
      const mine = live?.find((j) => j.id === job.id);
      if (mine) {
        output = mine.tail;
        source = "live output the room still holds";
      }
    }
    if (output === null && job.logTail) {
      output = job.logTail;
      source = "the end of its output, from its exit record";
    }
    if (output === null) return lines(jobLine(job), "No output to show yet.");
    const { text, dropped } = lastLines(output, n);
    return lines(
      jobLine(job),
      `Output (${source}${dropped > 0 ? `, last ${n} lines; ${dropped} earlier not shown` : ""}):`,
      fence(cut(text, 60_000)),
    );
  },
};

const runPreviews: Tool = {
  name: "run_previews",
  description: "List a live run's previews (dev servers its agent exposed). " +
    "run_preview_open mints a link a person can open one at.",
  inputSchema: object(RUN_ARGS, ["taskId"]),
  annotations: READ,
  needs: ["tasks:read"],
  routes: [["GET", "/v1/tasks/{taskId}"], ["GET", "/v1/runs/{runId}/previews"]],
  run: async (args, ctx) => {
    const { api, run } = await resolveRun(args, ctx);
    const { previews } = await api.json<
      { previews: Array<{ id: string; port: number; label: string; url: string }> }
    >("GET", withGrant(`/v1/runs/${seg(run.id)}/previews`, run.grants?.history));
    if (previews.length === 0) {
      return TERMINAL_STATES.has(run.state)
        ? `Run ${run.id} has ended; its previews went with it.`
        : `Run ${run.id} exposes no previews.`;
    }
    return lines(
      previews.map((p) => `- ${p.id} "${p.label}" · port ${p.port} · ${p.url}`),
      `A link to open one: run_preview_open {taskId, previewId: "${previews[0].id}"}`,
    );
  },
};

// Not a read: opening mints a viewer ticket into the run's live dev server (hosted), so
// `--read-only` leaves it out.
const runPreviewOpen: Tool = {
  name: "run_preview_open",
  description: "Mint a link a person can open one of a live run's previews at (run_previews " +
    "lists them). The link is a one-time way in.",
  inputSchema: object({
    ...RUN_ARGS,
    previewId: str("The preview to open."),
    path: str("The page to land on, e.g. /login."),
  }, ["taskId", "previewId"]),
  annotations: WRITE,
  needs: ["tasks:read"],
  routes: [["GET", "/v1/tasks/{taskId}"], [
    "POST",
    "/v1/runs/{runId}/previews/{previewId}/open",
  ]],
  run: async (args, ctx) => {
    const { api, run } = await resolveRun(args, ctx);
    const previewId = needString(args, "previewId");
    const path = optString(args, "path");
    // The run's history grant is what the local binary's preview routes take in place of
    // tasks:read-all (packages/host/src/previews.ts `authenticateReader`).
    const answer = await api.json<{ url: string }>(
      "POST",
      withGrant(
        `/v1/runs/${seg(run.id)}/previews/${seg(previewId)}/open${
          path ? `?${new URLSearchParams({ path })}` : ""
        }`,
        run.grants?.history,
      ),
    );
    return `Open ${previewId} at: ${answer.url}`;
  },
};

interface UsageRecord {
  serverId: string;
  method: string;
  tool: string | null;
  status: string;
  durationMs: number;
  at: string;
}

/** The memory server's tools a run calls, and what each means for the activity list. */
const MEMORY_WRITES = new Set(["propose", "confirm", "refute"]);

async function memoryCalls(api: RyphClient, run: RunView, scan: number): Promise<string> {
  const out: string[] = [];
  let before = PAST_THE_END;
  let read = 0;
  let more = true;
  const pages: HistoryEvent[][] = [];
  while (more && read < scan) {
    const page = await readHistory(api, run, { before, limit: Math.min(1000, scan - read) });
    if (page.events.length === 0) break;
    pages.unshift(page.events);
    read += page.events.length;
    before = page.events[0].seq;
    more = page.hasMore;
  }
  const events = pages.flat();
  const results = new Map<string, HistoryEvent>();
  for (const e of events) {
    const p = e.payload as { toolCallId?: string } | null;
    if (e.kind === "tool_result" && p?.toolCallId) results.set(p.toolCallId, e);
  }
  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    const p = e.payload as { toolCallId?: string; toolName?: string; args?: unknown } | null;
    const m = /^memory__(.+)$/.exec(p?.toolName ?? "");
    if (!m) continue;
    const r = p?.toolCallId ? results.get(p.toolCallId) : undefined;
    const failed = (r?.payload as { isError?: boolean } | null)?.isError === true;
    const kind = MEMORY_WRITES.has(m[1]) ? "wrote" : "read";
    out.push(
      `  - #${e.seq} ${kind} memory__${m[1]}${failed ? " (refused)" : ""}: ${
        clip(JSON.stringify(p?.args ?? {}), 200)
      }`,
    );
  }
  if (out.length === 0) {
    return more
      ? `Memory calls: none found in the newest ${read} events; pass scanEvents for more.`
      : "Memory calls: none.";
  }
  if (more) out.push(`  (only the newest ${read} events were scanned; pass scanEvents for more)`);
  return ["Memory calls:", ...out].join("\n");
}

const runActivity: Tool = {
  name: "run_activity",
  description: "What a run did beyond its transcript, as its page's Actions and Usage tabs " +
    "show: lifecycle trail, forge writes (comments, issues, reviews), patches, check suites, " +
    "artifacts, environment builds, memories it was briefed with and read or wrote, MCP tool " +
    "calls through the gateway, and model usage.",
  inputSchema: object({
    ...RUN_ARGS,
    scanEvents: int(
      "How many of the newest events to scan for memory calls, default 2000.",
      0,
      20000,
    ),
  }, ["taskId"]),
  annotations: READ,
  needs: ["tasks:read"],
  routes: [["GET", "/v1/tasks/{taskId}"], ["GET", "/v1/runs/{runId}/events"], [
    "GET",
    "/v1/mcp-usage/{runId}",
  ], ["GET", "/v1/model-usage/runs/{runId}"]],
  run: async (args, ctx) => {
    const { api, detail, run } = await resolveRun(args, ctx);
    const out: string[] = [`Run ${run.id} of task ${detail.task.id}: ${runState(run)}.`];

    const trail = run.events ?? [];
    if (trail.length > 0) {
      out.push("Lifecycle:");
      for (const e of trail.slice(-15)) {
        out.push(`  - ${e.at} ${e.kind}${e.detail ? `: ${clip(e.detail, 160)}` : ""}`);
      }
    }

    const forge = run.forgeActions ?? [];
    out.push(forge.length === 0 ? "Forge writes: none." : "Forge writes:");
    for (const a of forge) {
      out.push(
        `  - ${a.tool} on ${a.repoRef}${a.threadRef ? `#${a.threadRef}` : ""} · ${a.state}${
          a.url ? ` · ${a.url}` : ""
        }${a.detail ? ` · ${clip(a.detail, 120)}` : ""}`,
      );
    }

    const patches = detail.patches.filter((p) => p.runId === run.id);
    out.push(patches.length === 0 ? "Patches: none." : "Patches:");
    for (const p of patches) {
      out.push(`  - ${p.id} ${p.state} · ${p.branchName}${p.forgeUrl ? ` · ${p.forgeUrl}` : ""}`);
    }
    const suites = (detail.checkSuites ?? []).filter((s) =>
      s.requestedBy.some((r) => r.runId === run.id)
    );
    for (const s of suites) out.push(`Check suite ${s.id}: ${s.state} @${s.commit.slice(0, 12)}`);
    for (const a of detail.artifacts ?? []) {
      const mine = a.versions.filter((v) => v.runId === run.id).map((v) => `v${v.version}`);
      if (mine.length > 0) out.push(`Artifact ${a.id} "${clip(a.title, 80)}": ${mine.join(", ")}`);
    }
    for (const b of (detail.environmentBuilds ?? []).filter((b) => b.runId === run.id)) {
      out.push(`Environment build for ${b.patchId}: ${b.note ?? "built"}`);
    }

    const brief = run.injectedContext?.brief;
    out.push(
      brief && brief.memoryIds.length > 0
        ? `Memory brief: ${brief.memoryIds.length} memories (${brief.memoryIds.join(", ")})`
        : "Memory brief: none.",
    );
    const scan = optInt(args, "scanEvents", 0, 20000) ?? 2000;
    if (scan > 0) {
      out.push(
        await section("Memory calls", () => memoryCalls(api, run, scan)),
      );
    }

    out.push(
      await section("MCP tool calls", async () => {
        const { usage, hasMore } = await api.json<{ usage: UsageRecord[]; hasMore: boolean }>(
          "GET",
          withGrant(`/v1/mcp-usage/${seg(run.id)}?limit=500`, run.grants?.tools),
        );
        const counts = new Map<string, { n: number; failed: number }>();
        for (const u of usage) {
          if (u.method !== "tools/call") continue;
          const key = `${u.serverId}:${u.tool ?? "?"}`;
          const c = counts.get(key) ?? { n: 0, failed: 0 };
          c.n++;
          if (u.status !== "ok") c.failed++;
          counts.set(key, c);
        }
        // Handshakes and listings are not calls.
        if (counts.size === 0) return "MCP tool calls: none.";
        return [
          `MCP tool calls${hasMore ? " (the newest 500)" : ""}:`,
          ...[...counts].map(([k, c]) =>
            `  - ${k} ×${c.n}${c.failed ? ` (${c.failed} not ok)` : ""}`
          ),
        ].join("\n");
      }),
    );

    out.push(
      await section("Model usage", async () => {
        const u = await api.json<{
          totals: {
            requests: number;
            tokens: { input: number; output: number; cacheRead: number };
            cost: { total: number };
          };
          byModel: Array<{ model: string | null; requests: number }>;
          pricing: { currency: string };
        }>("GET", withGrant(`/v1/model-usage/runs/${seg(run.id)}`, run.grants?.models));
        const t = u.totals;
        return `Model usage: ${t.requests} requests · ${t.tokens.input} in / ${t.tokens.output} out` +
          ` / ${t.tokens.cacheRead} cache-read tokens · ~${
            t.cost.total.toFixed(2)
          } ${u.pricing.currency}` +
          ` · ${u.byModel.map((m) => `${m.model ?? "?"} ×${m.requests}`).join(", ")}`;
      }),
    );
    return out.join("\n");
  },
};

const WAIT_UNTIL = ["settled", "idle", "change"] as const;
/** How many lines of news a wait shows: the newest, since what a long run did first is history. */
const WAIT_NEWS_LINES = 20;

/** The events after `seq`: all of them when they fit a page, else the newest page's. */
async function newsSince(
  api: RyphClient,
  run: RunView,
  seq: number,
  signal: AbortSignal,
): Promise<{ events: HistoryEvent[]; earlier: boolean }> {
  const page = await readHistory(api, run, { after: seq, limit: 150 }, signal);
  if (!page.hasMore) return { events: page.events, earlier: false };
  const newest = await readHistory(api, run, { before: PAST_THE_END, limit: 150 }, signal);
  return { events: newest.events.filter((e) => e.seq > seq), earlier: true };
}

/** Whether the run reached what the caller waits for. */
function reached(until: (typeof WAIT_UNTIL)[number], run: RunView): boolean {
  if (TERMINAL_STATES.has(run.state)) return true;
  if (until === "idle") return run.idleState === "idle" || run.idleState === "waiting-for-user";
  return false;
}

/** A pause the deadline cuts short, rejecting with its reason. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const runWait: Tool = {
  name: "run_wait",
  description: "Wait, at most timeoutSeconds, for a task's run to move: until it settles " +
    "(ends), until it is idle or waiting for a person, or until anything changes (a new " +
    "transcript event or a state change). Returns where it stands and what is new.",
  inputSchema: object({
    ...RUN_ARGS,
    until: oneOf(WAIT_UNTIL, "settled (default), idle or change."),
    timeoutSeconds: int("Default 60.", 1, WAIT_MAX_S),
  }, ["taskId"]),
  annotations: READ,
  needs: ["tasks:read"],
  routes: [["GET", "/v1/tasks/{taskId}"], ["GET", "/v1/runs/{runId}/events"]],
  run: async (args, ctx) => {
    const until = optEnum(args, "until", WAIT_UNTIL) ?? "settled";
    const seconds = optInt(args, "timeoutSeconds", 1, WAIT_MAX_S) ?? 60;
    // A hard limit: every read in the wait ends with it, so a server that stops answering
    // cannot hold the call past it.
    const deadline = AbortSignal.any([AbortSignal.timeout(seconds * 1000), ctx.signal]);
    let resolved: ResolvedRun;
    try {
      resolved = await resolveRun(args, ctx, deadline);
    } catch (err) {
      if (!deadline.aborted) throw err;
      throw new ApiError(0, `the deployment did not answer within ${seconds}s`);
    }
    let { api, run } = resolved;
    const pinned: Args = { ...args, runId: run.id };
    const lastSeq = async (r: RunView) =>
      (await readHistory(api, r, { before: PAST_THE_END, limit: 1 }, deadline)).events.at(-1)
        ?.seq ?? -1;
    // The newest event when the wait began. A read that failed leaves it unknown, and it is read
    // again on the next poll: measured against a guess, the first good read would look like news.
    const baseline = () => lastSeq(run).catch(() => null);
    let startSeq = await baseline();
    const startState = runState(run);
    const stillGoing = () =>
      lines(
        `Still ${runState(run)} after ${seconds}s (run ${run.id}).`,
        "Wait again, or read run_transcript for what it is doing.",
      );
    let polls = 0;
    try {
      for (;;) {
        if (reached(until, run)) break;
        if (until === "change") {
          if (runState(run) !== startState) break;
          if (startSeq === null) startSeq = await baseline();
          else if ((await lastSeq(run).catch(() => -1)) > startSeq) break;
        }
        if (deadline.aborted) return stillGoing();
        await sleep(ctx.intervalMs, deadline);
        ({ api, run } = await resolveRun(pinned, ctx, deadline));
        ctx.progress(`${runState(run)} (poll ${++polls})`);
      }
    } catch (err) {
      if (!deadline.aborted) throw err;
      return stillGoing();
    }
    const tail = startSeq !== null
      ? await newsSince(api, run, startSeq, deadline).catch(() => null)
      : null;
    const result = run.result;
    const news = tail ? summarize(tail.events) : null;
    const hiddenOnly = news !== null && tail!.events.length > 0 && news.lines.length === 0;
    const shown = news?.lines.slice(-WAIT_NEWS_LINES);
    const earlier = tail !== null && (tail.earlier || shown!.length < news!.lines.length);
    return lines(
      `Run ${run.id}: ${runState(run)}.`,
      result && `Result: ${result.status}${result.summary ? `: ${cut(result.summary, 1500)}` : ""}`,
      news !== null && news.lines.length > 0 &&
        (earlier ? "New since the wait began, the latest:" : "New since the wait began:"),
      shown,
      hiddenOnly &&
        `Only hidden events arrived since the wait began (${news.hidden.thinking} thinking, ` +
          `${news.hidden.diag} diag): run_transcript {after: ${startSeq}, thinking: true, ` +
          "diag: true} shows them.",
      earlier && `Earlier: run_transcript {after: ${startSeq}}`,
    );
  },
};

export const runTools: Tool[] = [
  runTranscript,
  runSubagents,
  runBackground,
  runPreviews,
  runPreviewOpen,
  runActivity,
  runWait,
];
