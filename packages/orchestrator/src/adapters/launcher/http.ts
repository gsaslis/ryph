// The docker launcher's transport, as every client beside this file uses it: one bearer, JSON
// both ways, a deadline on every short call and none on a long one, and every failure sorted
// into the three things a caller can act on.
//
// - `ImageGone`: the launcher's adapter said the image is gone for good (`{error:"image_gone"}`,
//   a 409 or a long call's last line). Rethrown as the port's own class, so the core acts on it
//   exactly as it acts on the in-process adapter's.
// - a `LauncherError` with `retryable: false`: the launcher refused the request itself — a 400
//   (the spec failed its schema: a bug here, and the same request fails the same way again), a
//   401 (the token is wrong: configuration, not weather), a 403 (a launcher that refuses this
//   request outright), a 404 (no such route: a launcher of another version, or a part of it this
//   launcher does not serve). Nothing a retry changes.
// - a `LauncherError` with `retryable: true`: everything else. The launcher did not answer, timed
//   out, went quiet mid-call, answered a 5xx (its adapter failed: docker said no, which is
//   docker's to change), or answered something that is not the answer — a proxy's error page
//   during a restart. The forge client's rule, for the forge client's reason: "we could not ask"
//   must never read as a verdict. Of these, `unreached` marks the one failure that provably sent
//   nothing — the connection was refused or the name did not resolve — which `untilReached` asks
//   again for a while, since a launcher being recreated is away for up to a minute.
// Each client applies this to its port's own shape: a method the port lets throw throws it; a
// method that must never throw turns retryable into its "could not ask" answer and terminal into
// its failure (see each client).

import type { z } from "@zod/zod";
import { neverReached, REACH_MS, untilReached as untilServiceReached } from "@ryph/service";
import { ImageGone } from "../../ports/image_gone.ts";
import { ErrorAnswer, IMAGE_GONE, LONG_CALL_STALL_MS, LongLine } from "./wire.ts";

export interface LauncherConnection {
  /** The launcher's base URL, as THIS process dials it. */
  url: string;
  /** RYPH_LAUNCHER_TOKEN: opens the run-side routes and nothing else. */
  token: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** How long a long call may hear nothing, beats included, before it counts as lost. */
  stallMs?: number;
  /** How long `untilReached` keeps asking a launcher that cannot be connected to (90 s). */
  reachMs?: number;
}

/** A launcher call that failed, and whether asking again could answer differently. */
export class LauncherError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The HTTP status, or null when nothing answered. */
    readonly status: number | null = null,
    /**
     * Nothing was sent: no connection was made at all (refused, or the name did not resolve), so
     * the launcher cannot have acted on the request and asking again repeats nothing.
     */
    readonly unreached = false,
  ) {
    super(message);
  }
}

/**
 * A spec as it goes out: parsed with the lax schema (wire.ts), so a spec the launcher would refuse
 * fails here, terminal, naming the field — and whatever the core object carries beyond the port's
 * fields stays behind.
 */
export function outgoing<T>(schema: z.ZodType<T>, spec: unknown, what: string): T {
  const parsed = schema.safeParse(spec);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new LauncherError(`this ${what} cannot go to the launcher — ${issues.join("; ")}`, false);
}

/** Whether `err` is worth asking again: anything but the launcher's own refusal of the request. */
export function retryable(err: unknown): boolean {
  return !(err instanceof LauncherError) || err.retryable;
}

const message = (err: unknown) => err instanceof Error ? err.message : String(err);

export { neverReached, REACH_MS };

/**
 * `attempt`, asked again while it fails `unreached` — the launcher could not be connected to, so it
 * never saw the request — for at most `conn.reachMs` (@ryph/service's `untilReached`, the loop the
 * mcp-gateway's tool host shares). A launcher recreated by `compose up` is away for up to a
 * minute, and a launch that failed then would error a run over nothing.
 */
export function untilReached<T>(
  conn: LauncherConnection,
  attempt: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return untilServiceReached(attempt, {
    unreached: (err) => err instanceof LauncherError && err.unreached,
    budgetMs: conn.reachMs ?? REACH_MS,
    exhausted: (err, budget) =>
      new LauncherError(
        `${message(err)} (still unreachable after ${Math.round(budget / 1000)} s)`,
        true,
        null,
        true,
      ),
    ...(signal === undefined ? {} : { signal }),
  });
}

function base(conn: LauncherConnection): string {
  return conn.url.replace(/\/+$/, "");
}

