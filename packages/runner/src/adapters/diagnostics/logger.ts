// `Diagnostics` on @ryph/logger — the machinery's event story rides the same shared logger
// as the operational `log` voice, so levels, formatters, and the RYPH_LOG_* knobs live in
// one place. The composition root pins that logger to stderr, keeping stdout for the `Result`
// JSON alone.
//
// Invariants:
// - total (the port's contract): emit never throws — a payload the formatter chokes on
//   (e.g. a throwing toJSON) degrades to a minimal stderr line instead of throwing into
//   a caller that is often already inside a catch block

import { Logger } from "@ryph/logger";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export function loggerDiagnostics(scope: string): Diagnostics {
  const logger = new Logger(scope);
  const emit = (level: "debug" | "warn", event: string, fields?: Record<string, unknown>) => {
    try {
      if (fields === undefined) logger[level](event);
      else logger[level](event, fields);
    } catch {
      console.error(`${level.toUpperCase()} ${event} (unserializable fields)`);
    }
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
  };
}
