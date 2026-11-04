// Opt-in fixture for sequential CRUD tests only. Migration, DDL, session-state and background
// work tests must use isolated databases instead. A lease's close leaves the suite's connection open.
import { afterAll, afterEach, describe, test as bunTest } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { is, type SQL, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { type DbHandle, openDbCluster } from "./open.ts";

export interface TestDbOptions<TSchema extends Record<string, unknown>> {
  open: () => Promise<DbHandle<TSchema>>;
  schema: TSchema;
  /** False preserves fresh-per-case semantics (for example a real-server migration path). */
  reuse?: boolean;
}

function resetStatement(schema: Record<string, unknown>): SQL {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const tables = Object.values(schema).filter((value) => is(value, PgTable)).map((table) => {
    const config = getTableConfig(table);
    return `${quote(config.schema ?? "public")}.${quote(config.name)}`;
  });
  if (tables.length === 0) throw new Error("Reusable database schema must contain tables");
  return sql.raw(`TRUNCATE TABLE ${[...new Set(tables)].join(", ")} RESTART IDENTITY CASCADE`);
}

function freshOnly(): never {
  throw new Error("Use makeTestDb() for migration, notification or session-lock tests");
}

/** Owns one database; each run gets a lease, and cannot overlap another run. */
export class ReusableTestDb<TSchema extends Record<string, unknown>> {
  #handle: DbHandle<TSchema> | undefined;
  #active = false;
  #closed = false;
  readonly #open: () => Promise<DbHandle<TSchema>>;
  readonly #reuse: boolean;
  readonly #truncate: SQL;

  constructor(options: TestDbOptions<TSchema>) {
    this.#open = options.open;
    this.#reuse = options.reuse ?? true;
    this.#truncate = resetStatement(options.schema);
  }

  async run(body: (getDb: () => Promise<DbHandle<TSchema>>) => Promise<void>): Promise<void> {
    if (this.#closed) throw new Error("Database fixture is closed");
    if (this.#active) throw new Error("Database fixture tests must not overlap");
    this.#active = true;
    let live = true;
    let lease: Promise<DbHandle<TSchema>> | undefined;
    const getDb = (): Promise<DbHandle<TSchema>> => {
      if (!live) return Promise.reject(new Error("Database lease has expired"));
      lease ??= (async () => {
        this.#handle ??= await this.#open();
        return {
          ...this.#handle,
          migrate: freshOnly,
          notify: freshOnly,
          listen: freshOnly,
          lockSession: freshOnly,
          close: () => Promise.resolve(),
        };
      })();
      return lease;
    };
    const errors: unknown[] = [];
    try {
      await body(getDb);
    } catch (error) {
      errors.push(error);
    } finally {
      live = false;
      try {
        // Even a callback that forgot to await getDb cannot outlive fixture cleanup.
        await lease;
        if (lease && this.#handle) {
          if (this.#reuse) {
            await this.#reset(this.#handle);
          } else {
            await this.#dispose();
          }
        }
      } catch (error) {
        // A rejected lease may be the same error the body already propagated.
        if (errors.length === 0 || error !== errors[0]) errors.push(error);
      } finally {
        this.#active = false;
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Test body and database cleanup failed");
    }
  }

  async #reset(handle: DbHandle<TSchema>): Promise<void> {
    try {
      await handle.db.execute(this.#truncate);
    } catch (error) {
      // Never hand a connection with failed cleanup to the next test.
      try {
        await this.#dispose();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Database reset and disposal failed");
      }
      throw error;
    }
  }

  async #dispose(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close();
  }

  async close(): Promise<void> {
    if (this.#active) throw new Error("Cannot close an active database fixture");
    this.#closed = true;
    await this.#dispose();
  }
}

/**
 * Registers a bun:test suite: each case a test named `<suite> > <case>`, run in order, on one
 * fixture that is closed after the file's last test whatever happened. Filter with
 * `bun test -t "<suite>"`; a case alone with `-t "<case>"`.
 * Database access is lazy, so memory-only cases don't open or reset a database.
 */
export function reusableDbSuite<TSchema extends Record<string, unknown>>(
  name: string,
  options: TestDbOptions<TSchema>,
): {
  test: (name: string, body: () => Promise<void>) => void;
  makeTestDb: () => Promise<DbHandle<TSchema>>;
} {
  let fixture: ReusableTestDb<TSchema> | undefined;
  let current: (() => Promise<DbHandle<TSchema>>) | undefined;
  // Registered where the suite is, at the top of its file: bun runs it after that file's tests.
  afterAll(async () => {
    await fixture?.close();
  });
  return {
    test: (caseName, body) => {
      // A describe per case, under one name, so the cases group as the suite's in the output.
      // bun runs a file's tests in order, so the cases never overlap on the fixture.
      describe(name, () => {
        bunTest(caseName, () =>
          (fixture ??= new ReusableTestDb(options)).run(async (getDb) => {
            current = getDb;
            try {
              await body();
            } finally {
              current = undefined;
            }
          }));
      });
    },
    makeTestDb: () => {
      if (!current) throw new Error("Database requested outside a suite step");
      return current();
    },
  };
}

/** `adminUrl` with its database swapped for `name`, keeping the rest (the pool's query too). */
function databaseUrl(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.href;
}

/** Runs `body` on one connection to the server `adminUrl` names, and closes it. */
async function onAdmin<T>(adminUrl: string, body: (admin: postgres.Sql) => Promise<T>): Promise<T> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    return await body(admin);
  } finally {
    await admin.end();
  }
}

/**
 * A database of its own on the real Postgres server `adminUrl` names (RYPH_TEST_POSTGRES_URL),
 * with `ddl` run in it, and a way to drop it. For what PGlite cannot show: it runs every query on
 * one session, so row locks between two transactions never meet there. `ddl` is the schema's
 * CREATE statements (drizzle-kit's `generateMigration` from nothing), since `pushSchema` cannot
 * run over postgres-js.
 */
export async function freshPostgresDb(
  adminUrl: string,
  ddl: readonly string[],
): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `ryph_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const drop = async () => {
    const end = postgres(adminUrl, { max: 1, onnotice: () => {} });
    try {
      await end.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await end.end();
    }
  };
  const setup = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    for (const statement of ddl) await setup.unsafe(statement);
  } catch (err) {
    // The caller never gets a handle to drop it with, so it goes here.
    await setup.end();
    await drop().catch(() => {});
    throw err;
  }
  await setup.end();
  return { url: url.href, drop };
}

/** One committed migration set: its folder and the bookkeeping table drizzle.config.ts names. */
export interface MigrationSet {
  folder: string;
  table: string;
}

/** The advisory lock namespaces (the first key of the two-key form) this file takes. */
const TEMPLATE_LOCKS = 0x72797401;
const OWNER_LOCKS = 0x72797402;

/** Each template this process has made sure of, by server and sets. */
const templates = new Map<string, Promise<string>>();

/**
 * The name of the template database holding `sets`, migrated in order: a hash of every file in
 * the sets and their tables, so an edited migration is a new template and an unchanged one is
 * shared by every process that asks, whichever package or check it is.
 */
async function templateName(sets: readonly MigrationSet[]): Promise<string> {
  const hash = createHash("sha256").update("ryph test template 1\0");
  for (const set of sets) {
    hash.update(`${set.table}\0`);
    const files = (await readdir(set.folder, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    for (const file of files) {
      hash.update(`${file.slice(set.folder.length)}\0`);
      hash.update(await readFile(file));
      hash.update("\0");
    }
  }
  return `ryph_tpl_${hash.digest("hex").slice(0, 24)}`;
}

/**
 * Makes sure the template exists on the server, building it if no one has. Every bun test worker
 * of every package and check sharing the server may ask at once, so the build runs under an
 * advisory lock keyed on the name, taken in the admin database (advisory locks are per database,
 * and every asker connects to the same one). The one holding it builds into `<name>_tmp` and
 * renames that into place once migrated, so the name only ever names a finished template: a
 * builder that died leaves only the `_tmp`, which the next builder drops. The rest wait on the
 * lock and find the template there.
 *
 * A template takes no connections (ALLOW_CONNECTIONS false), because CREATE DATABASE refuses to
 * copy a database anyone is connected to, and nothing should be: a clone is where tests write.
 */
async function ensureTemplate(adminUrl: string, sets: readonly MigrationSet[]): Promise<string> {
  const name = await templateName(sets);
  const building = `${name}_tmp`;
  const key = Number.parseInt(name.slice("ryph_tpl_".length, "ryph_tpl_".length + 7), 16);
  await onAdmin(adminUrl, async (admin) => {
    // One connection (`onAdmin`'s max 1), so the lock is this session's; ending it releases.
    await admin`SELECT pg_advisory_lock(${TEMPLATE_LOCKS}, ${key})`;
    const [found] = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (found) return;
    await admin.unsafe(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${building}`);
    const cluster = await openDbCluster(databaseUrl(adminUrl, building));
    try {
      for (const set of sets) await cluster.migrate(set.folder, set.table);
    } finally {
      await cluster.close();
    }
    await admin.unsafe(`ALTER DATABASE ${building} WITH ALLOW_CONNECTIONS false`);
    // Waits a moment for the migrator's backends to go, as CREATE DATABASE does.
    await admin.unsafe(`ALTER DATABASE ${building} RENAME TO ${name}`);
  });
  return name;
}

