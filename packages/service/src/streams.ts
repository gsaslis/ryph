// Long-lived streams, ended once a drain stops accepting new requests.
//
// `serve`'s `shutdown()` (serve.ts) waits for every in-flight request, and two kinds never finish on
// their own: a Server-Sent Events tail (a browser tab on a task page) and a streamed NDJSON
// request body (a runner's live uplink, open for the whole run). One of either holds the drain to
// its deadline, every time — which locally is a Ctrl-C that seems to do nothing for 25 s and a
// second Ctrl-C that skips closing the database.
//
// Both are safe to end early. A viewer's EventSource reconnects and replays from the store; an
// uplink's producer reconnects and replays its room. So `end()` closes every SSE response and
// errors every NDJSON request body still open, and everything else — ordinary requests, uploads —
// is left to finish inside the deadline as before. A request body is ERRORED, never closed: a
// closed one reads as complete, and a cut-short body must never be taken for a whole one.
//
// An SSE response can also be WORK rather than a tail — a streamed completion on the model proxy,
// a streamed tool call on the MCP gateway. Those listeners say which with `work`. Work is spared
// by `endTails()`, so a drain can give it a grace first, and `end()` errors it instead of closing
// it: a clean close reads as a finished reply, an error as a failed call the client can retry.

export type FetchHandler<A extends unknown[] = []> = (
  req: Request,
  ...rest: A
) => Response | Promise<Response>;

export interface StreamTracker {
  /** The handler, with its long-lived streams tracked. */
  wrap<A extends unknown[]>(
    handler: FetchHandler<A>,
  ): (req: Request, ...rest: A) => Promise<Response>;
  /** Ends every tracked stream, and any opened after. */
  end(): void;
  /** Ends every tail, and any opened after, sparing work: what a graced listener's drain does first. */
  endTails(): void;
  /** How many are open, for tests and logs. */
  readonly open: number;
  /** Requests whose handler has not returned yet — what a drain still waits on, for its logs. */
  readonly inFlight: number;
}

/** The "draining" every ended request body errors with. */
export class DrainingError extends Error {
  constructor() {
    super("the server is draining");
    this.name = "DrainingError";
  }
}

export interface TrackStreamsOptions {
  /** Which SSE responses are work, a reply a cut must not pass for whole; none by default. */
  work?: (req: Request) => boolean;
}

/**
 * `serve`'s `onError` for a tracked listener. An errored body reaches `onError`, and the
 * default prints its stack to stderr, which a drain would do once for every stream it cuts.
 */
export function quietDrainErrors(err: unknown): Response {
  if (!(err instanceof DrainingError)) console.error(err);
  return new Response("Internal Server Error", { status: 500 });
}

const isType = (headers: Headers, type: string): boolean =>
  (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === type;

const close = (c: ReadableStreamDefaultController<Uint8Array>) => c.close();
const fail = (c: ReadableStreamDefaultController<Uint8Array>) => c.error(new DrainingError());

export function trackStreams(opts: TrackStreamsOptions = {}): StreamTracker {
  const isWork = opts.work ?? (() => false);
  // Each open stream's `finish`, and whether it is work.
  const open = new Map<() => void, boolean>();
  let tailsEnded = false;
  let ended = false;
  let inFlight = 0;

  /** A copy of `source` that `end()` stops: closed (a response) or errored (a request body). */
  const guarded = (
    source: ReadableStream<Uint8Array>,
    stop: (c: ReadableStreamDefaultController<Uint8Array>) => void,
    work: boolean,
  ): ReadableStream<Uint8Array> => {
    const reader = source.getReader();
    let finish: () => void = () => {};
    return new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          if (!open.delete(finish)) return;
          try {
            stop(controller);
          } catch {
            // Already closed or errored from the other side.
          }
          // Runs the source's own `cancel`, which is where a tail drops its subscription and
          // keepalive timer.
          reader.cancel(new DrainingError()).catch(() => {});
        };
        open.set(finish, work);
        if (ended || (tailsEnded && !work)) finish();
      },
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (open.delete(finish)) controller.error(err);
          return;
        }
        // Ended while this read waited: `finish` has already settled the controller.
        if (!open.has(finish)) return;
        if (chunk.done) {
          open.delete(finish);
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      cancel(reason) {
        open.delete(finish);
        return reader.cancel(reason);
      },
    }, { highWaterMark: 0 });
  };

  return {
    wrap: <A extends unknown[]>(handler: FetchHandler<A>) => async (req: Request, ...rest: A) => {
      let body: ReadableStream<Uint8Array> | null = null;
      if (req.body !== null && isType(req.headers, "application/x-ndjson")) {
        body = guarded(req.body, fail, false);
        req = new Request(req, {
          body,
          // Required by the constructor for a stream body; the handler reads it as before.
          duplex: "half",
        } as RequestInit);
      }
      inFlight++;
      let res: Response;
      try {
        res = await handler(req, ...rest);
      } finally {
        inFlight--;
        // A body the handler answered without reading (a refusal, a 401) will never be read, and
        // left open it would stay tracked for the life of the process.
        if (body !== null && !body.locked) body.cancel(new DrainingError()).catch(() => {});
      }
      if (res.body === null || !isType(res.headers, "text/event-stream")) return res;
      const work = isWork(req);
      return new Response(guarded(res.body, work ? fail : close, work), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    },
    end() {
      ended = true;
      for (const finish of [...open.keys()]) finish();
    },
    endTails() {
      tailsEnded = true;
      for (const [finish, work] of [...open]) if (!work) finish();
    },
    get open() {
      return open.size;
    },
    get inFlight() {
      return inFlight;
    },
  };
}
