// A Diagnostics double that keeps every warn for the test to read: which event, with what
// fields. Debug lines are dropped, as the noop adapter drops them.

import type { Diagnostics } from "../../src/ports/diagnostics.ts";

export interface RecordedWarn {
  event: string;
  fields?: Record<string, unknown>;
}

export function recordingDiagnostics(): { diag: Diagnostics; warns: RecordedWarn[] } {
  const warns: RecordedWarn[] = [];
  const diag: Diagnostics = {
    debug: () => {},
    warn: (event, fields) => {
      warns.push({ event, fields });
    },
  };
  return { diag, warns };
}
