// The committed migration files, applied in order to a database whose tables already hold rows
// — the shape of every deployment after the first — and then compared with the schema: what
// the files build must be what the code expects, or the migrate job wedges the deploy.
//
// The rows seeded before the workspaces migration (0005) are in the SINGLE-REPO shape that
// migration retires — a task with `repo_url`/`connected_repo_id`, a run whose work item says
// `repo`/`branchName` and whose result says `branch` — because those JSON columns are read by
// code that expects the list shape, and a row the migration forgot would 500 the patch queue.

import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { sql } from "drizzle-orm";
import { pushSchema } from "drizzle-kit/api";
import { makeDb } from "../src/adapters/store/db/db.ts";
import * as authSchema from "@ryph/auth/schema";
import * as schema from "../src/adapters/store/db/schema.ts";

const DIR = new URL("../drizzle/", import.meta.url);

async function migrations(): Promise<Array<{ tag: string; statements: string[] }>> {
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", DIR), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  return Promise.all(journal.entries.map(async ({ tag }) => ({
    tag,
    statements: (await readFile(new URL(`${tag}.sql`, DIR), "utf8"))
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  })));
}

const T = "2026-09-01T00:00:00.000Z";
/** The idle clocks 0044 gives every task and work item that had none. */
const DEFAULT_CLOCKS = { idleMs: 300_000, attendedIdleMs: 1_800_000 };
/** A later second, so "the newest run" can be told from "the run with the biggest id". */
const T2 = "2026-09-02T00:00:00.000Z";

/** Rows in the shape the last single-repo migration (0004) left. */
const BEFORE_WORKSPACES = [
  `INSERT INTO "agents" ("id","name","email","harness_kind","created_at","updated_at")
   VALUES ('a-1','Ada','ada@example.com','echo','${T}','${T}')`,
  `INSERT INTO "connected_repos" ("id","installation_id","full_name","url","default_branch","created_at","updated_at")
   VALUES ('cr-1','42','acme/app','https://github.com/acme/app.git','main','${T}','${T}')`,
  `INSERT INTO "tasks" ("id","agent_id","spec_title","spec_instructions","repo_url","repo_ref","connected_repo_id","origin","target_pull_request","created_at")
   VALUES ('t-1','a-1','T','I','https://github.com/acme/app.git','refs/heads/feat','cr-1','forge',7,'${T}')`,
  `INSERT INTO "tasks" ("id","agent_id","spec_title","spec_instructions","repo_url","repo_ref","connected_repo_id","origin","created_at")
   VALUES ('t-2','a-1','T','I','https://example.com/raw.git','main',NULL,'user','${T}')`,
  // A connected-repo run that shipped, a raw-URL run that failed, and a run still queued.
  `INSERT INTO "runs" ("id","task_id","agent_id","state","heartbeat_seq","token_hash","control_token","branch_name","work_item","result","created_at","updated_at")
   VALUES ('r-1','t-1','a-1','succeeded',0,'h1','c1','ryph/ada/r-1',
     '{"id":"r-1","agent":{"name":"Ada","email":"ada@example.com"},"spec":{"title":"T","instructions":"I"},"repo":{"url":"http://gw/v1/git/r-1/repo.git","ref":"refs/heads/feat"},"branchName":"ryph/ada/r-1","harness":{"kind":"echo"}}',
     '{"status":"success","summary":"done","branch":{"name":"ryph/ada/r-1","headSha":"abc","commits":[{"sha":"abc","subject":"s"}]}}',
     '${T}','${T}')`,
  `INSERT INTO "runs" ("id","task_id","agent_id","state","heartbeat_seq","token_hash","control_token","branch_name","work_item","result","created_at","updated_at")
   VALUES ('r-2','t-2','a-1','failed',0,'h2','c2','ryph/ada/r-2',
     '{"id":"r-2","agent":{"name":"Ada","email":"ada@example.com"},"spec":{"title":"T","instructions":"I"},"repo":{"url":"https://example.com/raw.git","ref":"main"},"branchName":"ryph/ada/r-2","harness":{"kind":"echo"}}',
     '{"status":"failure","reason":"r","summary":"","branch":null}',
     '${T}','${T}')`,
  `INSERT INTO "runs" ("id","task_id","agent_id","state","heartbeat_seq","token_hash","control_token","branch_name","work_item","created_at","updated_at")
   VALUES ('r-3','t-2','a-1','queued',0,'h3','c3','ryph/ada/r-3',
     '{"id":"r-3","agent":{"name":"Ada","email":"ada@example.com"},"spec":{"title":"T","instructions":"I"},"repo":{"url":"https://example.com/raw.git","ref":"main"},"branchName":"ryph/ada/r-3","harness":{"kind":"echo"}}',
     '${T}','${T}')`,
  `INSERT INTO "patches" ("id","connected_repo_id","run_id","task_id","branch_name","head_sha","bundle_key","state","attempts","created_at","updated_at")
   VALUES ('p-1','cr-1','r-1','t-1','ryph/ada/r-1','abc','r-1/abc.bundle','submitted',1,'${T}','${T}')`,
];

