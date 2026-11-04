import { getContext, setContext } from "svelte";
import type { CheckSuiteView } from "$lib/api/types";
import { ID_BODY } from "$lib/utils/ids";

// The check suites a page already holds, kept live while any runs: a checks tool call in the
// transcript shows the suite it started from here, rather than reading each one again. A page that
// holds none sets nothing, and those calls show their plain reply.

const KEY = Symbol("check-suites");

/** What a page holds for its transcript: the suites, and the run whose calls the transcript shows. */
export interface CheckSuitesContext {
  suites: CheckSuiteView[];
  runId: string | null;
}

export function setCheckSuitesContext(held: () => CheckSuitesContext): void {
  setContext(KEY, held);
}

export function getCheckSuitesContext(): (() => CheckSuitesContext) | undefined {
  return getContext<(() => CheckSuitesContext) | undefined>(KEY);
}

const SUITE_ID = new RegExp(`\\bcs-${ID_BODY}\\b`, "g");
const REQUESTED_AT = /^Checks requested for ([0-9a-f]{7,40})\b/m;

/**
 * The suites a checks tool's reply names, as the page holds them now. A request still reading its
 * base names no suite yet, only the commit: then a suite on that commit this run asked for through
 * the tool, once there is one. Not one created since the call, because the request may land on an
 * older suite it reuses, and a later one on the same commit is then not this call's. Of those, the
 * one shaped like the call: all the checks when it named none, else exactly the ones it named.
 */
export function suitesInReply(
  reply: string,
  suites: CheckSuiteView[],
  runId: string | null,
  named: readonly string[],
): CheckSuiteView[] {
  const ids = [...new Set(reply.match(SUITE_ID) ?? [])];
  if (ids.length > 0) {
    return ids.flatMap((id) => suites.filter((suite) => suite.id === id));
  }
  const commit = REQUESTED_AT.exec(reply)?.[1];
  if (commit === undefined || runId === null) return [];
  const ours = suites
    .filter((suite) =>
      suite.commit.startsWith(commit) &&
      suite.requestedBy.some((r) => r.kind === "tool" && r.runId === runId)
    )
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const wanted = new Set(named);
  const shaped = ours.filter((suite) =>
    wanted.size === 0 ? !suite.partial : suite.partial &&
      suite.checks.length === wanted.size && suite.checks.every((c) => wanted.has(c.name))
  );
  return (shaped.length > 0 ? shaped : ours).slice(0, 1);
}
