#!/usr/bin/env -S bun --env-file=deploy/compose-networked/.env
/**
 * The long-database half of the perf harness — `bun run perf:seed`.
 *
 * Makes the compose stack's databases look like a deployment after years of use: a hundred
 * thousand tasks, their runs, run events, patches, transcripts and metered model calls, spread
 * over two years with the skew real use has (one agent doing most of the work, a long tail of
 * enormous runs).
 *
 * It does not invent row shapes. Every jsonb column is copied from a TEMPLATE row that the real
 * services wrote during a `perf:load` run, so the seeded rows are exactly as fat as real ones
 * and parse wherever the services read them. Run `perf:load --scenario smoke` once first.
 *
 * Everything seeded is terminal (runs concluded, patches settled or parked), so the sweeps have
 * the whole table to look past and nothing to act on — which is the question: what does the
 * history cost the live path?
 *
 *   bun run perf:seed --runs 100000 --events 80
 *
 * Ids are prefixed `s-` so `--wipe` can take the seeded rows out again without touching anything
 * the load driver made.
 */

import { parseArgs } from "@std/cli/parse-args";
import postgres from "postgres";
import { pgBase } from "./pg.ts";

const args = parseArgs(process.argv.slice(2), {
  string: ["runs", "events", "usage", "days", "chunk"],
  boolean: ["wipe"],
  default: { runs: "100000", events: "80", usage: "30", days: "730", chunk: "5000" },
});
const RUNS = Number(args.runs);
const EVENTS_MEAN = Number(args.events);
const USAGE_MEAN = Number(args.usage);
const DAYS = Number(args.days);
const CHUNK = Number(args.chunk);

const url = (db: string) => (process.env.PERF_PG_BASE ?? pgBase()) + db;
const ryph = postgres(url("ryph"), { max: 1, onnotice: () => {} });
const history = postgres(url("ryph_history"), { max: 1, onnotice: () => {} });
const keys = postgres(url("ryph_keys"), { max: 1, onnotice: () => {} });

const t0 = performance.now();
const took = () => `${((performance.now() - t0) / 1000).toFixed(0)}s`;

if (args.wipe) {
  console.log("wiping seeded rows");
  await history`delete from history_events where run_id like 's-%'`;
  await history`delete from history_concluded_runs where run_id like 's-%'`;
  await keys`delete from proxy_usage where run_id like 's-%'`;
  await ryph`delete from patches where id like 's-%'`;
  await ryph`delete from run_events where run_id like 's-%'`;
  await ryph`delete from runs where id like 's-%'`;
  await ryph`delete from tasks where id like 's-%'`;
  await ryph`delete from connected_repos where id like 's-%'`;
  console.log(`done in ${took()}`);
  process.exit(0);
}

// ── the templates ────────────────────────────────────────────────────────────────────────────

const [template] = await ryph`
  select r.id as run_id, r.task_id from runs r
  where r.state = 'succeeded' and r.id not like 's-%' order by r.created_at limit 1`;
if (!template) {
  console.error("no template run — run `bun run perf:load --scenario smoke` first");
  process.exit(1);
}
const agents = (await ryph`select id from agents where archived_at is null order by created_at`)
  .map((a) => a.id as string);
if (agents.length === 0) {
  console.error(
    "no live agent to attribute runs to — run `bun run perf:load --scenario smoke` first",
  );
  process.exit(1);
}
const [usageTemplate] = await keys`select * from proxy_usage order by seq limit 1`;
if (!usageTemplate) {
  console.error("no template usage row — run `bun run perf:load --scenario smoke` first");
  process.exit(1);
}
console.log(
  `seeding ${RUNS} runs over ${DAYS} days across ${agents.length} agents, ` +
    `~${EVENTS_MEAN} transcript events and ~${USAGE_MEAN} model calls per run`,
);

// Ten connected repos for the patches to point at. Fake coordinates: nothing submits them.
await ryph`
  insert into connected_repos (id, provider, installation_id, repo_ref, url, default_branch,
    submission_policy, created_at, updated_at)
  select 's-repo-' || g, 'github', null, 'perf/seed-' || g, 'https://github.com/perf/seed-' || g,
    'main', 'require-approval', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  from generate_series(0, 9) g
  on conflict do nothing`;

// ── the control plane: tasks, runs, run events, patches ──────────────────────────────────────

