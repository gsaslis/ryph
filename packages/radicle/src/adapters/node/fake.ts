// A radicle-node that only exists for tests — a REAL unix listener speaking the real line
// protocol, not a stub of the port. The adapter under test is the same code production runs;
// only the thing on the other end of the socket is ours.
//
// It can do the two things the consumer's correctness argument depends on: emit events on
// demand, and HANG UP mid-stream. A fake that could only answer nicely would never exercise the
// reconcile path, which is the whole reason the event stream is allowed to be lossy.

import { createServer, type Socket } from "node:net";
import type { NodeEvent } from "../../ports/node.ts";
import { writeAll } from "../../helpers/unix_socket.ts";

export interface FakeNodeOptions {
  /** Where to listen. Unix socket paths are short by OS limit — keep it in a temp dir. */
  path: string;
  /** What `nodeId` answers. */
  nid?: string;
  /** Commands to answer `{"error": …}` to, so the refusal path can be exercised. */
  failCommands?: string[];
  /**
   * What `sessions` answers — ONE line holding the whole array, as the real node does. It is
   * also what `session {nid}` is answered from: the matching row, or `null`, which is what
   * heartwood's `Option<Session>` looks like on the wire.
   */
  sessions?: unknown[];
  /** What `seedsFor` answers — the routing table's peers for a repo, same one-line shape. */
  seeds?: unknown[];
  /**
   * What `fetch` answers, per peer. The real node reports a FAILED fetch as an ordinary reply
   * (`{"status":"failed","reason":"…"}`, heartwood's tagged `FetchResult`) rather than as an
   * error line, which is the whole reason a fake needs to be able to say it.
   */
  fetchResults?: Record<string, unknown>;
  /**
   * Never answers a `fetch` at all — a node whose fetch from that seed is queued behind
   * another one, which `rad sync --fetch` waits out past its own `--timeout`.
   */
  stallFetches?: boolean;
  /**
   * What `connect` answers, per NID — heartwood's `ConnectResult`, tagged on `status`:
   * `{"status":"connected"}` or `{"status":"disconnected","reason":"…"}`. The default is
   * disconnected, which is what dialling a seed that is not there looks like.
   *
   * Only the real `rad` CLI ever sends this command; the bridge's own adapter does not dial.
   */
  connectResults?: Record<string, unknown>;
}

export interface FakeNode {
  readonly path: string;
  /** Every command line the node received, in order, parsed. */
  readonly commands: Array<Record<string, unknown>>;
  /** Pushes an event to every open subscription. */
  emit(event: NodeEvent): void;
  /** Closes every open subscription without closing the listener — a mid-stream hangup. */
  hangUp(): void;
  /** How many subscriptions are open right now. */
  subscribers(): number;
  close(): Promise<void>;
}

export function startFakeNode(opts: FakeNodeOptions): FakeNode {
  const listener = createServer((conn) => {
    conn.on("error", () => {});
    if (closed) conn.destroy();
    else serve(conn);
  });
  // A UNIX path is bound before `listen` returns, so a client may dial the moment this does.
  listener.listen(opts.path);
  const nid = opts.nid ?? "z6MkfakeNodeIdfakeNodeIdfakeNodeIdfakeNod";
  const failing = new Set(opts.failCommands ?? []);
  const commands: Array<Record<string, unknown>> = [];
  const subscriptions = new Set<Socket>();
  let closed = false;

  const write = (conn: Socket, value: unknown): Promise<void> =>
    writeAll(conn, new TextEncoder().encode(`${JSON.stringify(value)}\n`));

  const serve = async (conn: Socket) => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      // Read by hand rather than in a for-await: leaving one of those destroys the socket, and a
      // subscription's has to stay open after its reads stop.
      const reader = conn[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
      while (true) {
        const { value, done } = await reader.next();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const cut = buffer.indexOf("\n");
        if (cut === -1) continue;
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        const command = JSON.parse(line) as Record<string, unknown>;
        commands.push(command);
        if (failing.has(String(command.command))) {
          await write(conn, { error: `the node is not having it: ${String(command.command)}` });
          break;
        }
        switch (command.command) {
          case "subscribe":
            // The connection is kept and handed to `emit`; nothing reads it from here on.
            subscriptions.add(conn);
            return;
          case "nodeId":
            await write(conn, nid);
            break;
          case "status":
            await write(conn, { updated: false });
            break;
          case "seed":
          case "unseed":
            await write(conn, { updated: true });
            break;
          case "sessions":
            await write(conn, opts.sessions ?? []);
            break;
          case "session": {
            const wanted = String(command.nid ?? "");
            const found = (opts.sessions ?? []).find(
              (s) => (s as { nid?: unknown })?.nid === wanted,
            );
            await write(conn, found ?? null);
            break;
          }
          case "connect": {
            // `addr` is heartwood's `ConnectAddress`, a string `<nid>@<host>:<port>`.
            const peer = String(command.addr ?? "").split("@")[0];
            await write(
              conn,
              opts.connectResults?.[peer] ??
                { status: "disconnected", reason: "nothing answered at that address" },
            );
            break;
          }
          case "seedsFor":
            await write(conn, opts.seeds ?? []);
            break;
          case "fetch": {
            if (opts.stallFetches) {
              // Hold the connection open with nothing on it until the client gives up.
              await reader.next().catch(() => null);
              break;
            }
            const peer = String(command.nid ?? "");
            const answer = opts.fetchResults?.[peer];
            // `clone` is part of heartwood's `FetchResult::Success` and its absence makes the
            // real CLI refuse the reply — which is the whole point of a fake the real `rad`
            // can be pointed at.
            await write(
              conn,
              answer ?? { status: "success", updated: [], namespaces: [], clone: false },
            );
            break;
          }
          case "announceRefsFor":
            await write(conn, []);
            break;
          default:
            await write(conn, { error: `unknown command ${String(command.command)}` });
            break;
        }
        // One command per connection, exactly as the real node does.
        break;
      }
    } catch {
      // A client that hung up mid-command is not an error here.
    }
    conn.destroy();
  };

  return {
    path: opts.path,
    commands,
    emit(event) {
      for (const conn of subscriptions) {
        write(conn, event).catch(() => subscriptions.delete(conn));
      }
    },
    hangUp() {
      for (const conn of subscriptions) conn.destroy();
      subscriptions.clear();
    },
    subscribers: () => subscriptions.size,
    close() {
      closed = true;
      for (const conn of subscriptions) conn.destroy();
      subscriptions.clear();
      listener.close();
      return Promise.resolve();
    },
  };
}
