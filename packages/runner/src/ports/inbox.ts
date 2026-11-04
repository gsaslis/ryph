// The run's inbox, as the core PULLS it. The architecture's invariant used to be "a run's inputs
// are fixed at birth, and nothing is ever handed in afterward"; it is restated rather than
// dropped: a run's WORK is fixed at birth, and what the outside may hand in afterwards is a
// message, which can only ever be read (docs/architecture.md). This port is that one channel.
//
// A pull, deliberately — not an answer riding a heartbeat (a beat reports and stays a bare
// gauge) and not a dial into the container (no single-process deployment can make one). The
// runner asks, from boot to finalize, and the `after` cursor it asks with is its
// acknowledgement of everything before it.

import type { InboundMessage } from "../core/types.ts";

export interface Inbox {
  /**
   * The messages past `after` (a seq; -1 for "from the beginning"), waiting up to `waitMs` for
   * one to exist — a long poll, so an idle run costs one open request rather than a tight
   * loop. Answers `[]` when the wait elapses, or when `signal` aborts. Throws on a failure to
   * ask; the core treats that as "nothing yet" and asks again after a pause.
   *
   * `ack: false` reads without acknowledging: `after` then stamps nothing delivered. For a look
   * that hands nothing to the agent (the patch cues read before finalize).
   */
  poll(
    after: number,
    opts: { waitMs: number; signal: AbortSignal; ack?: boolean },
  ): Promise<InboundMessage[]>;
}