// Agent skew: the first agent does half the work, the rest share the other half. The agent, the
// state and (below) the patch state are picked from a hash of `g` rather than drawn: stable, so
// the model-proxy rows bill each run to the agent that ran it and a re-run writes events for the
// state the kept run row already has, and salted per purpose, so the three picks are independent
// of each other rather than all following `g`'s residues.
// `created` spreads evenly over DAYS, newest last, so seq order and time order agree.
for (let from = 0; from < RUNS; from += CHUNK) {
  const to = Math.min(RUNS, from + CHUNK) - 1;
  await ryph.begin(async (tx) => {
    await tx`
      create temp table seed_ids on commit drop as
      select g,
        's-t-' || lpad(g::text, 9, '0') as task_id,
        's-r-' || lpad(g::text, 9, '0') as run_id,
        (${agents}::text[])[case when ('x' || substr(md5(g::text || ':agent'), 1, 7))::bit(28)::int % 2 = 0 then 1
          else 1 + (('x' || substr(md5(g::text || ':agent'), 1, 7))::bit(28)::int / 2) % ${agents.length} end]
          as agent_id,
        to_char((now() - make_interval(secs => (${RUNS} - g)::float8 / ${RUNS} * ${DAYS} * 86400))
          at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created,
        (array['succeeded','succeeded','succeeded','succeeded','succeeded','succeeded','succeeded',
               'failed','failed','errored','cancelled','lost'])[1 + ('x' || substr(md5(g::text || ':state'), 1, 7))::bit(28)::int % 12]
          as state
      from generate_series(${from}::int, ${to}::int) g`;

    await tx`
      insert into tasks (id, agent_id, spec_title, spec_instructions, repos, workspace_id, origin,
        requested_by_user_id, requested_via, target_change_request, lifetime, purpose,
        current_run_id, current_run_state, current_run_phase, last_activity_at, created_at)
      select s.task_id, s.agent_id,
        (array['fix','refactor','add','investigate','update','remove'])[1 + g % 6] || ' ' ||
          (array['the billing webhook','flaky login test','dependency bumps','the search index',
                 'retry logic','docs for the CLI','the onboarding flow','memory leak in worker'])[1 + g % 8]
          || ' #' || g,
        t.spec_instructions, t.repos, null,
        (array['user','user','user','automation','forge','chat'])[1 + g % 6],
        t.requested_by_user_id, null, null, t.lifetime, null,
        s.run_id, s.state, 'finalizing', s.created, s.created
      from seed_ids s cross join (select * from tasks where id = ${template.task_id}) t
      on conflict do nothing`;

    await tx`
      insert into runs (id, task_id, agent_id, state, phase, heartbeat_seq, last_heartbeat_at,
        desired_state, cancel_requested_at, attended, idle_deadline_at,
        origin_thread_repo_id, origin_thread_kind, origin_thread_ref, origin_chatroom_id,
        origin_thread_key, token_hash, control_token, handle, launched_at, branch_name, image,
        environment_id, environment, environment_wait, work_item, injected_context, model_scope,
        tool_scope, forge_scope, services, network_scope, limits, egress_refusals, result,
        memory_outcome_reported_at, created_at, updated_at)
      select s.run_id, s.task_id, s.agent_id, s.state, 'finalizing', 40 + g % 200, s.created,
        null, null, false, null, null, null, null, null, null,
        md5(s.run_id), md5(s.run_id || 'c'), 'manual-' || s.run_id, s.created,
        'ryph/' || s.run_id, r.image, null, r.environment, null, r.work_item, r.injected_context,
        r.model_scope, r.tool_scope, r.forge_scope, r.services, r.network_scope, r.limits, null,
        -- The result a run in that state holds: the template's success, a failure or a
        -- cancellation of the same shape, and none for a run the reaper lost.
        case s.state
          when 'succeeded' then r.result
          when 'cancelled' then jsonb_build_object('status', 'cancelled', 'summary',
            'seeded cancellation', 'branches', '[]'::jsonb)
          when 'lost' then null
          when 'errored' then jsonb_build_object('status', 'error', 'reason', 'seeded error',
            'during', 'running', 'branches', '[]'::jsonb)
          else jsonb_build_object('status', 'failure', 'reason', 'seeded failure', 'summary', '',
            'branches', '[]'::jsonb)
        end,
        s.created, s.created, s.created
      from seed_ids s cross join (select * from runs where id = ${template.run_id}) r
      on conflict do nothing`;

    // The lifecycle a real run leaves: created, launched, first beat, phases, credentials, and
    // the result it reported — none for a lost run, which is lost because it never did.
    // Replaced, not added to: run_events has no natural key to conflict on, so a re-run would
    // otherwise give every seeded run a second lifecycle.
    await tx`delete from run_events where run_id in (select run_id from seed_ids)`;
    await tx`
      insert into run_events (run_id, at, kind, detail)
      select s.run_id, s.created, e.kind,
        case when e.kind = 'result-received' then
          case s.state when 'succeeded' then 'success' when 'cancelled' then 'cancelled'
            when 'errored' then 'error' else 'failure' end
        else e.detail end
      from seed_ids s cross join (values
        (1, 'created', null), (2, 'launched', null), (3, 'first-heartbeat', null),
        (4, 'phase-changed', 'cloning'), (5, 'phase-changed', 'preparing'),
        (6, 'credentials-issued', 'model:mock'), (7, 'phase-changed', 'running'),
        (8, 'phase-changed', 'finalizing'), (9, 'result-received', null)
      ) as e(n, kind, detail)
      where not (e.kind = 'result-received' and s.state = 'lost')
      order by s.g, e.n`;

    // A third of runs leave a patch; most were submitted, a few wait on a human forever.
    await tx`
      insert into patches (id, connected_repo_id, run_id, task_id, set_id, path, branch_name,
        head_sha, base_sha, generation, title, description, commits, bundle_key, state, attempts,
        next_attempt_at, lease_expires_at, last_error, approved_by, approved_at, forge_ref,
        forge_url, landed, superseded_by_patch_id, memory_fate_reported_at, created_at, updated_at)
      select 's-p-' || lpad(s.g::text, 9, '0'), 's-repo-' || (s.g % 10), s.run_id, s.task_id,
        's-set-' || s.g, '.', 'ryph/' || s.run_id, md5(s.run_id || 'h'), md5(s.run_id || 'b'), 1,
        'Seeded change ' || s.g, 'A change the seeder made up. ' || repeat('Details. ', 40),
        jsonb_build_array(jsonb_build_object('sha', md5(s.run_id || 'h'), 'subject', 'seeded commit')),
        'bundles/' || s.run_id, p.state, 1, null, null, null, null, null,
        case when p.state = 'submitted' then (1000 + s.g)::text end,
        case when p.state = 'submitted' then 'https://github.com/perf/seed/pull/' || (1000 + s.g) end,
        case when p.state = 'submitted' and random() < 0.7
          then jsonb_build_object('kind', 'merged', 'at', s.created) end,
        null, case when p.state = 'pending_approval' then null else s.created end,
        s.created, s.created
      from seed_ids s
      -- Picked from a hash of the run's number, which also makes the subquery per row: an
      -- uncorrelated random() here is evaluated once per statement, one state for a whole chunk.
      cross join lateral (select (array['submitted','submitted','submitted','submitted',
        'submitted','submitted','submitted','submitted','rejected','superseded','superseded',
        'pending_approval'])[1 + ('x' || substr(md5(s.g::text || ':patch'), 1, 7))::bit(28)::int % 12] as state) p
      where s.state = 'succeeded' and s.g % 3 = 0
      on conflict do nothing`;
  });
  console.log(`  control plane ${to + 1}/${RUNS} (${took()})`);
}

