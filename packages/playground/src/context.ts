/**
 * What fixtures share while they run: the people, what has been created (kept in the manifest so
 * a reused playground's live fixtures find it again), the pool of runs waiting for a runner, and
 * the timeline the backdating pass reads.
 */

import { type Person, Session } from "./api.ts";
import { FakeRun, type Outcome, type Step, StoppedError } from "./runner.ts";
import type { MockChat } from "./mock_chat.ts";
import type { MockGitlab } from "./mock_gitlab.ts";
import type { Layout, Ports } from "./stack.ts";
import type { Notice } from "./notices.ts";
import { opening, replyTo, type Story } from "./stories.ts";

export type Role = "owner" | "member" | "operator" | "viewer";

/** Everything the seed fixtures made that a later start needs. Serialised into the manifest. */
export interface State {
  people: Partial<Record<Role, Person>>;
  repos: Record<string, { id: string; path: string }>;
  workspaceId?: string;
  agents: Record<string, { id: string; name: string }>;
  providerKeyId?: string;
  /** The seeded chatrooms by platform, and the Zulip channel the Grafana response opens in. */
  chatrooms?: Partial<Record<"telegram" | "zulip" | "slack" | "discord", string>>;
}

/** One seeded run as it really happened, and when it should look like it happened. */
export interface TimelineEntry {
  runId: string;
  taskId: string;
  realStart: string;
  realEnd: string;
  /** How long before the playground was seeded the run should appear to have started. */
  ageMs: number;
  durationMs: number;
  /** Synthetic platform inbox rows, installed only while the host is offline. */
  notices?: Notice[];
  /** A finished check suite on the run's patch, installed only while the host is offline. */
  checks?: SeedCheck[];
}

/** One check of a seeded suite: the playground has no launcher to run a real one. */
export interface SeedCheck {
  name: string;
  run: string;
  state: "passed" | "failed";
  /** How long it took. */
  seconds: number;
  logTail: string;
}

/**
 * Bootstrap tokens as the host prints them, matched to whoever is waiting for that run. A run
 * nobody claims within a moment — a task started in the UI, an automation's — is adopted and
 * played by a generic script, so everything a person does in the playground gets a runner.
 */
export class RunPool {
  #tokens = new Map<string, string>();
  #waiters = new Map<string, (token: string) => void>();
  #claimed = new Set<string>();
  adopt: ((runId: string, token: string) => void) | null = null;

  feed(runId: string, token: string): void {
    const waiter = this.#waiters.get(runId);
    if (waiter) {
      this.#waiters.delete(runId);
      this.#claimed.add(runId);
      return waiter(token);
    }
    this.#tokens.set(runId, token);
    setTimeout(() => {
      if (this.#claimed.has(runId) || !this.adopt) return;
      this.#claimed.add(runId);
      this.#tokens.delete(runId);
      this.adopt(runId, token);
    }, 2_000);
  }

  claim(runId: string, timeoutMs = 30_000): Promise<string> {
    this.#claimed.add(runId);
    const known = this.#tokens.get(runId);
    if (known) {
      this.#tokens.delete(runId);
      return Promise.resolve(known);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(runId);
        reject(new Error(`no bootstrap token for ${runId} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.#waiters.set(runId, (token) => {
        clearTimeout(timer);
        resolve(token);
      });
    });
  }
}

export class Context {
  readonly sessions = new Map<Role, Session>();
  readonly timeline: TimelineEntry[] = [];
  readonly live = new Set<{ run: FakeRun; done: Promise<void> }>();
  readonly control: string;
  /** The running host's setup token, for the owner fixture's registration (stack.ts). */
  setupToken: () => Promise<string | null> = () => Promise.resolve(null);
  #stopping = false;

  constructor(
    readonly layout: Layout,
    readonly ports: Ports,
    readonly pool: RunPool,
    readonly state: State,
    /** The mock chat platforms, for the chat fixture's linking message. */
    readonly chat: MockChat,
    /** The fake GitLab, which the gitlab fixture scripts people's side of. */
    readonly gitlab: MockGitlab,
  ) {
    // 127.0.0.1, not localhost: the host binds that alone, and localhost may be ::1 first.
    this.control = `http://127.0.0.1:${ports.control}`;
    for (const [role, person] of Object.entries(state.people)) {
      this.sessions.set(role as Role, new Session(this.control, person));
    }
  }

  get owner(): Session {
    const s = this.sessions.get("owner");
    if (!s) throw new Error("no owner: the owner fixture has not run");
    return s;
  }

  as(role: Role): Session {
    return this.sessions.get(role) ?? this.owner;
  }

  repo(name: string): { id: string; path: string } {
    const r = this.state.repos[name];
    if (!r) throw new Error(`no repo ${name}: the repos fixture has not run`);
    return r;
  }

  agent(key: string): { id: string; name: string } {
    const a = this.state.agents[key];
    if (!a) throw new Error(`no agent ${key}: the agents fixture has not run`);
    return a;
  }

  /** Starts a task as `who` and returns its run, bootstrapped and checked out. */
  async startRun(
    who: Session,
    body: Record<string, unknown>,
    checkout = true,
  ): Promise<{ run: FakeRun; taskId: string }> {
    const { runId, taskId } = await who.post<{ runId: string; taskId: string }>("/v1/tasks", body);
    const token = await this.pool.claim(runId);
    const run = await FakeRun.start(this.control, runId, token, this.layout.work);
    if (checkout) await prepare(run);
    return { run, taskId };
  }

  /** Plays a story start to finish, as fast as the host takes it. */
  async playStory(story: Story, agentId: string, ageMs: number): Promise<void> {
    const who = this.as(story.by ?? "owner");
    const target = story.workspace
      ? { workspaceId: this.state.workspaceId }
      : { connectedRepoId: this.repo(story.gitlab ? `gitlab:${story.gitlab}` : story.repo).id };
    const realStart = new Date().toISOString();
    const cloned = story.outcome.kind !== "error";
    const { run, taskId } = await this.startRun(who, {
      agentId,
      spec: { title: story.title, instructions: story.instructions },
      ...target,
    }, cloned);
    try {
      await run.play(story.steps, 0, {
        postMessage: async (text, from) => {
          await this.as(from).post(`/v1/runs/${run.runId}/messages`, { text, attachmentIds: [] });
        },
        cancelTask: async () => {
          await who.post(`/v1/tasks/${taskId}/cancel`);
        },
      });
      await run.conclude(story.outcome);
    } catch (err) {
      if (!(err instanceof StoppedError)) throw err;
      await run.concludeCancelled(`Cancelled by ${who.person.name}.`);
    }
    if (story.outcome.kind === "lost") await this.#waitUntilTerminal(taskId, 60_000);
    if (story.patch && story.patch !== "pending") await this.#decide(run.runId, story.patch);
    this.timeline.push({
      runId: run.runId,
      taskId,
      realStart,
      realEnd: new Date().toISOString(),
      ageMs,
      durationMs: story.minutes * 60_000,
    });
  }

  async #waitUntilTerminal(taskId: string, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const { runs } = await this.owner.get<{ runs: Array<{ state: string }> }>(
        `/v1/tasks/${taskId}`,
      );
      const state = runs.at(-1)?.state;
      if (state && !["starting", "running"].includes(state)) return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`task ${taskId} did not end within ${timeoutMs / 1000} s`);
  }

  /** Approves or rejects the run's patch as the owner would. */
  async #decide(runId: string, fate: "approve" | "reject"): Promise<void> {
    const { patches } = await this.owner.get<{ patches: Array<{ id: string; runId: string }> }>(
      `/v1/patches?limit=100`,
    );
    const patch = patches.find((p) => p.runId === runId);
    if (!patch) throw new Error(`run ${runId} opened no patch to ${fate}`);
    await this.owner.post(`/v1/patches/${patch.id}/${fate}`, fate === "approve" ? {} : undefined);
  }

