// A repo's checks: run them on your own commit (the same flow as `ryph checks run`), follow a
// suite, and read and act on the deployment's suites.
//
// Invariants:
// - checks_run asks about the repository its `path` names, else the one the server was started
//   in: a client starts the server once, and its agent may work in another worktree since
// - a suite that fails is a successful call with a failing verdict

import { UsageError } from "../../api/client.ts";
import { ChecksClient, type SuiteView } from "../../checks/api.ts";
import { repoRoot } from "../../checks/git.ts";
import {
  askForChecks,
  failedChecks,
  isRequestId,
  type Outcome,
  summarize,
  tail,
  waitFor,
} from "../../checks/run.ts";
import { type Args, optBool, optInt, optString, optStrings } from "../args.ts";
import { fence } from "@ryph/shared/markdown";
import { clip } from "../format.ts";
import { resourceTool } from "../resource.ts";
import {
  bool,
  int,
  object,
  READ,
  str,
  strings,
  type Tool,
  type ToolContext,
  WRITE,
} from "../tool.ts";

/** How much of a failed check's log a result carries. */
const LOG_TAIL_LINES = 150;
/** The longest a wait holds a call, as run_wait's. */
const WAIT_MAX_S = 300;

const timeoutArg = int(
  `With wait: give up after this many seconds, default and at most ${WAIT_MAX_S}; ` +
    "checks_status {wait: true} waits again.",
  1,
  WAIT_MAX_S,
);

async function checksClient(ctx: ToolContext): Promise<ChecksClient> {
  return new ChecksClient(await ctx.api());
}

const checksRun: Tool = {
  name: "checks_run",
  description: "Run this repository's ryph checks on the current branch's HEAD commit, the same " +
    "suite a pull request on it would get. Commit first: uncommitted changes are not checked. " +
    "Returns the verdict and, for each failed check, the end of its log. A rebase or amend " +
    "makes a new commit, which needs a new run.",
  inputSchema: object({
    path: str("The repository directory to check; pass your current working directory."),
    checks: strings(
      "Only these checks, by name. A partial run never stands in for the full suite a pull " +
        "request gets.",
    ),
    base: str("The branch whose checks file judges; default the repo's default branch."),
    wait: bool(
      "Wait for the verdict (default true). False returns the suite's id at once, to follow " +
        "with checks_status.",
    ),
    timeoutSeconds: timeoutArg,
  }),
  annotations: WRITE,
  needs: ["checks:request", "repos:read"],
  needsAll: true,
  routes: [
    ["POST", "/v1/check-suites"],
    ["POST", "/v1/check-suites/bundle"],
    ["GET", "/v1/check-requests/{requestId}"],
    ["GET", "/v1/check-suites/{suiteId}"],
    ["GET", "/v1/check-suites/{suiteId}/log"],
  ],
  run: async (args, ctx) => {
    const checks = optStrings(args, "checks");
    const base = optString(args, "base");
    if (args.path !== undefined && (typeof args.path !== "string" || args.path === "")) {
      throw new UsageError("path: the repository directory");
    }
    const cwd = args.path === undefined ? ctx.cwd : await repoRoot(args.path as string, ctx.cwd);
    const client = await checksClient(ctx);
    const asked = await askForChecks(client, { cwd, checks, base });
    const header = [
      `Asked for checks on ${asked.commit.slice(0, 12)} (${asked.branch}) in ${asked.repo}.`,
      ...asked.warnings.map((w) => `Note: ${w}.`),
    ];
    const { request, suite } = asked.answer;
    if (optBool(args, "wait") === false) {
      return [
        ...header,
        suite !== null
          ? `Suite ${suite.id}, ${suite.state}: ${client.suiteUrl(suite.id)}`
          : `Waiting for ryph to pick it up: ask ${request.id}.`,
        `Follow it with checks_status { suiteId: "${suite?.id ?? request.id}" }.`,
      ].join("\n");
    }
    return [...header, ...await waitAndRender(client, suite?.id ?? request.id, args, ctx)]
      .join("\n");
  },
};

