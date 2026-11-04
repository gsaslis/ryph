/**
 * Moves seeded history into the past. Seeding plays every run in about a second, all of them
 * "just now"; this rewrites the database (with the host stopped, so nothing else holds it) so
 * each run started when its timeline entry says and took as long as its story says.
 *
 * Per run it is one affine map over time, applied to every timestamp column of every row that
 * names the run (or its task): the instant the run really started maps to its new start, and
 * the real run is stretched to the story's duration. Order is kept within a run, and across
 * tables, because every row of the run goes through the same map. Whatever happened after the
 * run ended (a person approving its patch) keeps its real distance from the end.
 *
 * Everything else that was seeded (people, agents, repos, keys) moves to before the oldest run.
 * Timestamps are ISO text in every schema here, which is what makes a generic pass possible:
 * the columns are found by name, `at` or `*_at`, and only ISO values are touched.
 */

import { PGlite } from "@electric-sql/pglite";
import { lockDataDir } from "@ryph/db";
import type { SeedCheck, TimelineEntry } from "./context.ts";

/** Tables the pass never touches: key rotation, live sessions and challenges, sweep cursors. */
const SKIP = new Set([
  "auth_signing_keys",
  "auth_sessions",
  "one_time_tokens",
  "passkey_challenges",
  "identity_challenges",
  "chat_poll_cursors",
  "merge_polls",
  "webhooks",
  "radicle_cursors",
  "radicle_tracked_repos",
]);

const ISO = `'^\\d{4}-\\d\\d-\\d\\dT'`;
const FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The SQL expression mapping column `c` through the run map `m`. */
const mapped = (c: string) =>
  `case when ${c} !~ ${ISO} then ${c} else to_char((case
     when ${c}::timestamptz <= m.real_end then m.new_start + (${c}::timestamptz - m.real_start) * m.k
     else m.new_start + (m.real_end - m.real_start) * m.k + (${c}::timestamptz - m.real_end)
   end) at time zone 'UTC', ${FORMAT}) end`;

export async function backdate(dataDir: string, timeline: TimelineEntry[], now = Date.now()) {
  if (timeline.length === 0) return;
  const lock = await lockDataDir(dataDir);
  let db: PGlite;
  try {
    db = new PGlite(dataDir);
  } catch (error) {
    await lock.release();
    throw error;
  }
  try {
    await db.exec(`create temp table pg_runs (
      run_id text primary key, task_id text not null,
      real_start timestamptz not null, real_end timestamptz not null,
      new_start timestamptz not null, k double precision not null)`);
    for (const t of timeline) {
      // The public API intentionally cannot post as the platform. Install the catalogue's
      // synthetic inbox only here, with the host stopped, before mapping all its timestamps.
      for (const [i, notice] of (t.notices ?? []).entries()) {
        await db.query(
          `insert into run_messages (id, run_id, seq, kind, sender, text, payload, attachments, created_at, delivered_at)
           select $1, $2, coalesce(max(seq), -1) + 1, $3, $4::jsonb, $5, $6::jsonb, '[]'::jsonb, $7, $7
           from run_messages where run_id = $2`,
          [
            `rm-playground-notice-${t.runId}-${i}`,
            t.runId,
            notice.kind,
            JSON.stringify(notice.sender),
            notice.text,
            notice.payload === null ? null : JSON.stringify(notice.payload),
            notice.createdAt,
          ],
        );
      }
      const real = Math.max(1, Date.parse(t.realEnd) - Date.parse(t.realStart));
      await db.query(
        "insert into pg_runs values ($1, $2, $3, $4, $5, $6)",
        [
          t.runId,
          t.taskId,
          t.realStart,
          t.realEnd,
          new Date(now - t.ageMs).toISOString(),
          t.durationMs / real,
        ],
      );
    }

    const { rows } = await db.query<{ table_name: string; column_name: string }>(`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type = 'text'
      order by table_name, ordinal_position`);
    const tables = new Map<string, string[]>();
    for (const { table_name, column_name } of rows) {
      (tables.get(table_name) ?? tables.set(table_name, []).get(table_name)!).push(column_name);
    }

    const oldest = Math.max(...timeline.map((t) => t.ageMs));
    const before = `interval '${Math.round((oldest + 3 * 86_400_000) / 1000)} seconds'`;
    for (const [table, columns] of tables) {
      if (SKIP.has(table)) continue;
      const times = columns.filter((c) => c === "at" || c.endsWith("_at"));
      if (times.length === 0) continue;
      const set = (cols: string[]) => cols.map((c) => `"${c}" = ${mapped(`t."${c}"`)}`).join(", ");
      const key = table === "runs"
        ? "t.id = m.run_id"
        : table === "tasks"
        ? "t.id = m.task_id"
        : columns.includes("run_id")
        ? "t.run_id = m.run_id"
        : columns.includes("task_id")
        ? "t.task_id = m.task_id"
        : null;
      if (key !== null) {
        await db.exec(`update "${table}" t set ${set(times)} from pg_runs m where ${key}`);
      } else {
        // Not about a run: it existed before all of them.
        const cols = times.filter((c) => c === "created_at" || c === "updated_at");
        if (cols.length === 0) continue;
        await db.exec(
          `update "${table}" set ${
            cols.map((c) =>
              `"${c}" = case when "${c}" !~ ${ISO} then "${c}" else to_char(("${c}"::timestamptz - ${before}) at time zone 'UTC', ${FORMAT}) end`
            ).join(", ")
          }`,
        );
      }
    }
    // The one timestamp kept inside a document: when a patch landed.
    await db.exec(
      `update patches t set landed = jsonb_set(t.landed, '{at}', to_jsonb(${
        mapped(`(t.landed->>'at')`)
      })) from pg_runs m where t.run_id = m.run_id and t.landed ? 'at'`,
    );
    for (const t of timeline) {
      if (t.checks?.length) await installChecks(db, t.runId, t.checks);
    }
  } finally {
    await db.close();
    await lock.release();
  }
}

