#!/usr/bin/env -S bun --env-file=deploy/compose-networked/.env
/**
 * What the database did — `bun run perf:report`, after (or during) a `perf:load`.
 *
 * Per database: the statements that cost the most in total, the slowest on average, and every
 * table read by sequential scan with how many rows those scans walked. A big table with a large
 * `seq_tup_read` is the signature of a query that gets slower as history grows.
 *
 *   bun run perf:report            # read
 *   bun run perf:report --reset    # zero the counters, so the next read covers one scenario
 */

import { parseArgs } from "@std/cli/parse-args";
import postgres from "postgres";
import { pgBase } from "./pg.ts";

const args = parseArgs(process.argv.slice(2), {
  boolean: ["reset"],
  string: ["top"],
  default: { top: "12" },
});
const TOP = Number(args.top);
const DBS = [
  "ryph",
  "ryph_history",
  "ryph_keys",
  "ryph_mcp",
  "ryph_memory",
  "ryph_chat",
  "ryph_forge",
  "ryph_automations",
];
const base = process.env.PERF_PG_BASE ?? pgBase();

const oneLine = (q: string, n = 150) => q.replace(/\s+/g, " ").slice(0, n);

for (const db of DBS) {
  const sql = postgres(base + db, { max: 1, onnotice: () => {} });
  try {
    // The overlay preloads the library; the view and its functions exist per database only once
    // the extension is created in it.
    await sql`create extension if not exists pg_stat_statements`;
    if (args.reset) {
      await sql`select pg_stat_statements_reset()`;
      await sql`select pg_stat_reset()`;
      continue;
    }
    const total = await sql`
      select calls, round(total_exec_time)::int as total_ms, round(mean_exec_time::numeric, 2) as mean_ms,
        round(max_exec_time)::int as max_ms, rows, shared_blks_read as disk_blks, query
      from pg_stat_statements
      where dbid = (select oid from pg_database where datname = current_database())
        and query not ilike '%pg_stat%' and query not ilike 'begin%' and query not ilike 'commit%'
      order by total_exec_time desc limit ${TOP}`;
    const scans = await sql`
      select relname, seq_scan, seq_tup_read, idx_scan, n_live_tup,
        pg_size_pretty(pg_total_relation_size(relid)) as size,
        n_tup_upd, n_tup_hot_upd
      from pg_stat_user_tables where seq_scan > 0 and n_live_tup > 1000
      order by seq_tup_read desc limit 8`;
    if (total.length === 0 && scans.length === 0) continue;
    console.log(`\n━━ ${db} ━━`);
    console.log("  by total time:");
    for (const r of total) {
      console.log(
        `    ${String(r.total_ms).padStart(8)}ms total  ${String(r.calls).padStart(7)} calls  ` +
          `mean ${String(r.mean_ms).padStart(8)}ms  max ${String(r.max_ms).padStart(6)}ms  ` +
          `rows ${String(r.rows).padStart(8)}  | ${oneLine(r.query)}`,
      );
    }
    if (scans.length > 0) {
      console.log("  sequential scans on tables over 1000 rows:");
      for (const r of scans) {
        console.log(
          `    ${r.relname.padEnd(24)} ${String(r.n_live_tup).padStart(9)} rows ${
            r.size.padStart(8)
          }  ` +
            `seq_scan=${r.seq_scan} seq_tup_read=${r.seq_tup_read} idx_scan=${r.idx_scan} ` +
            `upd=${r.n_tup_upd} hot=${r.n_tup_hot_upd}`,
        );
      }
    }
  } catch (err) {
    console.log(`\n━━ ${db} ━━ ${String(err).slice(0, 120)}`);
  } finally {
    await sql.end();
  }
}
if (args.reset) console.log("counters reset");
