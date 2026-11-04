// Narrates the run to stderr — the natural narrator for a box whose logs are collected by
// whatever runs it (docker logs, a supervisor, a terminal).
// stderr, never stdout: stdout carries only the run's product (the `Result` JSON main.ts prints),
// so a caller can parse it directly.

import type { Narrator } from "../../ports/narrator.ts";

export function consoleNarrator(): Narrator {
  return {
    emit(_runId, chunk, lane) {
      console.error(`[${lane ? `${lane} ` : ""}${chunk.kind}] ${chunk.text ?? ""}`);
      // stderr keeps no seq-ordered record, so there is nothing here to point back at.
      return undefined;
    },
  };
}
