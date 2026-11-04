import { describe, expect, it } from "vitest";
import {
  checkLogHref,
  getActiveChecks,
  getCheckLog,
  getCheckSuite,
  getRepoChecks,
  listCheckSuites,
  rerunCheckSuite,
} from "./checks";
import { patchWithContextSchema, taskDetailSchema } from "./types";
import { suite } from "./checks.test-fixture";

// A suite page reads one suite and, on demand, one check's whole log as plain text; its re-run
// is a POST that answers the suite. Pinned here: the routes, the shape, and that the task detail
// and the approval queue still parse from an orchestrator that sends no checks at all.

type Seen = { url?: string; init?: RequestInit };

const respond = (status: number, body: unknown, seen?: Seen, type = "application/json") =>
  ((url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.init = init;
    }
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": type },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

describe("check suite reads", () => {
  it("reads a suite by id", async () => {
    const seen: Seen = {};
    const { suite: got, branch } = await getCheckSuite(
      respond(200, { suite, branch: "pull/7/head" }, seen),
      "cs-0123456789",
    );
    expect(seen.url).toBe("/api/v1/check-suites/cs-0123456789");
    expect(branch).toBe("pull/7/head");
    expect(got.checks.map((c) => c.name)).toEqual(["lint", "test"]);
    // head-authored text arrives as it was written; the page renders it as text
    expect(got.checks[1].logTail).toContain("<script>");
  });

  it("reads one check's log as plain text, naming the generation and the check", async () => {
    const seen: Seen = {};
    const log = await getCheckLog(
      respond(200, "line 1\nline 2", seen, "text/plain"),
      "cs-1",
      2,
      "e2e",
    );
    expect(log).toBe("line 1\nline 2");
    expect(seen.url).toBe("/api/v1/check-suites/cs-1/log?generation=2&check=e2e");
    expect(checkLogHref("cs-1", 2, "e2e")).toBe(
      "/api/v1/check-suites/cs-1/log?generation=2&check=e2e",
    );
  });

  it("re-runs with a POST and answers the suite; a refusal carries its reason", async () => {
    const seen: Seen = {};
    const got = await rerunCheckSuite(
      respond(200, { suite: { ...suite, state: "queued", generation: 2 } }, seen),
      "cs-0123456789",
    );
    expect(seen.url).toBe("/api/v1/check-suites/cs-0123456789/rerun");
    expect(seen.init?.method).toBe("POST");
    expect(got.generation).toBe(2);
    await expect(
      rerunCheckSuite(respond(409, { error: "the suite passed" }), "cs-0123456789"),
    ).rejects.toThrow("the suite passed");
  });
});

describe("the checks page's lists", () => {
  const asked = { kind: "patch", label: "#12", href: "https://github.com/acme/api/pull/12" };

  it("lists suites with the filters and cursor in the query, leaving out the defaults", async () => {
    const seen: Seen = {};
    const page = await listCheckSuites(
      respond(
        200,
        { suites: [{ suite, branch: "ryph/x", askedBy: [asked] }], nextCursor: "c" },
        seen,
      ),
      { repo: "cr-1", state: "failing", asked: "anyone" },
      { cursor: "2026-09-30T10:00:00.000Z|cs-1" },
    );
    expect(seen.url).toBe(
      "/api/v1/check-suites?repo=cr-1&state=failing&cursor=2026-09-30T10%3A00%3A00.000Z%7Ccs-1",
    );
    expect(page.suites[0].askedBy).toEqual([asked]);
    expect(page.nextCursor).toBe("c");
    const plain: Seen = {};
    await listCheckSuites(respond(200, { suites: [], nextCursor: null }, plain));
    expect(plain.url).toBe("/api/v1/check-suites");
  });

  it("reads a push to a change request as an asker, and filters on it", async () => {
    const pushed = { kind: "push", label: "#42", href: "https://github.com/acme/api/pull/42" };
    const seen: Seen = {};
    const page = await listCheckSuites(
      respond(
        200,
        { suites: [{ suite, branch: "pull/42/head", askedBy: [pushed] }], nextCursor: null },
        seen,
      ),
      { asked: "push" },
    );
    expect(seen.url).toBe("/api/v1/check-suites?asked=push");
    expect(page.suites[0].askedBy).toEqual([pushed]);
  });

  it("reads what runs now with the pods in use", async () => {
    const seen: Seen = {};
    const got = await getActiveChecks(
      respond(200, { active: [], capacity: { inUse: 1, total: 4 } }, seen),
    );
    expect(seen.url).toBe("/api/v1/checks/active");
    expect(got.capacity).toEqual({ inUse: 1, total: 4 });
  });

  it("reads each repo's checks file, an invalid one with no path or commit included", async () => {
    const repo = {
      connectedRepoId: "cr-1",
      repoRef: "acme/api",
      provider: "github",
      defaultBranch: "main",
      latest: null,
    };
    const seen: Seen = {};
    const repos = await getRepoChecks(respond(200, {
      repos: [
        { ...repo, file: { state: "invalid", path: null, commit: null, error: "too big" } },
        { ...repo, file: { state: "unread", error: "forge answered 502" } },
      ],
    }, seen));
    expect(seen.url).toBe("/api/v1/checks/repos");
    expect(repos.map((r) => r.file.state)).toEqual(["invalid", "unread"]);
  });

  it("reads one repo's checks file by its id", async () => {
    const seen: Seen = {};
    await getRepoChecks(respond(200, { repos: [] }, seen), "cr-1");
    expect(seen.url).toBe("/api/v1/checks/repos?repo=cr-1");
  });

  it("reads a suite from an orchestrator that answers no branch", async () => {
    const { branch } = await getCheckSuite(respond(200, { suite }, {}), "cs-0123456789");
    expect(branch).toBeNull();
  });
});

describe("checks on older answers", () => {
  it("a task detail without checkSuites has none", () => {
    const parsed = taskDetailSchema.shape.checkSuites.parse(undefined);
    expect(parsed).toEqual([]);
  });

  it("a patch without checks has none, and with them parses the summary", () => {
    const shape = patchWithContextSchema.shape.checks;
    expect(shape.parse(undefined)).toBeNull();
    expect(shape.parse({ suiteId: "cs-1", state: "running", passed: 1, failed: 0, total: 3 }))
      .toEqual({ suiteId: "cs-1", state: "running", passed: 1, failed: 0, total: 3 });
  });
});
