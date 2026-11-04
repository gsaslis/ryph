// `NodeControl` over the node's UNIX control socket.
//
// The protocol is a line protocol, so this is short: connect, write one JSON object plus a
// newline, read NDJSON back until the node closes. There is no framing beyond the newline and no
// correlation id, which is precisely why each call gets its OWN connection — two commands on one
// socket could not be told apart.
//
// Responses are `CommandResult`, serialized UNTAGGED: a success is the payload itself, an error
// is `{"error": "…"}`. So "is this an error" is "does it have a string `error` field", and a
// payload that happens to carry one would be indistinguishable — no node command returns such a
// payload, and heartwood's own client makes the same assumption.
//
// `subscribe` reads forever and never applies back-pressure: the node's channel is bounded and
// evicts a slow consumer silently. Whatever kills the stream — a hangup, a dead socket, an
// abort — comes out as one `eof` item, because the CONSUMER's correctness path (reconcile)
// hangs off exactly that signal.

import type { Socket } from "node:net";
import {
  FetchRefusedError,
  NodeCommandError,
  type NodeControl,
  type NodeEvent,
  type NodeStreamItem,
  NodeUnavailableError,
  type SeedScope,
  type Updated,
} from "../../ports/node.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { SILENT_DIAGNOSTICS } from "../../ports/diagnostics.ts";
import { connectUnix, writeAll } from "../../helpers/unix_socket.ts";

export interface SocketNodeControlOptions {
  /** The control socket path — RAD_SOCKET, or `<RAD_HOME>/node/control.sock`. */
  socket: string;
  /** How long a single command may take before the connection is torn down. */
  timeoutMs?: number;
  diag?: Diagnostics;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function isErrorLine(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null &&
    typeof (value as { error?: unknown }).error === "string";
}

/** Splits a byte stream into complete lines, dropping the empty ones the node pads with. */
async function* lines(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const value of source) {
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line !== "") yield line;
    }
  }
  const tail = buffer.trim();
  if (tail !== "") yield tail;
}

