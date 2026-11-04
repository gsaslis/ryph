// The served document of a publish, made by the sanitizer supervisor over a unix socket
// (sanitizer_supervisor.ts): the shape the control-plane image uses, where the control plane may
// run no program at all and the supervisor beside it alone may start the sanitizer process.
// main.ts picks it when RYPH_ARTIFACT_SANITIZER_SOCKET names the socket; the compiled `ryph`
// binary and the dev tasks start the process themselves (process_preparer.ts).
//
// The same slots as process_preparer.ts: one per run, `maxInFlight` at once, refused past that,
// never queued. A slot is held until the supervisor has answered or this side's own deadline has
// passed, whichever is first. That deadline is the supervisor's (budget plus start-up grace, when
// it SIGKILLs the process) plus a margin, so a supervisor that is alive has always answered by
// then; one that is hung or dead costs a publish that much and is refused `unavailable`, never
// waited on, and the slot is free again. Hanging up kills the process the supervisor started for
// this connection, so a publish given up on stops costing the pod its memory too.
//
// What comes back is checked here (`validatePrepared`) exactly as the direct path checks its
// child's stdout: a supervisor is this platform's code, but what it relays was made from hostile
// input, and nothing but a well-formed answer is ever stored.

import type { ArtifactHtmlPreparer, ArtifactHtmlSlot } from "../../ports/artifact_html.ts";
import {
  DEFAULT_ARTIFACT_HTML_BUDGET_MS,
  DEFAULT_ARTIFACT_HTML_IN_FLIGHT,
  outcomeOf,
  STARTUP_GRACE_MS,
  validatePrepared,
} from "./process_preparer.ts";
import {
  type Conn,
  dial,
  MAX_ANSWER_BYTES,
  MAX_REQUEST_BYTES,
  readFrame,
  writeFrame,
} from "./sanitizer_protocol.ts";

/** Past the supervisor's own deadline, how long this side waits for its answer. */
const CLIENT_MARGIN_MS = 2_000;

