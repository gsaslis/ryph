import { getContext, setContext } from "svelte";
import {
  getTasks,
  subscribeTasks,
  type TaskFilters,
  taskFiltersToParams,
  type TaskStreamState,
  type TaskStreamSubscription,
} from "$lib/api/tasks";
import type { TaskPage, TaskSummary } from "$lib/api/types";

/**
 * Newest first, ties broken by id — exactly the server's `ORDER BY created_at DESC, id DESC`.
 * Both columns are text there and the timestamps are ISO-8601, so comparing the strings is the
 * same comparison the database made; a row inserted here lands where the next page would put it.
 */
function newestFirst(a: TaskSummary, b: TaskSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * The task list as the section holds it: the rows on screen, how to get more of them, and a tail
 * that keeps them current.
 *
 * ONE INSTANCE PER SECTION, not per view. The pane and the narrow-screen table are two drawings
 * of the same list and are both mounted at once (the pane is only hidden by CSS), so a list per
 * view would mean two page loads, two streams, and two answers to "what is on screen".
 *
 * The load is still what puts the first page here — that is what makes the list server-rendered
 * and what a reload or an `invalidate` re-runs. Everything after that is this: deeper pages from
 * `loadMore`, and rows the stream rewrites.
 */
export class LiveTaskList {
  /** What is on screen, newest first. */
  rows = $state<TaskSummary[]>([]);
  /** The filters these rows were read under — what `loadMore` and the tail must ask with. */
  filters = $state<TaskFilters>({});
  /** Opaque; null means the list ends here. */
  nextCursor = $state<string | null>(null);
  loadingMore = $state(false);
  /** Connection health is distinct from the last successfully loaded rows. */
  streamState = $state<TaskStreamState>("connecting");
  streaming = $derived(this.streamState === "live");
  // Transport handles must not become effect dependencies.
  #subscription: TaskStreamSubscription | null = null;
  #disconnect: (() => void) | null = null;

  retry(): void {
    this.#subscription?.retry();
  }

  /**
   * The filters, serialized — the identity of the list these rows belong to. State, not a plain
   * field, because the tail is an effect that must reopen when this changes and only then: it is
   * the one thing that says "a different list", where `filters` is a fresh object on every load.
   */
  #key = $state("");

  /**
   * The key the in-flight `loadMore` was issued under, or null when none is. Keyed and not a
   * bare boolean because a filter change mid-flight used to leave `loadingMore` stuck true —
   * the request returned under a key that no longer matched and its `finally` declined to clear
   * the flag, so the NEW list could never page at all.
   */
  #loading = $state<string | null>(null);

  constructor(page?: TaskPage, filters: TaskFilters = {}) {
    if (page !== undefined) this.seed(page, filters);
  }

  get hasMore(): boolean {
    return this.nextCursor !== null;
  }

  /**
   * Adopt a page from the section's load. A different filter set is a different list and
   * replaces what is here; the same one is a refresh of the head, which keeps whatever deeper
   * pages have been loaded underneath it.
   */
  seed(page: TaskPage, filters: TaskFilters = {}): void {
    const key = taskFiltersToParams(filters).toString();
    if (key !== this.#key) {
      // A different list. What is on screen answers a question nobody is asking any more, and
      // the cursor into it points nowhere — both go.
      this.#key = key;
      this.filters = filters;
      this.rows = page.tasks;
      this.nextCursor = page.nextCursor;
      // Whatever is in flight belongs to the list being replaced; its answer will be discarded
      // on arrival, so this list starts able to page.
      this.#loading = null;
      this.loadingMore = false;
      return;
    }
    this.#absorbHead(page);
  }

  /**
   * Merge a fresh head page into the rows. This is the repair, and it is why the stream resends
   * its snapshot on every reconnect: a row inside the page's range that the page did not carry
   * left the filters while nobody was listening, and only comparing against the range can tell
   * that apart from a row that simply sits deeper than the head.
   */
  #absorbHead(page: TaskPage): void {
    const oldest = page.tasks.at(-1);
    // An empty head page under these filters means nothing matches them at all.
    if (oldest === undefined) {
      this.rows = [];
      this.nextCursor = page.nextCursor;
      return;
    }
    const fresh = new Set(page.tasks.map((task) => task.id));
    const kept = this.rows.filter((row) => !fresh.has(row.id) && newestFirst(row, oldest) > 0);
    this.rows = [...page.tasks, ...kept].sort(newestFirst);
    // A cursor we already hold points past rows this page never reached, so it still stands;
    // only a list that is nothing but this page takes the page's own.
    //
    // ...and a list holding NO cursor takes it too, whatever it kept. The case is a `task`
    // frame that arrived before the first `sync` (the server now orders the two, but a client
    // must not depend on that to stay correct): the row was appended to an empty list with
    // `nextCursor` null, the `sync` that followed then read it as a row deeper than its own
    // range and kept it — and without this the list would sit on a null cursor forever,
    // unable to page past one stale row.
    if (kept.length === 0 || this.nextCursor === null) this.nextCursor = page.nextCursor;
  }

  /** A row the tail says moved: replace it where it is, or place it if it belongs on screen. */
  upsert(task: TaskSummary): void {
    const at = this.rows.findIndex((row) => row.id === task.id);
    if (at !== -1) {
      this.rows[at] = task;
      return;
    }
    // A row we do not hold belongs at the head or nowhere. Below the oldest row on screen lies
    // the part of the list nobody has paged in yet; putting a row there would draw it as if the
    // gap above it had been read, and `loadMore` would then hand it over a second time.
    const oldest = this.rows.at(-1);
    if (this.hasMore && oldest !== undefined && newestFirst(task, oldest) > 0) return;
    this.rows = [...this.rows, task].sort(newestFirst);
  }

  /** A row the tail says no longer matches the filters. */
  remove(id: string): void {
    this.rows = this.rows.filter((row) => row.id !== id);
  }

  /** The next page, appended. A no-op at the end of the list or while one is already in flight. */
  async loadMore(): Promise<void> {
    const cursor = this.nextCursor;
    if (cursor === null || this.loadingMore) return;
    const key = this.#key;
    this.#loading = key;
    this.loadingMore = true;
    try {
      const page = await getTasks(fetch, this.filters, { cursor });
      // The filters changed while this was in flight: these rows answer a question nobody is
      // asking any more, and appending them would mix two lists.
      if (key !== this.#key) return;
      const held = new Set(this.rows.map((row) => row.id));
      this.rows = [...this.rows, ...page.tasks.filter((task) => !held.has(task.id))];
      this.nextCursor = page.nextCursor;
    } finally {
      // Only the request that still owns the flag may clear it: a stale one returning after the
      // filters changed must not clear the flag a newer `loadMore` is holding.
      if (this.#loading === key) {
        this.#loading = null;
        this.loadingMore = false;
      }
    }
  }

  /**
   * Attach the live tail. Returns the teardown, so the caller is an `$effect` — which also means
   * this only ever runs in the browser, where `EventSource` exists.
   */
  connect(): () => void {
    this.#disconnect?.();
    const filters = this.filters;
    const key = this.#key;
    let active = true;
    this.streamState = "connecting";
    const guard = (apply: () => void) => {
      // Frames from a tail opened under filters nobody is looking at any more. The effect closes
      // it, but a frame already in the queue must not land on the list that replaced it.
      if (active && key === this.#key) apply();
    };
    const sub: TaskStreamSubscription = subscribeTasks(filters, {
      onSync: (page) => guard(() => this.#absorbHead(page)),
      onState: (state) => guard(() => (this.streamState = state)),
      onTask: (task) => guard(() => this.upsert(task)),
      onLeave: (id) => guard(() => this.remove(id)),
    });
    this.#subscription = sub;
    const disconnect = () => {
      if (!active) return;
      active = false;
      sub.close();
      if (this.#subscription === sub) {
        this.#subscription = null;
        this.#disconnect = null;
        this.streamState = "suspended";
      }
    };
    this.#disconnect = disconnect;
    return disconnect;
  }
}

const TASK_LIST_KEY = Symbol("task-list");

/**
 * The section's list, shared. The pane sits beside the page panel and can therefore only be
 * rendered by the app shell, while the narrow-screen table is a page inside it — context is what
 * lets the two be the same list without the shell threading it through every route.
 */
export function setTaskListContext(list: LiveTaskList): LiveTaskList {
  return setContext(TASK_LIST_KEY, list);
}

export function getTaskListContext(): LiveTaskList {
  return getContext<LiveTaskList>(TASK_LIST_KEY);
}
