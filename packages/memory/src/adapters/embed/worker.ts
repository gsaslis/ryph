// The local embedder's own thread: `workerEmbedder` (worker_embedder.ts) posts here, and the
// model loads and runs here, off the service's event loop. See that file for why.

import { localEmbedder, type LocalEmbedderOptions } from "./local.ts";

export type EmbedCall =
  | { kind: "load"; opts: LocalEmbedderOptions }
  | { kind: "embed"; texts: string[] };

export type EmbedRequest = EmbedCall & { id: number };

export type EmbedReply =
  | { id: number; ok: true; vectors?: number[][] }
  | { id: number; ok: false; error: string };

/** The two members of the worker's global scope this file uses. */
declare const self: {
  onmessage: ((event: MessageEvent<EmbedRequest>) => void) | null;
  postMessage(message: EmbedReply): void;
};

let embedder: ReturnType<typeof localEmbedder> | null = null;

self.onmessage = async (event: MessageEvent<EmbedRequest>) => {
  const request = event.data;
  const reply = (message: EmbedReply) => self.postMessage(message);
  try {
    if (request.kind === "load") {
      embedder = localEmbedder(request.opts);
      await embedder.load();
      reply({ id: request.id, ok: true });
      return;
    }
    if (embedder === null) throw new Error("the embedder was asked to embed before it loaded");
    reply({ id: request.id, ok: true, vectors: await embedder.embed(request.texts) });
  } catch (err) {
    reply({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
