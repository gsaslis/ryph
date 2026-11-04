#!/usr/bin/env -S bun --env-file=deploy/compose-networked/.env
/**
 * The pressure half of the perf harness — `bun run perf:load`.
 *
 * It plays three parties against the compose stack started by `bun run perf:up`, all over the
 * same HTTP surfaces the real ones use:
 *
 * - USERS create tasks through the control plane, at a rate or up to a concurrency.
 * - RUNNERS, one per run, do what packages/runner does: fetch the spec and credentials, beat
 *   every 10 s and on each phase change, stream model calls through the real model proxy (to the
 *   `mock-model` service, so usage rows are metered for real), batch transcript events to the
 *   historian every second, and post a result. The bootstrap token comes off the control plane's
 *   log, which is the manual provisioner's contract, and is redeemed for the run token as a
 *   runner's first request would.
 * - VIEWERS, each a browser tab on a task page: the task list's SSE, the run's transcript SSE, and
 *   the page's 3 s poll (task, transcript head and tail, run usage), switching task every minute.
 *
 * Every request is timed per operation. Every 15 s a window prints (p50/p95/max per op, errors,
 * runs in flight, database connections); at the end a summary prints and the raw numbers land in
 * perf/results/.
 *
 *   bun run perf:load --scenario steady      # see SCENARIOS below
 *   bun run perf:load --runs 300 --concurrency 150 --turns 30 --viewers 40
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "@std/cli/parse-args";
import { type Child, command } from "@ryph/process";
import postgres from "postgres";
import { pgBase } from "./pg.ts";
import { readSetupToken } from "../deploy/compose-networked/setup_token.ts";

// ── configuration ────────────────────────────────────────────────────────────────────────────

const APP = process.env.PERF_APP ?? "http://127.0.0.1:3000";
const CONTROL = process.env.PERF_CONTROL ?? "http://127.0.0.1:7411";
const HISTORY = process.env.PERF_HISTORY ?? "http://127.0.0.1:7413";
const PROXY = process.env.PERF_MODEL_PROXY ?? "http://127.0.0.1:7420";
const PG = process.env.PERF_PG ?? `${pgBase()}ryph`;
const COMPOSE = [
  "compose",
  "-p",
  "ryph-perf",
  "-f",
  // From this file, not the working directory, the way compose-networked/smoke.ts finds its own.
  fileURLToPath(new URL("../deploy/compose-networked/compose.yaml", import.meta.url)),
  "-f",
  fileURLToPath(new URL("./compose.perf.yaml", import.meta.url)),
];

const EMAIL = "perf@ryph.local";
const PASSWORD = "perf-password-perf-password";

interface Scenario {
  /** Tasks created in total. */
  runs: number;
  /** Runs in flight at most; creation waits for a slot. */
  concurrency: number;
  /** Tasks created per second at most. */
  rate: number;
  /** Model turns per run (mean; each run draws 50–150% of it). */
  turns: number;
  /** Tool time between turns, ms (mean). */
  thinkMs: number;
  /** Browser tabs open on task pages. */
  viewers: number;
}

const SCENARIOS: Record<string, Scenario> = {
  // A handful of runs, to check the harness itself.
  smoke: { runs: 5, concurrency: 5, rate: 1, turns: 3, thinkMs: 500, viewers: 2 },
  // A busy team's day, compressed: 40 runs in flight, a dozen people watching.
  steady: { runs: 200, concurrency: 40, rate: 2, turns: 15, thinkMs: 3000, viewers: 12 },
  // Everyone at once: 500 webhooks' worth of tasks as fast as the control plane takes them.
  burst: { runs: 500, concurrency: 500, rate: 50, turns: 10, thinkMs: 2000, viewers: 25 },
  // Long, chatty runs: fewer of them, many turns, big transcripts.
  soak: { runs: 60, concurrency: 30, rate: 1, turns: 120, thinkMs: 2000, viewers: 20 },
};