const checksStatus: Tool = {
  name: "checks_status",
  description: "Read a ryph check suite (cs-…) or ask (cq-…), and optionally wait for its " +
    "verdict. Returns the verdict and the end of each failed check's log.",
  inputSchema: object({
    suiteId: str("The suite or ask id."),
    wait: bool("Wait for the verdict (default false)."),
    timeoutSeconds: timeoutArg,
  }, ["suiteId"]),
  annotations: READ,
  needs: ["repos:read"],
  routes: [["GET", "/v1/check-requests/{requestId}"], ["GET", "/v1/check-suites/{suiteId}"], [
    "GET",
    "/v1/check-suites/{suiteId}/log",
  ]],
  run: async (args, ctx) => {
    const id = optString(args, "suiteId");
    if (id === undefined) throw new UsageError("suiteId: the suite or ask id");
    const client = await checksClient(ctx);
    if (optBool(args, "wait") === true) {
      return (await waitAndRender(client, id, args, ctx)).join("\n");
    }
    if (isRequestId(id)) {
      const { request, suite } = await client.getRequest(id);
      if (suite === null) {
        return [
          `Ask ${request.id} is ${request.state}${request.reason ? `: ${request.reason}` : ""}.`,
          ...(request.state === "pending" ? ["No suite yet; ask again shortly."] : []),
        ].join("\n");
      }
      return (await renderOutcome(client, { kind: "suite", suite })).join("\n");
    }
    return (await renderOutcome(client, { kind: "suite", suite: await client.getSuite(id) }))
      .join("\n");
  },
};

/** Waits at most `timeoutSeconds` for the verdict, then says where the suite stands. */
async function waitAndRender(
  client: ChecksClient,
  id: string,
  args: Args,
  ctx: ToolContext,
): Promise<string[]> {
  const seconds = optInt(args, "timeoutSeconds", 1, WAIT_MAX_S) ?? WAIT_MAX_S;
  // Ended by a cancelled call too: what it would answer then is not sent.
  const signal = AbortSignal.any([AbortSignal.timeout(seconds * 1000), ctx.signal]);
  let last: SuiteView | null = null;
  try {
    const outcome = await waitFor(client, id, {
      intervalMs: ctx.intervalMs,
      signal,
      onChange: (now: SuiteView) => {
        last = now;
        const settled = now.checks.filter((c) => c.state !== "queued" && c.state !== "running");
        ctx.progress(`${now.state}: ${settled.length} of ${now.checks.length} checks done`);
      },
    });
    return await renderOutcome(client, outcome);
  } catch (err) {
    if (!signal.aborted) throw err;
    const suite = last as SuiteView | null;
    return [
      suite === null
        ? `No suite yet for ${id} after ${seconds}s.`
        : `Suite ${suite.id} is still ${suite.state} after ${seconds}s.`,
      `Wait again: checks_status {suiteId: "${suite?.id ?? id}", wait: true}.`,
    ];
  }
}

/** The verdict in words, with the end of each failed check's log once the suite has settled. */
async function renderOutcome(client: ChecksClient, outcome: Outcome): Promise<string[]> {
  if (outcome.kind === "no-suite") {
    const { request } = outcome;
    return [
      `No checks ran: the ask was ${request.state}${request.reason ? `: ${request.reason}` : ""}.`,
    ];
  }
  const { suite } = outcome;
  const summary = summarize(client, suite);
  const lines = [
    `Suite ${suite.id}: ${suite.state}${suite.reason ? ` (${suite.reason})` : ""}.`,
    `Commit ${suite.commit.slice(0, 12)}, judged by ${suite.checksRef}'s checks file.`,
    `Details: ${summary.url}`,
    ...suite.checks.map((c) =>
      `- ${c.name}: ${c.state}${
        c.exitCode !== null && c.state !== "passed" ? ` (exit ${c.exitCode})` : ""
      }`
    ),
  ];
  const settled = suite.state === "passed" || suite.state === "failed" ||
    suite.state === "error" || suite.state === "cancelled";
  if (!settled) {
    lines.push("Not finished yet.");
    return lines;
  }
  for (const check of failedChecks(suite)) {
    const log = check.hasLog
      ? await client.getLog(suite.id, suite.generation, check.name).catch(() => null)
      : null;
    const body = log ?? check.logTail;
    if (!body) continue;
    lines.push("", `Log of ${check.name} (last ${LOG_TAIL_LINES} lines):`);
    lines.push(fence(tail(body, LOG_TAIL_LINES)));
  }
  return lines;
}

