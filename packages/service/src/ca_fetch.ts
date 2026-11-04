// A fetch that trusts one CA: what `Deno.createHttpClient({ caCerts })` gave the Kubernetes API
// clients, whose API server presents a certificate signed by the cluster's own CA.
//
// The global fetch cannot be told about a CA without a runtime extension: Bun's fetch ignores an
// undici `dispatcher` (measured on Bun 1.4: the request fails verification, as it should with no
// CA), and Bun's `tls` option is a `Bun.*`-only extension. node:https's `ca` works under both Bun
// and Node, so this is a fetch-shaped function over it.
//
// The CA REPLACES the default roots rather than adding to them, as Deno's `caCerts` did: a
// certificate is accepted only if this CA signed it. For a cluster's API server that is the whole
// point, and stricter than before. Verification is never turned off here: there is no option to.
//
// Deliberately small: one request, its streamed answer, an AbortSignal. No redirects are followed
// (the API server sends none); a 3xx comes back as itself.

import { request } from "node:https";
import type { IncomingMessage } from "node:http";

export type CaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** A response body that errors, rather than ends, if the connection drops before it is whole. */
function bodyOf(res: IncomingMessage): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 0) <= 0) res.pause();
      });
      res.once("end", () => {
        if (settled) return;
        settled = true;
        controller.close();
      });
      const cut = (err?: Error) => {
        if (settled) return;
        settled = true;
        controller.error(err ?? new Error("the response was cut short"));
      };
      res.once("error", cut);
      res.once("close", () => {
        if (!res.complete) cut();
      });
    },
    pull() {
      res.resume();
    },
    cancel() {
      settled = true;
      res.destroy();
    },
  }, { highWaterMark: 64 * 1024, size: (chunk) => chunk?.byteLength ?? 0 });
}

/** A fetch for https: URLs that accepts only certificates `ca` (PEM, one or more) signed. */
export function caFetch(ca: string | string[]): CaFetch {
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.protocol !== "https:") {
      throw new TypeError(`caFetch is for https: URLs, not ${url.protocol}`);
    }
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    // Read whole before sending: these are small JSON requests, and a length lets the request go
    // out unchunked.
    const body = init.body === undefined || init.body === null
      ? undefined
      : new Uint8Array(await new Response(init.body).arrayBuffer());
    if (body !== undefined && !headers.has("content-length")) {
      headers.set("content-length", String(body.byteLength));
    }
    const outgoing: Record<string, string[]> = {};
    for (const [name, value] of headers) (outgoing[name] ??= []).push(value);
    return await new Promise<Response>((resolve, reject) => {
      const req = request(url, {
        method: init.method ?? "GET",
        headers: outgoing,
        ca,
        // Explicit, though it is node's default: this function exists to verify.
        rejectUnauthorized: true,
        signal,
      }, (res) => {
        const answer = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          answer.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        }
        const status = res.statusCode ?? 0;
        const nullBody = status === 204 || status === 304 || (init.method ?? "GET") === "HEAD";
        if (nullBody) res.resume();
        resolve(
          new Response(nullBody ? null : bodyOf(res), {
            status,
            statusText: res.statusMessage,
            headers: answer,
          }),
        );
      });
      req.once("error", reject);
      req.end(body);
    });
  };
}
