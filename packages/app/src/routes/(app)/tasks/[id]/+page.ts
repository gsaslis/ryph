import type { PageLoad } from "./$types";
import { browser } from "$app/environment";
import { getTask } from "$lib/api/tasks";
import {
  getRunEventsAfter,
  getRunHead,
  getRunTail,
  type HistoryPage,
  type HistoryWindow,
} from "$lib/api/history";
import { getRunUsageState } from "$lib/api/model-usage";
import { type TaskDetail, TERMINAL_RUN_STATES } from "$lib/api/types";
import { taskName } from "$lib/utils/task-prompt";
import { type HistoryRead, historyRead, holding, readsBill } from "./holding";

/** The newest events, which is where the page opens. */
const TAIL = 200;
/**
 * The first events of the run — the `workspace.created` the tool rows relativise paths against,
 * and the handful of lifecycle chunks that say the session started. Never grows: nothing deeper
 * than this is read until somebody scrolls there.
 */
const HEAD = 50;
/**
 * The most the historian will answer in one read: more than a page should pull before first paint.
 * A page that missed more than this since what it holds is read as every re-load used to read it —
 * the run's newest page, and nothing of what lies between — so the history draws there exactly
 * what it always drew.
 */
const MAX_PAGE = 1_000;

/** An empty window, for a task whose run has not been minted yet. */
function noHistory(): HistoryWindow {
  const empty = { events: [], firstSeq: -1, lastSeq: -1, hasMore: false };
  return { head: empty, tail: { ...empty } };
}

/** One read that is allowed not to answer: what came back, or what went wrong asking. */
type Read = { page: HistoryPage } | { error: string };

/**
 * A history read the load survives.
 *
 * This load re-runs again and again while a run is live, and the first one of a run makes three or
 * four reads, later ones a read since what the page holds — so over an hour of watching a run it is
 * still a great many requests,
 * and the odds that none of them ever meets a gateway mid-rollout are nil. One that does used to
 * reject the `Promise.all` and put the page on SvelteKit's error screen, with a run still going on
 * the other side of it. What a read that did not answer costs now is that one page of the window.
 */
async function attempt(read: Promise<HistoryPage>): Promise<Read> {
  try {
    return { page: await read };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "could not read the run's history" };
  }
}

/**
 * The run's two ends. A small missing middle is returned as background work, never awaited
 * before the conversation can render.
 *
 * A short run is the case the third read exists for: four hundred events of a "ping" conversation
 * are a few dozen rows once the diag voice is filtered out, so head and tail land on the same
 * screen with the hole between them, and the gap row drew, fetched itself and vanished inside a
 * frame or two. Two requests for a run with no hole, three for one small enough to close, and
 * never more than that.
 *
 * Any of them may come back empty-handed. The window then carries whatever DID answer plus the
 * reason the rest did not, and `RunHistory.seed` takes it as far as it goes.
 */
async function windowOf(
  f: typeof fetch,
  runId: string,
  grant: string | null,
): Promise<{ history: HistoryWindow; olderHistory: Promise<HistoryWindow> | null }> {
  // Both ends at once, because the tail alone cannot say where the checkout lived; the hole
  // between them is only knowable once they are both here, so closing it is a third read.
  const [head, tail] = await Promise.all([
    attempt(getRunHead(f, runId, HEAD, grant)),
    attempt(getRunTail(f, runId, TAIL, grant)),
  ]);
  if (!("page" in head) || !("page" in tail)) {
    return {
      olderHistory: null,
      history: {
        ...("page" in head ? { head: head.page } : {}),
        ...("page" in tail ? { tail: tail.page } : {}),
        // Whichever failed; the tail's is the one that matters, since it is the end of the run the
        // page opens on and the one whose absence is felt.
        error: "error" in tail ? tail.error : "error" in head ? head.error : undefined,
      },
    };
  }
  const hole = tail.page.firstSeq - head.page.lastSeq - 1;
  const history = { head: head.page, tail: tail.page };
  if (hole <= 0 || hole > MAX_PAGE) return { history, olderHistory: null };
  // Always resolves: losing this read leaves a gap the reader can fetch on demand.
  const olderHistory = attempt(getRunEventsAfter(f, runId, head.page.lastSeq, hole, grant))
    .then((middle): HistoryWindow => "page" in middle ? { middle: middle.page } : {});
  return { history, olderHistory };
}

