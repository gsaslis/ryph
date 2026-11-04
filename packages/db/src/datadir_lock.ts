// An advisory lock on a PGlite data directory, held for as long as one process has it open.
//
// Postgres's own guard does not fire here: PGlite writes `postmaster.pid` with a fake pid (-42,
// /tmp/pglite/base), so a second process opening the same directory succeeds, writes its own
// `postmaster.pid` and `global/pg_control`, and the two then interleave writes over one cluster.
// That is how a second `ryph up` against a live RYPH_HOME damaged it on 2026-10-12.
//
// The lock is a SIBLING file, `<dataDir>.lock`, not one inside the directory: PGlite creates the
// leaf directory itself, and refuses nothing it finds there. It names the holder's pid, host and
// start time. A holder whose pid is still alive is refused; one whose pid is gone left the lock
// behind (a crash, a SIGKILL) and it is taken over.
//
// It is advisory: only openers that come through here are covered. A pid reused after a crash
// can make a dead holder look alive, and then the lock has to be removed by hand — the error says
// which file.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { link, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";

/** Who holds a lock, as written in the lock file. */
export interface DataDirLockHolder {
  pid: number;
  host: string;
  startedAt: string;
  /** Unique per acquisition, so a release never removes a lock someone else took since. */
  token: string;
}

/** Another live process holds the data directory. */
export class DataDirLockedError extends Error {
  constructor(
    readonly dataDir: string,
    readonly lockPath: string,
    readonly holder: DataDirLockHolder,
  ) {
    super(
      `the database at ${dataDir} is open in pid ${holder.pid} on ${holder.host} ` +
        `(since ${holder.startedAt}). Stop it first. If that process is not ryph, the lock is ` +
        `stale: remove ${lockPath} by hand.`,
    );
    this.name = "DataDirLockedError";
  }
}

/** A held lock. `release` is idempotent. */
export interface DataDirLock {
  lockPath: string;
  release: () => Promise<void>;
}

/** Locks this process holds, by lock path, to their token — removed at exit if still held. */
const held = new Map<string, string>();
/** Every token this process has written and not yet given up, including ones still being
 * linked into place: a lock carrying our pid and one of these is ours, never a stale one. */
const ours = new Set<string>();
let exitHookInstalled = false;

/** How many times a race with another opener is retried before giving up, and the pause between
 * tries while another opener is clearing a stale lock. */
const ATTEMPTS = 100;
const RETRY_MS = 10;
/** How many dead takeover guards a takeover steps over before it gives up (`takeStale`). */
const MAX_GUARD_DEPTH = 8;

/**
 * Takes the lock on `dataDir` or throws `DataDirLockedError`. Call it before constructing PGlite,
 * and release it after closing.
 */
export async function lockDataDir(dataDir: string): Promise<DataDirLock> {
  const dir = resolve(dataDir.replace(/(.)\/+$/, "$1"));
  const lockPath = `${dir}.lock`;
  const mine: DataDirLockHolder = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
  const body = JSON.stringify(mine);

  // Ours from before the file can exist: another opener in this process that reads it between
  // the link and `hold` must see it as held, not as a previous incarnation's.
  ours.add(mine.token);
  let taken = false;
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (await create(lockPath, body)) {
        hold(lockPath, mine.token);
        taken = true;
        return { lockPath, release: () => release(lockPath, mine.token) };
      }

      const seen = await readOrNull(lockPath);
      if (seen === null) continue; // released between our create and read
      const holder = parse(seen);
      if (holder !== null && isLive(holder)) {
        throw new DataDirLockedError(dir, lockPath, holder);
      }
      const took = await takeStale(lockPath, seen, body);
      if (took === "busy") await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      if (took === "removed") {
        console.warn(
          holder === null
            ? `ryph: removed an unreadable lock at ${lockPath}`
            : `ryph: took over a stale lock at ${lockPath} from pid ${holder.pid} on ` +
              `${holder.host}, which is no longer running`,
        );
      }
    }
    throw new Error(`could not take the lock at ${lockPath}: other processes kept racing for it`);
  } finally {
    if (!taken) ours.delete(mine.token);
  }
}

/**
 * Creates the lock file with `body` only if none exists. Written aside and linked into place, so
 * the file appears whole: a reader never sees a lock that exists but is still empty.
 */
