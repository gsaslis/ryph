// The agent's background commands, with real processes: a job's end told to the agent with its
// status and output, stdout and stderr in one log in the order they were written, a timeout and a
// stop ending the whole process group, the run's end stopping everything without a word, the
// limits and the bounds on what the agent passes, the idle-clock hold, the durable record in
// order, and the live lines shaped for the uplink.

import { test } from "bun:test";
import { command } from "@ryph/process";
import { readFileSync, statSync } from "node:fs";
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  type BackgroundDeps,
  livePieces,
  OutputRing,
  startBackgroundJobs,
  tailOf,
} from "../src/core/background.ts";
import type { BackgroundNoticeMessage } from "../src/core/types.ts";
import type {
  BackgroundEndedRecord,
  BackgroundStartedRecord,
  CommandLine,
} from "../src/ports/background.ts";
import type { BackgroundRunArgs, BackgroundRunOutcome } from "../src/ports/run_actions.ts";
import { recordingDiagnostics } from "./doubles/diagnostics.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  cond: () => boolean | Promise<boolean>,
  what: string,
  ms = 5_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Whether a pid is still running, not just waiting for its parent to reap it. */
async function alive(pid: number): Promise<boolean> {
  const { code, stdout } = await command("ps", {
    args: ["-o", "stat=", "-p", String(pid)],
  }).output();
  const state = new TextDecoder().decode(stdout).trim();
  // kill -0 also succeeds for a dead grandchild until its new parent reaps it.
  if (code === 1 && state === "") return false;
  assertEquals(code, 0, "ps could inspect the grandchild");
  return !state.startsWith("Z");
}

/** Jobs over a temp checkout root, with everything they tell recorded. */
async function fixture(over: Partial<BackgroundDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "runner-bg-root-"));
  const logs = await mkdtemp(join(tmpdir(), "runner-bg-logs-"));
  const notices: BackgroundNoticeMessage[] = [];
  const started: BackgroundStartedRecord[] = [];
  const records: Array<[string, string, unknown]> = [];
  const lines: CommandLine[] = [];
  const holds = { changed: 0 };
  const { diag, warns } = recordingDiagnostics();
  let replay: (() => CommandLine[]) | null = null;
  const jobs = startBackgroundJobs({
    diag,
    checkoutRoot: root,
    env: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", AGENT_ONLY: "yes" }),
    notice: (message) => {
      notices.push(message);
      return true;
    },
    holdChanged: () => holds.changed++,
    records: {
      started: (record) => {
        started.push(record);
        records.push(["started", record.id, record]);
        return Promise.resolve(true);
      },
      log: (id, text) => {
        records.push(["log", id, text]);
        return Promise.resolve(true);
      },
      ended: (id, record) => {
        records.push(["ended", id, record]);
        return Promise.resolve(true);
      },
    },
    uplink: {
      // As the adapter does: the first connection's replay is taken as it opens.
      // and, like it, drops what is sent before then.
      open: (r) => {
        replay = r;
        lines.push(...r());
      },
      send: (line) => {
        if (replay !== null) lines.push(line);
      },
      close: () => Promise.resolve(),
    },
    makeDir: () => Promise.resolve(logs),
    stopGraceMs: 300,
    endGraceMs: 300,
    leftoverGraceMs: 200,
    flushMs: 20,
    recordWaitMs: 200,
    releaseMs: 200,
    ...over,
  });
  return {
    jobs,
    root,
    notices,
    started,
    records,
    lines,
    holds,
    warns,
    replay: () => replay!(),
    async cleanup() {
      await jobs.close(2_000);
      await rm(root, { recursive: true }).catch(() => {});
      await rm(logs, { recursive: true }).catch(() => {});
    },
  };
}

async function start(
  fx: Awaited<ReturnType<typeof fixture>>,
  args: Partial<BackgroundRunArgs> & Pick<BackgroundRunArgs, "command">,
) {
  const outcome: BackgroundRunOutcome = await fx.jobs.run({ label: "a job", ...args });
  assert(outcome.kind === "started", JSON.stringify(outcome));
  return outcome.job;
}

const ended = (fx: Awaited<ReturnType<typeof fixture>>, id: string) => () => {
  const out = fx.jobs.output({ id });
  return out.kind === "job" && out.job.ended !== null;
};

/** A leader that exits once what it starts ignores TERM; that says "term" when one reaches it,
 * and holds the pipe until it is killed. */
const LEAVES_TERM_IGNORER = "bash -c \"trap 'echo term' TERM; : > trapped; while true; do " +
  'sleep 0.02; done" & until [ -e trapped ]; do sleep 0.01; done; exit 0';

/** The job's output so far, or nothing for one there is no job of. */
const tail = (fx: Awaited<ReturnType<typeof fixture>>, id: string) => {
  const out = fx.jobs.output({ id });
  return out.kind === "job" ? out.tail : "";
};

test("background: readiness matches cleaned output across chunks once, without ending the service", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, {
      command: "printf '\\033[32mREA'; sleep 0.1; printf 'DY\\033[0m\\nREADY\\n' >&2; sleep 0.3",
      service: true,
      readyWhen: "READY",
    });
    await until(() => fx.notices.length > 0, "readiness notice");
    assertEquals(fx.notices.map((n) => n.background.reason), ["ready"]);
    const output = fx.jobs.output({ id: job.id });
    assert(output.kind === "job");
    assertEquals(output.job.ended, null);
    assert(typeof output.job.readyAt === "string");
    assertEquals(fx.jobs.holdUntil(), null);
    await until(() => fx.notices.length === 2, "subsequent service exit");
    assertEquals(fx.notices.map((n) => n.background.reason), ["ready", "exited"]);
  } finally {
    await fx.cleanup();
  }
});

test("background: readiness waits for start recording and is suppressed by stop", async () => {
  let release!: () => void;
  const recorded = new Promise<void>((resolve) => release = resolve);
  const fx = await fixture({
    records: {
      started: async () => {
        await recorded;
        return true;
      },
      ended: () => Promise.resolve(true),
      log: () => Promise.resolve(true),
    },
    recordWaitMs: 2_000,
  });
  try {
    const starting = start(fx, {
      command: "printf READY; sleep 30",
      service: true,
      readyWhen: "READY",
    });
    await until(() => {
      const output = fx.jobs.output({ id: "bg-1" });
      return output.kind === "job" && output.job.readyAt != null;
    }, "marker before start recorded");
    assertEquals(fx.notices, []);
    release();
    const job = await starting;
    assertEquals(fx.notices.map((n) => n.background.reason), ["ready"]);
    await fx.jobs.stop(job.id);
    assertEquals(fx.notices.length, 1);
  } finally {
    release();
    await fx.cleanup();
  }
});

