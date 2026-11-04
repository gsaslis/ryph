// `EventSink` that keeps what it was given. The consumer's whole contract is "exactly these
// events, exactly once", which is an assertion about a LIST — so the fake is a list, and a test
// reads it rather than intercepting a socket.
//
// It is an adapter and not a test file on purpose: a host wiring the bridge up for the first
// time can point the consumer at this and watch what it would have sent.

import type {
  BridgeBranchEvent,
  BridgeEvent,
  BridgeThreadEvent,
  DeliverOutcome,
  EventSink,
} from "../../ports/event_sink.ts";

export interface RecordingEventSink extends EventSink {
  /** Every event handed over, in order — a refused one included: it WAS handed over. */
  readonly events: BridgeEvent[];
  /** The delivery ids, which is what most assertions are actually about. */
  ids(): string[];
  /** Only the conversation events, in order — comments and change request fates. */
  threadEvents(): BridgeThreadEvent[];
  /** Only the default-branch moves, in order. */
  branchEvents(): BridgeBranchEvent[];
  clear(): void;
  /**
   * Refuse every subsequent delivery with `outcome`; `null` accepts again. The interesting
   * retry behaviour is a mailroom that is down and then COMES BACK, which a constructor
   * argument cannot express.
   */
  refuse(outcome: DeliverOutcome | null): void;
}

export interface RecordingEventSinkOptions {
  /** Refuse everything with this outcome instead of accepting. For the retry paths. */
  refuseWith?: DeliverOutcome;
}

export function recordingEventSink(opts: RecordingEventSinkOptions = {}): RecordingEventSink {
  const events: BridgeEvent[] = [];
  let refuseWith: DeliverOutcome | null = opts.refuseWith ?? null;
  return {
    events,
    ids: () => events.map((e) => e.deliveryId),
    threadEvents: () => events.filter((e): e is BridgeThreadEvent => e.kind !== "branch.updated"),
    branchEvents: () => events.filter((e): e is BridgeBranchEvent => e.kind === "branch.updated"),
    clear: () => events.splice(0, events.length),
    refuse: (outcome) => {
      refuseWith = outcome;
    },
    deliver(event) {
      events.push(event);
      return Promise.resolve(refuseWith ?? { kind: "ok" });
    },
  };
}