  /**
   * Keeps a run going for as long as the playground is up: answering every message, and between
   * messages playing `working` (when given) on a loop. Concluded when the playground stops or a
   * person cancels it.
   */
  converse(
    run: FakeRun,
    intro: Parameters<FakeRun["play"]>[0],
    working: Parameters<FakeRun["play"]>[0] | null,
  ): void {
    const done = (async () => {
      try {
        await run.play(intro, 1_500);
        let step = 0;
        while (!run.cancelled.signal.aborted) {
          if (working === null) await run.setIdle("waiting-for-user");
          const messages = await run.receive(working === null ? 25 : 0);
          if (messages.length > 0) {
            await run.setIdle(null);
            for (const m of messages) await run.play(replyTo(m.text), 1_200);
          } else if (working !== null) {
            await run.play([working[step++ % working.length]], 0);
            await new Promise((r) => setTimeout(r, 4_000 + Math.random() * 4_000));
          }
        }
      } catch (err) {
        if (!(err instanceof StoppedError)) console.error(`  ! live run ${run.runId}: ${err}`);
      }
      await run.concludeCancelled(
        this.#stopping ? "The playground stopped." : "Cancelled.",
      ).catch(() => {});
    })();
    const entry = { run, done };
    this.live.add(entry);
    done.finally(() => this.live.delete(entry));
  }

  /** A run nobody scripted: give it the generic opening and keep it talking. */
  async adopt(runId: string, token: string): Promise<void> {
    try {
      const run = await FakeRun.start(this.control, runId, token, this.layout.work);
      await prepare(run);
      this.converse(run, opening(run.title, run.instructions), null);
      console.log(`  · playing ${runId} (${run.title || "untitled"}) with the generic script`);
    } catch (err) {
      console.error(`  ! could not play ${runId}: ${err}`);
    }
  }

  /**
   * Plays the next run nobody claims — one a `/ryph` comment on GitLab started — with `steps`
   * and `outcome` instead of the generic script, and resolves once it has concluded.
   */
  playUnclaimed(steps: Step[], outcome: Outcome, timeoutMs = 60_000): Promise<string> {
    const previous = this.pool.adopt;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pool.adopt = previous;
        reject(new Error(`no run started within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pool.adopt = (runId, token) => {
        clearTimeout(timer);
        this.pool.adopt = previous;
        void (async () => {
          const run = await FakeRun.start(this.control, runId, token, this.layout.work);
          await prepare(run);
          await run.play(steps, 0);
          await run.conclude(outcome);
          return runId;
        })().then(resolve, reject);
      };
    });
  }

  /** Ends every live run, as a person would see a runner shut down. */
  async stopLive(): Promise<void> {
    this.#stopping = true;
    this.pool.adopt = null;
    for (const { run } of this.live) run.cancelled.abort();
    await Promise.all([...this.live].map((l) => l.done));
  }
}

/** Clone, then the phases a real run walks through before its agent starts. */
async function prepare(run: FakeRun): Promise<void> {
  await run.checkout();
  await run.setPhase("preparing");
  await run.setPhase("running");
  run.emit("transcript", "system", "agent_start", { type: "agent_start" });
}
