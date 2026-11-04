import { describe, expect, it } from "vitest";
import { ApiError } from "$lib/api/call";
import {
  asksForPrompt,
  awaitsPrompt,
  handOff,
  promptReadiness,
  refusedAsEnded,
  StartAgain,
  takeHandoff,
  taskName,
} from "./task-prompt";

describe("taskName", () => {
  it("is the title when there is one", () => {
    expect(taskName("Fix the flaky login test")).toBe("Fix the flaky login test");
  });

  it("is a new task while there is none", () => {
    expect(taskName(null)).toBe("New task");
  });
});

describe("promptReadiness", () => {
  it("is getting ready before the run exists", () => {
    expect(promptReadiness(null)).toBe("getting-ready");
  });

  it("is getting ready while the run starts and sets up", () => {
    expect(promptReadiness({ state: "starting", phase: null })).toBe("getting-ready");
    expect(promptReadiness({ state: "starting", phase: "booting" })).toBe("getting-ready");
    expect(promptReadiness({ state: "running", phase: "cloning" })).toBe("getting-ready");
    expect(promptReadiness({ state: "running", phase: "setting-up" })).toBe("getting-ready");
  });

  it("is ready once the run is running", () => {
    expect(promptReadiness({ state: "running", phase: "running" })).toBe("ready");
  });

  it("has ended on any terminal state", () => {
    for (const state of ["succeeded", "failed", "errored", "cancelled", "lost"] as const) {
      expect(promptReadiness({ state, phase: "running" })).toBe("ended");
    }
  });
});

describe("asksForPrompt", () => {
  it("asks while the task waits for its prompt", () => {
    expect(asksForPrompt({ awaitingPrompt: true, sending: false, sent: false })).toBe(true);
  });

  it("does not ask a task that has its prompt", () => {
    expect(asksForPrompt({ awaitingPrompt: false, sending: false, sent: false })).toBe(false);
  });

  it("keeps asking while a send is in flight, even once a read says it arrived", () => {
    expect(asksForPrompt({ awaitingPrompt: false, sending: true, sent: false })).toBe(true);
  });

  it("stops asking once this page sent it, before any read says so", () => {
    expect(asksForPrompt({ awaitingPrompt: true, sending: false, sent: true })).toBe(false);
  });
});

describe("awaitsPrompt", () => {
  it("takes the detail's word when it gives one", () => {
    expect(awaitsPrompt({ awaitingPrompt: true, spec: { instructions: null } })).toBe(true);
    expect(awaitsPrompt({ awaitingPrompt: false, spec: { instructions: "Do it" } })).toBe(false);
  });

  it("reads null instructions as waiting when the detail does not say", () => {
    expect(awaitsPrompt({ spec: { instructions: null } })).toBe(true);
    expect(awaitsPrompt({ spec: { instructions: "Do it" } })).toBe(false);
  });
});

describe("refusedAsEnded", () => {
  it("is the server's terminal refusal and nothing else", () => {
    const terminal = { error: "run is terminal (cancelled)", reason: "terminal" };
    expect(refusedAsEnded(new ApiError(409, terminal, "run is terminal (cancelled)"))).toBe(true);
    expect(refusedAsEnded(new ApiError(409, { error: "taken" }, "taken"))).toBe(false);
    expect(refusedAsEnded(new ApiError(400, terminal, "x"))).toBe(false);
    expect(refusedAsEnded(new Error("run is terminal"))).toBe(false);
  });
});

describe("handoff", () => {
  const file = new File([new Uint8Array(4)], "a.png", { type: "image/png" });

  it("is taken once, by the task it was left for", () => {
    handOff("t-handoff", { text: "Fix it", files: [file] });
    expect(takeHandoff("t-other")).toBeNull();
    expect(takeHandoff("t-handoff")).toEqual({ text: "Fix it", files: [file] });
    expect(takeHandoff("t-handoff")).toBeNull();
  });
});

describe("StartAgain", () => {
  const carried = { text: "Fix it", files: [] };

  it("creates the re-run, hands the draft to it, and opens it; it sends nothing", async () => {
    const calls: string[] = [];
    const again = new StartAgain(
      () => {
        calls.push("create");
        return Promise.resolve({ taskId: "t-again" });
      },
      (taskId) => {
        calls.push(`open ${taskId}`);
        // The new page is the one to take it.
        expect(takeHandoff(taskId)).toBe(carried);
        return Promise.resolve();
      },
    );
    await again.start(carried);
    expect(calls).toEqual(["create", "open t-again"]);
  });

  it("joins a press while one is under way rather than starting a second re-run", async () => {
    let created = 0;
    let finish!: () => void;
    const again = new StartAgain(
      () => {
        created++;
        return new Promise((resolve) => (finish = () => resolve({ taskId: "t-once" })));
      },
      () => Promise.resolve(),
    );
    const first = again.start(carried);
    const second = again.start(carried);
    finish();
    await Promise.all([first, second]);
    expect(created).toBe(1);
    takeHandoff("t-once");
  });

  it("remembers nothing from a failed try: the next creates afresh", async () => {
    let created = 0;
    const opened: string[] = [];
    const again = new StartAgain(
      () => {
        created++;
        return created === 1
          ? Promise.reject(new Error("no"))
          : Promise.resolve({ taskId: `t-try-${created}` });
      },
      (taskId) => {
        opened.push(taskId);
        return Promise.resolve();
      },
    );
    await expect(again.start(carried)).rejects.toThrow("no");
    expect(opened).toEqual([]);
    await again.start(carried);
    expect([created, opened]).toEqual([2, ["t-try-2"]]);
    expect(takeHandoff("t-try-2")).toBe(carried);
  });
});