test("background: missing or partial markers never report ready; stopped output cannot report ready", async () => {
  const fx = await fixture();
  try {
    const exited = await start(fx, { command: "printf REA", service: true, readyWhen: "READY" });
    await until(() => fx.notices.length === 1, "exit without marker");
    assertEquals(fx.notices[0].background.reason, "exited");
    const output = fx.jobs.output({ id: exited.id });
    assert(output.kind === "job");
    assertEquals(output.job.readyAt, null);
    const stopped = await start(fx, {
      command: "trap 'printf READY; exit 0' TERM; printf BOOTED; while :; do sleep 0.1; done",
      service: true,
      readyWhen: "READY",
    });
    await until(() => {
      const output = fx.jobs.output({ id: stopped.id });
      return output.kind === "job" && output.tail.includes("BOOTED");
    }, "trap installed");
    await fx.jobs.stop(stopped.id);
    assertEquals(fx.notices.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("background: readyWhen is bounded plain text and requires a service", async () => {
  const fx = await fixture();
  try {
    for (
      const args of [
        { readyWhen: "READY" },
        { service: true, readyWhen: "" },
        { service: true, readyWhen: "  " },
        { service: true, readyWhen: "x".repeat(1001) },
        { service: true, readyWhen: "\u001b[32mREADY" },
      ]
    ) {
      assertEquals(
        (await fx.jobs.run({ command: "true", label: "invalid", ...args })).kind,
        "refused",
      );
    }
  } finally {
    await fx.cleanup();
  }
});

test("background: an exit is told to the agent with its code and output, and logged in order", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, {
      command: "echo one; echo two >&2; echo three; exit 3",
      label: "three lines",
    });
    assertEquals(job.id, "bg-1");
    assertMatch(job.logPath, /bg-1\.log$/);
    await until(() => fx.notices.length === 1, "the notice");
    const notice = fx.notices[0];
    assertEquals(notice.kind, "system");
    assertEquals(notice.sender, { kind: "platform" });
    assertEquals(notice.background.id, "bg-1");
    assertEquals(notice.background.label, "three lines");
    assertEquals(notice.background.reason, "exited");
    assertEquals(notice.background.exitCode, 3);
    assertEquals(notice.background.signal, null);
    assertStringIncludes(notice.text, 'Background command bg-1 ("three lines") exited with code 3');
    assertStringIncludes(notice.text, "Its last 3 lines:\n\none\ntwo\nthree");
    assertStringIncludes(notice.text, job.logPath);
    // One pipe: stderr lands between the stdout lines it was written between.
    assertEquals(await readFile(job.logPath, "utf8"), "one\ntwo\nthree\n");
    const out = fx.jobs.output({ id: "bg-1", tailLines: 2 });
    assert(out.kind === "job");
    assertEquals(out.tail, "two\nthree");
    assertEquals(out.lines, 2);
    assertEquals(out.job.ended?.reason, "exited");
  } finally {
    await fx.cleanup();
  }
});

test("background: a job gets the agent's env and none of the runner's, in the cwd it names", async () => {
  const fx = await fixture();
  try {
    process.env.RUNNER_ONLY_VAR = "nope";
    await mkdir(`${fx.root}/repo/sub`, { recursive: true });
    const job = await start(fx, {
      command: 'echo "$AGENT_ONLY ${RUNNER_ONLY_VAR:-unset}"; pwd',
      cwd: "repo/sub",
    });
    assertEquals(job.cwd, `${fx.root}/repo/sub`);
    await until(ended(fx, job.id), "the end");
    const text = await readFile(job.logPath, "utf8");
    assertStringIncludes(text, "yes unset\n");
    assertStringIncludes(text, "/repo/sub\n");
    // The default is the checkout root, where pi's bash starts.
    const plain = await start(fx, { command: "true" });
    assertEquals(plain.cwd, fx.root);
  } finally {
    delete process.env.RUNNER_ONLY_VAR;
    await fx.cleanup();
  }
});

test("background: a timeout ends the whole group, grandchildren included, and is told", async () => {
  const fx = await fixture({ minuteMs: 1_500 });
  try {
    const job = await start(fx, {
      command: `sleep 300 & echo $! > ${"$PWD"}/child.pid; sleep 300`,
      timeoutMinutes: 1,
    });
    await until(() => {
      try {
        return readFileSync(`${fx.root}/child.pid`, "utf8").trim() !== "";
      } catch {
        return false;
      }
    }, "the grandchild's pid");
    const child = Number(readFileSync(`${fx.root}/child.pid`, "utf8").trim());
    assert(await alive(child));
    await until(() => fx.notices.length === 1, "the timeout's notice");
    assertEquals(fx.notices[0].background.reason, "timeout");
    assertEquals(fx.notices[0].background.signal, "SIGTERM");
    assertStringIncludes(fx.notices[0].text, "timed out and was stopped");
    // The leader's notice and the grandchild's exit are independently scheduled. Wait for
    // the latter, without requiring the orphan's new parent to have reaped its zombie too.
    await until(async () => !await alive(child), "the grandchild to exit");
    const out = fx.jobs.output({ id: job.id });
    assert(out.kind === "job");
    assertEquals(out.job.ended?.reason, "timeout");
  } finally {
    await fx.cleanup();
  }
});

test("background: a job that ignores TERM is killed after the grace", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, {
      command: "trap '' TERM; echo ready; while true; do sleep 0.05; done",
    });
    await until(() =>
      fx.jobs.output({ id: job.id }).kind === "job" &&
      (fx.jobs.output({ id: job.id }) as { tail: string }).tail.includes("ready"), "ready");
    const t0 = Date.now();
    const stopped = await fx.jobs.stop(job.id);
    assert(stopped.kind === "stopped");
    assertEquals(stopped.already, false);
    assertEquals(stopped.job.ended?.reason, "stopped");
    assertEquals(stopped.job.ended?.signal, "SIGKILL");
    assert(Date.now() - t0 >= 250, "killed only after the grace");
    // A stop by the agent sends no notice.
    await sleep(50);
    assertEquals(fx.notices, []);
  } finally {
    await fx.cleanup();
  }
});

test("background: stop ends a job once, reports it again after, and a double stop agrees", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, { command: "sleep 300" });
    const [a, b] = await Promise.all([fx.jobs.stop(job.id), fx.jobs.stop(job.id)]);
    assert(a.kind === "stopped" && b.kind === "stopped");
    assertEquals(a.job.ended?.reason, "stopped");
    assertEquals(b.job.ended?.reason, "stopped");
    const again = await fx.jobs.stop(job.id);
    assert(again.kind === "stopped");
    assertEquals(again.already, true);
    assertEquals(fx.notices, []);
    // An id that is not one is refused, and says which there are.
    const unknown = await fx.jobs.stop("../etc");
    assert(unknown.kind === "refused");
    assertStringIncludes(unknown.reason, "it has bg-1");
  } finally {
    await fx.cleanup();
  }
});

