// The `Diagnostics` adapter on @ryph/logger — the machinery's log rides the same shared
// logger as everything else (levels, formatters, and RYPH_LOG_* knobs in one place).
//
// Invariants:
// - total (the port's contract): emit never throws — a payload the formatter chokes on
//   (e.g. a throwing toJSON) degrades to a minimal stderr line instead of throwing into
//   a caller that is often already inside a catch block

import { Logger } from "@ryph/logger";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export function loggerDiagnostics(scope: string): Diagnostics {
  const logger = new Logger(scope);
  const emit = (level: "debug" | "warn", event: string, data?: Record<string, unknown>) => {
    try {
      if (data === undefined) logger[level](event);
      else logger[level](event, data);
    } catch {
      console.error(`${level.toUpperCase()} ${event} (unserializable data)`);
    }
  };
  return {
    debug: (event, data) => emit("debug", event, data),
    warn: (event, data) => emit("warn", event, data),
  };
}
