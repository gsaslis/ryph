import { browser } from "$app/environment";
import { z } from "zod";
import { apiCall, apiText } from "./call";
import {
  type CheckApproval,
  checkApprovalSchema,
  type CheckCapacity,
  checkCapacitySchema,
  type CheckSuiteListItem,
  checkSuiteListItemSchema,
  type CheckSuiteView,
  checkSuiteViewSchema,
  type RepoChecks,
  repoChecksSchema,
} from "./types";

/**
 * Check suites: the commands a repo's `.ryph/checks.yml` declares, run by the platform against a
 * commit. Anyone who can read repos can read a suite and its logs; re-running one takes patch
 * review, and write access to the repo.
 */

function suitePath(id: string): string {
  return `/v1/check-suites/${encodeURIComponent(id)}`;
}

/** What the checks list can be narrowed to; absent, everything. */
export interface CheckSuiteFilters {
  repo?: string | null;
  state?: "any" | "failing" | "passed" | "active";
  asked?: "anyone" | "tool" | "patch" | "push" | "forge" | "local";
}

const checkSuitePageSchema = z.object({
  suites: z.array(checkSuiteListItemSchema),
  nextCursor: z.string().nullable(),
});
export type CheckSuitePage = z.infer<typeof checkSuitePageSchema>;

/** One page of the suites the caller can see, newest first. */
export async function listCheckSuites(
  f = fetch,
  filters: CheckSuiteFilters = {},
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<CheckSuitePage> {
  const params = new URLSearchParams();
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.state && filters.state !== "any") params.set("state", filters.state);
  if (filters.asked && filters.asked !== "anyone") params.set("asked", filters.asked);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const query = params.toString();
  return checkSuitePageSchema.parse(
    await apiCall(f, query === "" ? "/v1/check-suites" : `/v1/check-suites?${query}`),
  );
}

/** The suites not settled yet, and how many check pods are in use of the instance's limit. */
export async function getActiveChecks(
  f = fetch,
): Promise<{ active: CheckSuiteListItem[]; capacity: CheckCapacity }> {
  return z.object({ active: z.array(checkSuiteListItemSchema), capacity: checkCapacitySchema })
    .parse(await apiCall(f, "/v1/checks/active"));
}

/** Each connected repository's checks file on its default branch, and its newest full suite;
 * one repository's alone, by id, with `repo`. */
export async function getRepoChecks(f = fetch, repo?: string): Promise<RepoChecks[]> {
  const query = repo === undefined ? "" : `?${new URLSearchParams({ repo })}`;
  return z.object({ repos: z.array(repoChecksSchema) })
    .parse(await apiCall(f, `/v1/checks/repos${query}`)).repos;
}

/**
 * The same read as a page's `load` hands it to a card: unawaited, and asked in the BROWSER only,
 * as `streamEnvironmentDefinition` is and for its reason. The files are read off the forge, and
 * the server's answer could not reach the rendered HTML anyway. Null on the server: "still being
 * read".
 */
export function streamRepoChecks(f = fetch, repo?: string): Promise<RepoChecks[] | null> {
  return browser ? getRepoChecks(f, repo) : Promise.resolve(null);
}

/** One suite, with every check of its current generation, and the branch its head was pushed
 * on when it knows one, as the list has it. */
export async function getCheckSuite(
  f = fetch,
  id: string,
): Promise<{ suite: CheckSuiteView; branch: string | null }> {
  return z.object({ suite: checkSuiteViewSchema, branch: z.string().nullable().default(null) })
    .parse(await apiCall(f, suitePath(id)));
}

/**
 * One check's whole log in one generation of a suite, as plain text. It is the check's own
 * output, so a page shows it as text and never as markup.
 */
export async function getCheckLog(
  f = fetch,
  id: string,
  generation: number,
  check: string,
): Promise<string> {
  const query = new URLSearchParams({ generation: String(generation), check });
  return await apiText(f, `${suitePath(id)}/log?${query}`);
}

/** Where the same log is opened in a new tab, through the app's proxy. */
export function checkLogHref(id: string, generation: number, check: string): string {
  const query = new URLSearchParams({ generation: String(generation), check });
  return `/api${suitePath(id)}/log?${query}`;
}

/** Runs a settled suite again. Answers the suite that runs, which may be a new one. */
export async function rerunCheckSuite(f = fetch, id: string): Promise<CheckSuiteView> {
  const res = await apiCall(f, `${suitePath(id)}/rerun`, { method: "POST" });
  return z.object({ suite: checkSuiteViewSchema }).parse(res).suite;
}

function approvalPath(id: string): string {
  return `/v1/check-approvals/${encodeURIComponent(id)}`;
}

/** An outside contribution's head waiting for someone to approve its checks: what the comment
 * on its change request links to. */
export async function getCheckApproval(f = fetch, id: string): Promise<CheckApproval> {
  return z.object({ approval: checkApprovalSchema })
    .parse(await apiCall(f, approvalPath(id))).approval;
}

/**
 * Approves an outside contribution's head: its checks run once. Takes patch review, and the
 * access commanding agents on the repository takes (write on GitHub, delegacy on Radicle).
 * Answers the approval, and the change request to send the approver back to.
 */
export async function approveCheckRun(
  f = fetch,
  id: string,
): Promise<{ approval: CheckApproval; returnTo: string | null }> {
  return z.object({ approval: checkApprovalSchema, returnTo: z.string().nullable() })
    .parse(await apiCall(f, `${approvalPath(id)}/approve`, { method: "POST" }));
}