test("background: a stop racing a natural exit sends no notice and records one ending", async () => {
  // A wide leftover grace: the late stop below must land while what the leader left is ended.
  const fx = await fixture({ leftoverGraceMs: 2_000 });
  try {
    // A stop that found the job still there (`already: false`) is a stop, told to nobody —
    // even one that lands after the leader exited, while what it left is being ended.
    const asked: string[] = [];
    for (let i = 0; i < 5; i++) {
      const job = await start(fx, { command: "sleep 0.05" });
      await sleep(45 + i * 5);
      const stopped = await fx.jobs.stop(job.id);
      assert(stopped.kind === "stopped");
      const reason = stopped.job.ended?.reason;
      if (!stopped.already) {
        asked.push(job.id);
        assertEquals(reason, "stopped");
      } else assertEquals(reason, "exited");
    }
    // The leader gone, the pipe still held by what it left: a stop now is still a stop. The
    // group's TERM goes out only once the leader's exit is seen, and what it left says so.
    const leftover = await start(fx, {
      command: LEAVES_TERM_IGNORER,
    });
    await until(() => tail(fx, leftover.id).includes("term"), "the leader's exit", 20_000);
    const late = await fx.jobs.stop(leftover.id);
    assert(late.kind === "stopped");
    assertEquals([late.already, late.job.ended?.reason], [false, "stopped"]);
    asked.push(leftover.id);
    await until(() => fx.records.filter(([what]) => what === "ended").length === 6, "records");
    const endings = fx.records.filter(([what]) => what === "ended").map(([, id]) => id);
    assertEquals(new Set(endings).size, 6);
    await sleep(50);
    for (const notice of fx.notices) {
      assert(!asked.includes(notice.background.id), `${notice.background.id} was told`);
    }
  } finally {
    await fx.cleanup();
  }
});

test("background: the run's end stops every job without a word, and nothing new starts", async () => {
  const fx = await fixture();
  try {
    const a = await start(fx, { command: "sleep 300" });
    const b = await start(fx, { command: "sleep 300", service: true });
    const done = await start(fx, { command: "true" });
    await until(ended(fx, done.id), "the quick one");
    const before = fx.notices.length;
    await fx.jobs.stopAll();
    for (const id of [a.id, b.id]) {
      const out = fx.jobs.output({ id });
      assert(out.kind === "job");
      assertEquals(out.job.ended?.reason, "run_ended");
    }
    assertEquals(fx.notices.length, before);
    const late = await fx.jobs.run({ command: "true", label: "late" });
    assert(late.kind === "refused");
    assertStringIncludes(late.reason, "The run is ending");
    // Idempotent.
    await fx.jobs.stopAll();
  } finally {
    await fx.cleanup();
  }
});

test("background: a service's end is told as unexpected, and a service holds no clock", async () => {
  const fx = await fixture();
  try {
    const service = await start(fx, { command: "sleep 0.2; exit 1", service: true });
    assertEquals(fx.jobs.holdUntil(), null);
    await until(() => fx.notices.length === 1, "the notice");
    assertStringIncludes(fx.notices[0].text, "started as a service");
    assertEquals(fx.notices[0].background.id, service.id);
  } finally {
    await fx.cleanup();
  }
});

test("background: a running job holds the idle clock past its timeout, and lets go when it ends", async () => {
  const fx = await fixture();
  try {
    assertEquals(fx.jobs.holdUntil(), null);
    const changed = fx.holds.changed;
    const job = await start(fx, { command: "sleep 300", timeoutMinutes: 5 });
    assert(fx.holds.changed > changed);
    const until_ = fx.jobs.holdUntil();
    assert(until_ !== null);
    assert(until_ > Date.parse(job.timeoutAt), "past the timeout: the kill grace and the reap");
    const before = fx.holds.changed;
    await fx.jobs.stop(job.id);
    assertEquals(fx.jobs.holdUntil(), null);
    assert(fx.holds.changed > before);
  } finally {
    await fx.cleanup();
  }
});

test("background: what the agent passes is bounded", async () => {
  const fx = await fixture();
  try {
    const refused = async (args: BackgroundRunArgs, says: string) => {
      const outcome = await fx.jobs.run(args);
      assert(outcome.kind === "refused", JSON.stringify(outcome));
      assertStringIncludes(outcome.reason, says);
    };
    await refused({ command: "  ", label: "x" }, "command must be");
    await refused({ command: "x".repeat(16 * 1024 + 1), label: "x" }, "over 16 KiB");
    await refused({ command: "true", label: " \n " }, "label must say");
    await refused({ command: "true", label: "x".repeat(81) }, "label must say");
    // Counted as the historian and the control plane count it: UTF-16 units.
    await refused({ command: "true", label: "😀".repeat(41) }, "label must say");
    await refused({ command: "true", label: "x", timeoutMinutes: 0 }, "timeoutMinutes");
    await refused({ command: "true", label: "x", timeoutMinutes: 121 }, "timeoutMinutes");
    await refused({ command: "true", label: "x", timeoutMinutes: 1.5 }, "timeoutMinutes");
    await refused({ command: "true", label: "x", cwd: "nowhere" }, "does not exist");
    await writeFile(`${fx.root}/file`, "");
    await refused({ command: "true", label: "x", cwd: "file" }, "is not a directory");
    // A label's line breaks and control characters become spaces.
    const job = await start(fx, { command: "true", label: "unit\ntests\x1b" });
    assertEquals(job.label, "unit tests");
    // Ids are minted, in order, and only refusals mint none.
    assertEquals(job.id, "bg-1");
    const bad = fx.jobs.output({ id: "bg-1", tailLines: 0 });
    assert(bad.kind === "refused");
  } finally {
    await fx.cleanup();
  }
});

test("background: a run whose shell has not started refuses", async () => {
  const fx = await fixture({ env: () => null });
  try {
    const outcome = await fx.jobs.run({ command: "true", label: "x" });
    assert(outcome.kind === "refused");
    assertStringIncludes(outcome.reason, "shell has not started");
  } finally {
    await fx.cleanup();
  }
});

test("background: at most eight run at once, and sixty-four in a run", async () => {
  const fx = await fixture();
  try {
    const running = await Promise.all(
      Array.from({ length: 8 }, () => fx.jobs.run({ command: "sleep 300", label: "s" })),
    );
    assert(running.every((o) => o.kind === "started"));
    const ninth = await fx.jobs.run({ command: "true", label: "x" });
    assert(ninth.kind === "refused");
    assertStringIncludes(ninth.reason, "8 background commands are already running");
    for (const o of running) if (o.kind === "started") await fx.jobs.stop(o.job.id);
    for (let i = 8; i < 64; i++) {
      const o = await fx.jobs.run({ command: "true", label: "t" });
      assert(o.kind === "started", `${i}: ${JSON.stringify(o)}`);
      await until(ended(fx, o.job.id), `job ${o.job.id}`);
    }
    const over = await fx.jobs.run({ command: "true", label: "x" });
    assert(over.kind === "refused");
    assertStringIncludes(over.reason, "started 64 background commands");
    const list = fx.jobs.output({});
    assert(list.kind === "list");
    assertEquals(list.jobs.length, 64);
    assertEquals(list.jobs.at(-1)!.id, "bg-64");
  } finally {
    await fx.cleanup();
  }
});

