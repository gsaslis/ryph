// Background jobs in a process of their own, as the runner runs them: a stop, a timeout and the
// run's end each have to take the whole group down — a member that ignores TERM included. The
// signal to the group is the runner's own kill(2) on `-pgid` (core/background.ts). Under Deno it
// went through bash, because the image's scoped --allow-run refused a direct kill: in the image
// no signal reached a job until this test ran under the image's flags.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { command } from "@ryph/process";
import { signalProcessGroup } from "../src/core/background.ts";

const PACKAGE = new URL("..", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/background_scoped.ts", import.meta.url).pathname;
/** Far past what the fixture takes (about two seconds) once its signals land. */
const DEADLINE_MS = 30_000;

/** Whether `-pgid` still names a group, or `pid` a process, from this (unscoped) side. */
async function exists(target: string): Promise<boolean> {
  const { code } = await command("bash", {
    args: ["-c", 'kill -0 -- "$1" 2>/dev/null', "probe", target],
  }).output();
  return code === 0;
}

interface Reported {
  jobs: Array<{
    id: string;
    pgid: number;
    pids: number[];
    ended: { reason: string; signal: string | null } | null;
  }>;
  warns: Array<{ event: string; fields?: Record<string, unknown> }>;
}

test("background: in a process of its own, every end takes the whole group", async () => {
  const proc = await command(process.execPath, {
    args: ["--no-env-file", FIXTURE],
    cwd: PACKAGE,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  // A signal that never arrives leaves a stop waiting forever: that is a failure, not a hang.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = await Promise.race([
    proc.status,
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), DEADLINE_MS))),
  ]);
  clearTimeout(timer);
  if (status === null) proc.kill("SIGKILL");
  const stderr = await err;
  const stdout = await out;
  const groups = [...stderr.matchAll(/^group (\d+)$/gm)].map((m) => Number(m[1]));
  const left: string[] = [];
  try {
    assert(status !== null, `the jobs did not all end within ${DEADLINE_MS} ms:\n${stderr}`);
    assertEquals(status.code, 0, `stderr:\n${stderr}`);
    const report: Reported = JSON.parse(stdout);
    assertEquals(report.warns, [], "nothing was warned of, a refused signal least of all");
    assertEquals(
      report.jobs.map((job) => job.ended?.reason),
      ["stopped", "timeout", "run_ended"],
    );
    for (const job of report.jobs) {
      if (await exists(`-${job.pgid}`)) left.push(`${job.id}: group ${job.pgid}`);
      for (const pid of job.pids) {
        if (await exists(String(pid))) left.push(`${job.id}: pid ${pid}`);
      }
    }
    assertEquals(left, [], "every job's group is gone");
  } finally {
    // What a failure left behind does not outlive the test.
    for (const pgid of groups) await signalProcessGroup(pgid, "SIGKILL");
  }
});

// TODO(bun): there is no run permission to scope. Under Deno this checked that the image's
// --allow-run refused a direct kill, the premise of the test above; Bun has no permission model,
// so the runner signals the group itself and nothing is left to refuse it (docs/runtime.md,
// What we lose).
test.skip("background: the compiled runner's run permission is scoped, and it may not signal a group", () => {});

test("background: a group that is gone is no failure; a pgid that is no job's is never signalled", async () => {
  const child = await command("bash", { args: ["-c", "exit 0"], detached: true }).spawn();
  await child.status;
  assertEquals(await signalProcessGroup(child.pid, "SIGTERM"), null);
  for (const pgid of [0, 1, -5, 1.5]) {
    const failed = await signalProcessGroup(pgid, "SIGTERM");
    assert(failed !== null, `pgid ${pgid} must be refused`);
    assertEquals(failed.code, null);
  }
});