/**
 * Rows in the shape the last GitHub-only migration (0014) left, seeded just before the forge
 * seams (0015) run over them.
 *
 * They exist because 0015's backfills are the part of it with no schema to catch a mistake: a
 * triple `jsonb_set` over a live run's frozen grant, a sender object rebuilt field by field,
 * two integer thread ids becoming text. `pushSchema` at the end of this test compares COLUMNS,
 * and every one of these could be silently wrong and still pass it. The scalar `forge_scope` on
 * `r-5` is the other half: a column whose contents are not what the migration assumes must be
 * SKIPPED, not fail the statement — a failed statement is a migrate job that never finishes
 * and a deployment that never starts.
 */
const BEFORE_FORGE = [
  // A live run with a frozen forge grant: two repos, one of them a source, and an origin that
  // is a pull request. Every one of those spellings is renamed inside the jsonb.
  `INSERT INTO "runs" ("id","task_id","agent_id","state","heartbeat_seq","token_hash","control_token","branch_name","work_item","network_scope","forge_scope","origin_thread_repo_id","origin_thread_kind","origin_thread_number","created_at","updated_at")
   VALUES ('r-4','t-1','a-1','running',0,'h4','c4','ryph/ada/r-4',
     '{"id":"r-4","agent":{"name":"Ada","email":"ada@example.com"},"spec":{"title":"T","instructions":"I"},"repos":[],"harness":{"kind":"echo"}}',
     '{"mode":"open","bundles":[],"hosts":[]}',
     '{"repos":[{"connectedRepoId":"cr-1","fullName":"acme/app","tenantId":"42"}],"sourceRepos":[{"connectedRepoId":"cr-1","fullName":"acme/app","tenantId":"42"}],"origin":{"connectedRepoId":"cr-1","kind":"pull_request","number":7},"capabilities":{}}',
     'cr-1','pull_request',7,'${T}','${T}')`,
  // And one whose frozen grant is a jsonb SCALAR — not a shape anything writes, but the shape
  // that decides whether the backfill is guarded or merely lucky.
  `INSERT INTO "runs" ("id","task_id","agent_id","state","heartbeat_seq","token_hash","control_token","branch_name","work_item","network_scope","forge_scope","created_at","updated_at")
   VALUES ('r-5','t-2','a-1','running',0,'h5','c5','ryph/ada/r-5',
     '{"id":"r-5","agent":{"name":"Ada","email":"ada@example.com"},"spec":{"title":"T","instructions":"I"},"repos":[],"harness":{"kind":"echo"}}',
     '{"mode":"open","bundles":[],"hosts":[]}',
     '"not an object"','${T}','${T}')`,
  // A forge follow-up sitting in a run's inbox, and a platform one beside it that must not be
  // touched.
  `INSERT INTO "run_messages" ("id","run_id","seq","kind","sender","text","created_at")
   VALUES ('m-1','r-4',1,'user','{"kind":"forge","login":"ada","repoFullName":"acme/app","threadNumber":7}','do it','${T}')`,
  `INSERT INTO "run_messages" ("id","run_id","seq","kind","sender","text","created_at")
   VALUES ('m-2','r-4',2,'system','{"kind":"platform"}','a note','${T}')`,
  // The run's face in its thread, addressed by an integer.
  `INSERT INTO "progress_comments" ("run_id","task_id","connected_repo_id","thread_kind","thread_number","comment_id","last_posted","attempts","created_at","updated_at")
   VALUES ('r-4','t-1','cr-1','pull_request',7,'gh-99','{"state":"running"}',0,'${T}','${T}')`,
  // And a write the run made through the tool surface, addressed the same way.
  `INSERT INTO "forge_tool_actions" ("id","run_id","tool","connected_repo_id","repo_full_name","number","state","created_number","created_at")
   VALUES ('fa-1','r-4','add_comment','cr-1','acme/app',7,'done',78,'${T}')`,
];