test("background: the raw log stops at 16 MiB with a closing line; the stored log goes on", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, {
      command:
        "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | " +
        "head -c 17000000; echo; echo tail-line",
    });
    await until(ended(fx, job.id), "the end", 20_000);
    const size = (await stat(job.logPath)).size;
    const closing = "\n[ryph: log truncated at 16 MiB]\n";
    assertEquals(size, 16 * 1024 * 1024 + closing.length);
    const file = await open(job.logPath, "r");
    const end = new Uint8Array(closing.length);
    await file.read(end, 0, end.length, size - closing.length);
    await file.close();
    assertEquals(new TextDecoder().decode(end), closing);
    // The ring kept flowing past the cap: the agent still sees the end.
    const out = fx.jobs.output({ id: job.id, tailLines: 1 });
    assert(out.kind === "job");
    assertEquals(out.tail, "tail-line");
    await until(() => fx.records.some(([what]) => what === "ended"), "the record");
    const record = fx.records.find(([what]) => what === "ended")![2] as BackgroundEndedRecord;
    // The record describes the stored log, the people's view: past the upload's 4 MiB.
    assertEquals(record.logTruncated, true);
    assert(record.logBytes > 16 * 1024 * 1024, `${record.logBytes}`);
    const log = await storedLog(fx);
    assert(new TextEncoder().encode(log).byteLength <= 4 * 1024 * 1024);
    // The stored log is the people's view, which the raw log's cap never stopped.
    assert(log.endsWith("a\ntail-line\n"), JSON.stringify(log.slice(-120)));
    assert(log.startsWith("a".repeat(78) + "\n"), "from a line's start");
  } finally {
    await fx.cleanup();
  }
});

test("background: each job's record goes up in order, and close waits for it, bounded", async () => {
  const order: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const fx = await fixture({
    records: {
      started: async (r) => {
        await slow;
        order.push(`started ${r.id} ${r.command} ${r.service}`);
        return true;
      },
      log: (id, text) => {
        order.push(`log ${id} ${JSON.stringify(text)}`);
        return Promise.resolve(true);
      },
      ended: (id, r) => {
        order.push(`ended ${id} ${r.reason} ${r.exitCode} ${JSON.stringify(r.logTail)}`);
        return Promise.resolve(true);
      },
    },
  });
  try {
    const job = await start(fx, { command: "printf '\\033[31mred\\033[0m\\n'; exit 2" });
    await until(ended(fx, job.id), "the end");
    // The started record is still out: nothing after it has gone.
    assertEquals(order, []);
    release();
    await fx.jobs.close(2_000);
    assertEquals(order, [
      "started bg-1 printf '\\033[31mred\\033[0m\\n'; exit 2 false",
      `ended bg-1 exited 2 "red"`,
      // Cleaned, as people saw it.
      `log bg-1 ${JSON.stringify("red\n")}`,
    ]);
    // Removed once the records are in.
    await stat(job.logPath).then(
      () => assert(false, "the log outlived close"),
      () => {},
    );
  } finally {
    await fx.cleanup();
  }
});

test("background: a record that never answers holds close only to its bound", async () => {
  const fx = await fixture({
    records: {
      started: () => new Promise<boolean>(() => {}),
      log: () => Promise.resolve(true),
      ended: () => Promise.resolve(true),
    },
  });
  try {
    await start(fx, { command: "true" });
    const t0 = Date.now();
    await fx.jobs.close(200);
    assert(Date.now() - t0 < 2_000);
    assert(fx.warns.some((w) => w.event === "background.records_unfinished"));
  } finally {
    await fx.cleanup();
  }
});

test("background: the uplink gets started, ANSI-free output and exited, and a replay of it all", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, {
      command: "printf '\\033[1mbold\\033[0m\\r\\n'; sleep 0.1; echo plain; exit 4",
      label: "lines",
    });
    await until(ended(fx, job.id), "the end");
    const types = fx.lines.map((l) => l.type);
    assertEquals(types[0], "started");
    assertEquals(types.at(-1), "exited");
    const started = fx.lines[0];
    assert(started.type === "started");
    assertEquals(started.id, "bg-1");
    assertEquals(started.label, "lines");
    assertEquals(started.cwd, fx.root);
    assertEquals(started.service, false);
    const text = fx.lines.flatMap((l) => l.type === "output" ? [l.text] : []).join("");
    assertEquals(text, "bold\nplain\n");
    const exited = fx.lines.at(-1)!;
    assert(exited.type === "exited");
    assertEquals([exited.reason, exited.exitCode, exited.signal], ["exited", 4, null]);
    // A new connection opens with the whole picture.
    const replay = fx.replay();
    assertEquals(replay.map((l) => l.type), ["started", "output", "exited"]);
    assertEquals((replay[1] as { text: string }).text, "bold\nplain\n");
  } finally {
    await fx.cleanup();
  }
});

/** Whether the uplink kept to its budget: every byte sent or told skipped, at most 64 KiB in
 * any one window, `skipped` at most once a window, and every line under the historian's cap. */
async function budgetKept(command: string, total: number) {
  const fx = await fixture({ flushMs: 50 });
  try {
    const t0 = Date.now();
    const job = await start(fx, { command });
    await until(ended(fx, job.id), "the end", 20_000);
    const windows = Math.ceil((Date.now() - t0) / 1_000) + 1;
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
    const sent = fx.lines.flatMap((l) => l.type === "output" ? [bytes(l.text)] : [])
      .reduce((a, b) => a + b, 0);
    const skips = fx.lines.flatMap((l) => l.type === "skipped" ? [l.bytes] : []);
    const skipped = skips.reduce((a, b) => a + b, 0);
    assert(skipped > 0, "something was skipped");
    assertEquals(sent + skipped, total);
    assert(sent <= 64 * 1024 * windows, `${sent} bytes in ${windows} windows`);
    assert(skips.length <= windows, `${skips.length} skipped lines in ${windows} windows`);
    for (const line of fx.lines) {
      assert(new TextEncoder().encode(JSON.stringify(line)).byteLength <= 16 * 1024);
    }
  } finally {
    await fx.cleanup();
  }
}

test("background: past 64 KiB a second the uplink is told what was skipped, not sent it", async () => {
  await budgetKept("head -c 400000 /dev/zero | tr '\\0' 'x'", 400_000);
});

test("background: the live budget counts UTF-8 bytes, not characters", async () => {
  await budgetKept(`perl -e 'print "\\xc3\\xa9" x 200000'`, 400_000);
});

test("background: a notice that cannot be delivered, or throws, costs nothing", async () => {
  const fx = await fixture({
    notice: () => {
      throw new Error("the conversation is gone");
    },
  });
  try {
    const job = await start(fx, { command: "exit 1" });
    await until(ended(fx, job.id), "the end");
    assert(fx.warns.some((w) => w.event === "background.notice_failed"));
    const next = await start(fx, { command: "true" });
    assertEquals(next.id, "bg-2");
  } finally {
    await fx.cleanup();
  }
});

