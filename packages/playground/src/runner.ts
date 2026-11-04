/**
 * A runner with no agent behind it: it does what packages/runner does on the wire — bootstrap,
 * spec, credentials, heartbeats, transcript batches to the historian, model calls through the
 * proxy, a git clone through the forge's gateway, a bundle upload for a patch, a result — but the
 * transcript is a script. Every event has the shape the real pi adapter emits
 * (packages/runner/src/adapters/harness/pi.ts, mapEvent), so the app renders it as it would a
 * real run's.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { command } from "@ryph/process";
import { join } from "@std/path";

/** One beat of a script. Paths are relative to the repo the step names (the first by default). */
export type Step =
  | { think: string }
  | { say: string }
  | { bash: string; out: string; exit?: number; repo?: string }
  | { read: string; repo?: string }
  | { edit: string; find: string; replace: string; repo?: string }
  | { write: string; content: string; repo?: string }
  | { tool: string; args: Record<string, unknown>; result: string; error?: boolean }
  | { background: BackgroundJob }
  | { submit: { title: string; description?: string; repo?: string } }
  /** A person sends the run a message here; the runner receives it through its inbox. */
  | { user: string; from?: "owner" | "member" }
  /** A person cancels the task here; the runner notices on its next heartbeat. */
  | { cancel: true }
  /** The agent starts a subagent, which plays `steps` in its own lane straight away. */
  | { subagent: SubagentScript }
  /** A subagent (by label) answers, and the agent is handed the notice of its end. */
  | { ends: string }
  /** The agent speaks to a subagent (by label): a steer while it runs, a continue once it ended. */
  | { tell: { label: string; message: string; steps?: Step[]; answer?: string } };

/**
 * A subagent's first stretch of work: the steps it plays in its lane as soon as it starts. With an
 * `answer` it ends at an `ends` step; without one it is still running when the script
 * moves on.
 */
export interface SubagentScript {
  label: string;
  mode: "explore" | "work";
  task: string;
  steps: Step[];
  answer?: string;
}

interface Subagent {
  id: string;
  label: string;
  /** When its running stretch began; null once it ended. */
  since: number | null;
  /** What it answers when it ends, while it runs. */
  answer: string | null;
}

export interface BackgroundJob {
  label: string;
  command: string;
  log: string;
  exitCode: number;
  service?: boolean;
}

export type Outcome =
  | { kind: "success" | "no-changes" | "failed"; summary: string }
  | { kind: "error"; reason: string; during: "cloning" | "preparing" | "setting-up" }
  /** The runner goes quiet without a result, and the reaper marks the run lost. */
  | { kind: "lost" };

export interface Hooks {
  /** Posts `text` to the run as a person (the `user` step). */
  postMessage?(text: string, from: "owner" | "member"): Promise<void>;
  /** Cancels the run's task as a person (the `cancel` step). */
  cancelTask?(): Promise<void>;
}

interface RepoEntry {
  connectedRepoId: string;
  url: string;
  ref: string;
  path: string;
  /** The run's branch namespace: a scripted run ships only the default line, `<namespace>/work`. */
  branchNamespace: string;
}

/** The one line a scripted run ships on, as the runner's default line. */
const LINE = "work";
const lineBranch = (repo: RepoEntry) => `${repo.branchNamespace}/${LINE}`;

interface Spec {
  workItem: {
    repos: RepoEntry[];
    spec: { title?: string; instructions?: string } | null;
    agent: { name?: string; email?: string } | null;
  };
}

interface Message {
  seq: number;
  text: string;
  sender: unknown;
}

interface Branch {
  connectedRepoId: string;
  path: string;
  line: string;
  name: string;
  headSha: string;
  commits: Array<{ sha: string; subject: string }>;
  generation: number;
  carries: string[];
}

interface Clone {
  repo: RepoEntry;
  dir: string;
  baseSha: string;
}

