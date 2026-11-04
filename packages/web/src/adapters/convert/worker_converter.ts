// The conversion, in a worker thread, with a wall-clock budget and a ceiling on how many run at
// once. Two problems, one shape:
//
// - A BUDGET THAT BITES. Parsing and rewriting a hostile megabyte of HTML blocks for seconds —
//   53 of them, for the worst shape measured — and you
//   cannot cancel a synchronous call from the outside. A worker you can: `terminate()` kills it
//   mid-parse and the memory goes with the isolate, which is the only enforcement available.
// - A CEILING. Two conversions at once is the cap, and the third is refused rather than queued:
//   a queue behind a several-second job is a wait nobody asked for, and telling one agent "busy,
//   try again" is a far better outcome than every run's tools going slow together.
//
// ONE WORKER PER CONVERSION, deliberately. Measured at 75–105 ms to spawn one, load the three
// libraries and answer — next to a network fetch that is noise, and it buys the property that
// matters: after every call, whatever that page did to the heap is gone. A pooled worker would
// save the 75 ms and keep the leak.
//
// The worker is NOT a permission boundary. It shares this process's privileges, and it needs
// none of them anyway: it is handed a string and answers with a string. What it is, is a place
// where CPU and memory can be taken away.
//
// The compiler does not follow `new Worker(new URL(...))`, so the binary carries this worker
// only because packages/ryph/scripts/compile.ts names it. That is a real coupling and it is
// written down in both places.

import { Worker } from "node:worker_threads";
import type { ConvertedPage } from "../../core/markdown.ts";
import { ConversionRefusedError, type Converter } from "../../ports/converter.ts";

/** How long one page may take before its worker is killed. */
export const DEFAULT_CONVERT_BUDGET_MS = 5_000;
/**
 * How many conversions may run at once, service-wide. TWO, and the number is arithmetic rather
 * than taste: a megabyte of adversarial HTML measures at up to ~400 MB resident while it is
 * being parsed and scored, so two of them plus this process's own ~150 MB fits inside the 2Gi
 * the Deployment asks for, with room for the page that is merely large. Four did not.
 */
export const DEFAULT_MAX_IN_FLIGHT = 2;

/**
 * What the worker turns a page into: web__fetch's reader-mode markdown (core/markdown.ts), or
 * the whole page as plain text (core/text.ts) for memory's URL ingest, which keeps every word.
 */
export type ConvertFormat = "markdown" | "text";

export interface WorkerConverterOptions {
  budgetMs?: number;
  maxInFlight?: number;
  /** Default "markdown". With "text", the page's `markdown` is the plain text. */
  format?: ConvertFormat;
}

/** The worker's module, resolved here so both a source run and the compiled binary find it. */
const WORKER_URL = new URL("./convert_worker.ts", import.meta.url);

export function workerConverter(options: WorkerConverterOptions = {}): Converter {
  const budgetMs = options.budgetMs ?? DEFAULT_CONVERT_BUDGET_MS;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const format = options.format ?? "markdown";
  let closed = false;
  // Every worker currently running, with the way to end its caller's wait. A COUNT would have
  // been enough for the ceiling, but not for the shutdown this promises: `close()` says that
  // in-flight conversions die with their workers, and a flag cannot terminate anything.
  const running = new Set<{ terminate: () => void }>();

  return {
    convert(html: string, url: string): Promise<ConvertedPage> {
      if (closed) {
        return Promise.reject(new ConversionRefusedError("the web service is shutting down"));
      }
      if (running.size >= maxInFlight) {
        return Promise.reject(
          new ConversionRefusedError(
            `this deployment is already converting ${maxInFlight} pages at once, which is its ` +
              "limit — try again in a moment",
          ),
        );
      }
      return new Promise<ConvertedPage>((resolve, reject) => {
        let worker: Worker;
        try {
          worker = new Worker(WORKER_URL);
        } catch (err) {
          reject(new ConversionRefusedError(`the page could not be converted (${String(err)})`));
          return;
        }
        let settled = false;
        const finish = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          void worker.terminate();
          running.delete(entry);
          outcome();
        };
        // What `close()` reaches for: ending this conversion means killing the worker AND
        // answering the caller, who is otherwise waiting on a promise nothing will settle.
        const entry = {
          terminate: () =>
            finish(() => reject(new ConversionRefusedError("the web service is shutting down"))),
        };
        running.add(entry);
        const deadline = setTimeout(
          () =>
            finish(() =>
              reject(
                new ConversionRefusedError(
                  `that page took longer than ${
                    Math.round(budgetMs / 1000)
                  }s to convert and was stopped — it is too big or too complex for this tool. ` +
                    "Try a more specific page, or its raw/plain-text version",
                ),
              )
            ),
          budgetMs,
        );
        worker.on("message", (message: unknown) => {
          const data = message as
            | { ok: true; page: ConvertedPage }
            | { ok: false; error: string };
          finish(() =>
            data.ok ? resolve(data.page) : reject(
              new ConversionRefusedError(`the page could not be converted (${data.error})`),
            )
          );
        });
        worker.on("error", () => {
          // A worker that dies (out of memory, a library throwing where it cannot be caught) is
          // this page's problem, never the service's: the error is consumed here.
          finish(() =>
            reject(
              new ConversionRefusedError("the page could not be converted (it broke the reader)"),
            )
          );
        });
        worker.postMessage({ html, url, format });
      });
    },
    close() {
      closed = true;
      // A copy, because terminating each one removes it from the set.
      for (const entry of [...running]) entry.terminate();
    },
  };
}
