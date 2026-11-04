// cloneTestDb against a real Postgres: a template built once however many processes ask at once,
// and a database of its own per call. Skipped unless RYPH_TEST_DB names a server this test may
// create and drop databases on, e.g. `postgres://postgres:pw@127.0.0.1:5432/postgres`.

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { cloneTestDb } from "../src/testing.ts";

const url = process.env.RYPH_TEST_DB;
const fixture = new URL("./fixture_migrations", import.meta.url).pathname;
const testing = new URL("../src/testing.ts", import.meta.url).pathname;

/** The fixture set under a table no other run has used, so its template is new on the server. */
const freshSet = () => ({
  folder: fixture,
  table: `__clone_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
});

test.skipIf(!url)("each clone is a migrated database of its own, gone once dropped", async () => {
  const set = freshSet();
  const [a, b] = await Promise.all([cloneTestDb(url!, [set]), cloneTestDb(url!, [set])]);
  const first = postgres(a.url, { max: 1, onnotice: () => {} });
  const second = postgres(b.url, { max: 1, onnotice: () => {} });
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  try {
    await first`INSERT INTO kv (k, v) VALUES ('a', '1')`;
    expect(await second`SELECT * FROM kv`).toHaveLength(0);
    const applied = await second.unsafe(`SELECT count(*)::int AS n FROM drizzle."${set.table}"`);
    expect(applied[0].n).toBe(1);
    await first.end();
    await a.drop();
    const left = await admin`SELECT datname FROM pg_database
      WHERE datname IN (${new URL(a.url).pathname.slice(1)}, ${new URL(b.url).pathname.slice(1)})`;
    expect(left.map((row) => row.datname)).toEqual([new URL(b.url).pathname.slice(1)]);
  } finally {
    await first.end();
    await second.end();
    await admin.end();
    await a.drop();
    await b.drop();
  }
});

test.skipIf(!url)("processes asking for one new template at once build it once", async () => {
  // A copy of the fixture under a path of its own, read by every process: the template's name is
  // the set's hash, so the same set from several processes races for the same template.
  const dir = await mkdtemp(join(tmpdir(), "ryph-clone-"));
  const folder = join(dir, "drizzle");
  await cp(fixture, folder, { recursive: true });
  const set = { ...freshSet(), folder };
  const script = `
    const { cloneTestDb } = await import(${JSON.stringify(testing)});
    const db = await cloneTestDb(process.env.RYPH_TEST_DB, [${JSON.stringify(set)}]);
    await db.drop();
    console.log(db.template);
    process.exit(0);
  `;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  try {
    const answers = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<{ code: number | null; out: string }>((resolve) => {
            let out = "";
            const child = spawn(process.execPath, ["-e", script], {
              stdio: ["ignore", "pipe", "inherit"],
            });
            child.stdout.on("data", (chunk) => out += chunk);
            child.on("error", () => resolve({ code: null, out }))
              .on("close", (code) => resolve({ code, out: out.trim() }));
          }),
      ),
    );
    expect(answers.map((a) => a.code)).toEqual([0, 0, 0, 0, 0, 0]);
    const names = new Set(answers.map((a) => a.out));
    expect(names.size).toBe(1);
    const [name] = names;
    const found = await admin`SELECT datname, datallowconn FROM pg_database
      WHERE datname IN (${name}, ${`${name}_tmp`})`;
    expect(found.map((row) => [row.datname, row.datallowconn])).toEqual([[name, false]]);
  } finally {
    await admin.end();
    await rm(dir, { recursive: true });
  }
});