const json = { "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BEAT_MS = 10_000;

/** The outcomes `ryph__report_outcome` takes, as the real runner's loopback does. */
const REPORTED_OUTCOMES = ["in-progress", "success", "no-changes", "failed"] as const;
type ReportedOutcome = (typeof REPORTED_OUTCOMES)[number];

function isReportedOutcome(value: unknown): value is ReportedOutcome {
  return (REPORTED_OUTCOMES as readonly unknown[]).includes(value);
}

export class StoppedError extends Error {
  constructor() {
    super("the run was cancelled");
  }
}

export class FakeRun {
  #seq = 0;
  /** Each subagent lane counts its own seqs, from 1, as the runner's emitter does. */
  #laneSeqs = new Map<string, number>();
  /** The lane the transcript is being written into: the run's own, or a subagent's. */
  #lane = "";
  #subagents: Subagent[] = [];
  #queue: unknown[] = [];
  #beatSeq = 0;
  #phase = "cloning";
  #idle: { deadline: string; state: "idle" | "waiting-for-user" } | null = null;
  /** What the agent last reported through ryph__report_outcome, carried on every beat as the real
   * runner does; null once a message reached it since. Undefined until it reports, so the beat
   * leaves out what it has never said. */
  #declared: ReportedOutcome | null | undefined = undefined;
  #beater: ReturnType<typeof setInterval> | null = null;
  #flusher: ReturnType<typeof setInterval> | null = null;
  #flushing: Promise<void> = Promise.resolve();
  #inboxAfter = -1;
  #clones = new Map<string, Clone>();
  #branches: Branch[] = [];
  #callId = 0;
  #jobId = 0;
  /** Set once a heartbeat answers `cancel: true`, or `stop()` is called. */
  readonly cancelled = new AbortController();

  private constructor(
    readonly runId: string,
    readonly control: string,
    readonly token: string,
    readonly env: Record<string, string>,
    readonly spec: Spec,
    readonly model: { base: string; key: string } | null,
    readonly workDir: string,
  ) {}

  /** Bootstraps the run as a runner's first requests do, and starts beating and flushing. */
  static async start(
    control: string,
    runId: string,
    bootstrapToken: string,
    workRoot: string,
  ): Promise<FakeRun> {
    const boot = await fetch(`${control}/v1/runs/${runId}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    if (!boot.ok) throw new Error(`bootstrap ${runId}: ${boot.status} ${await boot.text()}`);
    const env = ((await boot.json()) as { env: Record<string, string> }).env;
    const auth = { authorization: `Bearer ${env.RYPH_RUN_TOKEN}` };
    const spec = await (await fetch(`${control}/v1/runs/${runId}/spec`, { headers: auth }))
      .json() as Spec;
    const creds = await (await fetch(`${control}/v1/runs/${runId}/credentials`, { headers: auth }))
      .json() as { env: Record<string, string> };
    const model = creds.env.RYPH_MODEL_BASE_URL && creds.env.RYPH_MODEL_API_KEY
      ? { base: creds.env.RYPH_MODEL_BASE_URL, key: creds.env.RYPH_MODEL_API_KEY }
      : null;
    const run = new FakeRun(
      runId,
      control,
      env.RYPH_RUN_TOKEN,
      env,
      spec,
      model,
      join(workRoot, runId),
    );
    run.#beater = setInterval(() => void run.beat(), BEAT_MS);
    run.#flusher = setInterval(() => {
      run.#flushing = run.#flushing.then(() => run.#flush());
    }, 500);
    await run.setPhase("cloning");
    return run;
  }

  get repos(): RepoEntry[] {
    return this.spec.workItem.repos;
  }

  get title(): string {
    return this.spec.workItem.spec?.title ?? "";
  }

  get instructions(): string {
    return this.spec.workItem.spec?.instructions ?? "";
  }

  // ── the wire ───────────────────────────────────────────────────────────────────────────────

  #runner(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.control}/v1/runs/${this.runId}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...json, ...init.headers },
    });
  }

  async beat(): Promise<void> {
    const res = await this.#runner("/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        seq: this.#beatSeq++,
        phase: this.#phase,
        idleDeadlineAt: this.#idle?.deadline ?? null,
        idleState: this.#idle?.state ?? null,
        ...(this.#declared === undefined ? {} : { declaredOutcome: this.#declared }),
      }),
    }).catch(() => null);
    if (res?.ok) {
      const { cancel } = await res.json() as { cancel: boolean };
      if (cancel && !this.cancelled.signal.aborted) this.cancelled.abort();
    } else {
      await res?.body?.cancel();
    }
  }

  setPhase(phase: string): Promise<void> {
    this.#phase = phase;
    return this.beat();
  }

  /** Waiting on a person (or idle) until `minutes` from now, as the real runner beats it. */
  setIdle(state: "idle" | "waiting-for-user" | null, minutes = 30): Promise<void> {
    this.#idle = state === null
      ? null
      : { state, deadline: new Date(Date.now() + minutes * 60_000).toISOString() };
    return this.beat();
  }

  emit(voice: "transcript" | "diag", kind: string, text: string | null, payload: unknown = null) {
    const lane = this.#lane;
    let seq: number;
    if (lane === "") seq = this.#seq++;
    else {
      seq = (this.#laneSeqs.get(lane) ?? 0) + 1;
      this.#laneSeqs.set(lane, seq);
    }
    this.#queue.push({
      ...(lane === "" ? {} : { lane }),
      seq,
      at: new Date().toISOString(),
      voice,
      kind,
      level: voice === "diag" ? "debug" : null,
      text,
      payload,
    });
    return seq;
  }

  async #flush(): Promise<void> {
    const history = this.env.RYPH_HISTORY_URL ?? this.control;
    while (this.#queue.length > 0) {
      const batch = this.#queue.slice(0, 100);
      const res = await fetch(`${history}/v1/runs/${this.runId}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, ...json },
        body: JSON.stringify({ events: batch }),
      }).catch(() => null);
      if (res === null || res.status >= 500) return; // the next tick retries
      if (!res.ok) {
        console.error(`  ! history refused a batch for ${this.runId}: ${await res.text()}`);
      } else await res.body?.cancel();
      this.#queue.splice(0, batch.length);
    }
  }

  /** Waits until every event emitted so far is stored. */
  async flushed(): Promise<void> {
    this.#flushing = this.#flushing.then(() => this.#flush());
    await this.#flushing;
  }

  /** One model call through the proxy, so the run's usage is metered for real. */
  async modelTurn(): Promise<void> {
    if (!this.model) return;
    const res = await fetch(`${this.model.base}/chat/completions`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${this.model.key}` },
      body: JSON.stringify({
        model: this.env.RYPH_MODEL ?? "playground-large",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "continue" }],
      }),
    }).catch(() => null);
    await res?.text().catch(() => {});
  }

  /** The person's messages that arrived since the last call; waits up to `waitS` for one. */
  async receive(waitS: number): Promise<Message[]> {
    const res = await this.#runner(`/messages?after=${this.#inboxAfter}&wait=${waitS}`, {
      signal: AbortSignal.any([this.cancelled.signal, AbortSignal.timeout((waitS + 10) * 1000)]),
    }).catch(() => null);
    if (!res?.ok) {
      await res?.body?.cancel();
      return [];
    }
    const { messages } = await res.json() as { messages: Message[] };
    // A message reached the agent: what it reported no longer stands, as the real runner clears it.
    if (messages.length > 0 && this.#declared !== undefined) this.#declared = null;
    for (const m of messages) {
      this.#inboxAfter = Math.max(this.#inboxAfter, m.seq);
      this.emit("transcript", "inbound", m.text, m);
    }
    return messages;
  }

  // ── the checkout ───────────────────────────────────────────────────────────────────────────

  /** Where the transcript says the checkout is, as a real run's would. */
  get displayRoot(): string {
    return `/tmp/ryph-${this.runId}`;
  }

  #repo(name?: string): RepoEntry {
    const repo = name ? this.repos.find((r) => r.path === name) : this.repos[0];
    if (!repo) throw new Error(`run ${this.runId} has no repo ${name ?? "at all"}`);
    return repo;
  }

  #shown(repo: RepoEntry, path: string): string {
    return `${this.displayRoot}/${repo.path}/${path}`;
  }

  async #git(dir: string, ...args: string[]): Promise<string> {
    const origin = this.env.RYPH_GIT_ORIGIN.replace(/\/+$/, "");
    const agent = this.spec.workItem.agent;
    const out = await command("git", {
      args,
      cwd: dir,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${
          btoa(`x-access-token:${this.env.RYPH_GIT_TOKEN}`)
        }`,
        GIT_AUTHOR_NAME: agent?.name ?? "Agent",
        GIT_AUTHOR_EMAIL: agent?.email ?? "agent@ryph.local",
        GIT_COMMITTER_NAME: agent?.name ?? "Agent",
        GIT_COMMITTER_EMAIL: agent?.email ?? "agent@ryph.local",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) {
      throw new Error(`git ${args[0]} in ${this.runId}: ${new TextDecoder().decode(out.stderr)}`);
    }
    return new TextDecoder().decode(out.stdout);
  }

  /** Clones every repo of the run through the gateway, onto its branch, as the runner does. */
  async checkout(): Promise<void> {
    await mkdir(this.workDir, { recursive: true });
    this.emit("diag", "checkout.created", null, { dir: this.displayRoot, keepTemp: false });
    for (const repo of this.repos) {
      const dir = join(this.workDir, repo.path);
      await this.#git(this.workDir, "clone", "--quiet", repo.url, dir);
      await this.#git(dir, "checkout", "--quiet", repo.ref);
      await this.#git(dir, "checkout", "--quiet", "-b", lineBranch(repo));
      const baseSha = (await this.#git(dir, "rev-parse", "HEAD")).trim();
      this.#clones.set(repo.path, { repo, dir, baseSha });
    }
  }

  #clone(name?: string): Clone {
    const repo = this.#repo(name);
    const clone = this.#clones.get(repo.path);
    if (!clone) throw new Error(`run ${this.runId} has not checked out ${repo.path}`);
    return clone;
  }

  async cleanup(): Promise<void> {
    await rm(this.workDir, { recursive: true }).catch(() => {});
  }

  // ── the transcript ─────────────────────────────────────────────────────────────────────────

  #assistant(blocks: Array<Record<string, unknown>>, stopReason: string) {
    return { type: "message_end", message: { role: "assistant", content: blocks, stopReason } };
  }

  think(text: string) {
    this.emit(
      "transcript",
      "thinking",
      text,
      this.#assistant([{ type: "thinking", thinking: text }], "toolUse"),
    );
  }

  say(text: string, stopReason = "toolUse"): number {
    return this.emit(
      "transcript",
      "assistant",
      text,
      this.#assistant([{ type: "text", text }], stopReason),
    );
  }

  toolCall(
    toolName: string,
    args: Record<string, unknown>,
    resultText: string,
    opts: { isError?: boolean; details?: unknown } = {},
  ) {
    const toolCallId = `call_${++this.#callId}`;
    this.emit("transcript", "tool_use", `${toolName} ${JSON.stringify(args)}`, {
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args,
    });
    const result = {
      content: [{ type: "text", text: resultText }],
      ...(opts.details === undefined ? {} : { details: opts.details }),
    };
    this.emit(
      "transcript",
      "tool_result",
      `${opts.isError ? "[error] " : ""}${JSON.stringify(result)}`,
      {
        type: "tool_execution_end",
        toolCallId,
        toolName,
        result,
        isError: opts.isError === true,
      },
    );
  }

  /** Plays a script, `pace` ms between steps. Throws StoppedError once the run is cancelled. */
  async play(steps: Step[], pace: number, hooks: Hooks = {}): Promise<void> {
    for (const step of steps) {
      if (this.cancelled.signal.aborted) throw new StoppedError();
      await this.#step(step, hooks);
      if (pace > 0) await sleep(pace * (0.6 + Math.random() * 0.8));
    }
    if (this.cancelled.signal.aborted) throw new StoppedError();
  }

  async #step(step: Step, hooks: Hooks): Promise<void> {
    // A real agent makes one model call per assistant message, and every tool call is one.
    if ("bash" in step || "read" in step || "edit" in step || "write" in step || "tool" in step) {
      await this.modelTurn();
    }
    if ("think" in step) {
      await this.modelTurn();
      this.think(step.think);
    } else if ("say" in step) {
      await this.modelTurn();
      this.say(step.say);
    } else if ("bash" in step) {
      const exit = step.exit ?? 0;
      const out = exit === 0 ? step.out : `${step.out}\n\nCommand exited with code ${exit}`;
      this.toolCall("bash", { command: step.bash }, out, { isError: exit !== 0 });
    } else if ("read" in step) {
      const clone = this.#clone(step.repo);
      const text = await readFile(join(clone.dir, step.read), "utf8");
      this.toolCall("read", { path: this.#shown(clone.repo, step.read) }, text.slice(0, 20_000));
    } else if ("edit" in step) {
      const clone = this.#clone(step.repo);
      const file = join(clone.dir, step.edit);
      const before = await readFile(file, "utf8");
      if (!before.includes(step.find)) {
        throw new Error(`script edit of ${step.edit}: ${JSON.stringify(step.find)} is not in it`);
      }
      await writeFile(file, before.replace(step.find, step.replace));
      const patch = await this.#git(clone.dir, "diff", "--", step.edit);
      this.toolCall(
        "edit",
        { path: this.#shown(clone.repo, step.edit), oldText: step.find, newText: step.replace },
        `Successfully replaced text in ${this.#shown(clone.repo, step.edit)}.`,
        { details: { patch } },
      );
    } else if ("write" in step) {
      const clone = this.#clone(step.repo);
      const file = join(clone.dir, step.write);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, step.content);
      this.toolCall(
        "write",
        { path: this.#shown(clone.repo, step.write), content: step.content },
        `Successfully wrote ${new TextEncoder().encode(step.content).length} bytes to ${
          this.#shown(clone.repo, step.write)
        }`,
      );
    } else if ("tool" in step) {
      const reports = step.tool === "ryph__report_outcome" && step.error !== true;
      const outcome = step.args.outcome;
      if (reports && !isReportedOutcome(outcome)) {
        throw new Error(
          `script report_outcome: ${JSON.stringify(outcome)} is not one of ${
            REPORTED_OUTCOMES.join(", ")
          }`,
        );
      }
      this.toolCall(step.tool, step.args, step.result, { isError: step.error });
      if (reports && isReportedOutcome(outcome)) {
        this.#declared = outcome;
        await this.beat();
      }
    } else if ("background" in step) {
      await this.#background(step.background);
    } else if ("submit" in step) {
      await this.#submit(step.submit);
    } else if ("user" in step) {
      if (!hooks.postMessage) throw new Error("a script with a user step needs postMessage");
      await this.setIdle("waiting-for-user");
      await this.flushed();
      await hooks.postMessage(step.user, step.from ?? "owner");
      for (let i = 0; i < 10; i++) {
        if ((await this.receive(5)).length > 0) break;
      }
      await this.setIdle(null);
    } else if ("subagent" in step) {
      await this.#startSubagent(step.subagent, hooks);
    } else if ("ends" in step) {
      this.#ends(step.ends);
    } else if ("tell" in step) {
      await this.#tell(step.tell, hooks);
    } else if ("cancel" in step) {
      if (!hooks.cancelTask) throw new Error("a script with a cancel step needs cancelTask");
      await this.flushed();
      await hooks.cancelTask();
      for (let i = 0; i < 10 && !this.cancelled.signal.aborted; i++) await this.beat();
    }
  }

  // ── subagents ───────────────────────────────────────────────────────────────────────────────

  #subagent(label: string): Subagent {
    const found = this.#subagents.find((s) => s.label === label);
    if (!found) throw new Error(`run ${this.runId} has no subagent ${JSON.stringify(label)}`);
    return found;
  }

  /** Plays steps in a subagent's lane, at a quicker pace than the run's own. */
  async #inLane(id: string, steps: Step[], hooks: Hooks): Promise<void> {
    for (const step of steps) {
      this.#lane = id;
      try {
        await this.#step(step, hooks);
      } finally {
        this.#lane = "";
      }
      await sleep(300);
    }
  }

  #inLaneNow(id: string, write: () => void): void {
    this.#lane = id;
    try {
      write();
    } finally {
      this.#lane = "";
    }
  }

  async #startSubagent(script: SubagentScript, hooks: Hooks): Promise<void> {
    const id = `sa-${this.#subagents.length + 1}`;
    const subagent: Subagent = {
      id,
      label: script.label,
      since: Date.now(),
      answer: script.answer ?? null,
    };
    this.#subagents.push(subagent);
    this.toolCall(
      "ryph__subagent_start",
      { task: script.task, label: script.label, mode: script.mode },
      `${id}\nStarted ${
        JSON.stringify(script.label)
      }. End your turn to wait; its answer arrives as a message.`,
    );
    this.#inLaneNow(id, () =>
      this.emit("transcript", "subagent.start", script.label, {
        id,
        label: script.label,
        mode: script.mode,
        task: script.task,
      }));
    await this.#inLane(id, script.steps, hooks);
  }

  /** Its answer, and the end of its stretch. */
  #answer(subagent: Subagent, reason = "answered"): void {
    const answer = subagent.answer ?? "";
    const durationMs = Date.now() - (subagent.since ?? Date.now());
    this.#inLaneNow(subagent.id, () => {
      if (reason === "answered") this.say(answer, "stop");
      this.emit("transcript", "subagent.end", null, {
        id: subagent.id,
        reason,
        answerChars: answer.length,
        durationMs,
      });
    });
    subagent.since = null;
    subagent.answer = null;
  }

  /**
   * A subagent ends on its own: its answer closes its lane, and the agent is handed the notice the
   * runner sends for it, a platform message narrated as `inbound` with `subagent` beside its text.
   */
  #ends(label: string): void {
    const subagent = this.#subagent(label);
    if (subagent.since === null) {
      throw new Error(`subagent ${JSON.stringify(label)} is not running`);
    }
    const answer = subagent.answer ?? "";
    const durationMs = Date.now() - subagent.since;
    this.#answer(subagent);
    const text = `Subagent ${subagent.id} (${JSON.stringify(label)}) answered after ${
      Math.round(durationMs / 1000)
    }s:\n\n${answer}`;
    this.emit("transcript", "inbound", text, {
      kind: "system",
      sender: { kind: "platform" },
      text,
      payload: null,
      createdAt: new Date().toISOString(),
      subagent: { id: subagent.id, label, reason: "answered", durationMs },
    });
  }

  async #tell(
    tell: { label: string; message: string; steps?: Step[]; answer?: string },
    hooks: Hooks,
  ): Promise<void> {
    const subagent = this.#subagent(tell.label);
    const running = subagent.since !== null;
    this.toolCall(
      "ryph__subagent_message",
      { id: subagent.id, text: tell.message },
      running
        ? `${subagent.id} is working; it reads this after its current tool call.`
        : `${subagent.id} had ended; it is continuing with this; its answer arrives as a message.`,
    );
    if (!running) {
      subagent.since = Date.now();
      subagent.answer = tell.answer ?? null;
    }
    this.#inLaneNow(subagent.id, () =>
      this.emit(
        "transcript",
        running ? "subagent.message" : "subagent.resume",
        tell.message,
        { id: subagent.id, message: tell.message },
      ));
    if (tell.answer !== undefined) subagent.answer = tell.answer;
    await this.#inLane(subagent.id, tell.steps ?? [], hooks);
  }

  async #background(job: BackgroundJob): Promise<void> {
    const id = `bg-${++this.#jobId}`;
    const startedAt = new Date();
    const timeoutAt = new Date(startedAt.getTime() + 30 * 60_000);
    const cwd = `${this.displayRoot}/${this.repos[0]?.path ?? ""}`;
    this.toolCall(
      "ryph__background_run",
      { command: job.command, label: job.label, cwd, ...(job.service ? { service: true } : {}) },
      `Started ${id} (${JSON.stringify(job.label)}) in ${cwd}, with a timeout of 30 minutes. ` +
        `Its output goes to /tmp/ryph-background/${id}.log.`,
    );
    const put = await this.#runner(`/runner/background/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        label: job.label,
        command: job.command,
        cwd,
        service: job.service === true,
        startedAt: startedAt.toISOString(),
        timeoutAt: timeoutAt.toISOString(),
      }),
    });
    await put.body?.cancel();
    const log = await this.#runner(`/runner/background/${id}/log`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: job.log,
    });
    await log.body?.cancel();
    if (job.service) return; // still running when the run ends; the run's end stops it
    const exit = await this.#runner(`/runner/background/${id}/exit`, {
      method: "POST",
      body: JSON.stringify({
        endedAt: new Date().toISOString(),
        reason: "exited",
        exitCode: job.exitCode,
        logBytes: new TextEncoder().encode(job.log).length,
        // The playground keeps no stored logs, so the tail is all a viewer gets: keep enough to read.
        logTail: job.log.split("\n").slice(-200).join("\n"),
      }),
    });
    await exit.body?.cancel();
  }

  /** Commits, bundles and uploads the repo's changes, then reports the patch mid-run. */
  async #submit(s: { title: string; description?: string; repo?: string }): Promise<void> {
    const clone = this.#clone(s.repo);
    const { repo, dir, baseSha } = clone;
    await this.#git(dir, "add", "-A");
    await this.#git(dir, "commit", "--quiet", "-m", s.title);
    const headSha = (await this.#git(dir, "rev-parse", "HEAD")).trim();
    const commits = (await this.#git(dir, "log", "--format=%H%x09%s", `${baseSha}..HEAD`))
      .trim().split("\n").map((l) => {
        const [sha, subject] = l.split("\t");
        return { sha, subject };
      });
    const bundle = join(this.workDir, `${repo.path}.bundle`);
    await this.#git(
      dir,
      "bundle",
      "create",
      "--quiet",
      bundle,
      `${baseSha}..refs/heads/${lineBranch(repo)}`,
    );
    const origin = this.env.RYPH_GIT_ORIGIN.replace(/\/+$/, "");
    const up = await fetch(`${origin}/v1/patches/${repo.connectedRepoId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.RYPH_GIT_TOKEN}`,
        "content-type": "application/x-git-bundle",
      },
      body: await readFile(bundle),
    });
    if (!up.ok) throw new Error(`bundle upload for ${this.runId}: ${up.status} ${await up.text()}`);
    await up.body?.cancel();
    const branch: Branch = {
      connectedRepoId: repo.connectedRepoId,
      path: repo.path,
      line: LINE,
      name: lineBranch(repo),
      headSha,
      commits,
      generation: 1,
      // Scripted patches stay on their original branch: no earlier generations or replayed work.
      carries: [],
    };
    const res = await this.#runner("/patches", {
      method: "POST",
      body: JSON.stringify({ branch, baseSha, title: s.title, description: s.description }),
    });
    if (!res.ok) throw new Error(`patch for ${this.runId}: ${res.status} ${await res.text()}`);
    const { patchId, state } = await res.json() as { patchId: string; state: string };
    this.#branches.push(branch);
    this.toolCall(
      "ryph__submit_patch",
      { path: repo.path, title: s.title, ...(s.description ? { description: s.description } : {}) },
      `Submitted patch ${patchId} for ${repo.path} at ${headSha.slice(0, 10)} (generation 1); ` +
        `it is ${state}.`,
    );
  }

  // ── the end ────────────────────────────────────────────────────────────────────────────────

  #stopTimers() {
    if (this.#beater !== null) clearInterval(this.#beater);
    if (this.#flusher !== null) clearInterval(this.#flusher);
    this.#beater = this.#flusher = null;
  }

  async #result(body: Record<string, unknown>): Promise<void> {
    // The run ending stops every subagent still at work.
    for (const subagent of this.#subagents) {
      if (subagent.since !== null) this.#answer(subagent, "run_ended");
    }
    this.#stopTimers();
    await this.flushed();
    if (body.status !== "error") await this.setPhase("finalizing");
    const res = await this.#runner("/result", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`result for ${this.runId}: ${res.status} ${await res.text()}`);
    await res.body?.cancel();
    await this.cleanup();
  }

  /** Ends the run as its script says. */
  async conclude(outcome: Outcome): Promise<void> {
    switch (outcome.kind) {
      case "lost":
        // Gone without a word: no result, no more beats. The reaper decides the rest.
        this.#stopTimers();
        await this.flushed();
        await this.cleanup();
        return;
      case "error":
        this.emit("diag", "run.phase", outcome.during, { phase: outcome.during, level: "warn" });
        return this.#result({
          status: "error",
          reason: outcome.reason,
          during: outcome.during,
          branches: [],
        });
    }
    await this.modelTurn();
    this.toolCall(
      "ryph__finish",
      { outcome: outcome.kind, summary: outcome.summary },
      "The run ends once this turn does.",
    );
    this.say(outcome.summary, "stop");
    this.emit("transcript", "system", "finished", null);
    this.emit("transcript", "final", null, { seq: null });
    await this.#result(
      outcome.kind === "failed"
        ? {
          status: "failure",
          reason: outcome.summary,
          summary: outcome.summary,
          branches: this.#branches,
        }
        : { status: "success", summary: outcome.summary, branches: this.#branches },
    );
  }

  /** Ends a run a person cancelled, or that the playground is shutting down. */
  async concludeCancelled(summary: string): Promise<void> {
    this.emit("transcript", "system", "cancelled", null);
    await this.#result({ status: "cancelled", summary, branches: this.#branches });
  }
}
