// Background jobs driven end to end in a process of their own, which the test starts
// (tests/background_permissions_test.ts): a stop, a timeout and the
// run's stopAll, each over a group with a member that ignores TERM. Prints, as JSON on stdout,
// each job's group, its members' pids and how it ended, and every warn — the test checks that
// every group is gone.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackgroundJobs } from "../../src/core/background.ts";
import type { BackgroundRunArgs } from "../../src/ports/run_actions.ts";

const warns: Array<{ event: string; fields?: Record<string, unknown> }> = [];
const root = await mkdtemp(join(tmpdir(), "runner-bg-scoped-"));
const jobs = startBackgroundJobs({
  diag: { debug: () => {}, warn: (event, fields) => warns.push({ event, fields }) },
  checkoutRoot: root,
  env: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
  notice: () => true,
  holdChanged: () => {},
  minuteMs: 400,
  stopGraceMs: 400,
  endGraceMs: 400,
  leftoverGraceMs: 300,
  recordWaitMs: 200,
  releaseMs: 100,
});

// The leader waits on two children: one that TERM ends, one only KILL does. It prints its own
// pid — the group's id — and theirs, so the test can look for them afterwards.
const GROUP = `bash -c "trap '' TERM; exec sleep 300" & a=$!; sleep 300 & b=$!; ` +
  `echo "pids $$ $a $b"; wait`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(args: Partial<BackgroundRunArgs>) {
  const outcome = await jobs.run({ command: GROUP, label: "group", ...args });
  if (outcome.kind !== "started") throw new Error(`refused: ${JSON.stringify(outcome)}`);
  const id = outcome.job.id;
  for (let i = 0; i < 250; i++) {
    const out = jobs.output({ id });
    const match = out.kind === "job" ? /pids (\d+) (\d+) (\d+)/.exec(out.tail) : null;
    if (match !== null) {
      // At once, so a test that gives up on this process can still clear what it started.
      console.error(`group ${match[1]}`);
      return { id, pgid: Number(match[1]), pids: [Number(match[2]), Number(match[3])] };
    }
    await sleep(20);
  }
  throw new Error(`${id} never printed its pids`);
}

const recorded = (id: string) => {
  const out = jobs.output({ id });
  if (out.kind !== "job") throw new Error(`no job ${id}`);
  return out.job;
};

// A stop: TERM, and KILL after the grace for the member that ignores it.
const stopped = await start({});
await jobs.stop(stopped.id);

// A timeout: the minute is shrunk, so it fires in under a second.
const timed = await start({ timeoutMinutes: 1 });
for (let i = 0; i < 500 && recorded(timed.id).ended === null; i++) await sleep(20);

// The run's end: a service, and close (which is stopAll first).
const service = await start({ service: true });
await jobs.close(5_000);

await rm(root, { recursive: true }).catch(() => {});

console.log(JSON.stringify({
  jobs: [stopped, timed, service].map(({ id, pgid, pids }) => ({
    id,
    pgid,
    pids,
    ended: recorded(id).ended,
  })),
  warns,
}));
