// The sanitizer's isolate inside an unconfined sanitizer process (sanitizer.ts): a
// node:worker_threads worker, so that the process's own thread stays free to watch its size, and
// so that a runtime that honours `resourceLimits` caps its heap. It says it has loaded (`ready`),
// then takes one message (the author's HTML and the budget) and answers once. The process exits
// after it. A confined process parses on its own thread instead: it may start no worker.

import { parentPort } from "node:worker_threads";
import { prepareArtifactHtml } from "../../helpers/artifact_html.ts";

parentPort!.postMessage({ kind: "ready" });
parentPort!.once("message", ({ html, budgetMs }: { html: string; budgetMs: number }) => {
  // The clock starts here, once the process and the worker have started and loaded: start-up
  // is the parent's grace (process_preparer.ts), not the document's budget.
  const deadline = performance.now() + budgetMs;
  try {
    parentPort!.postMessage(prepareArtifactHtml(html, deadline));
  } catch (err) {
    parentPort!.postMessage({
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