test("background: a pipe a leftover holds open is let go, and the job still ends", async () => {
  const fx = await fixture();
  try {
    // The leftover leaves the job's group, so no signal to the group reaches it.
    const job = await start(fx, {
      command: "perl -e 'setpgrp(0,0); sleep 30' & sleep 0.1; echo leader-done",
    });
    await until(ended(fx, job.id), "the end", 5_000);
    const out = fx.jobs.output({ id: job.id });
    assert(out.kind === "job");
    assertEquals(out.job.ended?.reason, "exited");
    assertEquals(out.job.ended?.exitCode, 0);
    assert(fx.warns.some((w) => w.event === "background.pipe_held"));
  } finally {
    await command("pkill", { args: ["-f", "setpgrp\\(0,0\\); sleep 30"] }).output()
      .catch(() => {});
    await fx.cleanup();
  }
});

test("output shaping: the ring keeps the last lines and characters, tails are bounded", () => {
  const ring = new OutputRing();
  for (let i = 1; i <= 2500; i++) ring.append(`line ${i}\n`);
  const lines = ring.text.split("\n").filter((l) => l !== "");
  assertEquals(lines.length, 2000);
  assertEquals(lines[0], "line 501");
  const big = new OutputRing();
  big.append("y".repeat(300 * 1024));
  assertEquals(big.text.length, 256 * 1024);
  assertEquals(tailOf("a\nb\nc\n", 2, 100), { text: "b\nc", lines: 2 });
  assertEquals(tailOf("", 2, 100), { text: "", lines: 0 });
  assertEquals(tailOf("aaaa\nbbbb\n", 2, 6), { text: "bbbb", lines: 1 });
  assertEquals(tailOf("abcdefgh", 1, 3), { text: "fgh", lines: 1 });
});

test("output shaping: live pieces fit a line and never split a surrogate pair", () => {
  const pieces = livePieces("é".repeat(20_000));
  assertEquals(pieces.join(""), "é".repeat(20_000));
  for (const piece of pieces) {
    assert(piece.length <= 8 * 1024);
    assert(new TextEncoder().encode(JSON.stringify(piece)).byteLength <= 15 * 1024);
  }
  // A surrogate pair is never split between two pieces.
  const emoji = livePieces("a" + "😀".repeat(5_000));
  for (const piece of emoji) assert(!/[\ud800-\udbff]$/.test(piece));
  assertEquals(emoji.join(""), "a" + "😀".repeat(5_000));
});

test("background: a log that is not UTF-8 still goes up within the control plane's cap", async () => {
  const fx = await fixture();
  try {
    // 5 MiB of bytes that are no UTF-8: each decodes to three bytes of replacement character.
    const job = await start(fx, {
      command: `perl -e 'print "\\xff" x 99, "\\n" for 1..52429'`,
    });
    await until(() => fx.records.some(([what]) => what === "log"), "the log", 20_000);
    const log = fx.records.find(([what]) => what === "log")![2] as string;
    assert(new TextEncoder().encode(log).byteLength <= 4 * 1024 * 1024);
    assert(log.length > 0);
    assertEquals(job.id, "bg-1");
  } finally {
    await fx.cleanup();
  }
});

test("background: a \\r\\n split across two reads is one line break, live", async () => {
  const fx = await fixture({ releaseMs: 2_000 });
  try {
    const job = await start(fx, { command: "printf 'a\\r'; sleep 0.2; printf '\\nb\\n'" });
    // (The release, at 2 s here, lets a `\r` go only when nothing follows it for that long.)
    await until(ended(fx, job.id), "the end");
    const live = fx.lines.flatMap((l) => l.type === "output" ? [l.text] : []).join("");
    assertEquals(live, "a\nb\n");
  } finally {
    await fx.cleanup();
  }
});

test("background: a log path the agent planted is never written through, and the job still runs", async () => {
  const logs = await mkdtemp(join(tmpdir(), "runner-bg-planted-"));
  const target = `${logs}/elsewhere`;
  await writeFile(target, "untouched");
  await symlink(target, `${logs}/bg-1.log`);
  const fx = await fixture({ makeDir: () => Promise.resolve(logs) });
  try {
    const job = await start(fx, { command: "echo hi; exit 5" });
    await until(() => fx.notices.length === 1, "the notice");
    assertEquals(await readFile(target, "utf8"), "untouched");
    assertStringIncludes(fx.notices[0].text, "hi");
    // The stored log is the view this side wrote, never the planted path.
    await until(() => fx.records.some(([what]) => what === "log"), "the log");
    assertEquals(fx.records.find(([what]) => what === "log")![2], "hi\n");
    assertEquals(job.id, "bg-1");
  } finally {
    await fx.cleanup();
    await rm(logs, { recursive: true }).catch(() => {});
  }
});

test("background: a log upload that never answers does not hold the exit record", async () => {
  const sent: string[] = [];
  const fx = await fixture({
    logStepMs: 100,
    records: {
      started: () => Promise.resolve(true),
      log: () => new Promise<boolean>(() => {}),
      ended: (id, r) => {
        sent.push(`${id} ${r.reason}`);
        return Promise.resolve(true);
      },
    },
  });
  try {
    await start(fx, { command: "exit 0" });
    await until(() => sent.length === 1, "the exit record");
    assertEquals(sent, ["bg-1 exited"]);
  } finally {
    await fx.cleanup();
  }
});

test("background: each job is started once on the uplink, the first by its replay", async () => {
  const fx = await fixture();
  try {
    for (let i = 0; i < 3; i++) await start(fx, { command: "true" });
    for (const id of ["bg-1", "bg-2", "bg-3"]) {
      await until(ended(fx, id), id);
      const started = fx.lines.filter((l) => l.type === "started" && l.id === id);
      assertEquals(started.length, 1, id);
    }
  } finally {
    await fx.cleanup();
  }
});

test("background: the record of a start and an end lands before anyone is told of it", async () => {
  const order: string[] = [];
  const fx = await fixture({
    recordWaitMs: 2_000,
    notice: (m) => {
      order.push(`notice ${m.background.id}`);
      return true;
    },
    records: {
      started: async (r) => {
        await sleep(100);
        order.push(`started ${r.id}`);
        return true;
      },
      log: () => Promise.resolve(true),
      ended: async (id) => {
        await sleep(100);
        order.push(`ended ${id}`);
        return true;
      },
    },
    uplink: {
      open: (replay) => {
        order.push("live open");
        for (const line of replay()) order.push(`live ${line.type}`);
      },
      send: (line) => order.push(`live ${line.type}`),
      close: () => Promise.resolve(),
    },
  });
  try {
    await start(fx, { command: "exit 1" });
    order.push("answered");
    await until(() => order.includes("notice bg-1"), "the notice");
    assertEquals(order.filter((o) => !o.startsWith("live output")), [
      "started bg-1",
      "live open",
      "live started",
      "answered",
      "ended bg-1",
      "live exited",
      "notice bg-1",
    ]);
  } finally {
    await fx.cleanup();
  }
});

const liveText = (lines: CommandLine[]) =>
  lines.flatMap((l) => l.type === "output" ? [l.text] : []).join("");

