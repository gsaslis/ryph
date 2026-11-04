// The connections one listener holds, and which of them are idle. Each costs memory whether or not
// anything rides it (a socket's kernel state, its HTTP parser: tens of KiB idle), and a Google
// Cloud load balancer keeps many open to every backend, so a listener needs a ceiling of its own.
// Two: past a SOFT cap the connections idle longest are closed to make room, which the balancer
// takes in its stride (it opens another when it needs one); and node:http's `maxConnections` as
// the hard one, past which a new connection is refused at once, which the balancer turns into a
// 502.
//
// A listener whose callers must present a credential (the tunnel one: a runner's ticket) holds the
// connections that have not yet presented one apart (`untrusted`): a few per source address and a
// few in all, each for a short deadline. Past the per-address cap the address's own oldest SILENT
// connection (one that has sent nothing yet) makes room for the new one, at any age; with none
// silent, its oldest that is past UNTRUSTED_GRACE_MS, since a connection that has sent bytes may be
// an honest dial whose request is still being served; with none such, the new one is refused.
// Past the total cap, the address holding the most untrusted connections gives up its oldest
// silent one (or its oldest at all), grace or not: so a new address always gets in, and a run that
// floods (from its own address, as each run pod has in a cluster) only ever churns through its
// own. Behind ONE shared address (compose's run gate, which every run's tunnel comes through)
// nothing tells the runs apart: a run that floods there churns through every run's silent
// connections (and, sending requests that fail, keeps its own for the grace), so while it floods
// another run's dial may be closed or refused and retried (the runner backs off and
// re-registers): one run can keep the others' tunnels down while it floods, and they come back
// once it stops. Telling them apart there needs the gate to say who each connection is (the PROXY
// protocol, say). Once
// trusted (`trust`), a connection counts against nothing here but the hard cap.
import type { Server } from "node:http";
import type { Duplex } from "node:stream";

/** A connection is idle only once nothing has ridden it this long: a just-accepted one may still
 * be sending its first request's headers, and one just answered may be about to be reused. */
export const MIN_IDLE_MS = 2_000;
/** An untrusted connection that has sent bytes is not evicted for another of its address until
 * this old. A silent one has no grace. */
export const UNTRUSTED_GRACE_MS = 250;

interface Held {
  address: string;
  /** Requests in flight on it. */
  active: number;
  /** A WebSocket or another upgrade: never idle again. */
  upgraded: boolean;
  /** When it last finished a request, or opened. */
  since: number;
  /** When it opened. */
  opened: number;
  /** It presented a credential (`trust`); always, on a listener without `untrusted`. */
  trusted: boolean;
  /** It has sent bytes: a request or an upgrade arrived on it (`busy`, `upgraded`), or the
   * runtime says it read some. Bun's node:http says nothing of bytes before a request's headers
   * are whole, so there a connection whose headers are still on their way counts as silent. */
  spoke: boolean;
  /** Closes it at the untrusted deadline. */
  deadline?: ReturnType<typeof setTimeout>;
}

export interface ConnectionsOptions {
  /** Past this many, the longest idle are closed as more come. Default: never. */
  soft?: number;
  /** Connections that have presented no credential yet: at most `perAddress` from one address and
   * `total` in all (past either, one makes room as the header says), each closed `deadlineMs`
   * after it opened unless trusted by then. Default: every connection is trusted from the start. */
  untrusted?: { perAddress: number; total: number; deadlineMs: number };
  /** How long a connection must have carried nothing to count as idle. Default MIN_IDLE_MS. */
  minIdleMs?: number;
  /** Seam for tests. */
  now?: () => number;
}

export class Connections {
  readonly #held = new Map<Duplex, Held>();
  // Of them, those with no request in flight and never upgraded, by when they last finished one
  // (or opened), oldest first: each moves to the end as it rests again. The idle ones are a prefix
  // of it, so finding them never looks past the first that is not, however many are open.
  readonly #resting = new Map<Duplex, Held>();
  // Untrusted connections by address, oldest first (a Set keeps insertion order).
  readonly #untrusted = new Map<string, Set<Duplex>>();
  #untrustedCount = 0;
  readonly #soft: number;
  readonly #limits: ConnectionsOptions["untrusted"];
  readonly #minIdle: number;
  readonly #now: () => number;

