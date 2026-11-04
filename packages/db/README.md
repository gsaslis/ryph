# Database test fixtures

`@ryph/db/testing` is a separate, test-only entry point. Runtime imports of `@ryph/db` do not load
it. It does not import Drizzle Kit: each package supplies its own schema-initialized database
opener, keeping schema creation and migration policy local.

## Opt-in reusable store suites

```ts
import { reusableDbSuite } from "@ryph/db/testing";
import * as schema from "../src/adapters/store/db/schema.ts";
import { makeTestDb as open } from "./db.ts";

const { test, makeTestDb } = reusableDbSuite("my-package store", {
  open,
  schema,
  // Only when the package's opener supports this real-server override:
  reuse: !process.env.RYPH_TEST_DB,
});

test("stores a row", async () => {
  const handle = await makeTestDb();
  // Await all store work before returning.
  await handle.close(); // The suite, not the case, owns the physical connection.
});
```

A suite opens its database lazily and owns teardown in `finally`. Each database-using case resets
its schema's tables with `TRUNCATE ... RESTART IDENTITY CASCADE`, including after failure. Schema
and table names are quoted; aliases of a table are deduplicated. Memory-only cases do not open or
reset a database. A schema without tables is refused. Each suite owns a distinct fixture, with no
global connection or schema cache.

`ReusableTestDb` exposes the same lifecycle directly through `run(getDb => ...)` and `close()`.
It rejects overlapping runs and acquisitions after a case ends. Multiple acquisitions inside a
case return the same lease. Failed resets discard the database. Body and cleanup errors are both
preserved. `reuse: false` opens and closes a fresh database for every database-using case.

### Isolation boundaries

This is for sequential CRUD/store cases, **not** arbitrary SQL/session isolation. It resets rows
and owned sequences, not DDL, session settings, open transactions or outstanding background work.
The lease refuses migrations, notifications, subscriptions and session-lock APIs. Use a fresh
database for those tests, for multiple independent connections, and for migration/lifecycle tests.
Do not retain a lease beyond its case. Concurrent queries inside one case remain supported, and
store transactions remain real (cases are not wrapped in rollback transactions).

Only use the fixture on disposable test databases. The supplied schema must describe the
application tables whose state the cases use; cascading truncation can also clear referencing
tables. It is not a multi-tenant database reset mechanism.

### Running and filtering

Cases are bun:test tests named `<suite> > <case>`. `bun test -t "<suite>"` selects the whole
suite, `-t "<case>"` one case. A failed case does not stop later ones. The suite's database is
closed after the file's last test, pass or fail. For a single file, run `bun test <file>` from the
package directory.

Current adopters:

| Package | File | Suite name |
| --- | --- | --- |
| orchestrator | `tests/drizzle_store_test.ts` | `drizzle store` |
| auth | `tests/drizzle_store_test.ts` | `auth store` |
| chat | `tests/drizzle_store_test.ts` | `chat store` |
| memory | `tests/drizzle_store_test.ts` | `memory store` |
| historian | `tests/drizzle_store_test.ts` | `historian store` |
| mcp-gateway | `tests/drizzle_store_test.ts` | `mcp-gateway store` |
| webhooks | `tests/store_test.ts` | `webhooks store` |

These are explicit conversions, not a global replacement of package `makeTestDb()` helpers.
In particular, historian's PostgreSQL notification bus tests and model-proxy's session-lock store
suite remain isolated, as do migration tests. Packages can add a small local binding in
`tests/reusable_db.ts`, keeping their opener and optional real-server fallback unchanged.

## Databases on a real server

`cloneTestDb(adminUrl, sets)` gives a test a database of its own on the Postgres server `adminUrl`
names, already migrated with `sets` (each a migrations folder and its bookkeeping table). The sets
are applied once per server, into a template named for a hash of their files, and each call copies
the template with `CREATE DATABASE … TEMPLATE`. Every process sharing the server may ask at once:
the template is built under an advisory lock into `<name>_tmp` and renamed into place when done, so
a template name only ever names a finished one, and templates take no connections, which copying
needs. `openClonedTestDb(adminUrl, sets, open)` wraps a package's opener so that its handle's
`close` drops the copy too; it is the `RYPH_TEST_DB` path of each package's `makeTestDb()`. The
database `adminUrl` names is never written to.

Each process holds an advisory lock on a token of its own for as long as it lives, and names its
copies after it, so the first copy a process makes also drops those of every process that has gone:
a test that never closed its handle leaves its copy only until then. A test file whose tests leave
handles open wraps its opener in `closedAfterEach`, which closes them after each test.

`freshPostgresDb(adminUrl, ddl)` is the older, unmigrated form, for the lock tests under
`RYPH_TEST_POSTGRES_URL` that build their schema from drizzle-kit DDL.
