// The `Diagnostics`-on-logger adapter: events ride the shared logger, and emit stays total —
// the port's contract — even when the payload defeats the formatter.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { defaultJsonFormatter, LogLevel, setupLogger } from "@ryph/logger";
import { loggerDiagnostics } from "../src/adapters/diagnostics/logger.ts";

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (msg: string) => lines.push(msg);
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

test("events land on stderr through the shared logger, data attached", () => {
  const capture = captureStderr();
  try {
    setupLogger({ level: LogLevel.DEBUG, formatter: defaultJsonFormatter, stderr: true });
    const diag = loggerDiagnostics("forge");
    diag.debug("git.exec", { op: "clone", code: 0 });
    diag.warn("patch.prune_failed");
    assertEquals(capture.lines.length, 2);
    const first = JSON.parse(capture.lines[0]);
    assertEquals(first.name, "forge");
    assertEquals(first.message, "git.exec");
    assertEquals(first.data, [{ op: "clone", code: 0 }]);
    assertEquals(JSON.parse(capture.lines[1]).level, "WARN");
  } finally {
    capture.restore();
    setupLogger({ level: LogLevel.INFO, stderr: false });
  }
});

test("a payload the formatter chokes on degrades to a line instead of throwing", () => {
  const capture = captureStderr();
  try {
    setupLogger({ level: LogLevel.DEBUG, formatter: defaultJsonFormatter, stderr: true });
    const diag = loggerDiagnostics("forge");
    diag.warn("bad.payload", { poison: { toJSON: () => JSON.parse("not json") } });
    assertEquals(capture.lines.length, 1);
    assert(capture.lines[0].includes("bad.payload"));
  } finally {
    capture.restore();
    setupLogger({ level: LogLevel.INFO, stderr: false });
  }
});
