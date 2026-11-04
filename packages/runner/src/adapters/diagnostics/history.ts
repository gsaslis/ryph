// The diagnostics leg of the history emitter: the machinery's event story becomes part of
// the run's permanent record, alongside the transcript. The Diagnostics port does not change —
// this is purely an adapter over the shared emitter (see adapters/history/emitter.ts).
//
// Build it ONLY over the base emitter, and report the emitter's own failures ONLY via the
// base logger diagnostics — the emitter warning into a tee that feeds the emitter would recurse.

import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { HistoryEmitter } from "../history/emitter.ts";

export function historyDiagnostics(emitter: HistoryEmitter): Diagnostics {
  const emit = (level: "debug" | "warn", event: string, fields?: Record<string, unknown>) => {
    // The emitter is total; the try is this adapter's own totality contract, belt over braces.
    try {
      emitter.emit({ voice: "diag", kind: event, level, payload: fields });
    } catch {
      // A diagnostics sink can neither throw nor block a run.
    }
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
  };
}

/** Fans one diagnostics stream out to several sinks, each leg guarded per the port's totality contract. */
export function teeDiagnostics(...sinks: Diagnostics[]): Diagnostics {
  const fan = (level: "debug" | "warn", event: string, fields?: Record<string, unknown>) => {
    for (const sink of sinks) {
      try {
        sink[level](event, fields);
      } catch {
        // One broken sink must not mute the others.
      }
    }
  };
  return {
    debug: (event, fields) => fan("debug", event, fields),
    warn: (event, fields) => fan("warn", event, fields),
  };
}
