// A `Diagnostics` that says nothing — the silent stand-in,
// used by tests (which assert on behavior, not logs)
// and by any caller that deliberately wants zero machinery narration.
// NOT the production wiring: main.ts wires loggerDiagnostics so runs are observable.
// Total by construction, zero overhead.

import type { Diagnostics } from "../../ports/diagnostics.ts";

export function noopDiagnostics(): Diagnostics {
  return {
    debug(): void {},
    warn(): void {},
  };
}