test("background: stopping everything keeps a natural exit's reason", async () => {
  const fx = await fixture();
  try {
    // The leader exits; what it left ignores TERM and holds the pipe a while. The group's TERM
    // goes out only once the leader's exit is seen, and what it left says so: stopAll lands after.
    const job = await start(fx, {
      command: LEAVES_TERM_IGNORER,
    });
    await until(() => tail(fx, job.id).includes("term"), "the leader's exit", 20_000);
    await fx.jobs.stopAll();
    const out = fx.jobs.output({ id: job.id });
    assert(out.kind === "job");
    assertEquals(out.job.ended?.reason, "exited");
  } finally {
    await fx.cleanup();
  }
});

test("background: the live started line fits the historian's cap whatever the command", async () => {
  const fx = await fixture();
  try {
    // Lone surrogates encode to six bytes of JSON each.
    await start(fx, { command: `true # ${"\ud800".repeat(2_040)}` });
    const started = fx.lines.find((l) => l.type === "started")!;
    assert(new TextEncoder().encode(JSON.stringify(started)).byteLength <= 16 * 1024);
  } finally {
    await fx.cleanup();
  }
});

// ---- leaks found in review, each through a real job --------------------------------------

test("background: C1, bidi and control characters are cleaned from output, label, command and cwd", async () => {
  const fx = await fixture();
  try {
    await mkdir(`${fx.root}/work\u202edir`);
    const job = await start(fx, {
      command: `printf 'ab\\302\\205cd\\342\\200\\256ef\\001!\\n' # note\u2066s`,
      label: "deploy\u0085 now",
      cwd: "work\u202edir",
    });
    await until(() => fx.notices.length === 1, "the notice");
    assertEquals(liveText(fx.lines), "abcdef!\n");
    assertEquals(job.label, "deploy now");
    assertEquals(job.cwd, `${fx.root}/workdir`);
    assert(job.command.endsWith("# notes"), job.command);
    assertEquals(fx.started[0].label, "deploy now");
    assert(fx.started[0].command.endsWith("# notes"));
  } finally {
    await fx.cleanup();
  }
});

test("background: no live line of a job goes before its started", async () => {
  let first = true;
  const fx = await fixture({
    recordWaitMs: 2_000,
    records: {
      started: async () => {
        // The second job's start record is slow; its output is printed meanwhile.
        if (!first) await sleep(1_000);
        first = false;
        return true;
      },
      log: () => Promise.resolve(true),
      ended: () => Promise.resolve(true),
    },
  });
  try {
    await start(fx, { command: "sleep 5" });
    await start(fx, { command: "echo hello; sleep 0.3" });
    await until(
      () => fx.lines.some((l) => l.id === "bg-2" && l.type === "exited"),
      "its exited",
    );
    const bg2 = fx.lines.filter((l) => l.id === "bg-2");
    assertEquals(bg2[0].type, "started");
    assertEquals(liveText(bg2), "hello\n");
    assertEquals(bg2.at(-1)!.type, "exited");
  } finally {
    await fx.cleanup();
  }
});

test("background: the log goes up only once the end has landed, however long that takes", async () => {
  const order: string[] = [];
  let endLands = true;
  const fx = await fixture({
    recordWaitMs: 100,
    records: {
      started: () => Promise.resolve(true),
      ended: async (id) => {
        // Slower than the wait before people are told: the log still waits for it.
        await sleep(400);
        order.push(`ended ${id}`);
        return endLands;
      },
      log: (id) => {
        order.push(`log ${id}`);
        return Promise.resolve(true);
      },
    },
  });
  try {
    await start(fx, { command: "echo one" });
    await until(() => order.includes("log bg-1"), "the log");
    assertEquals(order, ["ended bg-1", "log bg-1"]);
    // An end that never lands takes the log with it.
    endLands = false;
    await start(fx, { command: "echo two" });
    await until(() => order.includes("ended bg-2"), "the second end");
    await fx.jobs.close(2_000);
    assert(!order.includes("log bg-2"), order.join(", "));
    assert(fx.warns.some((w) => w.event === "background.log_skipped"));
  } finally {
    await fx.cleanup();
  }
});

// ---- round 4 ------------------------------------------------------------------------------

test("background: progress redraws keep one line, so the error before them stays in view (4)", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, {
      command: `echo "error: the thing broke"; ` +
        `perl -e '$|=1; print "progress $_%\\r" for 1..2500'; echo; exit 1`,
    });
    await until(() => fx.notices.length === 1, "the notice");
    assertStringIncludes(fx.notices[0].text, "error: the thing broke");
    const out = fx.jobs.output({ id: job.id });
    assert(out.kind === "job");
    assertEquals(out.tail, "error: the thing broke\nprogress 2500%");
    await until(() => fx.records.some(([what]) => what === "ended"), "the record");
    const record = fx.records.find(([what]) => what === "ended")![2] as BackgroundEndedRecord;
    assertStringIncludes(record.logTail, "error: the thing broke");
    // People still see each redraw, as a line.
    assertStringIncludes(liveText(fx.lines), "progress 1%\nprogress 2%\n");
  } finally {
    await fx.cleanup();
  }
});

test("background: a stored log with no line break still goes up (5)", async () => {
  for (
    const command of [
      `perl -e 'print "x" x 5000000'`,
      `perl -e 'print "progress $_\\r" for 1..300000'`,
    ]
  ) {
    const fx = await fixture();
    try {
      await start(fx, { command });
      await until(() => fx.records.some(([what]) => what === "log"), "the log", 20_000);
      const log = fx.records.find(([what]) => what === "log")![2] as string;
      assert(log.length > 1_000_000, `${log.length} chars for ${command}`);
      assert(new TextEncoder().encode(log).byteLength <= 4 * 1024 * 1024);
    } finally {
      await fx.cleanup();
    }
  }
});

test("background: a job that ends before its slow start record lands is told started, output, exited", async () => {
  let first = true;
  const fx = await fixture({
    recordWaitMs: 2_000,
    records: {
      started: async () => {
        if (!first) await sleep(600);
        first = false;
        return true;
      },
      log: () => Promise.resolve(true),
      ended: () => Promise.resolve(true),
    },
  });
  try {
    await start(fx, { command: "sleep 5" });
    await start(fx, { command: "echo quick" });
    await until(
      () => fx.lines.some((l) => l.id === "bg-2" && l.type === "exited"),
      "its exited",
    );
    const bg2 = fx.lines.filter((l) => l.id === "bg-2");
    assertEquals(bg2.map((l) => l.type), ["started", "output", "exited"]);
    assertEquals(liveText(bg2), "quick\n");
  } finally {
    await fx.cleanup();
  }
});

