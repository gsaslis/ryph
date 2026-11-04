// The sanitizer process: one per publish, started by process_preparer.ts in one of two shapes.
// The author's HTML comes in on stdin; one JSON answer goes out on stdout: a `PreparedHtml`,
// `{ kind: "out_of_memory" }` or `{ kind: "error", error }`.
//
// CONFINED: `node --permission --allow-fs-read=<its own modules> --max-old-space-size=<heapMb>
// sanitizer.ts <budgetMs> <heapMb> --confined`. Node's permission model grants it reading its own
// modules and nothing else: no write, no network, no child process, no worker, no addon, no WASI,
// no inspector. Before it reads a byte of the document it proves that (`assertConfined`): a
// process that holds any of those answers an error, which the parent takes as the platform's
// fault and never as a document. The parse runs on its one thread, whose V8 heap is capped by
// `--max-old-space-size`: past it V8 aborts the process ("JavaScript heap out of memory"), which
// the parent refuses as `too_complex`.
//
// UNCONFINED, where no Node 25 or later is there to run it: the runtime that started it runs it
// again, `<runtime> sanitizer.ts <budgetMs> <heapMb>`, or `<binary> __artifact-sanitizer
// <runtimeDir> <budgetMs> <heapMb>` (the binary's entry hands the last two here before it loads
// anything else). It holds every right of its uid, with an empty environment and an empty working
// directory; the parent logs that once at boot. The parse runs in a node:worker_threads worker
// with `resourceLimits` (which Node honours and Bun ignores, measured on 1.4.2), and this thread,
// idle while the worker parses, answers `out_of_memory` and exits once the process has grown by
// more than `heapMb` since the worker loaded.
//
// Time is the parent's to enforce in both: it SIGKILLs this process at the deadline, whatever it
// is doing.

import { text } from "node:stream/consumers";
import { Worker } from "node:worker_threads";
import { prepareArtifactHtml } from "../../helpers/artifact_html.ts";
import { assertConfined } from "./sanitizer_permissions.ts";

/** The subcommand a compiled binary that embeds the orchestrator must hand to
 * `runArtifactSanitizer` (packages/ryph/src/entry.ts does), before it imports anything else. */
export const ARTIFACT_SANITIZER_SUBCOMMAND = "__artifact-sanitizer";

/** The last argument of a confined run: the process must prove its confinement before reading. */
export const CONFINED_FLAG = "--confined";

/** The worker's module, for an unconfined run. A compiled binary carries it only because
 * packages/ryph/scripts/compile.ts names it: `new Worker(new URL(...))` is not an import. */
const WORKER_URL = new URL("./sanitizer_worker.ts", import.meta.url);

/** How often an unconfined run looks at its own size. */
const MEMORY_POLL_MS = 10;

/** Runs the sanitizer process on `args` (`<budgetMs> <heapMb> [--confined]`), then exits it. */
export async function runArtifactSanitizer(args: string[]): Promise<never> {
  const [budgetMs, heapMb] = args.slice(0, 2).map(Number);
  const confined = args.length === 3 && args[2] === CONFINED_FLAG;
  if (!(budgetMs > 0) || !(heapMb > 0) || (args.length !== 2 && !confined)) {
    return answer({ kind: "error", error: `bad arguments: ${args.join(" ")}` });
  }
  return confined ? await runConfined(budgetMs) : await runInWorker(budgetMs, heapMb);
}

/** The confined shape: proves its confinement, then parses on this thread. */
async function runConfined(budgetMs: number): Promise<never> {
  try {
    assertConfined();
  } catch (err) {
    return answer({ kind: "error", error: err instanceof Error ? err.message : String(err) });
  }
  const html = await text(process.stdin);
  // The clock starts here, once the process has started and loaded: start-up is the parent's
  // grace (process_preparer.ts), not the document's budget.
  const deadline = performance.now() + budgetMs;
  try {
    return answer(prepareArtifactHtml(html, deadline));
  } catch (err) {
    return answer({ kind: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

/** The unconfined shape: parses in a worker, and watches the process's size from here. */
async function runInWorker(budgetMs: number, heapMb: number): Promise<never> {
  const worker = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: heapMb } });
  // The worker's first message says it has loaded.
  let isReady = false;
  let ready = () => {};
  const loaded = new Promise<void>((resolve) => ready = resolve);
  let settle = (_: unknown) => {};
  const answered = new Promise<unknown>((resolve) => {
    settle = resolve;
    worker.on("message", (message: { kind: string }) => {
      if (message.kind !== "ready") resolve(message);
      else {
        isReady = true;
        ready();
      }
    });
    worker.once("error", (err: Error & { code?: string }) => {
      resolve(
        err.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? { kind: "out_of_memory" }
          : { kind: "error", error: err.message },
      );
    });
    // The worker answers whatever the document makes the sanitizer throw, so once it is running
    // the one way it ends unanswered is V8 stopping it at its heap cap, which can surface as a
    // plain exit when it happens inside a message handler.
    worker.once("exit", () => {
      resolve(
        isReady
          ? { kind: "out_of_memory" }
          : { kind: "error", error: "the worker exited before it loaded" },
      );
    });
  });
  const first = await Promise.race([loaded.then(() => null), answered]);
  if (first !== null) return answer(first);
  // Where `resourceLimits` is not honoured, this is the cap: the process may grow by `heapMb`
  // past what it was once everything had loaded.
  const ceiling = process.memoryUsage.rss() + heapMb * 1024 * 1024;
  const watch = setInterval(() => {
    if (process.memoryUsage.rss() > ceiling) settle({ kind: "out_of_memory" });
  }, MEMORY_POLL_MS);
  const html = await text(process.stdin);
  worker.postMessage({ html, budgetMs });
  const result = await answered;
  clearInterval(watch);
  return answer(result);
}

/** Writes `result` to stdout, whole, and exits. */
function answer(result: unknown): Promise<never> {
  return new Promise<never>(() => {
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
  });
}

if (import.meta.main) await runArtifactSanitizer(process.argv.slice(2));
