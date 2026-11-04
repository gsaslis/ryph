// `ryph checks` — the check suite a PR would get, asked for from your own machine before there
// is a PR. The suite is the one a push of the same
// commit on the same base gets, so when the PR opens on that commit the forge is told at once.
//
// Exit codes: 0 passed, 1 failed or error, 2 cancelled or anything else (no suite, an
// unreachable server, a refusal), 3 a usage or configuration mistake.

import { parseArgs } from "@std/cli/parse-args";
import { ApiError, resolveClientConfig, UsageError } from "../api/client.ts";
import { ChecksClient, type SuiteView } from "./api.ts";
import { GitError } from "./git.ts";
import { askForChecks, exitCodeFor, isRequestId, type Outcome, summarize, waitFor } from "./run.ts";

export const CHECKS_HELP = `ryph checks — run a repo's checks on your commit, before a PR

USAGE
  ryph checks run [options]        ask for checks on HEAD of the current branch, and wait
  ryph checks wait <id>            wait for a suite (cs-…) or an ask (cq-…) to finish
  ryph checks status <id>          read it once

  For an agent on this machine, \`ryph mcp\` serves the same as the checks_run and checks_status
  tools.

OPTIONS (run)
  --check <name>                   run only this check; repeat for more. A partial run never
                                   stands in for the full suite a PR gets.
  --base <branch>                  the branch whose checks file judges; default the repo's default
  --repo <owner/name|group/sub/project|rad:z…>
                                   default: read from the origin remote's URL
  --push | --bundle                how the commit reaches ryph. Default: --push when the remote's
                                   branch is HEAD already, else (and always on Radicle) a bundle
                                   of the branch is uploaded
  --no-wait                        print where to follow it and exit
  --json                           print one JSON object at the end instead of progress

ENVIRONMENT
  RYPH_URL                         the ryph web app, e.g. https://ryph.example.com
  RYPH_TOKEN                       an API token (ryph_pat_…) holding checks:request and repos:read;
                                   mint one on your account page
  Both may also live in ~/.ryph/config.env. The environment wins.

Checks run on a commit, not your working tree. A rebase or amend makes a new commit, which runs
again. Exit status: 0 passed, 1 failed, 2 cancelled or no result, 3 usage or configuration.
`;

/** Entry point from main.ts; returns the exit code. */
export async function checks(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  try {
    switch (verb) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(CHECKS_HELP);
        return verb === undefined ? 3 : 0;
      case "run":
        return await run(rest);
      case "wait":
        return await follow(rest, true);
      case "status":
        return await follow(rest, false);
      default:
        throw new UsageError(`unknown checks command ${JSON.stringify(verb)}\n\n${CHECKS_HELP}`);
    }
  } catch (err) {
    return reportFailure(err, rest.includes("--json"));
  }
}

/**
 * Says why a command could not finish and picks its exit code: 3 for a usage, repository or
 * configuration mistake (a refused token, a capability it lacks), 2 for the rest. With `--json`
 * the one JSON object stdout promises is this failure, `{error, status?}`; stderr still says it.
 */
export function reportFailure(
  err: unknown,
  json: boolean,
  out: { log(line: string): void; error(line: string): void } = console,
): number {
  const message = err instanceof Error ? err.message : String(err);
  out.error(`error: ${message}`);
  const status = err instanceof ApiError ? err.status : undefined;
  // The first paragraph: a usage error carries the help text after a blank line.
  if (json) {
    out.log(JSON.stringify({
      error: message.split("\n\n")[0],
      ...(status !== undefined ? { status } : {}),
    }));
  }
  if (err instanceof UsageError || err instanceof GitError) return 3;
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return 3;
  return 2;
}

async function clientFromConfig(): Promise<ChecksClient> {
  return new ChecksClient(
    await resolveClientConfig(undefined, undefined, "checks:request and repos:read"),
  );
}

async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    string: ["check", "base", "repo"],
    boolean: ["push", "bundle", "wait", "json"],
    collect: ["check"],
    negatable: ["wait"],
    default: { wait: true },
    unknown: (arg) => {
      throw new UsageError(`unexpected ${JSON.stringify(arg)}\n\n${CHECKS_HELP}`);
    },
  });
  if (args.push && args.bundle) throw new UsageError("--push and --bundle: pick one");
  const client = await clientFromConfig();
  const asked = await askForChecks(client, {
    cwd: process.cwd(),
    checks: args.check as string[],
    base: args.base,
    repo: args.repo,
    force: args.push ? "pushed" : args.bundle ? "bundle" : null,
  });
  for (const warning of asked.warnings) console.error(`warning: ${warning}`);
  const { request, suite } = asked.answer;
  const say = args.json ? () => {} : (line: string) => console.log(line);
  say(
    `asked for checks on ${asked.commit.slice(0, 12)} (${asked.branch}) in ${asked.repo}` +
      (asked.source === "bundle" ? ", sent as a bundle" : ""),
  );
  if (suite !== null) say(`  ${client.suiteUrl(suite.id)}`);
  else say(`  waiting for ryph to pick it up (${request.id})`);
  say("  a rebase or amend makes a new commit, which runs again");

  if (!args.wait) {
    if (args.json) {
      console.log(JSON.stringify(
        suite !== null
          ? { requestId: request.id, ...summarize(client, suite) }
          : { requestId: request.id, suiteId: null, url: null, state: request.state },
      ));
    } else if (suite === null) {
      say(`  follow it with: ryph checks wait ${request.id}`);
    }
    return 0;
  }
  return await followAndReport(client, suite?.id ?? request.id, {
    json: args.json,
    requestId: request.id,
  });
}

