import { browser } from "$app/environment";
import { z } from "zod";
import { apiCall, apiText } from "./call";
import {
  type BuildListItem,
  buildListItemSchema,
  type CreateTaskResponse,
  createTaskResponseSchema,
  type EnvironmentDefinition,
  environmentDefinitionSchema,
  type EnvironmentView,
  environmentViewSchema,
  type SubjectEnvironment,
  subjectEnvironmentSchema,
  type ThinkingLevel,
} from "./types";

/**
 * The machine a repo's or a workspace's runs start on: the environment in use, the newest build,
 * and whether this deployment builds environments at all. Readable by anyone who can see the
 * subject; only an admin may rebuild.
 */
export type EnvironmentSubject = { kind: "repo" | "workspace"; id: string };

function subjectPath(subject: EnvironmentSubject): string {
  const collection = subject.kind === "repo" ? "connected-repos" : "workspaces";
  return `/v1/${collection}/${encodeURIComponent(subject.id)}/environment`;
}

/**
 * The facts the card leads with. A database read on the control plane and nothing else, so a page
 * may await it and the card's five-second poll during a build costs almost nothing.
 */
export async function getEnvironment(
  f = fetch,
  subject: EnvironmentSubject,
): Promise<SubjectEnvironment> {
  return subjectEnvironmentSchema.parse(await apiCall(f, subjectPath(subject)));
}

/**
 * The same, with a failure folded into its message. A settings page must still open when the
 * control plane cannot answer this one route; the card then says why it is empty.
 */
export async function getEnvironmentOrError(
  f = fetch,
  subject: EnvironmentSubject,
): Promise<SubjectEnvironment | { error: string }> {
  try {
    return await getEnvironment(f, subject);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "the environment could not be read" };
  }
}

/** A read of the slow half that a page may or may not have made yet: null before it was asked
 * (the server's render never asks — see the pages' `load`), and the forge's failure folded into
 * a message, so the card can say "not just now" instead of losing the page. */
export type EnvironmentDefinitionRead = EnvironmentDefinition | { error: string } | null;

/**
 * What the default branch describes, and a workspace's passed-over Dockerfiles. Its own route
 * because it makes the forge fetch the repository from upstream — half a second on a warm cache,
 * seconds on a cold one — so a page streams it in beside the card rather than waiting for it.
 */
export async function getEnvironmentDefinition(
  f = fetch,
  subject: EnvironmentSubject,
): Promise<EnvironmentDefinition> {
  return environmentDefinitionSchema.parse(await apiCall(f, `${subjectPath(subject)}/definition`));
}

/**
 * The same, with a failure folded into its message. A forge that cannot be reached must cost the
 * card its offer to set the repository up, never the page.
 */
export async function getEnvironmentDefinitionOrError(
  f = fetch,
  subject: EnvironmentSubject,
): Promise<EnvironmentDefinition | { error: string }> {
  try {
    return await getEnvironmentDefinition(f, subject);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "the repository could not be read" };
  }
}

/**
 * The same read as a page's `load` hands it to the card: an unawaited promise, so the page
 * renders while the forge is still fetching the repository.
 *
 * It asks in the BROWSER only. A universal load runs on the server to render the HTML and again
 * in the browser when the page hydrates, and a promise it returns is not carried between the
 * two: asking on the server would make the forge fetch the repository twice per visit for an
 * answer no rendered HTML could hold anyway — `{#await}` renders its pending branch on the
 * server whatever the promise. So the server's promise answers null, which the card reads as
 * "still being read", and the browser's re-run of the load is what asks.
 */
export function streamEnvironmentDefinition(
  f = fetch,
  subject: EnvironmentSubject,
): Promise<EnvironmentDefinitionRead> {
  return browser ? getEnvironmentDefinitionOrError(f, subject) : Promise.resolve(null);
}

/** Queues a build from the subject's default branch now. Admin only; answers with the build. */
export async function rebuildEnvironment(
  f = fetch,
  subject: EnvironmentSubject,
): Promise<EnvironmentView> {
  const res = await apiCall(f, `${subjectPath(subject)}/rebuild`, { method: "POST" });
  return z.object({ environment: environmentViewSchema }).parse(res).environment;
}

/**
 * "Set up this repo's environment": starts a task for `agentId` whose instruction, checkout and
 * lifetime are the platform's — the agent writes `.ryph/`, ships it as a patch, and iterates on
 * the build results the platform posts back. Whoever may start a task on the repo may start this.
 */
export async function setupEnvironment(
  f = fetch,
  subject: EnvironmentSubject,
  input: { agentId: string; model?: string; thinking?: ThinkingLevel },
): Promise<CreateTaskResponse> {
  return createTaskResponseSchema.parse(
    await apiCall(f, `${subjectPath(subject)}/setup`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

/**
 * Where a build's whole log is read, through the app's proxy — a link a person opens in a new
 * tab, as plain text. The cookie the proxy reads rides along like on any other same-origin GET.
 */
export function environmentLogHref(environmentId: string): string {
  return `/api/v1/environments/${encodeURIComponent(environmentId)}/log`;
}

/** A build's log, for a page that shows it inline: as far as it has got while the build runs,
 * the whole of it once it settled. */
export async function getEnvironmentLog(f = fetch, environmentId: string): Promise<string> {
  return await apiText(f, `/v1/environments/${encodeURIComponent(environmentId)}/log`);
}

/** What the builds list can be narrowed to; absent, everything. `subject` is
 * `repo:<id>` or `workspace:<id>`. */
export interface BuildFilters {
  state?: "any" | "active" | "ready" | "failed";
  subject?: string | null;
}

const buildPageSchema = z.object({
  builds: z.array(buildListItemSchema),
  nextCursor: z.string().nullable(),
});
export type BuildPage = { builds: BuildListItem[]; nextCursor: string | null };

/** One page of every build on this deployment, newest first. */
export async function listBuilds(
  f = fetch,
  filters: BuildFilters = {},
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<BuildPage> {
  const params = new URLSearchParams();
  if (filters.state && filters.state !== "any") params.set("state", filters.state);
  if (filters.subject) params.set("subject", filters.subject);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const query = params.toString();
  return buildPageSchema.parse(
    await apiCall(f, query === "" ? "/v1/environments" : `/v1/environments?${query}`),
  );
}

/** One build, as the card shows it — what a run waiting on it polls for its progress. */
export async function getEnvironmentById(
  f = fetch,
  environmentId: string,
): Promise<EnvironmentView> {
  return environmentViewSchema.parse(
    await apiCall(f, `/v1/environments/${encodeURIComponent(environmentId)}`),
  );
}

/**
 * Starts the task's run now instead of waiting for its environment: on the newest ready image,
 * or the default one. The build goes on for the runs after it.
 */
export async function startWithoutEnvironment(f = fetch, taskId: string): Promise<void> {
  await apiCall(f, `/v1/tasks/${encodeURIComponent(taskId)}/start-without-environment`, {
    method: "POST",
  });
}
