// The local embedder, on a thread of its own.
//
// The ONNX runtime computes an embedding synchronously on whatever thread calls it. In-process,
// that thread is the service's event loop, and on a 250m pod one task-length query takes about
// four and a half seconds — measured, with the loop blocked for all of it. For those seconds the
// memory service answers nothing: not the next brief, not an agent's memory__* call, not its own
// readiness probe. A burst of run starts turned that into every brief missing the control
// plane's deadline and the pod reading as unready.
//
// In a Worker the loop stays free while the model runs, so requests keep being served and the
// query-embedding deadline in core/service.ts can actually fire. The CPU the model needs is the
// same; what changes is that nothing else has to wait behind it.
//
// Two more things follow from there being one model thread:
// - It is FIFO, so a backfill of two hundred claims would hold every search behind it for
//   minutes. Work goes to the worker a few texts at a time, one job in flight, and an urgent job
//   (a search someone is waiting on) is taken before any queued background one.
// - A worker that dies must not take the embedder with it: the jobs it held fail, and the next
//   job starts a fresh one. One that stops answering without dying is treated the same way once
//   a job has waited longer than any real one takes.

import type { Embedder } from "../../ports/embedder.ts";
import { LOCAL_EMBEDDING_MODEL, type LocalEmbedderOptions } from "./local.ts";
import type { EmbedCall, EmbedReply, EmbedRequest } from "./worker.ts";

/** Texts per worker job: small enough that an urgent search waits for little, large enough that
 * a backfill still batches. */
const CHUNK = 4;

/** How long one job may take before the worker is presumed wedged and replaced. A chunk is about
 * 18 s of model time on a contended 250m pod; loading the weights is the slow first call. */
const EMBED_TIMEOUT_MS = 120_000;
const LOAD_TIMEOUT_MS = 300_000;

interface Job {
  texts: string[];
  /** Shared by every chunk of one `embed` call: once one fails, or its caller stops waiting
   * (`signal`), the rest are not worth running. */
  request: { failed: boolean; signal?: AbortSignal };
  resolve(vectors: number[][]): void;
  reject(err: Error): void;
}

/** How long `close()` waits for the thread to be gone. */
const CLOSE_WAIT_MS = 2_000;

/**
 * Ends a worker and resolves once it is gone (or CLOSE_WAIT_MS passed). A process must not exit
 * while the thread still holds the ONNX runtime: Bun 1.4.2 aborts in a C++ exception at
 * `process.exit` with a live worker that loaded the native addon (exit 134 and a crash report,
 * measured on darwin-arm64), and exits cleanly once the worker's `close` event has fired.
 */
function terminated(target: Worker): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, CLOSE_WAIT_MS);
    (target as unknown as EventTarget).addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    target.terminate();
  });
}

/** `localEmbedder`'s interface, served by a Worker. `close()` ends the thread and resolves once
 * it is gone: await it before the process exits. */