export function socketNodeControl(opts: SocketNodeControlOptions): NodeControl {
  const diag = opts.diag ?? SILENT_DIAGNOSTICS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** One command, one connection, every answer line collected. */
  const call = async (
    command: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown[]> => {
    let conn: Socket;
    try {
      conn = await connectUnix(opts.socket);
    } catch (err) {
      throw new NodeUnavailableError(opts.socket, err);
    }
    // Destroyed under the read loop, which then throws: a deadline is an unavailable node.
    const deadline = setTimeout(() => conn.destroy(), options?.timeoutMs ?? timeoutMs);
    try {
      await writeAll(conn, new TextEncoder().encode(`${JSON.stringify(command)}\n`));
      const out: unknown[] = [];
      for await (const line of lines(conn)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          diag.warn("node.unparsable_line", { command: command.command, line: line.slice(0, 200) });
          continue;
        }
        if (isErrorLine(parsed)) {
          throw new NodeCommandError(String(command.command), parsed.error);
        }
        out.push(parsed);
      }
      diag.debug("node.call", { command: command.command, lines: out.length });
      return out;
    } catch (err) {
      if (err instanceof NodeCommandError) throw err;
      throw new NodeUnavailableError(opts.socket, err);
    } finally {
      clearTimeout(deadline);
      conn.destroy();
    }
  };

  /** The first answer line, which is all a single-valued command has. */
  const one = async (command: Record<string, unknown>): Promise<unknown> => {
    const out = await call(command);
    if (out.length === 0) {
      throw new NodeCommandError(String(command.command), "the node answered nothing");
    }
    return out[0];
  };

  /**
   * A command whose answer is ONE line carrying a whole array — `sessions`, `seedsFor`.
   *
   * The lines `call` collects are not the elements, so flattening is what makes
   * `sessions().length` a count of peers rather than of response lines.
   */
  const many = async (command: Record<string, unknown>): Promise<unknown[]> => {
    const out = await call(command);
    return out.flatMap((line) => (Array.isArray(line) ? line : [line]));
  };

  const sessionsOf = (): Promise<unknown[]> => many({ command: "sessions" });

  /**
   * One fetch, from ONE named peer.
   *
   * Two facts about `rad 1.10.2`, both measured against a live node and neither documented:
   * `timeout` is a serde `Duration` STRUCT (`{secs, nanos}`) and a number is refused with
   * `invalid type: integer …, expected struct Duration`; and `nid` is a `NodeId`, never null —
   * `invalid type: null, expected a string`. There is no "fetch from anyone" command.
   *
   * A THIRD, and it cost a live connect: a fetch that fails is a NORMAL reply,
   * `{"status":"failed","reason":"…"}` (heartwood's `FetchResult`, tagged), not an error line
   * and not a thrown anything. "an I/O error occurred during the fetch handshake (connection
   * reset)" is what a peer that simply does not HOLD the repository says, character for
   * character the same as a private repository's refusal — so the reply is inspected rather
   * than assumed to be a success just because nothing threw.
   *
   * A FOURTH, which is why nothing in the bridge fetches this way any more: the node refuses
   * outright for a peer it has no session with ("peer … is not connected; cannot initiate
   * fetch", `radicle-protocol/src/service.rs`), and the socket has no way to make it dial the
   * holder the routing table knows about. Fetching a repository from the network goes through
   * `rad sync --fetch` — see `core/sync_fetch.ts`.
   */
  const fetchFrom = async (
    rid: string,
    nid: string,
    fetchTimeoutMs: number,
  ): Promise<unknown[]> => {
    const answer = await call(
      {
        command: "fetch",
        rid,
        nid,
        timeout: {
          secs: Math.floor(fetchTimeoutMs / 1000),
          nanos: (fetchTimeoutMs % 1000) * 1_000_000,
        },
      },
      // Our own socket deadline is deliberately slacker, so the node's answer wins the race.
      { timeoutMs: fetchTimeoutMs + 5_000 },
    );
    for (const line of answer) {
      const row = line as { status?: unknown; reason?: unknown };
      if (row?.status !== "failed") continue;
      const reason = typeof row.reason === "string" && row.reason !== ""
        ? row.reason
        : "the node gave no reason";
      diag.debug("node.fetch_refused", { rid, nid, reason });
      // `triedSeeds` stays zero: this peer was NAMED by the caller, never checked against the
      // routing table, so its refusal is no evidence that a holder refused us.
      throw new FetchRefusedError(rid, 0, [{ nid, reason }]);
    }
    // No `status: failed` line: either a success, or a node too old to tag its answer. Nothing
    // says it failed.
    return answer;
  };

  return {
    async nodeId() {
      const nid = await one({ command: "nodeId" });
      if (typeof nid !== "string") {
        throw new NodeCommandError("nodeId", `expected a string, got ${JSON.stringify(nid)}`);
      }
      return nid;
    },
    async status() {
      await one({ command: "status" });
      return { running: true };
    },
    async seed(rid: string, scope: SeedScope): Promise<Updated> {
      const res = await one({ command: "seed", rid, scope });
      return { updated: Boolean((res as { updated?: unknown })?.updated) };
    },
    async unseed(rid: string): Promise<Updated> {
      const res = await one({ command: "unseed", rid });
      return { updated: Boolean((res as { updated?: unknown })?.updated) };
    },
    fetch(rid, nid, fetchTimeoutMs) {
      return fetchFrom(rid, nid, fetchTimeoutMs);
    },
    announceRefsFor(rid, namespaces) {
      return one({ command: "announceRefsFor", rid, namespaces });
    },
    sessions() {
      return sessionsOf();
    },
    seedsFor(rid) {
      // `seeds` is deprecated in heartwood; `seedsFor` is the live one and takes the namespaces
      // to report a sync status for. We want the ROUTING answer — who claims to hold it — so
      // the set is empty, which serde requires to be present all the same.
      return many({ command: "seedsFor", rid, namespaces: [] });
    },
    async *subscribe(signal?: AbortSignal): AsyncIterable<NodeStreamItem> {
      let conn: Socket;
      try {
        conn = await connectUnix(opts.socket);
      } catch (err) {
        yield { kind: "eof", reason: `could not connect: ${err}` };
        return;
      }
      const cut = () => conn.destroy();
      signal?.addEventListener("abort", cut, { once: true });
      let reason = "the node closed the stream";
      try {
        await writeAll(
          conn,
          new TextEncoder().encode(`${JSON.stringify({ command: "subscribe" })}\n`),
        );
        for await (const line of lines(conn)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // A node newer than this bridge must not be able to end the stream by emitting
            // something we cannot read.
            diag.warn("node.unparsable_event", { line: line.slice(0, 200) });
            continue;
          }
          if (isErrorLine(parsed)) {
            reason = `the node refused the subscription: ${parsed.error}`;
            break;
          }
          if (typeof parsed !== "object" || parsed === null) continue;
          const event = parsed as NodeEvent;
          if (typeof event.type !== "string") continue;
          yield { kind: "event", event };
        }
        if (signal?.aborted) reason = "the subscription was aborted";
      } catch (err) {
        reason = signal?.aborted ? "the subscription was aborted" : `the stream failed: ${err}`;
      } finally {
        signal?.removeEventListener("abort", cut);
        cut();
      }
      yield { kind: "eof", reason };
    },
  };
}
