// The check logs the agent asks for (`ryph__check_log`): each one saved to a directory of the
// run's own outside every clone, so the agent reads it with its own tools — sed, grep, tail —
// instead of a tail the platform picked. The log is the code under test's output: the agent is
// told so, and nothing here reads it back.
//
// Invariants:
// - the directory is outside every clone (no log is ever committed by accident), made only when
//   the first log is saved, and removed when the harness is done
// - a file name is built only from names the platform's own shapes allow (`SUITE_ID`,
//   `CHECK_NAME`), so nothing the agent passes names a path
// - every file is one this side created (O_EXCL), under a name never handed out before (a count
//   across the run, as images have), and none is opened by path again
// - nothing is saved once the directory is removed: a save in flight then is refused

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A suite's id, checked only for what this side needs of it: a name safe to put in a file name and
 * a URL path. Deliberately NOT the platform's id format (`ID_BODY` in @ryph/sealed): the runner
 * ships in the harness layer, which reaches an environment only when it is re-layered, so a run can
 * carry a runner older than the orchestrator that mints its suites' ids. A runner that spelled out
 * the format refused every id once the format moved — the 10-hex runner, `cs-[0-9a-f]{1,32}`,
 * rejected the UUIDv7 ids (`cs-01m4r5dasvernbfp25a77wb8f4`) check_status had just handed the agent.
 * Whether a suite exists, and may be read, is the platform's to answer.
 */
export const SUITE_ID = /^cs-[0-9A-Za-z_]{1,64}$/;
/** A check's name as `.ryph/checks.yml` may spell it. */
export const CHECK_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface RunCheckLogs {
  /** Writes the log and answers its path and line count. Throws when it could not be saved. */
  save(
    log: { suiteId: string; check: string; generation: number; bytes: Uint8Array },
  ): Promise<{ path: string; lines: number }>;
  /** Removes the directory and everything in it. Idempotent; never throws. */
  remove(): Promise<void>;
}

export function runCheckLogs(
  opts: { makeDir?: () => Promise<string> } = {},
): RunCheckLogs {
  const makeDir = opts.makeDir ?? (() => mkdtemp(join(tmpdir(), "ryph-check-logs-")));
  let dir: Promise<string> | null = null;
  let removed = false;
  let next = 1;
  return {
    async save({ suiteId, check, generation, bytes }) {
      if (!SUITE_ID.test(suiteId) || !CHECK_NAME.test(check) || !Number.isInteger(generation)) {
        throw new Error("not a check log the platform names");
      }
      if (removed) throw new Error("the run is finalizing");
      // Taken before the await, so a file number is never handed out twice.
      const n = next++;
      dir ??= makeDir();
      // A directory that could not be made is tried again for the next log.
      const base = await dir.catch((err) => {
        dir = null;
        throw err;
      });
      if (removed) throw new Error("the run is finalizing");
      const path = `${base}/${n}-${suiteId}-g${generation}-${check}.log`;
      await writeFile(path, bytes, { flag: "wx" });
      return { path, lines: lineCount(bytes) };
    },
    async remove() {
      removed = true;
      if (dir === null) return;
      const made = await dir.catch(() => null);
      dir = null;
      if (made !== null) await rm(made, { recursive: true }).catch(() => {});
    },
  };
}

/** Lines as `wc -l` would have them, plus a last one that has no newline. */
export function lineCount(bytes: Uint8Array): number {
  let lines = 0;
  for (const b of bytes) if (b === 0x0a) lines++;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}
