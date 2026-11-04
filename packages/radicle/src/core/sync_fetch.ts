// Fetching a repository from the Radicle network — through `rad sync --fetch`, which is
// heartwood's OWN seed walk, rather than through a hand-rolled one over the control socket.
//
// Why the porcelain and not the socket. The `fetch` control command takes ONE nid and fetches
// from it only if that peer is already in an established session (`radicle-protocol`'s
// `service.rs`: "peer {from} is not connected; cannot initiate fetch"). A bridge that only
// walked its own connected peers therefore asked whoever happened to be dialled — in one
// deployment that was one flaky seed out of five holders — and never reached the holder the routing table
// knew about but the node had not connected to. `rad clone` of the same RID inside the same
// container succeeded in about a second, because the CLI does what the socket will not do for
// us (`radicle-cli/src/commands/sync.rs`, `fetch`):
//
//   1. `seedsFor(rid)` — the ROUTING table's holders, not the session list;
//   2. partition them into connected and disconnected, keeping the disconnected ones that have
//      at least one known address, and add the profile's preferred seeds;
//   3. for each candidate in turn: if its session is connected, fetch; otherwise DIAL it
//      (`connect`, `persistent: false`, the same `--timeout`) and fetch once it answers;
//   4. stop as soon as the replication target is met.
//
// Reimplementing that over the socket would be a second, worse copy of it — and one that
// would have to track `Seed`, `Session`, `ConnectAddress` and `FetchResult` by hand. So the
// bridge runs the real thing and reads its output.
//
// READING ITS OUTPUT — three facts, all measured against rad 1.10.2 and none of them obvious:
//
// - EVERYTHING goes to STDOUT. `radicle-term`'s `error`, `warning`, `info!` and the spinner's
//   completion message all end up on stdout (`radicle-term/src/io.rs`'s `println`); the spinner
//   ANIMATION is the only thing on stderr and it is `Hidden` unless stderr is a terminal, so a
//   piped run emits no progress noise at all. stderr is normally empty.
// - A FAILED FETCH CAN EXIT ZERO. `sync.rs` hands a `FetcherResult::TargetError` to
//   `display_fetch_result`, which PRINTS it and returns `()`; `run` then returns `Ok(())`.
//   Non-zero is reserved for the failures that `bail!` — no node, a repository that is not
//   seeded, no candidate seeds at all. Taking exit 0 for "fetched" would call every refusal a
//   success.
// - The only positive evidence of a fetch is the `🌱 Fetched from <nid>` line per seed
//   (`display_success`). That, and nothing else, is what "we got it" means here.
//
// The failure lines are `✗ Error: <nid>: <reason>` (`display_fetch_result` over
// `results.failed()`, with `node_id_human` printing the full NID), so the per-peer reasons the
// 409 path shows a user survive the trip.

import type { ExecResult, RadExec } from "../ports/rad.ts";
import { FetchRefusedError } from "../ports/node.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";

/** How much longer than the fetch budget the subprocess itself is given. */
export const SYNC_EXEC_GRACE_MS = 5_000;

/** A NID as heartwood prints it: the whole base58 public key, never an alias here. */
const NID = /^(z[1-9A-HJ-NP-Za-km-z]{40,})$/;

/** What one `rad sync --fetch` left behind, read out of its output. */
export interface SyncFetchOutcome {
  /** The seeds we actually fetched from — `🌱 Fetched from <nid>`. Empty means it failed. */
  fetched: string[];
  /** Per-seed refusals, in the order the CLI listed them. */
  failures: Array<{ nid: string; reason: string }>;
  /** `found N potential seed(s)` — the routing table's count, or null if it never got that far. */
  candidates: number | null;
  /** The CLI's own words for the failure: its `✗ Error:` lines, or the bare output. */
  summary: string;
  /**
   * The CLI gave up on the NODE, not on the network — measured on a live node, where a fetch from
   * a big seed ran past 30s and `rad` printed `timed out reading from control socket` while the
   * node went on and finished the fetch afterwards. Nothing was refused, and the refs may
   * already be in storage by the time anyone reads this; the next pull picks them up.
   */
  inProgress: boolean;
}

/** heartwood's own words when the CLI's control-socket read deadline fires first. */
const STILL_RUNNING = /timed out reading from control socket/i;