const args = parseArgs(process.argv.slice(2), {
  string: ["scenario"],
  default: { scenario: "smoke" },
});
const base = SCENARIOS[args.scenario];
if (!base) {
  console.error(`unknown scenario ${args.scenario}; one of ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}
const cfg: Scenario = { ...base };
for (const key of Object.keys(cfg) as (keyof Scenario)[]) {
  if (args[key] !== undefined) cfg[key] = Number(args[key]);
}

// ── measurement ──────────────────────────────────────────────────────────────────────────────

interface Sample {
  op: string;
  ms: number;
  ok: boolean;
  status: number;
  at: number;
}

const samples: Sample[] = [];
let windowStart = 0;
const counters = {
  created: 0,
  provisioned: 0,
  finished: 0,
  failed: 0,
  events: 0,
  modelCalls: 0,
  inFlight: 0,
  viewerSse: 0,
};
const errors = new Map<string, number>();

function record(op: string, ms: number, ok: boolean, status: number) {
  samples.push({ op, ms, ok, status, at: performance.now() });
  if (!ok) errors.set(`${op} ${status}`, (errors.get(`${op} ${status}`) ?? 0) + 1);
}

/** A timed fetch. Status 0 means the request never got an answer. */
async function timed(
  op: string,
  url: string,
  init: RequestInit = {},
  okStatuses = [200, 201, 204],
) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
    const body = await res.text();
    const ms = performance.now() - t0;
    record(op, ms, okStatuses.includes(res.status), res.status);
    return { status: res.status, body, headers: res.headers };
  } catch (err) {
    record(op, performance.now() - t0, false, 0);
    return { status: 0, body: String(err), headers: new Headers() };
  }
}

/** A percentile of values already sorted ascending. */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** The first sample at or after `at`. Samples are appended as they complete, so `at` ascends. */
function firstSampleAt(at: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].at < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function table(from: number, to: number): string {
  // Only the window's own samples are walked, so a 15 s window costs the same an hour in.
  const byOp = new Map<string, Sample[]>();
  for (let i = firstSampleAt(from); i < samples.length && samples[i].at < to; i++) {
    const s = samples[i];
    (byOp.get(s.op) ?? byOp.set(s.op, []).get(s.op)!).push(s);
  }
  const rows = [...byOp.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([op, list]) => {
    // Sorted once, and the max read off the end: a spread of a whole run's samples into
    // Math.max overflows the stack past about a hundred thousand of them.
    const ms = list.map((s) => s.ms).sort((a, b) => a - b);
    const bad = list.filter((s) => !s.ok).length;
    return `  ${op.padEnd(26)} n=${String(list.length).padStart(6)}  p50=${
      pct(ms, 50).toFixed(0).padStart(6)
    }  p95=${pct(ms, 95).toFixed(0).padStart(6)}  p99=${pct(ms, 99).toFixed(0).padStart(6)}  max=${
      (ms.at(-1) ?? 0).toFixed(0).padStart(6)
    }${bad ? `  ERR=${bad}` : ""}`;
  });
  return rows.join("\n");
}

// ── the database, sampled ────────────────────────────────────────────────────────────────────

const sql = postgres(PG, { max: 1, onnotice: () => {} });
const dbSamples: Array<
  { at: number; conns: number; active: number; waiting: number; idleTx: number }
> = [];

async function sampleDb() {
  try {
    const [row] = await sql<
      Array<{ conns: number; active: number; waiting: number; idle_tx: number }>
    >`
      select count(*)::int as conns,
             count(*) filter (where state = 'active')::int as active,
             count(*) filter (where wait_event_type = 'Lock')::int as waiting,
             count(*) filter (where state like 'idle in transaction%')::int as idle_tx
      from pg_stat_activity where backend_type = 'client backend'`;
    dbSamples.push({
      at: performance.now(),
      conns: row.conns,
      active: row.active,
      waiting: row.waiting,
      idleTx: row.idle_tx,
    });
  } catch {
    // A sampler that fails says nothing about the system under test.
  }
}

const cpuSamples: Array<{ at: number; cpu: Record<string, number>; mem: Record<string, number> }> =
  [];

const toMiB = (v: string) => {
  const m = v.match(/([\d.]+)\s*([KMG]i?B)/);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2].startsWith("G") ? n * 1024 : m[2].startsWith("K") ? n / 1024 : n;
};

async function sampleCpu() {
  const out = await command("docker", {
    args: ["stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}} {{.MemUsage}}"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const cpu: Record<string, number> = {};
  const mem: Record<string, number> = {};
  for (const line of new TextDecoder().decode(out.stdout).split("\n")) {
    const m = line.match(/^ryph-perf-([a-z-]+)-1 ([\d.]+)% (\S+ ?\S*)/);
    if (!m) continue;
    cpu[m[1]] = Number(m[2]);
    mem[m[1]] = toMiB(m[3]);
  }
  cpuSamples.push({ at: performance.now(), cpu, mem });
}

/**
 * The cgroup's own accounting, per service: CPU time used and time spent THROTTLED — held off
 * the CPU because the quota ran out. Under a 250m limit the second number is the one that
 * matters: a service that is throttled is queueing every request behind its own quota, and a
 * point-in-time `docker stats` sample cannot see it.
 */
type CpuStat = Record<string, { usage: number; throttled: number; periods: number; hits: number }>;

async function cgroupCpu(): Promise<CpuStat> {
  const names = new TextDecoder().decode(
    (await command("docker", {
      args: ["ps", "--filter", "name=ryph-perf-", "--format", "{{.Names}}"],
      stdout: "piped",
    }).output()).stdout,
  ).trim().split("\n").filter(Boolean);
  const out: CpuStat = {};
  await Promise.all(names.map(async (name) => {
    const res = await command("docker", {
      args: ["exec", name, "cat", "/sys/fs/cgroup/cpu.stat"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const text = new TextDecoder().decode(res.stdout);
    const get = (k: string) => Number(text.match(new RegExp(`^${k} (\\d+)`, "m"))?.[1] ?? 0);
    out[name.replace(/^ryph-perf-|-1$/g, "")] = {
      usage: get("usage_usec") / 1e6,
      throttled: get("throttled_usec") / 1e6,
      periods: get("nr_periods"),
      hits: get("nr_throttled"),
    };
  }));
  return out;
}

// ── the run contract, off the control plane's log ────────────────────────────────────────────

const tokens = new Map<string, string>();
const tokenWaiters = new Map<string, (token: string) => void>();

async function followControlPlaneLog(): Promise<Child> {
  const child = await command("docker", {
    args: [...COMPOSE, "logs", "-f", "--no-log-prefix", "--since", "1s", "control-plane"],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  (async () => {
    const pattern = /RYPH_RUN_ID="([^"]+)".*?RYPH_BOOTSTRAP_TOKEN="([0-9a-f]+)"/;
    let buf = "";
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = line.match(pattern);
        if (!m) continue;
        tokens.set(m[1], m[2]);
        tokenWaiters.get(m[1])?.(m[2]);
        tokenWaiters.delete(m[1]);
      }
    }
  })();
  return child;
}

function tokenFor(runId: string, timeoutMs = 60_000): Promise<string | null> {
  const known = tokens.get(runId);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      tokenWaiters.delete(runId);
      resolve(null);
    }, timeoutMs);
    tokenWaiters.set(runId, (t) => {
      clearTimeout(timer);
      resolve(t);
    });
  });
}

// ── setup: an admin, a mock provider, a key, some agents ─────────────────────────────────────

const json = { "content-type": "application/json" };
let bearer = "";
let cookie = "";

// Only logins until the first success register, so the soak's re-logins never read the control
// plane's log again in the middle of a measurement. Set once the admin is known to exist (a
// register or a sign-in went through), so a failed read or register is tried again next time.
let registered = false;

async function login() {
  let res: Response | null = null;
  if (!registered) {
    // Null once the stack is claimed, and the sign-in below takes over. PERF_SETUP_TOKEN, for a
    // stack whose log has scrolled past it.
    const setupToken = await readSetupToken(
      { command: "docker", args: [...COMPOSE, "logs", "--no-color", "control-plane"] },
      process.env.PERF_SETUP_TOKEN,
    );
    res = await fetch(`${APP}/auth/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "Perf",
        email: EMAIL,
        password: PASSWORD,
        ...(setupToken ? { setupToken } : {}),
      }),
    });
  }
  if (!res?.ok) {
    await res?.body?.cancel();
    res = await fetch(`${APP}/auth/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
  }
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  registered = true;
  await res.body?.cancel();
  cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const pair = await fetch(`${CONTROL}/v1/auth/login`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!pair.ok) throw new Error(`bearer login failed: ${pair.status} ${await pair.text()}`);
  bearer = ((await pair.json()) as { accessToken: string }).accessToken;
}

const asUser = () => ({ cookie });
const asBearer = (t = bearer) => ({ authorization: `Bearer ${t}` });

// The repository the networked compose's `fixture-repo` makes, as the forge sees it: every task
// here checks it out, since a task names a connected repo and nothing else.
const FIXTURE_REPO = "/fixtures/hello";
let repoId = "";

/** The fixture repository's id, connected on first use and found again after. */
async function fixtureRepo(): Promise<string> {
  const listed = await (await fetch(`${CONTROL}/v1/connected-repos`, { headers: asBearer() }))
    .json() as { repos: Array<{ id: string; provider: string; repoRef: string }> };
  const known = listed.repos.find((r) => r.provider === "local" && r.repoRef === FIXTURE_REPO);
  if (known) return known.id;
  const res = await fetch(`${CONTROL}/v1/connected-repos`, {
    method: "POST",
    headers: { ...json, ...asBearer() },
    body: JSON.stringify({ provider: "local", path: FIXTURE_REPO }),
  });
  if (!res.ok) throw new Error(`connect the fixture repo: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function mockModelIp(): Promise<string> {
  const out = await command("docker", {
    args: [
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      "ryph-perf-mock-model-1",
    ],
    stdout: "piped",
  }).output();
  const ip = new TextDecoder().decode(out.stdout).trim();
  if (!ip) throw new Error("mock-model is not running — bun run perf:up");
  return ip;
}

async function setup(agentCount: number): Promise<string[]> {
  await login();
  const ip = await mockModelIp();
  repoId = await fixtureRepo();

  // The provider: created once, re-pointed at the mock's address on every start.
  const providers = await (await fetch(`${APP}/api/v1/providers`, { headers: asUser() }))
    .json() as {
      providers?: Array<{ id: string }>;
    };
  const baseUrl = `http://${ip}:8080/v1`;
  if (!providers.providers?.some((p) => p.id === "mock")) {
    const res = await fetch(`${APP}/api/v1/providers`, {
      method: "POST",
      headers: { ...json, ...asUser() },
      body: JSON.stringify({
        id: "mock",
        label: "Mock",
        baseUrl,
        models: [{
          id: "mock-1",
          price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        }],
      }),
    });
    if (!res.ok) throw new Error(`register provider: ${res.status} ${await res.text()}`);
  } else {
    await (await fetch(`${APP}/api/v1/providers/mock`, {
      method: "PATCH",
      headers: { ...json, ...asUser() },
      body: JSON.stringify({ baseUrl }),
    })).body?.cancel();
  }

  const keys = await (await fetch(`${APP}/api/v1/provider-keys`, { headers: asUser() })).json() as {
    providerKeys: Array<{ id: string; label: string; archivedAt: string | null }>;
  };
  let keyId = keys.providerKeys.find((k) => k.label === "perf" && k.archivedAt === null)?.id;
  if (!keyId) {
    const res = await fetch(`${APP}/api/v1/provider-keys`, {
      method: "POST",
      headers: { ...json, ...asUser() },
      body: JSON.stringify({ provider: "mock", label: "perf", secret: "sk-mock-perf" }),
    });
    if (!res.ok) throw new Error(`register key: ${res.status} ${await res.text()}`);
    keyId = ((await res.json()) as { id: string }).id;
  }

  const listed = await (await fetch(`${CONTROL}/v1/agents`, { headers: asBearer() })).json() as {
    agents: Array<{ id: string; email: string }>;
  };
  const agents: string[] = [];
  for (let i = 0; i < agentCount; i++) {
    const email = `perf-agent-${i}@ryph.local`;
    const found = listed.agents.find((a) => a.email === email);
    if (found) {
      agents.push(found.id);
      continue;
    }
    const res = await fetch(`${CONTROL}/v1/agents`, {
      method: "POST",
      headers: { ...json, ...asBearer() },
      body: JSON.stringify({
        name: `Perf ${i}`,
        email,
        harnessKind: "pi",
        modelPolicy: { providerKeyId: keyId, provider: "mock", allowedModels: "*" },
      }),
    });
    if (!res.ok) throw new Error(`create agent: ${res.status} ${await res.text()}`);
    agents.push(((await res.json()) as { id: string }).id);
  }
  return agents;
}

// ── one simulated runner ─────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => Math.round(ms * (0.5 + Math.random()));
const filler = (n: number) => "x".repeat(n);

// Task text that tokenizes like a real brief: an embedding costs per token, and "x" repeated
// is a handful of tokens however long it is.
const WORDS = (
  "the billing webhook retries forever when stripe answers with a timeout so add a bounded " +
  "backoff and a dead letter queue then update the integration tests and the runbook make sure " +
  "the migration is reversible and the dashboard shows the new counter check the flaky login " +
  "test in ci it fails when the session cookie expires between steps refactor the widget " +
  "pipeline so the renderer no longer imports the store directly and document the new seam"
).split(" ");
const prose = (chars: number) => {
  let out = "";
  while (out.length < chars) out += WORDS[Math.floor(Math.random() * WORDS.length)] + " ";
  return out.slice(0, chars);
};

/** Payload sizes drawn to look like a pi transcript: mostly small, a long tail of file reads. */
function toolResultSize(): number {
  const r = Math.random();
  if (r < 0.6) return 200 + Math.floor(Math.random() * 1_000);
  if (r < 0.9) return 2_000 + Math.floor(Math.random() * 6_000);
  return 10_000 + Math.floor(Math.random() * 20_000);
}

interface LiveRun {
  taskId: string;
  runId: string;
  lastSeq: number;
}
const liveRuns: LiveRun[] = [];
const doneRuns: LiveRun[] = [];

async function simulateRun(agentId: string, index: number): Promise<void> {
  const tCreated = performance.now();
  const created = await timed("task.create", `${CONTROL}/v1/tasks`, {
    method: "POST",
    headers: { ...json, ...asBearer() },
    body: JSON.stringify({
      agentId,
      spec: {
        title: `perf ${args.scenario} #${index} — refactor the widget pipeline`,
        instructions: `Load-test run ${index}. ${prose(300 + Math.floor(Math.random() * 1_500))}`,
      },
      connectedRepoId: repoId,
    }),
  });
  if (created.status !== 201) return void counters.failed++;
  counters.created++;
  const { runId, taskId } = JSON.parse(created.body) as { runId: string; taskId: string };

  const bootstrapToken = await tokenFor(runId);
  if (!bootstrapToken) {
    record("run.start", performance.now() - tCreated, false, 0);
    return void counters.failed++;
  }
  const bootstrap = await timed("runner.bootstrap", `${CONTROL}/v1/runs/${runId}/bootstrap`, {
    method: "POST",
    headers: asBearer(bootstrapToken),
  });
  if (bootstrap.status !== 200) return void counters.failed++;
  const token = JSON.parse(bootstrap.body).env.RYPH_RUN_TOKEN as string;
  record("run.start", performance.now() - tCreated, true, 200);
  counters.provisioned++;
  counters.inFlight++;

  const live: LiveRun = { taskId, runId, lastSeq: -1 };
  liveRuns.push(live);
  const run = `${CONTROL}/v1/runs/${runId}`;
  const auth = { ...json, ...asBearer(token) };
  // Cleared in `finally`, so a run that throws midway stops beating and flushing with it.
  const timers: ReturnType<typeof setInterval>[] = [];

  try {
    await timed("runner.spec", `${run}/spec`, { headers: auth });
    const creds = await timed("runner.credentials", `${run}/credentials`, { headers: auth });
    const env = creds.status === 200
      ? (JSON.parse(creds.body) as { env: Record<string, string> }).env
      : {};
    const modelBase = (env.RYPH_MODEL_BASE_URL ?? "").replace(/^https?:\/\/[^/]+/, PROXY);
    const modelKey = env.RYPH_MODEL_API_KEY ?? "";

    // The heartbeat: every 10 s, and at once on each phase change. Never two at once, as the
    // runner does it — but a beat asked for while one is in flight is sent right after it rather
    // than dropped, so a phase change always reaches the control plane.
    let beatSeq = 0;
    let phase = "cloning";
    let beating: Promise<void> | null = null;
    let beatAgain = false;
    /** Resolves once no beat is in flight or owed — so the result can wait for the last one. */
    const beat = (): Promise<void> => {
      if (beating !== null) {
        beatAgain = true;
        return beating;
      }
      beating = (async () => {
        do {
          beatAgain = false;
          await timed("runner.heartbeat", `${run}/heartbeat`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ seq: beatSeq++, phase, message: `perf ${phase}` }),
          });
        } while (beatAgain);
      })().finally(() => beating = null);
      return beating;
    };
    const beater = setInterval(() => void beat(), 10_000);
    timers.push(beater);
    const setPhase = (p: string) => {
      phase = p;
      return beat();
    };

    // The emitter: a queue flushed every second, at most 100 a batch.
    let seq = 0;
    const queue: unknown[] = [];
    // As packages/runner's emitter: a 5 s request budget, a 4xx batch dropped (the historian
    // said no), anything else kept and retried with a 1–8 s backoff — so an overloaded historian
    // gets the retry pressure real runners would put on it. `until` bounds the final flush, as
    // the runner's shutdown deadline does.
    let failures = 0;
    // When the run starts finishing, every flush — the interval's in-flight one included — gives
    // up at this deadline, as the runner's shutdown does, instead of retrying forever.
    let flushDeadline = Infinity;
    const flush = async () => {
      while (queue.length > 0 && performance.now() < flushDeadline) {
        const batch = queue.slice(0, 100);
        const res = await timed("historian.ingest", `${HISTORY}/v1/runs/${runId}/events`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.status === 200) {
          queue.splice(0, batch.length);
          failures = 0;
          counters.events += batch.length;
          // What was stored, not what has been emitted since: a viewer opening its stream after
          // this must not skip events still waiting in the queue.
          live.lastSeq = (batch.at(-1) as { seq: number }).seq;
        } else if (res.status >= 400 && res.status < 500) {
          queue.splice(0, batch.length);
          failures = 0;
        } else {
          failures++;
          await sleep(Math.min(8_000, 1_000 * 2 ** (failures - 1)));
        }
      }
    };
    let flushing = Promise.resolve();
    const flusher = setInterval(() => {
      flushing = flushing.then(flush);
    }, 1_000);
    timers.push(flusher);
    const emit = (voice: string, kind: string, text: string | null, payload: unknown = null) =>
      queue.push({
        seq: seq++,
        at: new Date().toISOString(),
        voice,
        kind,
        level: null,
        text,
        payload,
      });

    void setPhase("cloning");
    emit("diag", "clone.start", null, { repo: "Hello-World" });
    await sleep(jitter(1_500));
    void setPhase("preparing");
    await sleep(jitter(500));
    void setPhase("running");

    const turns = Math.max(1, Math.round(cfg.turns * (0.5 + Math.random())));
    for (let turn = 0; turn < turns; turn++) {
      // One model call, streamed through the proxy and read to the end — metered on the way.
      if (modelBase) {
        const t0 = performance.now();
        try {
          const res = await fetch(`${modelBase}/chat/completions`, {
            method: "POST",
            headers: { ...json, authorization: `Bearer ${modelKey}` },
            body: JSON.stringify({
              model: "mock-1",
              stream: true,
              stream_options: { include_usage: true },
              messages: [{ role: "user", content: filler(2_000) }],
            }),
            signal: AbortSignal.timeout(60_000),
          });
          await res.text();
          record("model.call", performance.now() - t0, res.ok, res.status);
          counters.modelCalls++;
        } catch {
          record("model.call", performance.now() - t0, false, 0);
        }
      }
      emit(
        "transcript",
        "assistant",
        `Turn ${turn}: ${filler(200 + Math.floor(Math.random() * 1_200))}`,
      );
      const tools = 1 + Math.floor(Math.random() * 3);
      for (let t = 0; t < tools; t++) {
        emit("transcript", "tool_use", null, { tool: "bash", args: { command: filler(120) } });
        emit("transcript", "tool_result", null, { output: filler(toolResultSize()) });
      }
      if (Math.random() < 0.2) emit("diag", "pi.debug", "tick", { level: "debug" });
      await sleep(jitter(cfg.thinkMs));
    }

    // The finalizing beat lands before the result, as the runner's does: after it, the run is
    // over and the beat would be a 409 the driver caused.
    // No beat may start after this one: the interval stops first, so the last beat in flight is
    // the finalizing one (or one it queued behind), and the result waits for it.
    clearInterval(beater);
    const finalizing = setPhase("finalizing");
    emit("transcript", "final", "done", null);
    clearInterval(flusher);
    flushDeadline = performance.now() + 10_000;
    await flushing;
    await flush();
    for (const timer of timers) clearInterval(timer);
    await finalizing;
    const result = await timed("runner.result", `${run}/result`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ status: "success", summary: "perf run finished", branches: [] }),
    });
    if (result.status === 200 || result.status === 204) counters.finished++;
    else counters.failed++;
  } finally {
    for (const timer of timers) clearInterval(timer);
    counters.inFlight--;
    liveRuns.splice(liveRuns.indexOf(live), 1);
    doneRuns.push(live);
  }
}

