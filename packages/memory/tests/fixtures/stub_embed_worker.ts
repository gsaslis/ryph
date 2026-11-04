// A stand-in for adapters/embed/worker.ts that needs no model: every text becomes [length], a
// text "slow" takes 50 ms, a text "crash" kills the worker the way an uncaught runtime error
// would, and a text "count" answers how many embed jobs this worker has run, itself included.

declare const self: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

let jobs = 0;

self.onmessage = async (event: MessageEvent) => {
  const request = event.data;
  if (request.kind === "load") return self.postMessage({ id: request.id, ok: true });
  jobs++;
  if (request.texts.includes("crash")) throw new Error("runtime exploded");
  if (request.texts.includes("count")) {
    return self.postMessage({ id: request.id, ok: true, vectors: [[jobs]] });
  }
  if (request.texts.includes("slow")) await new Promise((r) => setTimeout(r, 50));
  self.postMessage({
    id: request.id,
    ok: true,
    vectors: request.texts.map((t: string) => [t.length]),
  });
};