async function follow(argv: string[], wait: boolean): Promise<number> {
  const args = parseArgs(argv, {
    boolean: ["json"],
    unknown: (arg) => {
      if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
      return true;
    },
  });
  const id = args._[0];
  if (typeof id !== "string" || id === "") {
    throw new UsageError(`usage: ryph checks ${wait ? "wait" : "status"} <suite-or-ask-id>`);
  }
  const client = await clientFromConfig();
  if (wait) return await followAndReport(client, id, { json: args.json });

  // One read: a suite as it is now, or an ask and whatever suite it has so far.
  let suite: SuiteView | null;
  let outcome: Outcome | { kind: "pending" };
  if (isRequestId(id)) {
    const answer = await client.getRequest(id);
    suite = answer.suite;
    outcome = suite !== null
      ? { kind: "suite", suite }
      : answer.request.state === "pending" || answer.request.state === "active"
      ? { kind: "pending" }
      : { kind: "no-suite", request: answer.request };
    if (suite === null && !args.json) {
      console.log(`${id}: ${answer.request.state}${reasonOf(answer.request.reason)}`);
    }
  } else {
    suite = await client.getSuite(id);
    outcome = { kind: "suite", suite };
  }
  if (suite !== null) {
    if (args.json) console.log(JSON.stringify(summarize(client, suite)));
    else printSuite(client, suite);
  } else if (args.json) {
    console.log(JSON.stringify({ requestId: id, suiteId: null, state: outcome.kind }));
  }
  return exitCodeFor(outcome);
}

async function followAndReport(
  client: ChecksClient,
  id: string,
  opts: { json: boolean; requestId?: string },
): Promise<number> {
  let urlShown = !isRequestId(id);
  const outcome = await waitFor(client, id, {
    onChange: opts.json ? undefined : (now, before) => {
      if (!urlShown) {
        console.log(`  ${client.suiteUrl(now.id)}`);
        urlShown = true;
      }
      printChanges(now, before);
    },
  });
  if (outcome.kind === "no-suite") {
    if (opts.json) {
      console.log(JSON.stringify({
        requestId: outcome.request.id,
        suiteId: null,
        url: null,
        state: outcome.request.state,
        reason: outcome.request.reason ?? null,
      }));
    } else {
      console.log(
        `no checks ran: the ask was ${outcome.request.state}${reasonOf(outcome.request.reason)}`,
      );
    }
    return exitCodeFor(outcome);
  }
  const { suite } = outcome;
  if (opts.json) {
    console.log(JSON.stringify({
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
      ...summarize(client, suite),
    }));
  } else {
    console.log(`${suite.state}${reasonOf(suite.reason)}`);
  }
  return exitCodeFor(outcome);
}

function printChanges(now: SuiteView, before: SuiteView | null): void {
  if (before === null || before.state !== now.state) console.log(`suite: ${now.state}`);
  if (before !== null && before.generation !== now.generation) {
    console.log(`  run again (generation ${now.generation})`);
  }
  const was = new Map(
    before?.generation === now.generation ? before.checks.map((c) => [c.name, c.state]) : [],
  );
  for (const check of now.checks) {
    if (was.get(check.name) === check.state) continue;
    console.log(`  ${check.name}: ${describeCheck(check)}`);
  }
}

function printSuite(client: ChecksClient, suite: SuiteView): void {
  console.log(`${suite.id}: ${suite.state}${reasonOf(suite.reason)}`);
  console.log(`  ${client.suiteUrl(suite.id)}`);
  console.log(`  commit ${suite.commit.slice(0, 12)}, judged by ${suite.checksRef}`);
  for (const check of suite.checks) console.log(`  ${check.name}: ${describeCheck(check)}`);
}

function describeCheck(check: SuiteView["checks"][number]): string {
  return check.exitCode !== null && check.state !== "passed"
    ? `${check.state} (exit ${check.exitCode})`
    : check.state;
}

const reasonOf = (reason: string | null | undefined) => reason ? `: ${reason}` : "";
