// The GitLab webhook budget and the mailroom under simulated floods, wired as the forge wires them:
// the real mailroom (`@ryph/webhooks`) over an in-memory store, its real door (each GitLab delivery
// POSTed with its project's derived token, each GitHub one signed), its tick on a timer AND kicked
// by every arrival into an idle mailbox (`coalescingTick`, as forge's main.ts does), and the real
// budget (`hookBudget`) and admission (`gitlabHookAdmission`). Consumers are asynchronous: each
// GitLab call takes a while, so deliveries overlap and reservations are in flight together, are
// spent piecemeal and refunded late; and in some scenarios GitLab HANGS for minutes, every call
// running to a 15 s timeout and failing, retried on the mailroom's backoff. Time is virtual — an
// event loop moves the clock from one timer to the next and lets everything that can run, run.
//
// Seeded, over many scenarios: a few projects flooding at their door budgets (real notes, cheap
// rings for notes that are not there, pushes, merge request churn), floods that come and go, many
// projects each ringing a little (up to ~1900), and GitLab hanging beside any of them. Beside
// them, quiet projects send one episode each — a note, or a push or a merge request with a `/ryph`
// note behind it in the same queue — and a GitHub mailbox gets a push now and then.
//
// What must hold in every scenario:
// - I1: the bot's GitLab calls for webhooks never pass the cap: in any interval of length L, at
//   most a bucket (a minute's worth) plus L's refill — reservations in flight included.
// - I2: every quiet delivery is delivered, within its shape's bound (`QUIET_BOUND_MS`).
// - I3: waiting for the budget spends no attempt: a delivery's attempts are exactly the times its
//   consumer ran.
// - I4: the GitHub mailbox never waits on GitLab's: each push is delivered the moment the one
//   before it is done (or it arrives), plus its own consumer's time — not a virtual millisecond
//   more, whatever GitLab is doing.

import { createHmac } from "node:crypto";
import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  coalescingTick,
  deriveScopedSecret,
  type Hook,
  type HookStore,
  setup as setupWebhooks,
} from "@ryph/webhooks";
import {
  GITLAB_HOOK_READS_PER_MINUTE,
  hookBudget,
  HookReservation,
} from "../src/adapters/forge_api/gitlab_hook_reads.ts";
import { gitlabHookAdmission } from "../src/adapters/forge_api/gitlab_webhooks.ts";

const P = 2_000; // the forge's RYPH_WEBHOOKS_SWEEP_INTERVAL_MS default
const CAP = GITLAB_HOOK_READS_PER_MINUTE;
const RATE = CAP / 60_000; // per ms
const T0 = Date.parse("2026-10-14T00:00:00.000Z");
const MASTER = "sim-master";
const LABEL = "gitlab-hook:";
const GH_SECRET = "sim-github";
/** A GitLab call that hangs runs to this and fails, as the adapter's reads do. */
const TIMEOUT_MS = 15_000;

/** How long a quiet delivery may wait, per scenario shape, from when it was due (its arrival, or
 * its queue's previous delivery — or, in a hang, the moment GitLab answers again). Each is the
 * worst seen over 400 seeds, with a margin of a fifth to a half.
 *
 * A project that floods has spent far more than a quiet one, which goes first: a few seconds, a
 * few more when floods come and go. Hundreds of projects each ringing a little are by spend as
 * quiet as a quiet one, and share the budget with it, a project's spend halving every minute:
 * minutes, the longest a `/ryph` note behind its own project's merge request. And once a GitLab
 * that hung for up to four minutes answers again, a delivery that failed through the hang is
 * taken when its retry clock runs out — the backoff doubles from 10 s, so up to some three
 * minutes. */
const QUIET_BOUND_MS: Record<Shape, number> = {
  none: 5_000,
  loud: 30_000,
  bursty: 45_000,
  many: 6 * 60_000,
  mixed: 7 * 60_000,
  hang: 4 * 60_000,
};