// ── the historian: transcripts ───────────────────────────────────────────────────────────────

// Events per run: a long-tailed draw around the mean — most runs short, some very long, and one
// in a thousand a monster of fifty times the mean. Payload sizes follow the load driver's pi-like
// distribution, in text that does not compress to nothing (TOAST would otherwise flatter us).
for (let from = 0; from < RUNS; from += CHUNK) {
  const to = Math.min(RUNS, from + CHUNK) - 1;
  // Replaced too: each run's length is drawn afresh, so keeping the old rows would leave a
  // re-run's transcripts as long as the longer of two draws.
  await history`
    delete from history_events
    where run_id in (select 's-r-' || lpad(g::text, 9, '0') from generate_series(${from}::int, ${to}::int) g)`;
  await history`
    insert into history_events (run_id, seq, at, voice, kind, level, text, payload)
    select r.run_id, e.seq, r.created,
      case when e.seq % 7 = 0 then 'diag' else 'transcript' end,
      (array['pi.debug','tool_use','tool_result','tool_result','tool_use','assistant','assistant'])[1 + e.seq % 7],
      null,
      case when e.seq % 7 in (0, 5, 6) then 'Turn ' || e.seq || ': ' || repeat(md5(r.run_id || e.seq), 8 + (e.seq * 7) % 40) end,
      case when e.seq % 7 in (2, 3) then jsonb_build_object('output',
        repeat(md5(r.run_id || e.seq), case when (e.seq * 13) % 10 < 6 then 10 + (e.seq * 17) % 30
          when (e.seq * 13) % 10 < 9 then 60 + (e.seq * 17) % 200 else 300 + (e.seq * 17) % 600 end))
        when e.seq % 7 in (1, 4) then jsonb_build_object('tool', 'bash', 'args', jsonb_build_object('command', md5(r.run_id || e.seq)))
      end
    from (
      select 's-r-' || lpad(g::text, 9, '0') as run_id,
        to_char((now() - make_interval(secs => (${RUNS} - g)::float8 / ${RUNS} * ${DAYS} * 86400))
          at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created,
        case when g % 1000 = 7 then ${EVENTS_MEAN} * 50
          else greatest(5, floor(${EVENTS_MEAN} * -ln(1 - random()))::int) end as n
      from generate_series(${from}::int, ${to}::int) g
    ) r
    cross join lateral generate_series(0, r.n - 1) as e(seq)
    on conflict do nothing`;
  // Every seeded run is over, and the historian keeps that as its own fact (the conclude ping);
  // without the row, 100k runs would read as never ended to its ingest and stream paths.
  await history`
    insert into history_concluded_runs (run_id, at)
    select 's-r-' || lpad(g::text, 9, '0'), to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    from generate_series(${from}::int, ${to}::int) g
    on conflict do nothing`;
  console.log(`  historian ${to + 1}/${RUNS} (${took()})`);
}