test("background: what a job printed before its started goes after it, the last 64 KiB of it", async () => {
  let first = true;
  const fx = await fixture({
    recordWaitMs: 2_000,
    records: {
      started: async () => {
        if (!first) await sleep(500);
        first = false;
        return true;
      },
      log: () => Promise.resolve(true),
      ended: () => Promise.resolve(true),
    },
  });
  try {
    await start(fx, { command: "sleep 5" });
    await start(fx, { command: `perl -e 'print "x" x 99999, "\\n"'; sleep 1.5` });
    await until(
      () => fx.lines.some((l) => l.id === "bg-2" && l.type === "exited"),
      "its exited",
      5_000,
    );
    const bg2 = fx.lines.filter((l) => l.id === "bg-2");
    const sent = liveText(bg2);
    const skipped = bg2.flatMap((l) => l.type === "skipped" ? [l.bytes] : [])
      .reduce((a, b) => a + b, 0);
    assertEquals(new TextEncoder().encode(sent).byteLength, 64 * 1024);
    assertEquals(skipped, 100_000 - 64 * 1024);
    assert(sent.endsWith("x\n"));
  } finally {
    await fx.cleanup();
  }
});

// ---- round 5 ------------------------------------------------------------------------------

test("background: what a control string hid stays hidden in the stored log (3a)", async () => {
  const fx = await fixture();
  try {
    // The last 4 MiB would open five characters into an OSC body that runs past a line break; the
    // view was cleaned as it streamed, so the body is never text.
    await start(fx, {
      command: `perl -e 'print "x" x 1000, "\\e]0;", "y" x 60, "\\n", "hidden-title", ` +
        `"\\a", ("z" x 99 . "\\n") x 41942, "z" x 35'`,
    });
    await until(() => fx.records.some(([what]) => what === "log"), "the log", 20_000);
    const log = fx.records.find(([what]) => what === "log")![2] as string;
    assert(!log.includes("hidden") && !log.includes("y"), JSON.stringify(log.slice(0, 20)));
    assert(log.startsWith("z"), JSON.stringify(log.slice(0, 20)));
  } finally {
    await fx.cleanup();
  }
});

test("background: a flood of returns before a line leaves the line in the stored log (3b)", async () => {
  const fx = await fixture();
  try {
    await start(fx, { command: `perl -e 'print "\\r" x 5000000, "x\\n"'` });
    await until(() => fx.records.some(([what]) => what === "log"), "the log", 20_000);
    assertEquals(fx.records.find(([what]) => what === "log")![2], "x\n");
  } finally {
    await fx.cleanup();
  }
});

test("background: a released \\r and the \\n after it are one line break to people (5)", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, { command: "printf 'abc\\r'; sleep 0.6; printf '\\nnext\\n'" });
    await until(ended(fx, job.id), "the end");
    await until(() => fx.lines.some((l) => l.type === "exited"), "its exited");
    assertEquals(liveText(fx.lines), "abc\nnext\n");
    const out = fx.jobs.output({ id: job.id });
    assert(out.kind === "job");
    assertEquals(out.tail, "abc\nnext");
  } finally {
    await fx.cleanup();
  }
});

// ---- round 6 ------------------------------------------------------------------------------

/** What people saw of a job: a replay's lines, then everything sent after it. */
function seenAfterReplay(
  fx: Awaited<ReturnType<typeof fixture>>,
  replayed: CommandLine[],
  from: number,
) {
  return liveText(replayed) + liveText(fx.lines.slice(from));
}

test("background: a replay after a released redraw keeps the line break people saw (1)", async () => {
  for (const rest of ["\\nREST\\n", "REST\\n"]) {
    const fx = await fixture();
    try {
      const job = await start(fx, {
        command: `printf 'HALF\\r'; sleep 0.7; printf '${rest}'`,
      });
      await sleep(400); // past the release
      const from = fx.lines.length;
      const replayed = fx.replay();
      await until(ended(fx, job.id), "the end");
      await until(() => fx.lines.some((l) => l.type === "exited"), "its exited");
      const seen = seenAfterReplay(fx, replayed, from);
      assertEquals(seen, "HALF\nREST\n");
    } finally {
      await fx.cleanup();
    }
  }
});

test("background: an announce after a released redraw keeps the line break people saw (1)", async () => {
  let first = true;
  const fx = await fixture({
    recordWaitMs: 2_000,
    records: {
      started: async () => {
        if (!first) await sleep(700);
        first = false;
        return true;
      },
      log: () => Promise.resolve(true),
      ended: () => Promise.resolve(true),
    },
  });
  try {
    await start(fx, { command: "sleep 5" });
    await start(fx, {
      command: `printf 'HALF\\r'; sleep 1; printf 'REST\\n'`,
    });
    await until(
      () => fx.lines.some((l) => l.id === "bg-2" && l.type === "exited"),
      "exited",
      5_000,
    );
    const seen = liveText(fx.lines.filter((l) => l.id === "bg-2"));
    assertEquals(seen, "HALF\nREST\n");
  } finally {
    await fx.cleanup();
  }
});

/** The stored log, once it is up. */
async function storedLog(fx: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  await until(() => fx.records.some(([what]) => what === "log"), "the log", 30_000);
  return fx.records.find(([what]) => what === "log")![2] as string;
}

test("background: a log past both segments is its last 4 MiB, from a line's start (2)", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, {
      command: `yes 'line of text 0123456789' | head -c 9500000; echo; echo end`,
    });
    const log = await storedLog(fx);
    assert(new TextEncoder().encode(log).byteLength <= 4 * 1024 * 1024);
    assert(log.length > 4 * 1024 * 1024 - 64, `${log.length}`);
    const lines = log.split("\n");
    assertEquals(lines.at(-1), "");
    assertEquals(lines.at(-2), "end");
    for (const line of lines.slice(0, -4)) assertEquals(line, "line of text 0123456789");
    assertEquals(job.id, "bg-1");
  } finally {
    await fx.cleanup();
  }
});

test("background: the stored log is exactly what people watching saw (2)", async () => {
  const fx = await fixture({ releaseMs: 200 });
  try {
    const job = await start(fx, {
      command: `for i in $(seq 1 200); do printf '\\033[1mline %s\\033[0m\\r' $i; ` +
        `printf 'done %s\\n' $i; done; printf 'k=v\\n'; printf 'half\\r'; sleep 0.5; ` +
        `printf '\\nend\\n'`,
    });
    const log = await storedLog(fx);
    await until(() => fx.lines.some((l) => l.type === "exited"), "its exited");
    assertEquals(log, liveText(fx.lines));
    assertStringIncludes(log, "line 200\ndone 200\nk=v\nhalf\nend\n");
    assertEquals(job.id, "bg-1");
  } finally {
    await fx.cleanup();
  }
});

// ---- round 7 ------------------------------------------------------------------------------

test("background: the view's writes hold the pipe, even with no raw log to pace it (1)", async () => {
  const logs = await mkdtemp(join(tmpdir(), "runner-bg-paced-"));
  await symlink(`${logs}/elsewhere`, `${logs}/bg-1.log`);
  const peaks: number[] = [];
  const fx = await fixture({
    makeDir: () => Promise.resolve(logs),
    diag: {
      debug: (event, fields) => {
        if (event === "background.view_closed") peaks.push(fields?.peak as number);
      },
      warn: () => {},
    },
  });
  try {
    await start(fx, { command: `yes 'line of output 0123456789' | head -c 40000000` });
    await until(() => peaks.length === 1, "the view closed", 60_000);
    assert(peaks[0] <= 1024 * 1024 + 512 * 1024, `${peaks[0]} bytes queued at most`);
  } finally {
    await fx.cleanup();
    await rm(logs, { recursive: true }).catch(() => {});
  }
});

