# Database tests

`makeTestDb()` in `db.ts` creates an isolated database. Keep using it for migrations, DDL,
connection/session behavior, notifications, and tests with background work or multiple databases.

`reusableDbSuite()` in `reusable_db.ts` binds the shared
[`@ryph/db/testing` fixture](../../db/README.md) to the orchestrator schema and opener. It is an
opt-in alternative for sequential CRUD/store tests. Within this package, only
`drizzle_store_test.ts` uses it:

```ts
const { test, makeTestDb } = reusableDbSuite("drizzle store");

test("stores a row", async () => {
  const handle = await makeTestDb();
  // Exercise the store. Await all work before returning.
  await handle.close(); // Releases no physical connection: the suite owns it.
});
```

The suite lazily opens one PGlite database, pushes the schema once, and truncates all application
schema tables with `RESTART IDENTITY CASCADE` after each database-using case, including failed
cases. Memory-only cases do not open or reset a database. A failed reset discards the connection.
The parent test closes the database in `finally`. Overlapping fixture runs and closing an active
fixture are refused. Multiple `makeTestDb()` calls within a case return the **same** lease, not
independent databases.

This resets rows and owned sequences, **not arbitrary SQL session state or schema changes**. The
lease refuses migrations, notifications, subscriptions and session locks through the handle API. Do
not change session settings, use raw DDL, leave transactions open, retain the handle beyond a case,
or start work that outlives the case. Use the isolated helper for those tests. The reusable fixture
deliberately does not wrap tests in transactions: store transaction/commit behavior must remain
real.

With `RYPH_TEST_DB=postgres://…` set, `db.ts` opens every database on that server instead: the
committed migration set is applied once, into a template database named for a hash of the set, and
each `makeTestDb()` copies it (`CREATE DATABASE … TEMPLATE`) and drops the copy on close. The
reusable suite then opens a fresh copy for every case and closes it after. The database the URL
names is only connected to, never written to, so any server will do, and every worker and package
can share one at once: the checks run this way, over the `db` service in `.ryph/services.yml`. A
test that leaves its handle open leaves its copy on the server until the process ends, when the next
process to start sweeps it; a file whose tests do that wraps its opener in `closedAfterEach`.

To run the suite that way locally, start a throwaway Postgres 18 (fsync off is fine) and point
`RYPH_TEST_DB` at its default database:

```bash
docker run -d --rm -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=pw postgres:18 -c fsync=off
RYPH_TEST_DB=postgres://postgres:pw@127.0.0.1:55432/postgres bun run test
```

## Running the pilot

These cases are tests under one `describe` (the suite's name), and the fixture closes in a
file-level `afterAll`. `-t` selects by name: `-t "drizzle store"` runs the whole suite, a case's own
name runs one. Each case has its own name, failure and duration in test output.

From `packages/orchestrator`: `bun test --no-env-file --timeout 60000 tests/drizzle_store_test.ts`
(the `test` script in [`package.json`](../package.json), with the file in place of `tests/`).

The initial local experiment on the same 48 cases measured 18.4s for fresh databases, 16.9s for
fresh databases with cached schema SQL, and 3.6s for reuse. A repeated original baseline took 17.6s.
These are single-file wall times, not a whole-CI speedup claim. Measure the orchestrator check and
the other checks' critical path before expanding this pattern to other suites.