/** A store with the HookStore port's semantics, in memory: queues kept as arrays in seq order. */
function memoryStore(): HookStore {
  const rows = new Map<string, Hook>();
  const queues = new Map<
    string,
    { registrationId: string; scope: string | null; ids: string[]; at: number }
  >();
  let seq = 0;
  const qkey = (registrationId: string, scope: string | null) =>
    JSON.stringify([registrationId, scope]);
  const live = (h: Hook | undefined) =>
    h !== undefined && (h.state === "pending" || h.state === "delivering");
  const head = (q: { ids: string[]; at: number }) => {
    while (q.at < q.ids.length && !live(rows.get(q.ids[q.at]))) q.at++;
    return q.at < q.ids.length ? rows.get(q.ids[q.at])! : null;
  };
  const copy = (h: Hook): Hook => ({ ...h, headers: { ...h.headers } });
  return {
    recordHook(hook) {
      const row = { ...hook, seq: ++seq } as Hook;
      rows.set(row.id, row);
      const key = qkey(row.registrationId, row.scope);
      let q = queues.get(key);
      if (q === undefined) {
        q = { registrationId: row.registrationId, scope: row.scope, ids: [], at: 0 };
        queues.set(key, q);
      }
      q.ids.push(row.id);
      return Promise.resolve(copy(row));
    },
    getHook(id) {
      const row = rows.get(id);
      return Promise.resolve(row === undefined ? null : copy(row));
    },
    getHeadHook(registrationId, scope = null) {
      const q = queues.get(qkey(registrationId, scope));
      const h = q === undefined ? null : head(q);
      return Promise.resolve(h === null ? null : copy(h));
    },
    getDueQueues(registrationIds, dueAt) {
      const out: Array<{ registrationId: string; scope: string | null }> = [];
      for (const q of queues.values()) {
        if (!registrationIds.includes(q.registrationId)) continue;
        const h = head(q);
        if (h === null) continue;
        const due = h.state === "pending"
          ? h.nextAttemptAt === null || h.nextAttemptAt <= dueAt
          : h.leaseExpiresAt !== null && h.leaseExpiresAt <= dueAt;
        if (due) out.push({ registrationId: q.registrationId, scope: q.scope });
      }
      return Promise.resolve(out);
    },
    saveHook(hook) {
      rows.set(hook.id, copy(hook));
      return Promise.resolve();
    },
    hasDeliveredKey: () => Promise.resolve(false),
    saveHookIfState(hook, expected, expectedAttempts) {
      const row = rows.get(hook.id);
      if (
        row === undefined || !expected.includes(row.state) ||
        (expectedAttempts !== undefined && row.attempts !== expectedAttempts)
      ) {
        return Promise.resolve(false);
      }
      rows.set(hook.id, copy(hook));
      return Promise.resolve(true);
    },
    deleteTerminalHooks: () => Promise.resolve(0),
    deleteHooksForRegistration: () => Promise.resolve(),
  };
}

/** mulberry32 */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Virtual time: `sleep` waits for the clock, `run` moves it from one timer to the next, letting
 * everything that can run at each instant run first. Everything here that waits — consumers,
 * arrivals, the host's timer — waits on it; the mailroom's own work never does. */
function virtualClock(start: number) {
  let now = start;
  let seq = 0;
  const timers: Array<{ at: number; seq: number; fire: () => void | Promise<void> }> = [];
  const later = (at: number, fire: () => void | Promise<void>) => {
    timers.push({ at: Math.max(at, now), seq: seq++, fire });
  };
  /** Lets every runnable promise chain run to where it waits on the clock again. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    now: () => now,
    later,
    sleep: (ms: number) => new Promise<void>((resolve) => later(now + ms, resolve)),
    async run(until: () => boolean) {
      while (!until() && timers.length > 0) {
        await settle();
        let best = 0;
        for (let i = 1; i < timers.length; i++) {
          const a = timers[i];
          const b = timers[best];
          if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) best = i;
        }
        const [next] = timers.splice(best, 1);
        now = next.at;
        await next.fire();
      }
      await settle();
    },
  };
}

type Kind = "note" | "ring" | "push" | "mr";
type Shape = "none" | "loud" | "bursty" | "many" | "mixed" | "hang";
const EVENT: Record<Kind, string> = {
  note: "Note Hook",
  ring: "Note Hook",
  push: "Push Hook",
  mr: "Merge Request Hook",
};

interface Delivery {
  id: string;
  project: string;
  kind: Kind;
  takes: number;
  quiet: boolean;
  arrived: number;
  done: number | null;
  runs: number;
}

interface Scenario {
  name: string;
  shape: Shape;
  /** Per period, each flooding project's deliveries — at most two per door lane (a minute's 60). */
  flood: (
    period: number,
    rnd: () => number,
  ) => Array<{ project: string; kind: Kind; takes: number }>;
  quiet: number;
  periods: number;
  /** When GitLab hangs, if it does: [from, to) in ms since T0. */
  hang: [number, number] | null;
  many: number;
}