export function workerEmbedder(
  opts: LocalEmbedderOptions,
  /** The worker module; tests swap in a stub that needs no weights. */
  workerUrl: URL = new URL("./worker.ts", import.meta.url),
): Embedder & { load(): Promise<void>; close(): Promise<void> } {
  let worker: Worker | null = null;
  let loaded: Promise<void> | null = null;
  let closed = false;
  let nextId = 0;
  const replies = new Map<number, (reply: EmbedReply) => void>();

  /** The live worker, started (and its model loaded) on first use or after a crash. */
  const current = (): Worker => {
    if (worker !== null) return worker;
    const started = new Worker(workerUrl, { type: "module" });
    started.onmessage = (event: MessageEvent<EmbedReply>) => {
      replies.get(event.data.id)?.(event.data);
      replies.delete(event.data.id);
    };
    started.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      discard(started, `the embeddings worker failed: ${event.message}`);
    };
    worker = started;
    return started;
  };

  /** Ends a worker and fails whatever it held; the next job starts a fresh one. A worker already
   * replaced holds nothing any more — its jobs failed when it was — so a late error from it must
   * not fail the jobs of the one that took its place. */
  const discard = (target: Worker, error: string) => {
    target.terminate();
    if (worker !== target) return;
    worker = null;
    loaded = null;
    for (const [id, reply] of replies) reply({ id, ok: false, error });
    replies.clear();
  };

  const ask = async (call: EmbedCall): Promise<number[][] | undefined> => {
    if (closed) throw new Error("the embedder is closed");
    const target = current();
    const id = nextId++;
    const timeoutMs = call.kind === "load" ? LOAD_TIMEOUT_MS : EMBED_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = await new Promise<EmbedReply>((resolve) => {
      replies.set(id, resolve);
      timer = setTimeout(
        () => discard(target, `the embeddings worker did not answer within ${timeoutMs} ms`),
        timeoutMs,
      );
      target.postMessage({ ...call, id } satisfies EmbedRequest);
    }).finally(() => clearTimeout(timer));
    if (!reply.ok) throw new Error(reply.error);
    return reply.vectors;
  };

  const load = (): Promise<void> => {
    loaded ??= ask({ kind: "load", opts }).then(() => {}).catch((err) => {
      loaded = null;
      throw err;
    });
    return loaded;
  };

  // One job in flight; urgent ones first.
  const urgent: Job[] = [];
  const background: Job[] = [];
  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      for (
        let job = urgent.shift() ?? background.shift();
        job;
        job = urgent.shift() ?? background.shift()
      ) {
        if (job.request.failed) {
          job.reject(new Error("another part of this embedding failed"));
          continue;
        }
        if (job.request.signal?.aborted) {
          job.reject(new Error("the caller stopped waiting"));
          continue;
        }
        try {
          await load();
          // Checked again: a (re)load can take long enough for the caller to give up meanwhile.
          if (job.request.signal?.aborted) {
            job.reject(new Error("the caller stopped waiting"));
            continue;
          }
          job.resolve((await ask({ kind: "embed", texts: job.texts })) ?? []);
        } catch (err) {
          job.request.failed = true;
          job.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      running = false;
    }
  };

  const enqueue = (texts: string[], request: Job["request"], isUrgent: boolean) =>
    new Promise<number[][]>((resolve, reject) => {
      const queue = isUrgent ? urgent : background;
      const job: Job = { texts, request, resolve, reject };
      queue.push(job);
      // A caller that stops waiting takes its job out of the queue at once, so its slot and its
      // place in line go to someone still waiting. A job already at the worker runs to the end.
      request.signal?.addEventListener("abort", () => {
        const at = queue.indexOf(job);
        if (at === -1) return;
        queue.splice(at, 1);
        reject(new Error("the caller stopped waiting"));
      }, { once: true });
      void pump();
    });

  return {
    model: LOCAL_EMBEDDING_MODEL,
    load,
    async embed(texts, embedOpts) {
      if (texts.length === 0) return [];
      const request = { failed: false, signal: embedOpts?.signal };
      const chunks: Promise<number[][]>[] = [];
      for (let i = 0; i < texts.length; i += CHUNK) {
        chunks.push(enqueue(texts.slice(i, i + CHUNK), request, embedOpts?.urgent === true));
      }
      // Settled, not raced: every chunk's rejection is observed, and the first one is thrown.
      const settled = await Promise.allSettled(chunks);
      const failed = settled.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
      return settled.flatMap((r) => r.status === "fulfilled" ? r.value : []);
    },
    async close() {
      closed = true;
      const ending = worker === null ? Promise.resolve() : terminated(worker);
      worker = null;
      for (const [id, reply] of replies) reply({ id, ok: false, error: "the embedder is closed" });
      replies.clear();
      for (const job of [...urgent, ...background]) job.reject(new Error("the embedder is closed"));
      urgent.length = 0;
      background.length = 0;
      await ending;
    },
  };
}
