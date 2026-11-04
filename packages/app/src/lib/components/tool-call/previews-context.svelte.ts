import { getContext, setContext } from "svelte";
import { getRunPreviews, type RunPreview } from "$lib/api/previews";
import { previewHref } from "$lib/utils/previews";

const KEY = Symbol("run-previews");

/** One discovery loop for the transcript and Commands pane, owned by the run page. It reads once
 * on connect, since the call that exposed a port may sit in history the page has not loaded, then
 * keeps polling only while the run has previews or its transcript shows an `expose_port` call (see
 * `called`). A run that never exposes a port costs one read. */
export class PreviewsState {
  previews = $state<RunPreview[]>([]);
  status = $state<"loading" | "ready" | "unavailable" | "ended">("loading");

  #runId = $state<string | null>(null);
  #taskId = $state<string | null>(null);
  /** The grant the last poll carried, so an open link renews along with the list. */
  #grant = $state<string | null>(null);
  /** The run whose transcript has shown a preview call, and what restarts a stopped loop. */
  #calledFor: string | null = null;
  #begin: (() => void) | null = null;

  /** The app route that opens a preview in a new tab: `/previews/<runId>/<id>`. */
  href(preview: RunPreview): string | undefined {
    if (this.#runId === null) return undefined;
    return previewHref(this.#runId, preview.id, { grant: this.#grant, taskId: this.#taskId });
  }

  /** The transcript of `runId` shows a preview call: discovery keeps going, now or once connected. */
  called(runId: string): void {
    this.#calledFor = runId;
    if (this.#runId === runId) this.#begin?.();
  }

  connect(
    runId: string,
    grant: () => string | null,
    ended: boolean,
    taskId: string | null = null,
  ): () => void {
    this.previews = [];
    this.#runId = runId;
    this.#taskId = taskId;
    this.#grant = grant();
    this.status = ended ? "ended" : "loading";
    if (ended) return () => {};
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each poll is a run lookup; a background tab need not make one.
    const whenVisible = () => {
      document.removeEventListener("visibilitychange", whenVisible);
      if (!document.hidden) void refresh();
      else document.addEventListener("visibilitychange", whenVisible);
    };
    const refresh = async () => {
      try {
        const current = grant();
        const result = await getRunPreviews(fetch, runId, current, abort.signal);
        if (abort.signal.aborted) return;
        this.#grant = current;
        this.previews = result ?? [];
        this.status = result === null ? "unavailable" : "ready";
        if (result === null) return;
      } catch {
        if (abort.signal.aborted) return;
        // Keep the last list in place during a transient failure, but disable its actions.
        // Only a successful discovery (including an empty list) can replace that snapshot.
        this.status = "unavailable";
      }
      if (this.#calledFor !== runId && this.previews.length === 0) {
        looping = false;
        return;
      }
      timer = setTimeout(whenVisible, 3000);
    };
    let looping = false;
    const begin = () => {
      if (looping) return;
      looping = true;
      void refresh();
    };
    this.#begin = begin;
    begin();
    return () => {
      if (this.#begin === begin) this.#begin = null;
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }
}

export function setPreviewsContext(state: PreviewsState): void {
  setContext(KEY, state);
}

export function getPreviewsContext(): PreviewsState | undefined {
  return getContext<PreviewsState | undefined>(KEY);
}