// ── the model proxy: metered calls ───────────────────────────────────────────────────────────

for (let from = 0; from < RUNS; from += CHUNK) {
  const to = Math.min(RUNS, from + CHUNK) - 1;
  // No natural key to conflict on (seq is serial), so a re-run replaces the chunk's rows rather
  // than adding a second set beside them.
  await keys`
    delete from proxy_usage
    where run_id in (select 's-r-' || lpad(g::text, 9, '0') from generate_series(${from}::int, ${to}::int) g)`;
  await keys`
    insert into proxy_usage (run_id, agent_id, task_id, provider_key_id, provider, model, status,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
      reasoning_tokens, duration_ms, at)
    select r.run_id,
      (${agents}::text[])[case when ('x' || substr(md5(r.g::text || ':agent'), 1, 7))::bit(28)::int % 2 = 0 then 1
        else 1 + (('x' || substr(md5(r.g::text || ':agent'), 1, 7))::bit(28)::int / 2) % ${agents.length} end],
      r.task_id,
      ${usageTemplate.provider_key_id}, ${usageTemplate.provider}, ${usageTemplate.model}, 200,
      8000 + (c * 977) % 60000, 50 + (c * 131) % 1500, 6000 + (c * 733) % 48000, 0, null, null,
      800 + (c * 37) % 4000,
      to_char((r.created + make_interval(secs => c * 20)) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    from (
      select g, 's-r-' || lpad(g::text, 9, '0') as run_id, 's-t-' || lpad(g::text, 9, '0') as task_id,
        now() - make_interval(secs => (${RUNS} - g)::float8 / ${RUNS} * ${DAYS} * 86400) as created,
        greatest(1, floor(${USAGE_MEAN} * -ln(1 - random()))::int) as n
      from generate_series(${from}::int, ${to}::int) g
    ) r
    cross join lateral generate_series(1, r.n) as c`;
  console.log(`  model proxy ${to + 1}/${RUNS} (${took()})`);
}

console.log("analyzing");
await ryph`analyze`;
await history`analyze`;
await keys`analyze`;

const sizes = async (sql: postgres.Sql, label: string) => {
  const rows = await sql`
    select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) as size
    from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 6`;
  for (const r of rows) console.log(`  ${label}.${r.relname}: ${r.n_live_tup} rows, ${r.size}`);
};
await sizes(ryph, "ryph");
await sizes(history, "ryph_history");
await sizes(keys, "ryph_keys");
console.log(`seeded in ${took()}`);
await Promise.all([ryph.end(), history.end(), keys.end()]);
