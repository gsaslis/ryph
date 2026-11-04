import { getContext, setContext } from "svelte";
import type { BackgroundJob } from "$lib/api/background";

// The run's background commands as the page holds them, for the transcript: a background tool
// call or a job's notice names the job as the Commands tab lists it, and opens it there. A page
// without a Commands tab sets nothing, and those rows read on their own.

const KEY = Symbol("background-jobs");

export interface BackgroundJobsContext {
  /** The job by id, as the tab lists it; undefined for one the page does not hold. */
  job(id: string): BackgroundJob | undefined;
  /** The job is one the page can open: listed, or started in the loaded transcript. */
  knows(id: string): boolean;
  /** Opens the job in the Commands tab, opening the pane (or its sheet) too. */
  open(id: string): void;
}

export function setBackgroundJobsContext(context: BackgroundJobsContext): void {
  setContext(KEY, context);
}

export function getBackgroundJobsContext(): BackgroundJobsContext | undefined {
  return getContext<BackgroundJobsContext | undefined>(KEY);
}