async function create(lockPath: string, body: string): Promise<boolean> {
  const temp = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, body, { mode: 0o600 });
  try {
    await link(temp, lockPath);
    return true;
  } catch (error) {
    if (codeOf(error) === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Removes the stale lock that read as `seen`, and only that one. Checking the content and then
 * removing the file are two steps, so a racing opener could create its lock in between and lose
 * it to the removal. Only the holder of a takeover guard (taken as the lock itself is, with
 * `body`) removes a lock, and a removed stale lock never comes back with the same content, so a
 * racer that takes a guard after the stale lock is gone finds nothing to remove. "busy" means
 * another live opener holds the guard: try again shortly.
 *
 * A guard whose holder died mid-takeover is never removed to make way for a new one: clearing
 * it would be a check-then-remove of its own, and an opener that judged it dead could delete
 * the live guard another opener created since. Instead the guard is named for what it guards
 * (`guardPath`), and a dead guard is stepped over to the next one down the chain, named for the
 * stale lock AND the dead guard's content. A name, once its guard died, is never taken again,
 * so no two live openers can hold guards over the same stale lock. The dead guards are removed
 * once the stale lock is gone, when no opener can act on them any more. One whose holder died
 * after removing the lock stays behind, unused: its name is never taken again.
 */
async function takeStale(
  lockPath: string,
  seen: string,
  body: string,
): Promise<"removed" | "gone" | "busy"> {
  const chain = [seen];
  const dead: string[] = [];
  for (let depth = 0; depth < MAX_GUARD_DEPTH; depth++) {
    const guard = guardPath(lockPath, chain);
    if (await create(guard, body)) {
      try {
        if ((await readOrNull(lockPath)) !== seen) return "gone";
        await rm(lockPath, { force: true });
        return "removed";
      } finally {
        // Ours first, then the dead ones we stepped over: the stale lock is gone either way.
        await rm(guard, { force: true });
        for (const path of dead) await rm(path, { force: true });
      }
    }
    const text = await readOrNull(guard);
    if (text === null) return "busy"; // its holder just finished: look at the lock again
    const holder = parse(text);
    if (holder !== null && isLive(holder)) return "busy";
    dead.push(guard);
    chain.push(text);
  }
  throw new Error(
    `could not take over the stale lock at ${lockPath}: ${MAX_GUARD_DEPTH} openers died ` +
      `taking it over. Remove ${lockPath} and ${lockPath}.takeover-* by hand.`,
  );
}

/**
 * The takeover guard over the stale lock `chain[0]`, past the dead guards `chain[1..]`. Exported
 * for the tests.
 */
export function guardPath(lockPath: string, chain: readonly string[]): string {
  const hash = createHash("sha256");
  for (const text of chain) hash.update(`${text.length}:${text}`);
  return `${lockPath}.takeover-${hash.digest("hex").slice(0, 16)}`;
}

/**
 * Whether the holder may still have the directory open. A pid equal to ours that this process
 * did not lock is a previous incarnation's — a container restarted on the same volume gets the
 * same small pid again — so it counts as gone.
 */
function isLive(holder: DataDirLockHolder): boolean {
  if (holder.pid === process.pid) return ours.has(holder.token);
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it just is not ours to signal.
    return codeOf(error) === "EPERM";
  }
}

function hold(lockPath: string, token: string): void {
  held.set(lockPath, token);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // A process that exits without closing still gives its locks back. A crash or SIGKILL does
  // not, and the next opener takes the lock over as stale.
  process.on("exit", () => {
    for (const [lockPath, token] of held) {
      try {
        if (parse(readFileSync(lockPath, "utf8"))?.token === token) rmSync(lockPath);
      } catch {
        // Already gone, or unreadable: nothing of ours to remove.
      }
    }
  });
}

async function release(lockPath: string, token: string): Promise<void> {
  if (held.get(lockPath) !== token) return;
  held.delete(lockPath);
  ours.delete(token);
  const current = await readOrNull(lockPath);
  if (current !== null && parse(current)?.token === token) await rm(lockPath, { force: true });
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

function parse(text: string): DataDirLockHolder | null {
  try {
    const value = JSON.parse(text) as Partial<DataDirLockHolder>;
    if (
      typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 &&
      typeof value.token === "string"
    ) {
      return {
        pid: value.pid,
        host: String(value.host ?? "unknown host"),
        startedAt: String(value.startedAt ?? "an unknown time"),
        token: value.token,
      };
    }
  } catch {
    // Not ours, or damaged.
  }
  return null;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}