test("background: a replay is the people's view as they saw it, after what is no longer kept (3)", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, { command: `printf 'a\\rb\\rc\\n'` });
    await until(ended(fx, job.id), "the end");
    assertEquals(liveText(fx.replay()), "a\nb\nc\n");
    // The agent's tail keeps each line's last redraw.
    const out = fx.jobs.output({ id: job.id });
    assert(out.kind === "job");
    assertEquals(out.tail, "c");
    const big = await start(fx, { command: `yes 'line 0123456789' | head -c 400000` });
    await until(ended(fx, big.id), "the end");
    const replayed = fx.replay().filter((l) => l.id === big.id);
    const skipped = replayed.find((l) => l.type === "skipped");
    assert(skipped?.type === "skipped");
    const kept = new TextEncoder().encode(liveText(replayed)).byteLength;
    assertEquals(skipped.bytes + kept, 400_000);
    assert(liveText(replayed).startsWith("line 0123456789\n"), "from a line's start");
  } finally {
    await fx.cleanup();
  }
});

test("background: the record's log fields describe the stored log (4)", async () => {
  const fx = await fixture();
  try {
    await start(fx, { command: "printf 'one\\ntwo\\n'" });
    await start(fx, { command: `yes 'line 0123456789' | head -c 5000000` });
    await until(
      () => fx.records.filter(([what]) => what === "log").length === 2,
      "the logs",
      20_000,
    );
    const ended_ = (id: string) =>
      fx.records.find(([what, of]) => what === "ended" && of === id)![2] as BackgroundEndedRecord;
    assertEquals([ended_("bg-1").logBytes, ended_("bg-1").logTruncated], [8, false]);
    assertEquals([ended_("bg-2").logBytes, ended_("bg-2").logTruncated], [5_000_000, true]);
  } finally {
    await fx.cleanup();
  }
});

test("background: a job's view segments go once its log is up; its raw log stays (5)", async () => {
  const fx = await fixture();
  try {
    const job = await start(fx, { command: "echo hi" });
    await until(() => fx.records.some(([what]) => what === "log"), "the log");
    const dir = job.logPath.replace(/\/[^/]*$/, "");
    // The two go one after the other, so both are waited for: view-1 is still there for a moment
    // after view-0 has gone.
    const gone = (path: string) => {
      try {
        statSync(path);
        return false;
      } catch {
        return true;
      }
    };
    await until(
      () => gone(`${dir}/bg-1.view-0`) && gone(`${dir}/bg-1.view-1`),
      "the segments removed",
    );
    assertEquals(await readFile(job.logPath, "utf8"), "hi\n");
  } finally {
    await fx.cleanup();
  }
});

test("background: a planted view segment is never written through: no log, and the job runs (7)", async () => {
  for (const n of [0, 1]) {
    const logs = await mkdtemp(join(tmpdir(), "runner-bg-planted-view-"));
    const target = `${logs}/elsewhere`;
    await writeFile(target, "untouched");
    await symlink(target, `${logs}/bg-1.view-${n}`);
    const fx = await fixture({ makeDir: () => Promise.resolve(logs) });
    try {
      await start(fx, { command: "echo hi; exit 4" });
      await until(() => fx.notices.length === 1, "the notice");
      await until(() => fx.records.some(([what]) => what === "ended"), "the end record");
      await sleep(100);
      assertEquals(await readFile(target, "utf8"), "untouched");
      await fx.jobs.close(2_000);
      assert(!fx.records.some(([what]) => what === "log"), "no log without a view");
      const record = fx.records.find(([what]) => what === "ended")![2] as BackgroundEndedRecord;
      assertEquals([record.logBytes, record.logTruncated], [0, true]);
    } finally {
      await fx.cleanup();
      await rm(logs, { recursive: true }).catch(() => {});
    }
  }
});

test("background: a view whose write fails stores no log; the end and the notice still go (7)", async () => {
  const failing = {
    write: () => Promise.reject(new Error("disk full")),
    truncate: () => Promise.resolve(),
    read: () => Promise.resolve({ bytesRead: 0 }),
    close: () => Promise.resolve(),
  } as unknown as FileHandle;
  const fx = await fixture({ openView: () => Promise.resolve(failing) });
  try {
    await start(fx, { command: "echo hi; exit 2" });
    await until(() => fx.notices.length === 1, "the notice");
    await until(() => fx.records.some(([what]) => what === "ended"), "the end record");
    await fx.jobs.close(2_000);
    assert(!fx.records.some(([what]) => what === "log"), "no log of a view that failed");
    const record = fx.records.find(([what]) => what === "ended")![2] as BackgroundEndedRecord;
    assertEquals(record.logTruncated, true);
    assert(fx.warns.some((w) => w.event === "background.view_write_failed"));
  } finally {
    await fx.cleanup();
  }
});

test("background: a replay of 64 jobs stays under what a viewer takes at once", async () => {
  const fx = await fixture();
  try {
    const print = `yes 'line of output 0123456789' | head -c 300000`;
    for (let i = 0; i < 56; i++) {
      const job = await start(fx, { command: print });
      await until(ended(fx, job.id), job.id);
    }
    for (let i = 0; i < 8; i++) await start(fx, { command: `${print}; sleep 30` });
    await until(() =>
      fx.jobs.output({ id: "bg-64" }).kind === "job" &&
      (fx.jobs.output({ id: "bg-64" }) as { tail: string }).tail.length > 0, "the last output");
    await sleep(300);
    const replayed = fx.replay();
    const bytes = new TextEncoder().encode(liveText(replayed)).byteLength;
    assert(bytes <= 1536 * 1024, `${bytes} bytes replayed`);
    for (let n = 1; n <= 64; n++) {
      const of = replayed.filter((l) => l.id === `bg-${n}`);
      const sent = new TextEncoder().encode(liveText(of)).byteLength;
      const skipped = of.flatMap((l) => l.type === "skipped" ? [l.bytes] : []);
      assertEquals(skipped.length, 1, `bg-${n}`);
      assertEquals(sent + skipped[0], 300_000, `bg-${n}`);
      assert(of.findIndex((l) => l.type === "skipped") < of.findIndex((l) => l.type === "output"));
      // Cut from the front at a whole line: 26-byte lines never align with the cut.
      assert(liveText(of).startsWith("line of output 0123456789\n"), `bg-${n} starts mid-line`);
      // An ended job gets a short tail; a running one a share of the rest, far more.
      if (n <= 56) assert(sent <= 16 * 1024, `bg-${n}: ${sent}`);
      else assert(sent > 64 * 1024, `bg-${n}: ${sent}`);
    }
  } finally {
    await fx.cleanup();
  }
});