function scenario(seed: number): Scenario {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const shape = pick(["loud", "bursty", "many", "mixed", "hang", "hang", "none"] as const);
  // Minutes of flood: fewer where hundreds of projects ring, to keep the test quick.
  const periods = shape === "many" || shape === "mixed" ? int(45, 120) : int(120, 240);
  // A note is 7 calls once read; a ring for a note that is not there 1; a push 6 or its 2 reads; a
  // merge request 10, 5 or its 2 reads.
  const takesOf = (kind: Kind, r: () => number) =>
    kind === "note"
      ? 7
      : kind === "ring"
      ? 1
      : kind === "push"
      ? (r() < 0.5 ? 6 : 2)
      : pick([10, 5, 2]);
  const loud = Array.from({ length: int(1, 8) }, (_, i) => ({
    project: String(900_000 + i),
    notes: pick(["note", "ring"] as const),
    others: rnd() < 0.5,
    period: int(15, 150) * 1_000,
    phase: rnd(),
  }));
  const many = shape === "many" || shape === "mixed" ? int(100, 1_900) : 0;
  // Together, the many projects ring from half to three times what the budget serves of rings.
  const every = many / (RATE * P * (0.5 + 2.5 * rnd())); // each one's mean interval, in periods
  const hangFrom = int(10, periods - 30) * P;
  return {
    name: `seed ${seed}: ${shape}, ${loud.length} loud, ${many} many`,
    shape,
    quiet: shape === "many" ? int(1, 30) : int(1, 150),
    periods,
    hang: shape === "hang" ? [hangFrom, hangFrom + int(30, 240) * 1_000] : null,
    many,
    flood(period, r) {
      const out: Array<{ project: string; kind: Kind; takes: number }> = [];
      if (shape !== "many" && shape !== "none") {
        for (const f of loud) {
          if (shape === "bursty") {
            const at = (period * P / f.period + f.phase) % 1;
            if (at > 0.5) continue; // off for half of each period
          }
          for (let i = 0; i < 2; i++) {
            out.push({ project: f.project, kind: f.notes, takes: takesOf(f.notes, r) });
          }
          if (f.others) {
            for (let i = 0; i < 2; i++) {
              const kind = r() < 0.5 ? "push" : "mr";
              out.push({ project: f.project, kind, takes: takesOf(kind, r) });
            }
          }
        }
      }
      for (let i = 0; i < many; i++) {
        if (r() < 1 / every) out.push({ project: String(800_000 + i), kind: "ring", takes: 1 });
      }
      return out;
    },
  };
}