// ── one simulated viewer ─────────────────────────────────────────────────────────────────────

/** Opens an SSE stream and drains it until `signal` ends it. The sample is the wait for the
 * response headers — through the app, the first frame's arrival (perf/README.md). */
async function sse(op: string, url: string, signal: AbortSignal) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers: { ...asUser(), accept: "text/event-stream" }, signal });
    record(op, performance.now() - t0, res.ok, res.status);
    if (!res.ok || !res.body) return void await res.body?.cancel();
    counters.viewerSse++;
    try {
      for await (const _ of res.body) { /* drain */ }
    } finally {
      counters.viewerSse--;
    }
  } catch {
    if (!signal.aborted) record(op, performance.now() - t0, false, 0);
  }
}

async function simulateViewer(stop: AbortSignal): Promise<void> {
  const listStream = new AbortController();
  void sse(
    "view.tasks.stream",
    `${APP}/api/v1/tasks/stream?limit=50`,
    AbortSignal.any([stop, listStream.signal]),
  );
  await timed("view.tasks.list", `${APP}/api/v1/tasks?limit=50`, { headers: asUser() });

  while (!stop.aborted) {
    const pool = liveRuns.length > 0 && Math.random() < 0.8 ? liveRuns : doneRuns;
    const target = pool[Math.floor(Math.random() * pool.length)];
    if (!target) {
      await sleep(1_000);
      continue;
    }
    const tail = new AbortController();
    void sse(
      "view.events.stream",
      `${APP}/api/v1/runs/${target.runId}/events/stream?after=${target.lastSeq}`,
      AbortSignal.any([stop, tail.signal]),
    );
    // The page's 3 s invalidate: task, transcript head and tail, run usage — for about a minute.
    const until = performance.now() + jitter(60_000);
    while (!stop.aborted && performance.now() < until) {
      await Promise.all([
        timed("view.task", `${APP}/api/v1/tasks/${target.taskId}`, { headers: asUser() }),
        timed("view.events.head", `${APP}/api/v1/runs/${target.runId}/events?after=-1&limit=50`, {
          headers: asUser(),
        }),
        timed(
          "view.events.tail",
          `${APP}/api/v1/runs/${target.runId}/events?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
          { headers: asUser() },
        ),
        timed("view.run.usage", `${APP}/api/v1/model-usage/runs/${target.runId}`, {
          headers: asUser(),
        }),
      ]);
      await sleep(3_000);
    }
    tail.abort();
    await timed("view.tasks.list", `${APP}/api/v1/tasks?limit=50`, { headers: asUser() });
    if (Math.random() < 0.2) {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 86_400_000);
      await timed(
        "view.usage.report",
        `${APP}/api/v1/model-usage?from=${from.toISOString()}&to=${to.toISOString()}`,
        { headers: asUser() },
      );
    }
  }
  listStream.abort();
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────

console.log(`ryph perf · ${args.scenario} · ${JSON.stringify(cfg)}`);
const log = await followControlPlaneLog();
const agents = await setup(Math.min(20, Math.max(1, Math.ceil(cfg.concurrency / 5))));
// The access token is short-lived and a browser refreshes it; a soak outlives it. Log in again
// well inside its lifetime, so a 401 in the numbers is the system's and never the driver's.
const relogin = setInterval(
  () => login().catch((err) => console.error(`re-login: ${err}`)),
  5 * 60_000,
);
console.log(`setup done: ${agents.length} agents`);

const cpuBefore = await cgroupCpu();
const t0 = performance.now();
windowStart = t0;
const stopViewers = new AbortController();
const viewers = Array.from({ length: cfg.viewers }, () => simulateViewer(stopViewers.signal));

const ticker = setInterval(async () => {
  await Promise.all([sampleDb(), sampleCpu()]);
  const now = performance.now();
  const db = dbSamples.at(-1);
  const cpu = cpuSamples.at(-1)?.cpu ?? {};
  const hot = Object.entries(cpu).sort(([, a], [, b]) => b - a).slice(0, 5)
    .map(([k, v]) => `${k}=${v.toFixed(0)}%`).join(" ");
  console.log(
    `\n[${
      ((now - t0) / 1000).toFixed(0)
    }s] created=${counters.created} inflight=${counters.inFlight} ` +
      `finished=${counters.finished} failed=${counters.failed} events=${counters.events} ` +
      `model=${counters.modelCalls} sse=${counters.viewerSse}` +
      (db
        ? ` | db conns=${db.conns} active=${db.active} lockwait=${db.waiting} idletx=${db.idleTx}`
        : "") +
      `\n  cpu: ${hot}\n${table(windowStart, now)}`,
  );
  windowStart = now;
}, 15_000);

// Creation: at most `rate` a second and `concurrency` in flight. A slot is held from the create
// until the run ends, however it ends — a run whose token never came, or that threw, frees it too.
const runs: Promise<void>[] = [];
let occupied = 0;
let slotFree: (() => void) | null = null;
for (let i = 0; i < cfg.runs; i++) {
  while (occupied >= cfg.concurrency) {
    await new Promise<void>((r) => {
      slotFree = r;
      setTimeout(r, 250);
    });
  }
  const agent = agents[i % agents.length];
  occupied++;
  runs.push(
    simulateRun(agent, i).catch((err) => {
      counters.failed++;
      console.error(`run ${i}: ${err}`);
    }).finally(() => {
      occupied--;
      slotFree?.();
    }),
  );
  await sleep(1_000 / cfg.rate);
}
await Promise.all(runs);
stopViewers.abort();
await Promise.allSettled(viewers);
clearInterval(ticker);
clearInterval(relogin);
log.kill();

const elapsed = (performance.now() - t0) / 1000;
const cpuAfter = await cgroupCpu();
const cpuUse = Object.entries(cpuAfter).map(([svc, a]) => {
  const b = cpuBefore[svc] ?? { usage: 0, throttled: 0, periods: 0, hits: 0 };
  return {
    svc,
    cpuSeconds: a.usage - b.usage,
    throttledSeconds: a.throttled - b.throttled,
    throttledPct: a.periods - b.periods > 0
      ? (100 * (a.hits - b.hits)) / (a.periods - b.periods)
      : 0,
  };
}).filter((c) => c.cpuSeconds > 0.5).sort((x, y) => y.cpuSeconds - x.cpuSeconds);
console.log(`\n══ summary · ${args.scenario} · ${elapsed.toFixed(0)}s ══`);
console.log(
  `runs created=${counters.created} finished=${counters.finished} failed=${counters.failed} ` +
    `events=${counters.events} model calls=${counters.modelCalls}`,
);
console.log(table(t0, Infinity));
if (errors.size > 0) {
  console.log("errors:");
  for (const [k, v] of [...errors.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
}
const peak = dbSamples.reduce((m, s) => Math.max(m, s.conns), 0);
console.log(
  `db: peak connections ${peak}, peak lock waiters ${
    Math.max(0, ...dbSamples.map((s) => s.waiting))
  }`,
);
const cpuPeak: Record<string, number> = {};
for (const s of cpuSamples) {
  for (const [k, v] of Object.entries(s.cpu)) cpuPeak[k] = Math.max(cpuPeak[k] ?? 0, v);
}
console.log(
  `cpu peak (% of one core; 25% is a 250m limit): ${
    Object.entries(cpuPeak).sort(([, a], [, b]) => b - a).map(([k, v]) => `${k}=${v.toFixed(0)}%`)
      .join(" ")
  }`,
);

const firstMem = cpuSamples[0]?.mem ?? {};
const lastMem = cpuSamples.at(-1)?.mem ?? {};
console.log(
  `memory MiB, first → last sample: ${
    Object.keys(lastMem).filter((k) => lastMem[k] > 50).sort((a, b) => lastMem[b] - lastMem[a])
      .map((k) => `${k} ${(firstMem[k] ?? 0).toFixed(0)}→${lastMem[k].toFixed(0)}`).join("  ")
  }`,
);
console.log(
  "cpu over the run (cgroup): seconds used · seconds throttled · % of 100ms periods throttled",
);
for (const c of cpuUse) {
  console.log(
    `  ${c.svc.padEnd(14)} ${c.cpuSeconds.toFixed(1).padStart(7)}s used  ${
      c.throttledSeconds.toFixed(1).padStart(7)
    }s throttled  ${c.throttledPct.toFixed(0).padStart(3)}% of periods`,
  );
}

await mkdir("perf/results", { recursive: true });
const file = `perf/results/${new Date().toISOString().replace(/[:.]/g, "-")}-${args.scenario}.json`;
await writeFile(
  file,
  JSON.stringify({
    scenario: args.scenario,
    cfg,
    counters,
    cpuUse,
    errors: Object.fromEntries(errors),
    samples,
    dbSamples,
    cpuSamples,
  }),
);
console.log(`raw: ${file}`);
await sql.end();
process.exit(0);