/**
 * A Radicle repo connected while the flow stored `url = ""`, and a GitHub one beside it.
 *
 * The empty string was not cosmetic: `url` is the repository's address on the wire — the
 * services-file read hands it to the forge, whose schema requires it non-empty — so every run
 * on such a repo was refused with `url: Too small`. 0017 puts the RID back. The GitHub row is
 * here to prove the statement is not a blanket overwrite.
 */
const BEFORE_RADICLE_URL = [
  `INSERT INTO "connected_repos" ("id","provider","installation_id","repo_ref","url","default_branch","submission_policy","created_at","updated_at")
   VALUES ('cr-rad','radicle',NULL,'rad:z2oo6c5ceo8RPkRsxHBE2LBz7uHsC','','main','open','${T}','${T}')`,
  `INSERT INTO "connected_repos" ("id","provider","installation_id","repo_ref","url","default_branch","submission_policy","created_at","updated_at")
   VALUES ('cr-gh','github','42','acme/other','https://github.com/acme/other.git','main','open','${T}','${T}')`,
];

/**
 * Rows seeded just before the task list's denormalized attempt (0023) runs over them — the two
 * cases its backfill has to get right and that no column comparison can catch.
 *
 * `t-4` holds two runs whose ids sort the OPPOSITE way from their clocks, so a backfill that
 * ordered by id would pick the wrong attempt and the list would show a state that is over.
 * `t-3` holds none, which nothing writes today but an old database may still carry; it has to
 * settle rather than fail the statement, because a failed statement is a migrate job that never
 * finishes and a deployment that never starts.
 */
const BEFORE_TASK_LIST = [
  `INSERT INTO "tasks" ("id","agent_id","spec_title","spec_instructions","repos","origin","created_at")
   VALUES ('t-3','a-1','Never ran','I','[]','user','${T}')`,
  `INSERT INTO "tasks" ("id","agent_id","spec_title","spec_instructions","repos","origin","created_at")
   VALUES ('t-4','a-1','Two attempts','I','[]','user','${T}')`,
  // The LATER run, with the SMALLER id.
  `INSERT INTO "runs" ("id","task_id","agent_id","state","phase","heartbeat_seq","token_hash","control_token","branch_name","work_item","network_scope","created_at","updated_at")
   VALUES ('r-6','t-4','a-1','queued','setup',0,'h6','c6','ryph/ada/r-6',
     '{"id":"r-6","agent":{"name":"Ada","email":"ada@example.com"},"spec":{"title":"T","instructions":"I"},"repos":[],"harness":{"kind":"echo"}}',
     '{"mode":"open","bundles":[],"hosts":[]}','${T2}','${T2}')`,
  // The EARLIER run, with the BIGGER id.
  `INSERT INTO "runs" ("id","task_id","agent_id","state","heartbeat_seq","token_hash","control_token","branch_name","work_item","network_scope","created_at","updated_at")
   VALUES ('r-9','t-4','a-1','failed',0,'h9','c9','ryph/ada/r-9',
     '{"id":"r-9","agent":{"name":"Ada","email":"ada@example.com"},"spec":{"title":"T","instructions":"I"},"repos":[],"harness":{"kind":"echo"}}',
     '{"mode":"open","bundles":[],"hosts":[]}','${T}','${T}')`,
];

/**
 * Forge rows in the shape the checks migrations (0027, 0028) left — one per submitted patch, keyed
 * on it — seeded before 0030 gives every row an id of its own and the base its checks are
 * read at. `p-1` has a request on record, read at `release`; `p-2` has none, and is judged by
 * its repo's default branch.
 */
const BEFORE_PUSH_REPORTS = [
  `INSERT INTO "patches" ("id","connected_repo_id","run_id","task_id","set_id","path","branch_name","head_sha","bundle_key","state","attempts","created_at","updated_at")
   VALUES ('p-2','cr-1','r-1','t-1','p-2','repo','ryph/ada/r-1','def','r-1/def.bundle','submitted',1,'${T}','${T}')`,
  `INSERT INTO "check_requests" ("id","connected_repo_id","commit","patch_id","kind","state","source","checks_ref","attempts","created_at")
   VALUES ('cq-1','cr-1','abc','p-1','patch','pending','{"runId":"r-1","bundleKey":"k","branchName":"b","baseRef":"release"}','release',0,'${T}')`,
  `INSERT INTO "check_forge_reports" ("patch_id","connected_repo_id","head_sha","attempts","revision","open_generations","created_at","updated_at")
   VALUES ('p-1','cr-1','abc',0,3,'[]','${T}','${T}')`,
  `INSERT INTO "check_forge_reports" ("patch_id","connected_repo_id","head_sha","attempts","revision","open_generations","created_at","updated_at")
   VALUES ('p-2','cr-1','def',0,0,'[]','${T}','${T}')`,
];