async function simulate(seed: number) {
  const sc = scenario(seed);
  const rnd = prng(seed ^ 0x9e3779b9);
  const clock = virtualClock(T0);
  const budget = hookBudget({ perMinute: CAP, now: clock.now });
  const store = memoryStore();
  let kick: () => void = () => {};
  const mailroom = setupWebhooks({
    store,
    diag: { debug: () => {}, warn: () => {} },
    now: () => new Date(clock.now()),
    onIngested: () => kick(),
  });
  // As forge's main.ts: never two ticks at once, a kick during one makes one more.
  kick = coalescingTick(() => mailroom.tick(), (err) => {
    throw err;
  });
  const door = async (req: Request) => {
    for (const r of mailroom.routes) {
      const match = r.pattern.exec(req.url);
      if (r.method === req.method && match) {
        return await r.handler(req, { registrationId: match.pathname.groups.registrationId! });
      }
    }
    throw new Error("no route");
  };

  const deliveries = new Map<string, Delivery>();
  const byBody = new Map<string, Delivery>();
  /** Every call spent: [time, project]. */
  const ledger: Array<[number, string]> = [];
  const hanging = (t: number) => sc.hang !== null && t >= T0 + sc.hang[0] && t < T0 + sc.hang[1];
  mailroom.register({
    id: "gitlab",
    verification: {
      kind: "derived-secret-header",
      header: "x-gitlab-token",
      master: MASTER,
      label: LABEL,
      scopeParam: "project",
    },
    admitDelivery: gitlabHookAdmission(budget),
    consumer: async (hook, ticket) => {
      const d = byBody.get(hook.body)!;
      d.runs++;
      assert(ticket instanceof HookReservation, "every delivery holds a reservation");
      for (let i = 0; i < d.takes; i++) {
        ticket.take(1);
        ledger.push([clock.now(), d.project]);
        if (hanging(clock.now())) {
          await clock.sleep(TIMEOUT_MS);
          return { kind: "failed", message: "GitLab timed out", terminal: false };
        }
        await clock.sleep(40 + Math.floor(rnd() * 260));
      }
      d.done = clock.now();
      return { kind: "ok" };
    },
  });
  const github: Array<{ arrived: number; latency: number; done: number | null }> = [];
  mailroom.register({
    id: "github",
    verification: {
      kind: "hmac-sha256",
      header: "x-hub-signature-256",
      prefix: "sha256=",
      secret: GH_SECRET,
    },
    consumer: async (hook) => {
      const g = github[Number(hook.body)];
      await clock.sleep(g.latency);
      g.done = clock.now();
      return { kind: "ok" };
    },
  });

  const tokens = new Map<string, string>();
  const tokenOf = async (project: string) => {
    let t = tokens.get(project);
    if (t === undefined) {
      t = await deriveScopedSecret(MASTER, LABEL, project);
      tokens.set(project, t);
    }
    return t;
  };
  let n = 0;
  const quietOnes: Delivery[] = [];
  const ring = async (project: string, kind: Kind, takes: number, quiet: boolean) => {
    const body = String(++n);
    const d: Delivery = {
      id: "",
      project,
      kind,
      takes,
      quiet,
      arrived: clock.now(),
      done: null,
      runs: 0,
    };
    byBody.set(body, d);
    if (quiet) quietOnes.push(d);
    const res = await door(
      new Request(`http://forge/v1/hooks/gitlab?project=${project}`, {
        method: "POST",
        headers: { "x-gitlab-token": await tokenOf(project), "x-gitlab-event": EVENT[kind] },
        body,
      }),
    );
    assertEquals(res.status, 202);
    d.id = ((await res.json()) as { id: string }).id;
    deliveries.set(d.id, d);
  };
  const push = async () => {
    const body = String(github.length);
    github.push({ arrived: clock.now(), latency: 20 + Math.floor(rnd() * 80), done: null });
    const sig = createHmac("sha256", GH_SECRET).update(body).digest("hex");
    const res = await door(
      new Request("http://forge/v1/hooks/github", {
        method: "POST",
        headers: { "x-hub-signature-256": `sha256=${sig}` },
        body,
      }),
    );
    assertEquals(res.status, 202);
  };

  // The host's timer.
  const end = T0 + sc.periods * P;
  const quietLeft = () => quietOnes.some((d) => d.done === null);
  const timer = () => {
    kick();
    if (clock.now() < end + 30 * 60_000) clock.later(clock.now() + P, timer);
  };
  clock.later(T0, timer);
  // Arrivals, each at a moment of its own within its period — never in step with the timer.
  const episodes = Array.from({ length: sc.quiet }, (_, i) => ({
    project: String(100_000 + i),
    at: T0 + (15 + rnd() * (sc.periods - 15)) * P,
    items: [
      [["note", 7]],
      [["push", 6], ["note", 7]],
      [["mr", 10], ["note", 7]],
      [["push", 2], ["mr", 5], ["note", 7]],
    ][Math.floor(rnd() * 4)] as Array<[Kind, number]>,
  }));
  for (const e of episodes) {
    clock.later(e.at, async () => {
      for (const [kind, takes] of e.items) await ring(e.project, kind, takes, true);
    });
  }
  for (let period = 0; period < sc.periods; period++) {
    for (const f of sc.flood(period, rnd)) {
      clock.later(T0 + (period + rnd()) * P, () => ring(f.project, f.kind, f.takes, false));
    }
    if (rnd() < 0.2) clock.later(T0 + (period + rnd()) * P, push);
  }
  await clock.run(() => clock.now() >= end && !quietLeft() && github.every((g) => g.done !== null));
  return { sc, deliveries, ledger, github, store, end: clock.now() };
}