/** This process's owner token on each server, by admin URL. */
const owners = new Map<string, Promise<string>>();

/**
 * This process's token on the server: every clone it makes is named `ryph_clone_<token>_…`, and
 * it holds an advisory lock on the token for as long as it lives, on a connection kept open for
 * that alone. A clone a test never closed is left behind when its process ends (the server is
 * shared, and each one is a few MB of the service's disk), so taking the token first sweeps the
 * clones of every token whose lock is free, which is every process that has gone.
 */
function owner(adminUrl: string): Promise<string> {
  let token = owners.get(adminUrl);
  if (token === undefined) {
    token = (async () => {
      const id = crypto.getRandomValues(new Uint32Array(1))[0] >>> 4;
      // Never recycled, so the lock lasts the process; bun test exits with it still open.
      const held = postgres(adminUrl, { max: 1, max_lifetime: null, onnotice: () => {} });
      await held`SELECT pg_advisory_lock(${OWNER_LOCKS}, ${id})`;
      // A failed sweep frees the lock with its connection, so the next call starts clean.
      await onAdmin(adminUrl, async (admin) => {
        const names = await admin<{ datname: string }[]>`SELECT datname FROM pg_database
          WHERE datname ~ '^ryph_clone_[0-9a-f]{7}_[0-9a-f]{16}$'`;
        const byToken = Map.groupBy(names, (row) => row.datname.split("_")[2]);
        for (const [other, rows] of byToken) {
          const key = Number.parseInt(other, 16);
          if (key === id) continue;
          const [{ free }] = await admin<{ free: boolean }[]>`
            SELECT pg_try_advisory_lock(${OWNER_LOCKS}, ${key}) AS free`;
          if (!free) continue;
          try {
            for (const row of rows) {
              await admin.unsafe(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`);
            }
          } finally {
            await admin`SELECT pg_advisory_unlock(${OWNER_LOCKS}, ${key})`;
          }
        }
      }).catch(async (error) => {
        await held.end();
        throw error;
      });
      return id.toString(16).padStart(7, "0");
    })();
    token.catch(() => owners.delete(adminUrl));
    owners.set(adminUrl, token);
  }
  return token;
}

/**
 * A database of its own on the real Postgres server `adminUrl` names (RYPH_TEST_DB), already
 * migrated with `sets`, the template it was copied from, and a way to drop it. The sets are applied once per server, into a
 * template (see `ensureTemplate`), and each call copies it with CREATE DATABASE … TEMPLATE, which
 * takes a fraction of a migration run. The database `adminUrl` names is only connected to, to
 * create and drop the others, never written to.
 */
export async function cloneTestDb(
  adminUrl: string,
  sets: readonly MigrationSet[],
): Promise<{ url: string; template: string; drop(): Promise<void> }> {
  const key = JSON.stringify([adminUrl, sets]);
  let template = templates.get(key);
  if (template === undefined) {
    template = ensureTemplate(adminUrl, sets);
    // A failed build is asked again by the next test rather than failing every one after it.
    template.catch(() => templates.delete(key));
    templates.set(key, template);
  }
  const [name, token] = await Promise.all([template, owner(adminUrl)]);
  const clone = `ryph_clone_${token}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await onAdmin(adminUrl, (admin) => admin.unsafe(`CREATE DATABASE ${clone} TEMPLATE ${name}`));
  return {
    url: databaseUrl(adminUrl, clone),
    template: name,
    drop: async () => {
      await onAdmin(
        adminUrl,
        (admin) => admin.unsafe(`DROP DATABASE IF EXISTS ${clone} WITH (FORCE)`),
      );
    },
  };
}

/**
 * `open`, with every handle it gives a test closed after that test, for a file whose tests leave
 * theirs open. Call it at the file's top level, which is where the afterEach it registers belongs.
 * On PGlite an unclosed handle is only garbage; on a server it is a database left on the shared
 * service's disk until the process ends.
 */
export function closedAfterEach<A extends unknown[], H extends { close(): Promise<void> }>(
  open: (...args: A) => Promise<H>,
): (...args: A) => Promise<H> {
  const opened: H[] = [];
  afterEach(async () => {
    for (const handle of opened.splice(0)) await handle.close();
  });
  return async (...args) => {
    const handle = await open(...args);
    opened.push(handle);
    return handle;
  };
}

/**
 * `open` over a database of its own cloned from `sets` (`cloneTestDb`), whose `close` also drops
 * that database. The server path of a package's `makeTestDb`.
 */
export async function openClonedTestDb<H extends { close(): Promise<void> }>(
  adminUrl: string,
  sets: readonly MigrationSet[],
  open: (url: string) => Promise<H>,
): Promise<H> {
  const db = await cloneTestDb(adminUrl, sets);
  let handle: H;
  try {
    handle = await open(db.url);
  } catch (err) {
    await db.drop().catch(() => {});
    throw err;
  }
  let closed = false;
  return {
    ...handle,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await handle.close();
      } finally {
        await db.drop();
      }
    },
  };
}