/**
 * Before the landings (0042): `p-1` reached its forge and merged — its run was told then, under
 * the code of the day — and `p-2` reached its forge and waits for a verdict.
 */
const BEFORE_LANDINGS = [
  `UPDATE "patches" SET "forge_ref" = '7', "landed" = '{"kind":"merged","at":"2026-01-02T00:00:00.000Z"}',
     "updated_at" = '2026-01-02T00:00:00.000Z' WHERE "id" = 'p-1'`,
  `UPDATE "patches" SET "forge_ref" = '8', "updated_at" = '2026-01-01T12:00:00.000Z' WHERE "id" = 'p-2'`,
];

/**
 * A task and a queued run in the conversational shape 0044 retires (`kind` beside the clocks),
 * seeded just before it. The one-shot rows above (t-1, t-2, r-1..r-3) get the default clocks;
 * these keep their own.
 */
const BEFORE_EVERY_RUN_CONVERSATIONAL = [
  `UPDATE "tasks" SET "lifetime" = '{"kind":"conversational","idleMs":600000,"attendedIdleMs":3600000}' WHERE "id" = 't-3'`,
  `UPDATE "runs" SET "work_item" = "work_item" || '{"lifetime":{"kind":"conversational","idleMs":600000,"attendedIdleMs":3600000}}' WHERE "id" = 'r-6'`,
];

/**
 * Responses from before keyed correlation (0058): one closed and one open for `auto-1`, in the
 * shape whose partial unique index was on the automation alone.
 */
const BEFORE_RESPONSE_SLOTS = [
  `INSERT INTO "responses" ("id","automation_id","task_id","run_id","chatroom_id","state","alerts","opened_at","last_alert_at","last_activity_at","closed_at","closed_reason")
   VALUES ('resp-old','auto-1','t-1','r-1',NULL,'closed',2,'${T}','${T}','${T}','${T}','succeeded')`,
  `INSERT INTO "responses" ("id","automation_id","task_id","run_id","chatroom_id","state","alerts","opened_at","last_alert_at","last_activity_at","closed_at","closed_reason")
   VALUES ('resp-open','auto-1','t-1','r-1','chr-1','open',1,'${T}','${T}','${T}',NULL,NULL)`,
];

/**
 * Landings in the shape before patch lines (0059): one per checkout path. `t-1` holds one, which
 * becomes its path's default line's; `t-2` already holds the per-line shape, which is left as it
 * is; `t-3` holds none.
 *
 * And repo entries in that shape, which name the run's branch `branchName` where 0059 names the
 * same string `branchNamespace`: the tasks and runs from before workspaces hold one each (0005
 * wrote them). `t-3` holds three, in order — one old, one already in the new shape, one with
 * both keys, whose new key wins — and `r-9`'s work item one in each shape; `r-6`'s holds none.
 */
const ENTRY = {
  connectedRepoId: "cr-1",
  name: "acme/app",
  url: "https://github.com/acme/app.git",
  ref: "main",
  description: null,
};
const LANDING = {
  connectedRepoId: "cr-1",
  thread: "7",
  onto: "main",
  generation: 1,
  moved: false,
  at: T,
};
const BEFORE_LINES = [
  `UPDATE "tasks" SET "landings" = '${JSON.stringify({ repo: LANDING })}' WHERE "id" = 't-1'`,
  `UPDATE "tasks" SET "landings" = '${
    JSON.stringify({ repo: { work: LANDING } })
  }' WHERE "id" = 't-2'`,
  `UPDATE "tasks" SET "repos" = '${
    JSON.stringify([
      { ...ENTRY, path: "a", branchName: "ryph/ada/r-7" },
      { ...ENTRY, path: "b", branchNamespace: "ryph/ada/r-7" },
      { ...ENTRY, path: "c", branchName: "old", branchNamespace: "ryph/ada/r-7" },
    ])
  }' WHERE "id" = 't-3'`,
  `UPDATE "runs" SET "work_item" = jsonb_set("work_item", '{repos}', '${
    JSON.stringify([
      { ...ENTRY, path: "a", branchName: "ryph/ada/r-9" },
      { ...ENTRY, path: "b", branchNamespace: "ryph/ada/r-9" },
    ])
  }') WHERE "id" = 'r-9'`,
];