// Each seed is some thousands of deliveries through the real door — its HMAC checks included —
// so the work is real CPU, if not wall-clock time: a few hundred ms a seed on a fast machine, many
// times that on a check pod's share of a CPU. The seeds go in batches, each its own test, so no
// one test holds all of them under the per-test timeout.
const SEEDS = 24;
const BATCH = 3;

test("the seeds cover a hang and many projects ringing", () => {
  const shapes = new Set<Shape>();
  for (let seed = 1; seed <= SEEDS; seed++) shapes.add(scenario(seed).shape);
  assert(
    shapes.has("hang") && shapes.has("many"),
    `the seeds cover too few shapes: ${[...shapes]}`,
  );
});

for (let from = 1; from <= SEEDS; from += BATCH) {
  const to = Math.min(from + BATCH - 1, SEEDS);
  test(`simulated floods and hangs, seeds ${from}–${to}: the cap holds, waiting spends no attempt, quiet deliveries come within their bounds, and GitHub never waits on GitLab`, async () => {
    for (let seed = from; seed <= to; seed++) await check(seed);
  });
}

async function check(seed: number) {
  const { sc, deliveries, ledger, github, store, end } = await simulate(seed);
  const where = sc.name;

  // I1: in every interval, at most a bucket plus its refill — calls are spent while other
  // deliveries' reservations are in flight, so this is checked call by call, not per tick.
  // max over a ≤ b of calls(a..b] − RATE·(b − a) ≤ CAP: Kadane over the ledger.
  let worst = 0;
  let run = 0;
  let last = T0;
  for (const [t] of ledger) {
    run = Math.max(0, run - RATE * (t - last)) + 1;
    last = t;
    worst = Math.max(worst, run);
  }
  assert(worst <= CAP + 1e-6, `${where}: ${worst} calls in a window the cap allows ${CAP}`);

  // I3: attempts are consumer runs — waiting on the budget spent none.
  for (const d of deliveries.values()) {
    const row = await store.getHook(d.id);
    assertEquals(row?.attempts, d.runs, `${where}: ${d.id} spent attempts it never ran`);
    if (sc.hang === null && row?.state === "delivered") assertEquals(d.runs, 1);
  }

  // I4: GitHub, delivered the moment the push before it is done, plus its own consumer's time.
  let free = -Infinity;
  for (const [i, g] of github.entries()) {
    assert(g.done !== null, `${where}: GitHub push ${i} was never delivered`);
    const expected = Math.max(g.arrived, free) + g.latency;
    assertEquals(g.done, expected, `${where}: GitHub push ${i} waited on something`);
    free = g.done;
  }

  // I2: every quiet delivery, within its shape's bound.
  const byProject = new Map<string, Delivery[]>();
  for (const d of deliveries.values()) {
    const xs = byProject.get(d.project) ?? [];
    xs.push(d);
    byProject.set(d.project, xs);
  }
  let longest = 0;
  for (const items of byProject.values()) {
    let prev = -Infinity;
    for (const d of items) {
      if (!d.quiet) continue;
      assert(d.done !== null, `${where}: a quiet delivery of ${d.project} was never delivered`);
      // From when it was due — or, in a hang, from when GitLab answered again.
      const due = Math.max(d.arrived, prev, sc.hang === null ? -Infinity : T0 + sc.hang[1]);
      const waited = d.done - Math.min(due, d.done);
      prev = d.done;
      longest = Math.max(longest, waited);
      assert(
        waited <= QUIET_BOUND_MS[sc.shape],
        `${where}: ${d.kind} of quiet ${d.project} waited ${waited} ms`,
      );
    }
  }
  if (process.env.SIM_REPORT) {
    console.log(where, { longest, github: github.length, calls: ledger.length, end: end - T0 });
  }
}