/**
 * What the run has added since `after`, for a page that holds everything up to it. Behind a live
 * tail that is delivering, that is next to nothing; behind one that stalled, failed or was torn
 * down because the run is over, it is what the tail did not deliver.
 *
 * Read forwards from where the page's history ends rather than as the run's newest page, so the
 * events the page missed arrive as one stretch with nothing left out between. A run that outran
 * one read is read at its end instead, which is what every re-load used to take: the history takes
 * that page as it always took it, gap row and all. Handed back as the window's tail, which is all
 * a seeded history takes of a later window.
 */
async function since(
  f: typeof fetch,
  runId: string,
  after: number,
  grant: string | null,
): Promise<HistoryWindow> {
  const newer = await attempt(getRunEventsAfter(f, runId, after, MAX_PAGE, grant));
  const read = "page" in newer && newer.page.hasMore
    ? await attempt(getRunTail(f, runId, TAIL, grant))
    : newer;
  return "page" in read ? { tail: read.page } : { error: read.error };
}

/** The run's history, as far as the page needs it read. */
async function historyOf(
  f: typeof fetch,
  runId: string,
  grant: string | null,
  read: HistoryRead,
): Promise<{ history: HistoryWindow; olderHistory: Promise<HistoryWindow> | null }> {
  switch (read.kind) {
    case "window":
      return await windowOf(f, runId, grant);
    case "since":
      return { history: await since(f, runId, read.after, grant), olderHistory: null };
  }
}

/**
 * The task this browser last read a detail for, and the title it had.
 *
 * A load is only allowed to come back without a detail for a task it has already shown once —
 * that is what makes the difference between "the page cannot open" (which is an error screen, as
 * it has always been) and "the poll behind an open page missed a beat" (which is an indicator).
 * The page itself cannot make that call: it has no way to fail a load, and the load has no memory
 * of its own, so the memory is here.
 *
 * Browser only, and one slot: on the server every load IS a first load — it has no page on screen
 * to keep — and module state there is shared by every request the node server handles, which is
 * the last place to remember one reader's task.
 */
let shown: { id: string; title: string } | null = null;

export const load: PageLoad = async ({ fetch, params, depends }) => {
  depends("app:task");
  const rerun = browser && shown?.id === params.id;
  let detail: TaskDetail | null;
  try {
    detail = await getTask(fetch, params.id);
  } catch (e) {
    // The first look at a task has nothing to fall back on: a detail that cannot be read is a page
    // that cannot be drawn, and saying so is the honest answer. A later one has the whole page
    // still on screen behind it.
    if (!rerun) throw e;
    detail = null;
  }
  if (detail === null) {
    // This poll learned nothing. It says so rather than guessing: everything below is ABOUT the
    // detail — which run to read, which run to bill — and reading any of it off a detail that did
    // not arrive would only produce a second wrong answer. The page keeps what it last had and
    // shows a quiet indicator; the next poll is what clears it.
    const nothing: HistoryWindow = {};
    return {
      detail: null,
      history: nothing,
      olderHistory: null,
      usage: null,
      breadcrumb: shown?.title,
      detailsPane: true,
    };
  }
  // The latest run is the one the page follows; earlier attempts stay in `detail.runs`.
  const run = detail.runs.at(-1) ?? null;
  // What the page on screen already holds of that run, which this load does not read again. The
  // first look at a run — this page's, or a page opened on it afresh — holds nothing.
  const held = browser && run !== null ? holding(run.id) : null;
  const over = run !== null && TERMINAL_RUN_STATES.includes(run.state);
  // Start the bill alongside history, but never make the conversation wait for it. `null` is the
  // page reading it itself: it keeps the bill it has.
  const usage = run === null
    ? Promise.resolve({ usage: null, unavailable: false })
    : readsBill(held, over)
    ? getRunUsageState(fetch, run.id, run.grants?.models)
      .catch(() => ({ usage: null, unavailable: true }))
    : null;
  const { history, olderHistory } = run === null
    ? { history: noHistory(), olderHistory: null }
    : await historyOf(fetch, run.id, run.grants?.history ?? null, historyRead(held));
  const name = taskName(detail.task.spec.title);
  if (browser) shown = { id: params.id, title: name };
  // `detailsPane`: the layout holds room for the pane beside the panel before the page hands its
  // content over, which only happens once it has hydrated.
  return { detail, history, olderHistory, usage, breadcrumb: name, detailsPane: true };
};