test("every migration applies over tables that already hold rows, and they build the schema", async () => {
  const handle = await makeDb("pglite:memory://");
  try {
    const all = await migrations();
    assertEquals(all.length >= 8, true);
    for (const migration of all) {
      for (const statement of migration.statements) {
        await handle.db.execute(sql.raw(statement));
      }
      if (migration.tag === "0004_lowly_meltdown") {
        for (const seed of BEFORE_WORKSPACES) await handle.db.execute(sql.raw(seed));
      }
      if (migration.tag === "0014_fancy_slayback") {
        for (const seed of BEFORE_FORGE) await handle.db.execute(sql.raw(seed));
      }
      if (migration.tag === "0016_futuristic_colleen_wing") {
        for (const seed of BEFORE_RADICLE_URL) await handle.db.execute(sql.raw(seed));
      }
      if (migration.tag === "0022_run_launched_at") {
        for (const seed of BEFORE_TASK_LIST) await handle.db.execute(sql.raw(seed));
      }
      if (migration.tag === "0028_checks_by_time") {
        for (const seed of BEFORE_PUSH_REPORTS) await handle.db.execute(sql.raw(seed));
      }
      if (migration.tag === "0041_check_approvals") {
        for (const seed of BEFORE_LANDINGS) await handle.db.execute(sql.raw(seed));
      }
      if (migration.tag === "0043_merge_polls") {
        for (const seed of BEFORE_EVERY_RUN_CONVERSATIONAL) await handle.db.execute(sql.raw(seed));
      }
      if (migration.tag === "0056_light_harry_osborn") {
        for (const seed of BEFORE_RESPONSE_SLOTS) await handle.db.execute(sql.raw(seed));
      }
      if (migration.tag === "0058_response_slots") {
        for (const seed of BEFORE_LINES) await handle.db.execute(sql.raw(seed));
      }
    }

    // The task became a list of one; the change request it works on names its repo, and the
    // thread it names is text — GitHub's integers were one forge's spelling.
    const tasks = await handle.db.execute(
      sql`select "id", "repos", "workspace_id", "target_change_request" from "tasks" where "id" in ('t-1','t-2') order by "id"`,
    ) as unknown as { rows: Array<Record<string, unknown>> };
    assertEquals(tasks.rows, [
      {
        id: "t-1",
        repos: [{
          connectedRepoId: "cr-1",
          name: "acme/app",
          url: "https://github.com/acme/app.git",
          ref: "refs/heads/feat",
          path: "repo",
          branchNamespace: "ryph/ada/r-1",
          description: null,
        }],
        workspace_id: null,
        target_change_request: { connectedRepoId: "cr-1", thread: "7" },
      },
      {
        id: "t-2",
        repos: [{
          connectedRepoId: null,
          name: "https://example.com/raw.git",
          url: "https://example.com/raw.git",
          ref: "main",
          path: "repo",
          branchNamespace: "ryph/ada/r-2",
          description: null,
        }],
        workspace_id: null,
        target_change_request: null,
      },
    ]);

    // The runs' JSON moved with it: the work item lists its one repo (the gateway URL it was
    // given, under the path every old checkout used), and the result lists its branches —
    // one, naming the repo, or none. A queued run's work item is what its container will read.
    const runs = await handle.db.execute(
      sql`select "id", "work_item", "result" from "runs" where "id" in ('r-1','r-2','r-3') order by "id"`,
    ) as unknown as {
      rows: Array<{ id: string; work_item: Record<string, unknown>; result: unknown }>;
    };
    assertEquals(runs.rows.map((r) => r.id), ["r-1", "r-2", "r-3"]);
    for (const row of runs.rows) {
      assertEquals("repo" in row.work_item, false);
      assertEquals("branchName" in row.work_item, false);
      assertEquals(row.work_item.workspace, null);
      assertEquals(row.work_item.lifetime, DEFAULT_CLOCKS);
    }
    assertEquals(runs.rows[0].work_item.repos, [{
      connectedRepoId: "cr-1",
      name: "acme/app",
      url: "http://gw/v1/git/r-1/repo.git",
      ref: "refs/heads/feat",
      path: "repo",
      branchNamespace: "ryph/ada/r-1",
      description: null,
    }]);
    assertEquals(runs.rows[0].result, {
      status: "success",
      summary: "done",
      branches: [{
        connectedRepoId: "cr-1",
        path: "repo",
        name: "ryph/ada/r-1",
        headSha: "abc",
        commits: [{ sha: "abc", subject: "s" }],
        generation: 1,
      }],
    });
    assertEquals(runs.rows[1].result, {
      status: "failure",
      reason: "r",
      summary: "",
      branches: [],
    });
    assertEquals(
      (runs.rows[2].work_item.repos as Array<Record<string, unknown>>)[0],
      {
        connectedRepoId: null,
        name: "https://example.com/raw.git",
        url: "https://example.com/raw.git",
        ref: "main",
        path: "repo",
        branchNamespace: "ryph/ada/r-3",
        description: null,
      },
    );
    assertEquals(runs.rows[2].result, null);

    // The patch joined a set of its own, under the path every old checkout used — and, once
    // the incident-response migration (0007) ran, carries its branch's commits from the run's
    // result, so a pull request opened later still lists them.
    const patches = await handle.db.execute(
      sql`select "id", "set_id", "path", "generation", "base_sha", "commits" from "patches" where "id" = 'p-1'`,
    ) as unknown as { rows: unknown[] };
    assertEquals(patches.rows, [{
      id: "p-1",
      set_id: "p-1",
      path: "repo",
      generation: 1,
      base_sha: null,
      commits: [{ sha: "abc", subject: "s" }],
    }]);

    // The lifetime (0007, then 0044): every task and work item before it gets the default idle
    // clocks, a run's result names each branch's generation, and no run had been spoken to.
    // The forge seams (0014/0015): a connected repo names its provider and its address there,
    // and the identity that was GitHub's alone is now keyed by forge.
    const connected = await handle.db.execute(
      sql`select "id", "provider", "repo_ref", "installation_id", "url" from "connected_repos" order by "id"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(connected.rows, [
      {
        id: "cr-1",
        provider: "github",
        repo_ref: "acme/app",
        installation_id: "42",
        url: "https://github.com/acme/app.git",
      },
      {
        id: "cr-gh",
        provider: "github",
        repo_ref: "acme/other",
        installation_id: "42",
        // Untouched: 0017 repairs Radicle rows and only the empty ones.
        url: "https://github.com/acme/other.git",
      },
      {
        id: "cr-rad",
        provider: "radicle",
        repo_ref: "rad:z2oo6c5ceo8RPkRsxHBE2LBz7uHsC",
        installation_id: null,
        // 0017: the RID is the address, and an empty one refused every run on the repo.
        url: "rad:z2oo6c5ceo8RPkRsxHBE2LBz7uHsC",
      },
    ]);

    const lifetimes = await handle.db.execute(
      sql`select "id", "lifetime" from "tasks" where "id" in ('t-1','t-2','t-3') order by "id"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(lifetimes.rows, [
      { id: "t-1", lifetime: DEFAULT_CLOCKS },
      { id: "t-2", lifetime: DEFAULT_CLOCKS },
      // A conversational task keeps its clocks and loses its kind (0044).
      { id: "t-3", lifetime: { idleMs: 600_000, attendedIdleMs: 3_600_000 } },
    ]);
    const kept = await handle.db.execute(
      sql`select "work_item"->'lifetime' as "lifetime" from "runs" where "id" = 'r-6'`,
    ) as unknown as { rows: unknown[] };
    assertEquals(kept.rows, [{ lifetime: { idleMs: 600_000, attendedIdleMs: 3_600_000 } }]);
    const lived = await handle.db.execute(
      sql`select "id", "attended", "idle_deadline_at", "work_item"->'lifetime' as "lifetime", "result"->'branches'->0->'generation' as "generation" from "runs" where "id" in ('r-1','r-2','r-3') order by "id"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(lived.rows, [
      {
        id: "r-1",
        attended: false,
        idle_deadline_at: null,
        lifetime: DEFAULT_CLOCKS,
        generation: 1,
      },
      {
        id: "r-2",
        attended: false,
        idle_deadline_at: null,
        lifetime: DEFAULT_CLOCKS,
        generation: null,
      },
      {
        id: "r-3",
        attended: false,
        idle_deadline_at: null,
        lifetime: DEFAULT_CLOCKS,
        generation: null,
      },
    ]);

    // ---- the forge seams' BACKFILLS (0015), which no column comparison can catch ----------
    // A live run keeps its tools: every repo in its frozen grant names the forge it is on and
    // its address there, and the origin thread is a change request addressed by text.
    const scopes = await handle.db.execute(
      sql`select "id", "forge_scope", "origin_thread_kind", "origin_thread_ref" from "runs" where "id" in ('r-4','r-5') order by "id"`,
    ) as unknown as { rows: Array<Record<string, unknown>> };
    assertEquals(scopes.rows[0], {
      id: "r-4",
      forge_scope: {
        repos: [{
          connectedRepoId: "cr-1",
          provider: "github",
          repoRef: "acme/app",
          tenantId: "42",
        }],
        sourceRepos: [{
          connectedRepoId: "cr-1",
          provider: "github",
          repoRef: "acme/app",
          tenantId: "42",
        }],
        origin: { connectedRepoId: "cr-1", kind: "change_request", ref: "7" },
        capabilities: {},
      },
      origin_thread_kind: "change_request",
      origin_thread_ref: "7",
    });
    // The scalar was left exactly as it was rather than ending the statement — and with it,
    // the whole migration.
    assertEquals(scopes.rows[1].forge_scope, "not an object");

    // A forge follow-up in the inbox carries the same two renames; a platform sender is
    // untouched, because the rewrite is keyed on `kind`.
    const senders = await handle.db.execute(
      sql`select "id", "sender" from "run_messages" order by "id"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(senders.rows, [
      {
        id: "m-1",
        sender: { kind: "forge", login: "ada", repoRef: "acme/app", thread: "7" },
      },
      { id: "m-2", sender: { kind: "platform" } },
    ]);

    // Both integer thread ids became text, and `pull_request` became `change_request`.
    const progress = await handle.db.execute(
      sql`select "run_id", "thread_kind", "thread_ref" from "progress_comments"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(progress.rows, [
      { run_id: "r-4", thread_kind: "change_request", thread_ref: "7" },
    ]);

    const actions = await handle.db.execute(
      sql`select "id", "provider", "repo_ref", "thread_ref", "created_thread_ref" from "forge_tool_actions"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(actions.rows, [{
      id: "fa-1",
      provider: "github",
      repo_ref: "acme/app",
      thread_ref: "7",
      created_thread_ref: "78",
    }]);

    // ---- the task list's denormalized attempt (0023) --------------------------------------
    // Every task that already existed is backfilled from its NEWEST run, because a column the
    // list filters and sorts on cannot start out null on old rows. `t-4` is the one that proves
    // "newest" means the clock and not the id: its later run sorts FIRST by `created_at` and
    // LAST by id. `t-3` has no run at all — which should not happen — and settles as `lost`
    // rather than failing the migration and with it the whole deploy.
    const current = await handle.db.execute(
      sql`select "id", "current_run_id", "current_run_state", "current_run_phase", "last_activity_at" from "tasks" order by "id"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(current.rows, [
      // r-4 over r-1: same second, so the id breaks the tie, newest first.
      {
        id: "t-1",
        current_run_id: "r-4",
        current_run_state: "running",
        current_run_phase: null,
        last_activity_at: T,
      },
      {
        id: "t-2",
        current_run_id: "r-5",
        current_run_state: "running",
        current_run_phase: null,
        last_activity_at: T,
      },
      // No runs at all: `lost`, with `created_at` standing in for activity that never happened.
      {
        id: "t-3",
        current_run_id: "",
        current_run_state: "lost",
        current_run_phase: null,
        last_activity_at: T,
      },
      // r-6 over r-9: a LOWER id, but a later `created_at` — the clock decides.
      {
        id: "t-4",
        current_run_id: "r-6",
        current_run_state: "queued",
        current_run_phase: "setup",
        last_activity_at: T2,
      },
    ]);

    // Every forge row standing was a patch's (0030): it keeps its patch and its counters, gains an
    // id, and is told the base its checks are read at.
    const reports = await handle.db.execute(
      sql`select "id", "patch_id", "request_id", "checks_ref", "revision" from "check_forge_reports" order by "patch_id"`,
    ) as unknown as { rows: Array<Record<string, unknown>> };
    assertEquals(reports.rows.map(({ id: _id, ...row }) => row), [
      { patch_id: "p-1", request_id: null, checks_ref: "release", revision: 3 },
      { patch_id: "p-2", request_id: null, checks_ref: "main", revision: 0 },
    ]);
    for (const row of reports.rows) assertMatch(String(row.id), /^fr-[0-9a-f]{10}$/);
    assert(reports.rows[0].id !== reports.rows[1].id);

    // The landings (0042): a merge from before it was cued then, and is not owed a cue again —
    // nor a landing (0043), which the landing reconcile would otherwise make of it.
    const landings = await handle.db.execute(
      sql`select "id", "merged_cued_at", "landing_asked_at", "version" from "patches" where "id" in ('p-1','p-2') order by "id"`,
    ) as unknown as { rows: Array<Record<string, unknown>> };
    assertEquals(landings.rows, [
      {
        id: "p-1",
        merged_cued_at: "2026-01-02T00:00:00.000Z",
        landing_asked_at: "2026-01-02T00:00:00.000Z",
        version: 0,
      },
      { id: "p-2", merged_cued_at: null, landing_asked_at: null, version: 0 },
    ]);

    // Keyed correlation (0058): every response from before holds the automation-wide slot, ""
    // — which is what the door asks for under "automation" correlation, so the open one is still
    // joined — and says no title. The open one still holds its slot; another key has its own.
    const slots = await handle.db.execute(
      sql`select "id", "key", "title" from "responses" order by "id"`,
    ) as unknown as { rows: Array<Record<string, unknown>> };
    assertEquals(slots.rows, [
      { id: "resp-old", key: "", title: null },
      { id: "resp-open", key: "", title: null },
    ]);
    const open = (id: string, key: string) =>
      sql.raw(
        `INSERT INTO "responses" ("id","automation_id","task_id","run_id","state","key","opened_at","last_alert_at","last_activity_at")
        VALUES ('${id}','auto-1','t-1','r-1','open','${key}','${T}','${T}','${T}')`,
      );
    let taken = false;
    await handle.db.execute(open("resp-dup", "")).catch(() => (taken = true));
    assert(taken, "the automation-wide slot is still held by the open response");
    await handle.db.execute(open("resp-keyed", "grp-1"));

    // Patch lines (0059): a landing recorded per path became its path's default line's, and one
    // already per line stayed as it was — or `hasLanding` reads nothing, and the merged cue
    // waits forever.
    const lined = await handle.db.execute(
      sql`select "id", "landings" from "tasks" where "id" in ('t-1','t-2','t-3') order by "id"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(lined.rows, [
      { id: "t-1", landings: { repo: { work: LANDING } } },
      { id: "t-2", landings: { repo: { work: LANDING } } },
      { id: "t-3", landings: null },
    ]);

    // Patch lines (0059), too: every stored repo entry names the run's branch namespace under
    // its new key — or the forge grant names no branch the run may push — keeps its order, and
    // one already in the new shape is as it was.
    const renamed = await handle.db.execute(
      sql`select "id", "repos" from "tasks" where "id" = 't-3'`,
    ) as unknown as { rows: Array<{ repos: Array<Record<string, unknown>> }> };
    assertEquals(renamed.rows[0].repos, [
      { ...ENTRY, path: "a", branchNamespace: "ryph/ada/r-7" },
      { ...ENTRY, path: "b", branchNamespace: "ryph/ada/r-7" },
      { ...ENTRY, path: "c", branchNamespace: "ryph/ada/r-7" },
    ]);
    const items = await handle.db.execute(
      sql`select "id", "work_item" from "runs" where "id" in ('r-6','r-9') order by "id"`,
    ) as unknown as { rows: Array<{ work_item: { repos: unknown } }> };
    assertEquals(items.rows.map((r) => r.work_item.repos), [
      [],
      [
        { ...ENTRY, path: "a", branchNamespace: "ryph/ada/r-9" },
        { ...ENTRY, path: "b", branchNamespace: "ryph/ada/r-9" },
      ],
    ]);
    const left = await handle.db.execute(
      sql`select count(*)::int as "n" from "tasks", jsonb_array_elements("repos") as "e"
          where "e" ? 'branchName'`,
    ) as unknown as { rows: Array<{ n: number }> };
    assertEquals(left.rows[0].n, 0);

    // The final shape is the schema drizzle-kit would push: nothing left to add or drop. The
    // set is generated from two schemas sharing this database — this package's and
    // @ryph/auth's — so it is compared with both.
    const { statementsToExecute } = await pushSchema(
      { ...schema, ...authSchema },
      handle.db as never,
    );
    assertEquals(statementsToExecute, []);
  } finally {
    await handle.close();
  }
});