/**
 * A finished suite on the run's patch, as the checks service would have recorded it: the
 * playground has no launcher to run one. Written after the time map, so it is stamped from the
 * patch's own (already moved) time and lands just after the agent submitted.
 */
async function installChecks(db: PGlite, runId: string, checks: SeedCheck[]): Promise<void> {
  const { rows: [patch] } = await db.query<{
    id: string;
    connected_repo_id: string;
    head_sha: string;
    branch_name: string;
    bundle_key: string;
    target_ref: string | null;
    created_at: string;
    forge_ref: string | null;
  }>(
    `select p.id, p.connected_repo_id, p.head_sha, p.branch_name, p.bundle_key, p.created_at,
       p.forge_ref, r.default_branch as target_ref
     from patches p join connected_repos r on r.id = p.connected_repo_id
     where p.run_id = $1 order by p.created_at limit 1`,
    [runId],
  );
  if (!patch) throw new Error(`no patch on ${runId} to hang its checks on`);
  const body = runId.replace(/^r-/, "");
  const suiteId = `cs-${body}`;
  const base = patch.target_ref ?? "main";
  const at = (s: number) => new Date(Date.parse(patch.created_at) + s * 1000).toISOString();
  const queued = 20;
  const finished = queued + Math.max(...checks.map((c) => c.seconds));
  const source = {
    runId,
    bundleKey: patch.bundle_key,
    branchName: patch.branch_name,
    baseRef: base,
  };
  const definition = {
    setup: [],
    checks: checks.map((c) => ({
      name: c.name,
      run: c.run,
      timeoutSeconds: null,
      services: [],
      watch: [],
    })),
  };
  await db.query(
    `insert into check_suites (id, connected_repo_id, commit, checks_ref, checks_commit,
       checks_blob, checks_path, definition, environment_key, inputs_key, network_scope, image,
       services, source, state, generation, attempts, ryph_changed, launched_at, finished_at,
       created_at, updated_at)
     values ($1, $2, $3, $4, $3, $5, '.ryph/checks.yml', $6::jsonb, 'default', 'playground',
       '{"mode":"open","bundles":[],"hosts":[]}'::jsonb, null, '[]'::jsonb, $7::jsonb, $8, 1, 1,
       false, $9, $10, $11, $10)`,
    [
      suiteId,
      patch.connected_repo_id,
      patch.head_sha,
      base,
      `playground-${body}`,
      JSON.stringify(definition),
      JSON.stringify(source),
      checks.every((c) => c.state === "passed") ? "passed" : "failed",
      at(queued),
      at(finished),
      at(5),
    ],
  );
  for (const c of checks) {
    await db.query(
      `insert into check_results (suite_id, generation, name, state, exit_code, started_at,
         finished_at, log_tail, watched_changed)
       values ($1, 1, $2, $3, $4, $5, $6, $7, false)`,
      [
        suiteId,
        c.name,
        c.state,
        c.state === "passed" ? 0 : 1,
        at(queued),
        at(queued + c.seconds),
        c.logTail,
      ],
    );
  }
  await db.query(
    `insert into check_requests (id, suite_id, connected_repo_id, commit, run_id, patch_id,
       change_request, kind, state, source, checks_ref, reported_generation, attempts, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'patch', 'active', $8::jsonb, $9, 1, 1, $10)`,
    [
      `cq-${body}`,
      suiteId,
      patch.connected_repo_id,
      patch.head_sha,
      runId,
      patch.id,
      patch.forge_ref,
      JSON.stringify(source),
      base,
      at(5),
    ],
  );
}
