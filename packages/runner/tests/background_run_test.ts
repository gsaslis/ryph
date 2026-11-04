// Background commands through a whole run, on the fake column with real processes: a job's end
// reaches the agent as a message of its turn, and a finish stops what is still running before
// finalize — its record up before the run reports.

import { test } from "bun:test";
import { command } from "@ryph/process";
import { readFile } from "node:fs/promises";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { run } from "../src/core/run.ts";
import type { InboundMessage } from "../src/core/types.ts";
import type { Inbox } from "../src/ports/inbox.ts";
import type { RunActions } from "../src/ports/run_actions.ts";
import type { BackgroundRecords } from "../src/ports/background.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeRunFixture } from "./util.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An inbox nobody writes to: it waits out every poll. */
const silentInbox: Inbox = {
  poll: (_after, { waitMs, signal }) =>
    new Promise<InboundMessage[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), waitMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve([]);
      }, { once: true });
    }),
};

async function alive(pid: number): Promise<boolean> {
  const { code } = await command("bash", {
    args: ["-c", `kill -0 ${pid} 2>/dev/null`],
  }).output();
  return code === 0;
}

const agentEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

test("e2e: a job's end is the agent's next message, and a finish stops what still runs before the run reports", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  fx.ctx.inbox = silentInbox;
  const records: string[] = [];
  const background: BackgroundRecords = {
    started: (r) => {
      records.push(`started ${r.id}`);
      return Promise.resolve(true);
    },
    log: (id) => {
      records.push(`log ${id}`);
      return Promise.resolve(true);
    },
    ended: async (id, r) => {
      await sleep(50);
      records.push(`ended ${id} ${r.reason}`);
      return true;
    },
  };
  fx.ctx.backgroundRecords = background;
  let stopAll: (() => Promise<void>) | null = null;
  fx.ctx.onBackground = (stop) => (stopAll = stop);
  const reportedWith: string[][] = [];
  const report = orchestrator.reportResult.bind(orchestrator);
  orchestrator.reportResult = (r) => {
    reportedWith.push([...records]);
    return report(r);
  };
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const heard: string[] = [];
  let pid = 0;
  fx.ctx.harness = {
    async run(input, io) {
      io.onAgentEnv?.(agentEnv);
      const quick = await actions!.backgroundRun({
        command: "echo built; exit 2",
        label: "build",
      });
      assert(quick.kind === "started", JSON.stringify(quick));
      const long = await actions!.backgroundRun({
        command: `echo $$ > ${input.checkoutDir}/long.pid; exec sleep 300`,
        label: "server",
        service: true,
      });
      assert(long.kind === "started", JSON.stringify(long));
      io.conversation!.onSettled();
      for await (const message of io.conversation!.messages) {
        heard.push(message.text);
        for (let tries = 0; pid === 0 && tries < 200; tries++) {
          pid = Number(await readFile(`${input.checkoutDir}/long.pid`, "utf8").catch(() => "0"));
          if (pid === 0) await sleep(10);
        }
        actions!.finish({ outcome: "success", summary: "built" });
        io.conversation!.onSettled();
      }
      return { summary: "built", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(heard.length, 1);
    assertStringIncludes(heard[0], "A message arrived from the platform.");
    assertStringIncludes(heard[0], 'Background command bg-1 ("build") exited with code 2');
    assertStringIncludes(heard[0], "built");
    // The service was stopped with the run, said nothing, and is gone.
    assert(pid > 0);
    assertEquals(await alive(pid), false);
    // (The cast: `stopAll` is set in a callback, which narrowing does not see.)
    const stop = stopAll as (() => Promise<void>) | null;
    assert(stop !== null, "the composition root was handed the stop");
    // Both records were in, each in its order, before the run reported.
    assertEquals(reportedWith.length, 1);
    const of = (id: string) =>
      reportedWith[0].filter((r) => r.endsWith(id) || r.includes(`${id} `));
    assertEquals(of("bg-1"), ["started bg-1", "ended bg-1 exited", "log bg-1"]);
    assertEquals(of("bg-2"), ["started bg-2", "ended bg-2 run_ended", "log bg-2"]);
    // The notice is narrated as inbound, with the job in its raw.
    const inbound = fx.narrator.chunks.find((c) => c.chunk.kind === "inbound")?.chunk;
    assert(inbound?.kind === "inbound");
    assertEquals((inbound.raw as { background?: { id: string } }).background?.id, "bg-1");
    // Idempotent: the composition root's disposer finds nothing left to stop.
    await stop();
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a finish stops every background job at once, and nothing new starts after it", async () => {
  const fx = await makeRunFixture(fakeOrchestratorGateway());
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  fx.ctx.inbox = silentInbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const seen: string[] = [];
  fx.ctx.harness = {
    async run(_input, io) {
      io.onAgentEnv?.(agentEnv);
      const job = await actions!.backgroundRun({ command: "exec sleep 300", label: "long" });
      assert(job.kind === "started", JSON.stringify(job));
      actions!.finish({ outcome: "success", summary: "done" });
      // Before the settle: the finish alone ends it, without a word to the agent.
      for (let tries = 0; tries < 300; tries++) {
        const out = actions!.backgroundOutput({ id: "bg-1" });
        if (out.kind === "job" && out.job.ended !== null) {
          seen.push(out.job.ended.reason);
          break;
        }
        await sleep(10);
      }
      const late = await actions!.backgroundRun({ command: "true", label: "late" });
      seen.push(late.kind);
      if (late.kind === "refused") assertStringIncludes(late.reason, "bash tool still works");
      io.conversation!.onSettled();
      for await (const message of io.conversation!.messages) seen.push(message.text);
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(seen, ["run_ended", "refused"]);
  } finally {
    await fx.cleanup();
  }
});