  constructor(opts: ConnectionsOptions = {}) {
    this.#soft = opts.soft ?? Infinity;
    this.#limits = opts.untrusted;
    this.#minIdle = opts.minIdleMs ?? MIN_IDLE_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** Connections open now. */
  get size(): number {
    return this.#held.size;
  }

  /** Of them, those that presented no credential yet. */
  get untrusted(): number {
    return this.#untrustedCount;
  }

  /** Every connection open now. */
  sockets(): Duplex[] {
    return [...this.#held.keys()];
  }

  /** Takes a new connection on; false when it is already gone, or refused. Past the soft cap the
   * connections idle longest make room for it, and past an untrusted cap one makes room for it
   * (as the header says), or with none it is refused (destroyed). */
  add(socket: Duplex): boolean {
    if (this.#held.has(socket)) return true;
    if (socket.destroyed) return false;
    const address = (socket as { remoteAddress?: string }).remoteAddress ?? "";
    const limits = this.#limits;
    if (limits !== undefined) {
      const from = this.#untrusted.get(address);
      const full =
        (from !== undefined && from.size >= limits.perAddress && !this.#evict(from, true)) ||
        (this.#untrustedCount >= limits.total && !this.#evict(this.#largest(), false));
      if (full) {
        socket.destroy();
        return false;
      }
    }
    const held: Held = {
      address,
      active: 0,
      upgraded: false,
      since: this.#now(),
      opened: this.#now(),
      trusted: limits === undefined,
      spoke: false,
    };
    if (limits !== undefined) {
      let own = this.#untrusted.get(address);
      if (own === undefined) this.#untrusted.set(address, own = new Set());
      own.add(socket);
      this.#untrustedCount++;
      held.deadline = setTimeout(() => {
        if (!this.#held.get(socket)?.trusted) socket.destroy();
      }, limits.deadlineMs);
      (held.deadline as { unref?: () => void }).unref?.();
    }
    this.#held.set(socket, held);
    this.#resting.set(socket, held);
    socket.once("close", () => this.#drop(socket));
    // Never the one that just came: it is idle only until its first request arrives.
    if (this.#held.size > this.#soft) {
      this.closeIdle(this.#held.size - this.#soft, { except: socket });
    }
    return true;
  }

  /** `socket` presented a credential: it counts against the untrusted caps no more. */
  trust(socket: Duplex): void {
    const held = this.#held.get(socket);
    if (held === undefined || held.trusted) return;
    held.trusted = true;
    clearTimeout(held.deadline);
    this.#untrust(socket, held.address);
  }

  /** A request began on `socket`. */
  busy(socket: Duplex): void {
    const held = this.#held.get(socket);
    if (held === undefined) return;
    held.active++;
    held.spoke = true;
    this.#resting.delete(socket);
  }

  /** A request on `socket` ended. */
  done(socket: Duplex): void {
    const held = this.#held.get(socket);
    if (held === undefined) return;
    held.active = Math.max(0, held.active - 1);
    held.since = this.#now();
    if (held.active === 0 && !held.upgraded) {
      this.#resting.delete(socket);
      this.#resting.set(socket, held);
    }
  }

  /** `socket` upgraded: it is never idle again. */
  upgraded(socket: Duplex): void {
    const held = this.#held.get(socket);
    if (held === undefined) return;
    held.upgraded = true;
    held.spoke = true;
    this.#resting.delete(socket);
  }

  /** Idle connections now: none of their requests in flight, never upgraded, quiet for at least
   * the idle time. */
  get idle(): number {
    let idle = 0;
    const now = this.#now();
    for (const held of this.#resting.values()) {
      if (!this.#isIdle(held, now)) break;
      idle++;
    }
    return idle;
  }

  /** Closes up to `count` idle connections but `except` (only untrusted ones with
   * `untrustedOnly`; only those idle `idleMs` or longer when given), the longest idle first.
   * Returns how many. */
  closeIdle(
    count: number,
    opts: { except?: Duplex; untrustedOnly?: boolean; idleMs?: number } = {},
  ): number {
    if (count <= 0) return 0;
    const now = this.#now();
    const idle: Duplex[] = [];
    for (const [socket, held] of this.#resting) {
      if (idle.length >= count) break;
      // Oldest first: once one has not been idle long enough, nor has any after it.
      if (!this.#isIdle(held, now, opts.idleMs)) break;
      if (socket === opts.except || (opts.untrustedOnly && held.trusted)) continue;
      idle.push(socket);
    }
    for (const socket of idle) {
      this.#drop(socket);
      socket.destroy();
    }
    return idle.length;
  }

  /** Wires `listener`'s requests in: which connections are idle, and which have spoken, is theirs
   * to say. Its upgrades are the caller's to report (`upgraded`). */
  watch(listener: Server): void {
    listener.on("request", (req, res) => {
      this.busy(req.socket);
      res.once("close", () => this.done(req.socket));
    });
  }

  #isIdle(held: Held, now: number, idleMs = this.#minIdle): boolean {
    return held.active === 0 && !held.upgraded &&
      now - held.since >= Math.max(idleMs, this.#minIdle);
  }

  /** Closes one untrusted connection of `from` (insertion order is age order): its oldest silent
   * one, else its oldest, which with `grace` must be past UNTRUSTED_GRACE_MS. False when none
   * may go. */
  #evict(from: Set<Duplex> | undefined, grace: boolean): boolean {
    if (from === undefined) return false;
    let oldest: Duplex | undefined;
    for (const socket of from) {
      oldest ??= socket;
      const held = this.#held.get(socket);
      if (held !== undefined && !held.spoke && !this.#reads(socket)) return this.#close(socket);
    }
    const held = oldest === undefined ? undefined : this.#held.get(oldest);
    if (held === undefined) return false;
    if (grace && this.#now() - held.opened < UNTRUSTED_GRACE_MS) return false;
    return this.#close(oldest!);
  }

  /** The untrusted connections of the address holding the most of them. */
  #largest(): Set<Duplex> | undefined {
    let largest: Set<Duplex> | undefined;
    for (const from of this.#untrusted.values()) {
      if (largest === undefined || from.size > largest.size) largest = from;
    }
    return largest;
  }

  /** Whether the runtime says `socket` has read bytes (Node does; Bun's node:http does not). */
  #reads(socket: Duplex): boolean {
    return ((socket as { bytesRead?: number }).bytesRead ?? 0) > 0;
  }

  #close(socket: Duplex): boolean {
    this.#drop(socket);
    socket.destroy();
    return true;
  }

  #untrust(socket: Duplex, address: string) {
    const from = this.#untrusted.get(address);
    if (from?.delete(socket)) {
      this.#untrustedCount--;
      if (from.size === 0) this.#untrusted.delete(address);
    }
  }

  #drop(socket: Duplex) {
    const held = this.#held.get(socket);
    if (held === undefined) return;
    this.#held.delete(socket);
    this.#resting.delete(socket);
    clearTimeout(held.deadline);
    if (!held.trusted) this.#untrust(socket, held.address);
  }
}