export function socketArtifactHtml(
  options: {
    /** The supervisor's socket. */
    path?: string;
    /** How to reach it instead; tests pass a TCP connection. */
    connect?: () => Promise<Conn>;
    /** The supervisor's budget and grace, which this side's deadline is counted from. */
    budgetMs?: number;
    graceMs?: number;
    /** Past those, how long this side waits; tests shorten it. */
    marginMs?: number;
    maxInFlight?: number;
    /** Told when the supervisor killed a document's process at its deadline. */
    onKilled?: (owner: string) => void;
    /** Told when the supervisor cannot be reached, at boot or on a publish; that publish is
     * refused as `unavailable`. */
    onUnavailable?: (why: string) => void;
  },
): ArtifactHtmlPreparer & {
  /** How many slots are taken, and by whom: for tests and diagnostics. */
  inFlight(): string[];
  /** The boot check: whether the supervisor answered a connection. */
  ready: Promise<boolean>;
} {
  const budgetMs = options.budgetMs ?? DEFAULT_ARTIFACT_HTML_BUDGET_MS;
  const graceMs = options.graceMs ?? STARTUP_GRACE_MS;
  const marginMs = options.marginMs ?? CLIENT_MARGIN_MS;
  const maxInFlight = options.maxInFlight ?? DEFAULT_ARTIFACT_HTML_IN_FLIGHT;
  const { path } = options;
  const connect = options.connect ??
    (() => dial({ path: path! }));
  if (options.connect === undefined && !path) throw new Error("a socket path or a connect");
  const where = path ?? "the sanitizer supervisor";
  let closed = false;
  const slots = new Map<string, { stop: () => void }>();

  // The boot check: connect and hang up, which the supervisor reads as a probe.
  const ready = connect().then((conn) => {
    conn.close();
    return true;
  }, (err) => {
    options.onUnavailable?.(
      `the artifact sanitizer supervisor does not answer at ${where} (${String(err)}): every ` +
        "publish_artifact is refused as unavailable until it does. In the control-plane image " +
        "the entrypoint starts it beside this process; elsewhere, unset " +
        "RYPH_ARTIFACT_SANITIZER_SOCKET to start the sanitizer from this process.",
    );
    return false;
  });

  return {
    ready,
    inFlight: () => [...slots.keys()],
    reserve(owner) {
      if (closed) return { kind: "busy" };
      if (slots.has(owner)) return { kind: "owner_busy" };
      if (slots.size >= maxInFlight) return { kind: "busy" };
      let started = false;
      let stopped = false;
      let hangUp = () => {};
      const free = () => slots.delete(owner);
      slots.set(owner, {
        stop: () => {
          stopped = true;
          if (started) hangUp();
          else free();
        },
      });
      const slot: ArtifactHtmlSlot = {
        kind: "slot",
        release() {
          if (!started) free();
        },
        async prepare(html) {
          if (started) throw new Error("a slot prepares one document");
          started = true;
          if (stopped) return { kind: "busy" };
          const request = new TextEncoder().encode(html);
          if (request.length > MAX_REQUEST_BYTES) {
            free();
            throw new Error(`a document of ${request.length} bytes is past the supervisor's cap`);
          }
          let conn: Conn | null = null;
          let timedOut = false;
          let ended = false;
          let giveUp = (_: Error) => {};
          const gaveUp = new Promise<never>((_, reject) => giveUp = reject);
          gaveUp.catch(() => {});
          hangUp = () => {
            ended = true;
            giveUp(new Error("hung up"));
            try {
              conn?.close();
            } catch {
              // Closed already.
            }
          };
          // The whole exchange, the connect included, ends by this deadline.
          const deadline = setTimeout(() => {
            timedOut = true;
            hangUp();
          }, budgetMs + graceMs + marginMs);
          let body: Uint8Array | null;
          try {
            conn = await Promise.race([
              connect().then((c) => {
                // Connected after this side gave up: hang up at once.
                if (ended) c.close();
                return c;
              }),
              gaveUp,
            ]);
            await writeFrame(conn, request);
            body = await readFrame(conn, MAX_ANSWER_BYTES);
          } catch (err) {
            if (stopped) return { kind: "busy" };
            options.onUnavailable?.(
              timedOut
                ? `the artifact sanitizer supervisor at ${where} did not answer within ` +
                  `${budgetMs + graceMs + marginMs} ms`
                : `the artifact sanitizer supervisor at ${where} failed: ${String(err)}`,
            );
            return { kind: "unavailable" };
          } finally {
            clearTimeout(deadline);
            hangUp();
            free();
          }
          if (stopped) return { kind: "busy" };
          if (body === null) {
            options.onUnavailable?.(`the artifact sanitizer supervisor at ${where} hung up`);
            return { kind: "unavailable" };
          }
          let answer: unknown;
          try {
            answer = JSON.parse(new TextDecoder().decode(body));
          } catch {
            throw new Error("the artifact sanitizer supervisor answered something not JSON");
          }
          const kind = typeof answer === "object" && answer !== null
            ? (answer as { kind?: unknown }).kind
            : undefined;
          if (kind === "busy") {
            options.onUnavailable?.(
              `the artifact sanitizer supervisor at ${where} is still making another document`,
            );
            return { kind: "unavailable" };
          }
          if (kind === "fault") {
            const error = String((answer as { error?: unknown }).error).slice(0, 2_000);
            throw new Error(`the artifact sanitizer failed: ${error}`);
          }
          if (kind !== "prepared") {
            throw new Error("the artifact sanitizer supervisor answered an unknown kind");
          }
          const { prepared, killed } = answer as { prepared: unknown; killed: unknown };
          const outcome = outcomeOf(validatePrepared(prepared), budgetMs);
          if (killed === true) options.onKilled?.(owner);
          return outcome;
        },
      };
      return slot;
    },
    close() {
      closed = true;
      for (const entry of [...slots.values()]) entry.stop();
    },
  };
}