/** A suite as the list routes answer it: the suite, the branch its head is on, who asked. */
interface SuiteRow {
  suite: {
    id: string;
    state: string;
    repoRef: string | null;
    commit: string;
    partial?: boolean;
    createdAt: string;
    checks?: Array<{ name: string; pod?: string; size?: string }>;
  };
  branch: string | null;
  askedBy?: Array<{ label: string }>;
}

function suiteLine({ suite: s, branch, askedBy }: SuiteRow): string {
  return `- ${s.id} ${s.state}${s.partial ? " (partial)" : ""} · ${s.repoRef ?? "?"} @${
    s.commit.slice(0, 12)
  }${branch ? ` (${clip(branch, 60)})` : ""} · ${s.createdAt}${
    askedBy && askedBy.length > 0 ? ` · ${clip(askedBy.map((a) => a.label).join(", "), 80)}` : ""
  }`;
}

/** A suite's pods, when it has more than the one shared pod: ` · pods: shared, orchestrator
 * (large)`. */
function podsLine({ suite }: SuiteRow): string {
  const own = (suite.checks ?? []).filter((c) => c.pod === "own");
  if (own.length === 0) return "";
  const shared = own.length < (suite.checks ?? []).length ? ["shared"] : [];
  return ` · pods: ${
    [...shared, ...own.map((c) => `${c.name}${c.size ? ` (${c.size})` : ""}`)].join(", ")
  }`;
}

const checks = resourceTool({
  name: "checks",
  description: "Read the deployment's check suites (cs-…) and fork approvals. For one suite's " +
    "verdict and failed logs use checks_status.",
  needs: ["repos:read"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/check-suites",
      doc: "suites, newest first (state: any|failing|passed|active; asked: anyone|tool|patch|" +
        "push|forge|local; repo: connected repo id)",
      query: ["state", "asked", ["repoId", "repo"], "limit", "cursor"],
      render: (a) => {
        const { suites, nextCursor } = a as { suites: SuiteRow[]; nextCursor: string | null };
        return [
          ...(suites.length === 0 ? ["No suites."] : suites.map(suiteLine)),
          ...(nextCursor ? [`More: {action: "list", cursor: "${nextCursor}"}`] : []),
        ].join("\n");
      },
    },
    active: {
      method: "GET",
      path: "/v1/checks/active",
      doc: "suites running or waiting now, and the pods in use",
      render: (a) => {
        const { active, capacity } = a as {
          active: SuiteRow[];
          capacity: { inUse: number; total: number };
        };
        return [
          `Pods in use: ${capacity.inUse} of ${capacity.total}.`,
          ...active.map((row) => `${suiteLine(row)}${podsLine(row)}`),
        ].join("\n");
      },
    },
    repos: {
      method: "GET",
      path: "/v1/checks/repos",
      doc: "each repo's declared checks and the latest result of each",
      query: [["repoId", "repo"]],
    },
    log: {
      method: "GET",
      path: "/v1/check-suites/{suiteId}/log",
      doc: "one check's log for one generation",
      query: ["generation", "check"],
      requiredQuery: ["generation", "check"],
      text: true,
    },
    approval: {
      method: "GET",
      path: "/v1/check-approvals/{approvalId}",
      doc: "a fork pull request's checks waiting for approval",
    },
  },
  params: {
    generation: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
});

const checksManage = resourceTool({
  name: "checks_manage",
  description: "Act on check suites: run one again, or approve a fork pull request's checks.",
  needs: ["patches:review"],
  actions: {
    rerun: {
      method: "POST",
      path: "/v1/check-suites/{suiteId}/rerun",
      doc: "run a suite again (a new generation)",
    },
    approve: {
      method: "POST",
      path: "/v1/check-approvals/{approvalId}/approve",
      doc: "let a fork pull request's checks run",
    },
  },
  annotations: WRITE,
});

export const checksTools: Tool[] = [checksRun, checksStatus, checks, checksManage];
