// `ryph checks`'s calls, over the CLI's one HTTP client (../api/client.ts), which owns the token
// exchange and the error shape.
//
// The shapes here are the orchestrator's (core/check_types.ts `CheckSuiteView`, http/
// checks_api.ts) restated with only the fields this client reads, so a field the server adds
// costs nothing and a contract change is a fix in this file alone.
//
// Invariant: a bundle is streamed from disk, never read into memory: it can be as large as the
// forge's cap.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { ApiError, type ClientOptions, RyphClient, seg } from "../api/client.ts";

export type SuiteState =
  | "waiting"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "cancelled";

export type ResultState =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "timed_out"
  | "setup_failed"
  | "error"
  | "cancelled";

export const TERMINAL_SUITE_STATES: ReadonlySet<string> = new Set([
  "passed",
  "failed",
  "error",
  "cancelled",
]);

/** A check suite, as `GET /v1/check-suites/:id` answers it: only what this client reads. */
export interface SuiteView {
  id: string;
  repoRef: string | null;
  commit: string;
  checksRef: string;
  state: SuiteState;
  reason: string | null;
  generation: number;
  partial: boolean;
  detailsUrl: string | null;
  checks: Array<{
    name: string;
    state: ResultState;
    exitCode: number | null;
    hasLog: boolean;
    logTail: string | null;
  }>;
}

/** A local ask, as the orchestrator files it. `pending` until the tick resolves it to a suite;
 * `refused` and `superseded` are final without one (`reason` says why). */
export interface RequestView {
  id: string;
  state: string;
  suiteId: string | null;
  reason?: string | null;
}

/** What both ask routes and the request read answer: the request, and its suite once it has one. */
export interface AskAnswer {
  request: RequestView;
  suite: SuiteView | null;
}

/** The forge host the repo's remote is on (`github.com`, `gitlab.example.com:8443`), sent as
 * `?host=` beside the repo: `owner/name` may be connected on GitHub and on GitLab at once, and
 * the server breaks that tie by this host. It is only a tiebreak: a host the server does not
 * know a forge by (an ssh alias) leaves an address on one forge that forge's. Absent when not
 * known: a Radicle remote, or a `--repo` other than the remote's. */
interface OnHost {
  host?: string;
}

export interface PushedAsk extends OnHost {
  repo: string;
  commit: string;
  branch: string;
  base?: string;
  checks?: string[];
}

export interface BundleAsk extends OnHost {
  repo: string;
  branch: string;
  base?: string;
  checks?: string[];
  /** The bundle file on disk; streamed, not read. */
  path: string;
}

export type ChecksClientOptions = ClientOptions;

export class ChecksClient {
  readonly api: RyphClient;

  constructor(options: ChecksClientOptions | RyphClient) {
    this.api = options instanceof RyphClient ? options : new RyphClient(options);
  }

  /** The suite's page in the app. */
  suiteUrl(suiteId: string): string {
    return this.api.appUrl(`/checks/${seg(suiteId)}`);
  }

  /** Asks for checks on a commit already on the forge, on `branch`. */
  askPushed(ask: PushedAsk): Promise<AskAnswer> {
    const query = ask.host ? `?${new URLSearchParams({ host: ask.host })}` : "";
    return this.api.json<AskAnswer>("POST", `/v1/check-suites${query}`, {
      repo: ask.repo,
      commit: ask.commit,
      branch: ask.branch,
      ...(ask.base ? { base: ask.base } : {}),
      ...(ask.checks && ask.checks.length > 0 ? { checks: ask.checks } : {}),
    });
  }

  /** Asks for checks on a commit the forge has not seen, by uploading a bundle of it. */
  async askBundle(ask: BundleAsk): Promise<AskAnswer> {
    const query = new URLSearchParams({ repo: ask.repo, branch: ask.branch });
    if (ask.host) query.set("host", ask.host);
    if (ask.base) query.set("base", ask.base);
    for (const check of ask.checks ?? []) query.append("check", check);
    const { size } = await stat(ask.path);
    // Opened per attempt: a 401 retry needs the body from the start, and a stream reads once.
    const res = await this.api.send(
      "POST",
      `/v1/check-suites/bundle?${query}`,
      () =>
        Promise.resolve({
          body: Readable.toWeb(createReadStream(ask.path)) as ReadableStream<Uint8Array>,
          headers: { "content-type": "application/octet-stream", "content-length": String(size) },
        }),
    );
    if (!res.ok) throw await this.api.error(res);
    return await this.api.parseJson<AskAnswer>(res, "POST /v1/check-suites/bundle");
  }

  /** A local ask by its id: the request, and its suite once resolved. */
  getRequest(id: string, signal?: AbortSignal): Promise<AskAnswer> {
    return this.api.json<AskAnswer>(
      "GET",
      `/v1/check-requests/${seg(id)}`,
      undefined,
      signal,
    );
  }

  async getSuite(id: string, signal?: AbortSignal): Promise<SuiteView> {
    const body = await this.api.json<{ suite: SuiteView }>(
      "GET",
      `/v1/check-suites/${seg(id)}`,
      undefined,
      signal,
    );
    return body.suite;
  }

  /** One check's full log for one generation, as text; null when it has none. */
  getLog(suiteId: string, generation: number, check: string): Promise<string | null> {
    const query = new URLSearchParams({ generation: String(generation), check });
    return this.api.text(`/v1/check-suites/${seg(suiteId)}/log?${query}`);
  }

  /** The deployment's GitLab instance, as its forge names it (`GET /v1/forge-providers`): what a
   * remote under a path prefix is read against. Null when it runs no GitLab or does not say. */
  async gitlabUrl(): Promise<string | null> {
    try {
      const body = await this.api.json<{ gitlab?: { url?: unknown } | null }>(
        "GET",
        "/v1/forge-providers",
      );
      return typeof body.gitlab?.url === "string" ? body.gitlab.url : null;
    } catch (err) {
      if (err instanceof ApiError) return null;
      throw err;
    }
  }
}