/** The thrown form of a refusal the launcher answered without a stream. */
async function refusal(res: Response, path: string): Promise<Error> {
  const text = await res.text().catch(() => "");
  let parsed: z.infer<typeof ErrorAnswer> | null = null;
  try {
    const body = ErrorAnswer.safeParse(JSON.parse(text));
    if (body.success) parsed = body.data;
  } catch {
    // not JSON: a proxy's page, said by its status below
  }
  if (parsed?.error === IMAGE_GONE) return new ImageGone(parsed.message ?? "the image is gone");
  const said = parsed === null ? `HTTP ${res.status}` : (parsed.message ?? parsed.error);
  const terminal = res.status === 400 || res.status === 401 || res.status === 403 ||
    res.status === 404;
  return new LauncherError(`the launcher refused ${path}: ${said}`, !terminal, res.status);
}

/**
 * One short call: `body` undefined is a GET. Rejects with `ImageGone` or a `LauncherError`, never
 * with anything else.
 */
export async function launcherCall<T>(
  conn: LauncherConnection,
  path: string,
  body: unknown,
  answer: z.ZodType<T>,
  timeoutMs: number,
): Promise<T> {
  const doFetch = conn.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base(conn)}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${conn.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LauncherError(
      `the launcher did not answer ${path}: ${message(err)}`,
      true,
      null,
      neverReached(err),
    );
  }
  if (!res.ok) throw await refusal(res, path);
  if (res.status === 204) return answer.parse(undefined);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new LauncherError(`the launcher's answer to ${path} is not JSON: ${message(err)}`, true);
  }
  const parsed = answer.safeParse(raw);
  if (!parsed.success) {
    throw new LauncherError(`the launcher answered ${path} with something else`, true, res.status);
  }
  return parsed.data;
}

/**
 * One long call (see wire.ts): no deadline, the caller's `signal` the only way to stop it, and the
 * beats watched so a launcher that died mid-call is noticed within `stallMs` rather than never.
 * Aborting `signal` closes the connection, which is what the launcher's own request signal hears:
 * the server stops the work (a build) when it does. Rejects with the signal's reason when the
 * caller aborted, and otherwise only with `ImageGone` or a `LauncherError`.
 */
export async function launcherLongCall<T>(
  conn: LauncherConnection,
  path: string,
  body: unknown,
  answer: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const doFetch = conn.fetch ?? fetch;
  const stallMs = conn.stallMs ?? LONG_CALL_STALL_MS;
  const stop = new AbortController();
  const onAbort = () => stop.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) stop.abort(signal.reason);
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      stop.abort(new Error("stalled"));
    }, stallMs);
  };
  const lost = (err: unknown): never => {
    if (signal?.aborted) throw signal.reason ?? err;
    if (stalled) {
      throw new LauncherError(
        `the launcher went quiet on ${path}: nothing for ${Math.round(stallMs / 1000)} s`,
        true,
      );
    }
    throw new LauncherError(`the launcher did not finish ${path}: ${message(err)}`, true);
  };
  const unsent = (err: unknown): never => {
    if (!signal?.aborted && !stalled && neverReached(err)) {
      throw new LauncherError(
        `the launcher did not answer ${path}: ${message(err)}`,
        true,
        null,
        true,
      );
    }
    return lost(err);
  };
  try {
    heard();
    let res: Response;
    try {
      res = await doFetch(`${base(conn)}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: stop.signal,
      });
    } catch (err) {
      return unsent(err);
    }
    if (!res.ok) throw await refusal(res, path);
    if (res.body === null) return lost(new Error("an empty answer"));
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (err) {
        return lost(err);
      }
      if (chunk.done) return lost(new Error("the answer ended before its result"));
      heard();
      buffered += chunk.value;
      for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line === "") continue;
        let parsedLine: z.infer<typeof LongLine>;
        try {
          const json = LongLine.safeParse(JSON.parse(line));
          if (!json.success) throw new Error("not a line of the wire");
          parsedLine = json.data;
        } catch {
          // The stream is given up here: cancelled, so its connection does not linger unread.
          await reader.cancel().catch(() => {});
          throw new LauncherError(`the launcher answered ${path} with something else`, true);
        }
        if ("beat" in parsedLine) continue;
        await reader.cancel().catch(() => {});
        if ("error" in parsedLine) {
          if (parsedLine.error === IMAGE_GONE) throw new ImageGone(parsedLine.message);
          // Only a long call's adapter fails this way (the refusals come before the stream), so
          // this is docker's answer, said in its own words.
          throw new LauncherError(parsedLine.message, true, res.status);
        }
        const result = answer.safeParse(parsedLine.result);
        if (!result.success) {
          throw new LauncherError(`the launcher answered ${path} with something else`, true);
        }
        return result.data;
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