/** Colour is off when stdout is a pipe, but a future `--color=always` must not break parsing. */
function plain(text: string): string {
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Reads a finished `rad sync --fetch`. Pure, so the shapes below can be pinned by a test
 * holding output captured from the real CLI.
 */
export function parseSyncFetch(result: ExecResult): SyncFetchOutcome {
  const fetched: string[] = [];
  const failures: Array<{ nid: string; reason: string }> = [];
  const errors: string[] = [];
  let candidates: number | null = null;

  for (const raw of plain(`${result.stdout}\n${result.stderr}`).split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const seeded = line.match(/^🌱\s+Fetched from\s+(\S+)/);
    if (seeded) {
      fetched.push(seeded[1]);
      continue;
    }
    const found = line.match(/found (\d+) potential seed\(s\)/);
    if (found) candidates = Number(found[1]);
    const failed = line.match(/^✗\s+Error:\s+(.*)$/);
    if (!failed) continue;
    errors.push(failed[1]);
    // `<nid>: <reason>` is the per-seed shape; the other `✗ Error:` lines are the summary.
    const perSeed = failed[1].match(/^(\S+):\s+(.+)$/);
    if (perSeed && NID.test(perSeed[1])) failures.push({ nid: perSeed[1], reason: perSeed[2] });
  }

  const summary = errors.length > 0
    ? errors.join("; ")
    : (plain(result.stderr).trim() || plain(result.stdout).trim() ||
      `rad sync exited ${result.code} without saying anything`);
  return { fetched, failures, candidates, summary, inProgress: STILL_RUNNING.test(summary) };
}

/**
 * How many peers that CLAIM to hold the repository were actually ASKED for it.
 *
 * The distinction the 409 rests on: above zero, somebody who has it refused us and "the
 * repository is private" is a fair reading; at zero, nothing was refused by anybody who has it.
 * A candidate the CLI could not even dial ("Could not connect. No addresses known.", "Could not
 * connect. At least one address is known but all attempts timed out.", both from `sync.rs`) was
 * never asked, so it does not count — which is precisely the case that used to be mistaken for
 * a refusal.
 */
function askedCount(outcome: SyncFetchOutcome): number {
  return outcome.fetched.length +
    outcome.failures.filter((f) => !/^Could not connect\b/.test(f.reason)).length;
}

export interface SyncFetchDeps {
  exec: RadExec;
  diag: Diagnostics;
}

/**
 * Fetches `rid` from the network, or throws `FetchRefusedError` with everything the CLI said.
 *
 * The repository must already be seeded — `rad sync` refuses an unseeded one outright
 * (`sync.rs`: "repository {rid} is not seeded") — which is why the caller seeds first.
 *
 * `budgetMs` is BOTH the CLI's own `--timeout` and, plus `graceMs`, the bound on the
 * subprocess: the CLI gets the chance to end its own walk and print per-seed reasons, and a
 * `rad` that ignores its timeout still cannot outlive the request. It does ignore it: a fetch
 * the node has queued behind another one from the same seed is waited out past `--timeout`
 * (measured on a live node, killed at budget + grace every time). So a caller with a deadline of
 * its own passes the grace it can afford, which for the git door is none.
 *
 * `--replicas 1` because one replica is all a clone needs (heartwood's own `clone.rs` says
 * exactly that: `ReplicationFactor::must_reach(1)`); waiting for three would spend the whole
 * budget on seeds we do not need.
 */
export async function syncFetch(
  deps: SyncFetchDeps,
  rid: string,
  budgetMs: number,
  graceMs: number = SYNC_EXEC_GRACE_MS,
): Promise<SyncFetchOutcome> {
  const seconds = Math.max(1, Math.round(budgetMs / 1_000));
  const result = await deps.exec.rad(
    ["sync", rid, "--fetch", "--replicas", "1", "--timeout", `${seconds}sec`],
    // NO_COLOR belt and braces: the CLI already drops colour on a pipe.
    { timeoutMs: budgetMs + graceMs, env: { NO_COLOR: "1" } },
  );
  const outcome = parseSyncFetch(result);
  if (result.timedOut) {
    // We cut the CLI off, which says nothing about the node: same reading as its own
    // control-socket timeout — the fetch may still be running.
    deps.diag.warn("radicle.sync_fetch_timed_out", { rid, budgetMs });
    throw new FetchRefusedError(rid, askedCount(outcome), outcome.failures, {
      summary: `rad sync did not finish within ${budgetMs}ms`,
      candidates: outcome.candidates,
      inProgress: true,
    });
  }
  if (outcome.fetched.length === 0) {
    // Exit 0 is not success here — see the header. What counts is the `🌱` lines.
    deps.diag.warn("radicle.sync_fetch_failed", {
      rid,
      code: result.code,
      candidates: outcome.candidates,
      inProgress: outcome.inProgress,
      summary: outcome.summary,
    });
    throw new FetchRefusedError(rid, askedCount(outcome), outcome.failures, {
      summary: outcome.summary,
      candidates: outcome.candidates,
      inProgress: outcome.inProgress,
    });
  }
  deps.diag.debug("radicle.sync_fetched", { rid, from: outcome.fetched });
  return outcome;
}
