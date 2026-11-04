// Driver construction: a database URL becomes a live drizzle handle. Every service's own
// `db/db.ts` is a three-line call into this, so the URL contract, the driver choice and the
// gotchas below are stated once instead of four times.
//
// Both drivers speak the same dialect (pg-core) and are wire-identical for everything the store
// adapters do — jsonb, onConflictDo*, db.query.*, db.transaction(), advisory locks, SKIP LOCKED
// and LISTEN/NOTIFY were all verified equivalent on PGlite and on a real Postgres 17. So the
// adapters above this line never learn which driver they got.
//
// The imports are dynamic so a process only pays for the driver it uses: a Mode B image never
// loads PGlite's ~20 MB of WASM, and a `pglite:` boot never constructs a connection pool. The
// specifiers are literal, so `bun build --compile` still statically bundles both — which is what Mode A
// wants, since it can be pointed at either.

import { mkdir } from "node:fs/promises";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { lockDataDir } from "./datadir_lock.ts";
import { type DbTarget, describeDbTarget, parseDbUrl, poolOptions } from "./url.ts";

/**
 * A drizzle handle over one of our schemas, with the driver erased. Both `drizzle-orm/pglite`
 * and `drizzle-orm/postgres-js` widen to this, including the relational `db.query.*` API, so a
 * store adapter takes this type and works unchanged on either.
 */
export type RyphDb<TSchema extends Record<string, unknown>> = PgDatabase<
  PgQueryResultHKT,
  TSchema,
  ExtractTablesWithRelations<TSchema>
>;

/**
 * The rows of a raw `db.execute(sql\`…\`)`, whichever driver answered. The two drivers disagree
 * on the shape: PGlite answers `{ rows, … }`, postgres-js answers the row array itself (a
 * `RowList`, an array with extra fields hung on it). A store that reads `.rows` off the result
 * works under every test — they run on PGlite — and throws on the first raw query against a
 * real server, which is exactly how the run inbox failed on GKE. Every raw read goes through
 * here, so the difference is stated once.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  if (Array.isArray(rows)) return rows as T[];
  throw new Error("a raw query answered neither an array nor { rows }");
}

/** A live handle plus the way to give it back. `close` is idempotent. */
export interface DbHandle<TSchema extends Record<string, unknown>> {
  db: RyphDb<TSchema>;
  /** What was opened, password-redacted — for the boot log. Never reuse it to reconnect. */
  description: string;
  /** As `DbCluster.migrate`. */
  migrate: (migrationsFolder: string, migrationsTable?: string) => Promise<void>;
  /** As `DbCluster.notify`. */
  notify: (channel: string, payload: string) => Promise<void>;
  /** As `DbCluster.listen`. */
  listen: (channel: string, onNotify: (payload: string) => void) => Promise<Unlisten>;
  /** As `DbCluster.lockSession`. */
  lockSession: (options?: LockSessionOptions) => Promise<LockSession>;
  close: () => Promise<void>;
}

/** Stops one subscription. Idempotent. */
export type Unlisten = () => Promise<void>;

/**
 * A database session pinned to ONE connection, for advisory locks.
 *
 * The pinning is the whole point and not a detail: `pg_try_advisory_lock` is session-scoped, so
 * taking it on a pooled handle and releasing it on the next query hands the unlock to whichever
 * connection the pool happened to pick. That fails silently — the unlock returns false and the
 * lock stays held until the connection dies, which is a stuck leader nobody gets an error about.
 *
 * Hold one of these for the life of the process and take the lock per tick; do not open one per
 * tick, since each is a real connection.
 *
 * A plain session is pinned to one pooled connection for good and never gives it up on its own,
 * so a slow answer about one key costs no other key it holds. A leader that keeps one key across
 * ticks and must hear "no" in time opens a self-healing one instead (`LockSessionOptions`).
 *
 * A KEY IS A POSITIVE 32-BIT NUMBER, 0 to 4294967295. Postgres takes a 64-bit advisory key but
 * files it as two halves, and `pg_locks` only reports them apart; keeping to the low half is what
 * lets `held` ask about one key exactly, so a key outside the range is refused rather than
 * silently answered about the wrong lock.
 */
/** Refuses a key outside the range `held` can ask about, naming what was given. */
function checkKey(key: number): void {
  if (!Number.isInteger(key) || key < 0 || key > MAX_LOCK_KEY) {
    throw new RangeError(
      `lock key must be an integer from 0 to ${MAX_LOCK_KEY}; got ${key}`,
    );
  }
}

/** How long one query on a self-healing session (`LockSessionOptions.selfHealing`) may take
 * before the session gives its connection up. The queries are instant (`pg_try_advisory_lock`
 * never waits), so a slower answer means the connection is gone — a partition announces nothing,
 * and a dead socket left alone never answers. A caller asking "am I still the leader?" must get
 * its "no" in time to act on it. */
export const LOCK_QUERY_DEADLINE_MS = 3_000;

/** How long past LOCK_QUERY_DEADLINE_MS a self-healing session still looks for its answer. The
 * deadline is a timer, and a timer that fires after the event loop was held (a big parse, a GC
 * pause) fires before the socket the answer has long since reached is read: the grace is a later
 * turn of the loop, which reads it first. Without it a held loop alone gave the connection up. */
export const LOCK_QUERY_GRACE_MS = 100;

/** Server-side TCP keepalive on a self-healing session's connection, set on that backend alone
 * once it connects. Not as startup parameters, which a session-mode PgBouncer refuses (it takes
 * only a handful it knows and closes the connection on any other), so the leader's session would
 * never connect there. Behind a pooler they apply to the pooler's socket to the server, which is
 * the one whose backend holds the locks. A partitioned client gives its socket up, but nothing
 * reaches the backend on the far side, which sits idle holding the locks until the server's
 * kernel notices the peer is gone — after the server default, measured at 7200 s, i.e. two hours
 * in which no replica could take over. With these it notices in about 25 s (10 s idle, then three
 * probes 5 s apart), and `tcp_user_timeout` bounds the same for a reply stuck unacknowledged
 * (Linux; other servers ignore it). The session's own reconnect ends the old backend sooner
 * whenever this process gets back first (`LockSessionOptions.selfHealing`). */
export const LOCK_SESSION_KEEPALIVE = {
  tcp_keepalives_idle: "10",
  tcp_keepalives_interval: "5",
  tcp_keepalives_count: "3",
  tcp_user_timeout: "25000",
} as const;

/** How to open a `LockSession`. */
export interface LockSessionOptions {
  /**
   * A session that answers every call within LOCK_QUERY_DEADLINE_MS however its connection died
   * — `held` false, the others rejecting — and opens a fresh connection on the next call. For a
   * LEADER that holds ONE key across ticks and asks `held` before every piece of work: a delivery
   * loop that must hear "no longer the leader" in time, rather than wait for good on a dead
   * socket.
   *
   * Giving a connection up drops EVERY lock it held, so give such a session one key and nothing
   * else: a slow answer about one key costs all of them, and a caller that took a key and never
   * asks `held` again (a reaper's run, a per-room poll) would carry on beside the replica that
   * takes it next. Those keep a plain session, which never gives its connection up on its own.
   *
   * It also ends what it gave up. It notes each connection's backend, and the first call on the
   * next connection terminates the old one if it is still there — a partition leaves it idle
   * with the lock, and only this, or the server's TCP keepalive (LOCK_SESSION_KEEPALIVE), ends
   * it. Terminating needs the same database role, which every replica of a service has.
   *
   * No difference on PGlite, where nothing can drop.
   */
  selfHealing?: boolean;
}

/** The widest advisory key these sessions take: `pg_locks` files a 64-bit key as two halves and
 * reports them apart, so one that fits the low half is one `held` can ask about exactly. */
export const MAX_LOCK_KEY = 4_294_967_295;

export interface LockSession {
  /**
   * Takes `key` if it is free, and answers immediately either way — never waits. False means
   * another session in this database holds it, which is the "another replica is doing this
   * work" answer callers want.
   *
   * ON PGLITE THIS ALWAYS ANSWERS TRUE, and that is correct rather than a stub: a `pglite:`
   * database lives inside one process, so there is no second replica to lose the race to, and
   * Postgres advisory locks are re-entrant within a session anyway. Callers get "I am the
   * leader" on Mode A because on Mode A they are.
   */
  tryLock(key: number): Promise<boolean>;
  /**
   * Whether THIS session still holds `key`, asked of the database rather than remembered. A
   * caller that keeps a lock across ticks needs this: the locks are the connection's, so a
   * connection that drops — a restart, a failover, a proxy that timed it out — releases every one
   * of them server-side, and a caller going by what it once acquired would carry on believing it
   * is the leader while another replica takes over. False also means "this session is gone".
   *
   * Answers true on PGlite, for the same reason `tryLock` does.
   */
  held(key: number): Promise<boolean>;
  /** Releases `key`. Safe to call on a key this session does not hold. */
  unlock(key: number): Promise<void>;
  /** Returns the connection. Idempotent. */
  close(): Promise<void>;
}

/**
 * ONE database connection, shared by however many schemas a process mounts.
 *
 * This exists because opening the same database twice is not merely wasteful on PGlite, it is
 * WRONG: two PGlite instances pointed at one data directory both succeed, then silently fail to
 * see each other's writes — each runs its own Postgres over the same files, so writes interleave
 * and the last close wins. The single-process deployment mounts three schemas (control plane,
 * auth, model keys) against one URL, so it must open one client and scope it three times.
 *
 * On postgres:// the same shape is simply correct pooling: one pool, many schema views.
 */
export interface DbCluster {
  /** What was opened, password-redacted. */
  description: string;
  /**
   * A drizzle handle for `schema` over this cluster's one connection. Cheap — it is a typed
   * view, not a connection — so call it once per module that owns tables here.
   */
  scope<TSchema extends Record<string, unknown>>(schema: TSchema): RyphDb<TSchema>;
  /**
   * Applies the generated SQL migrations in `migrationsFolder`, recording them in the database
   * so it is idempotent — running it on every boot is the intended use.
   *
   * This is drizzle-orm's RUNTIME migrator, never drizzle-kit: drizzle-kit is a CLI that carries
   * esbuild, so it cannot ride inside a compiled binary. Which is the whole point — a downloaded
   * `ryph` provisions its own database on first launch with no toolchain present.
   *
   * `migrationsTable` names the bookkeeping table, in the `drizzle` schema. Give every set its own
   * when several share one database: the migrator runs only what is newer than the newest
   * timestamp in its table, so two sets in one table would silently skip each other's migrations.
   */
  migrate: (migrationsFolder: string, migrationsTable?: string) => Promise<void>;
  /**
   * Sends one `NOTIFY` on `channel`. The cross-replica signal: this is how a process tells its
   * peers that something they hold in memory has just gone stale.
   *
   * The payload is a POINTER, never the news itself — Postgres caps it at 8000 bytes and drops
   * the notification if a listener falls behind, so anything a receiver cannot afford to miss
   * must be read back from a table. Send a run id, not a transcript chunk.
   */
  notify: (channel: string, payload: string) => Promise<void>;
  /**
   * Subscribes to `channel` on a connection of its own, and returns the unsubscribe.
   *
   * `onNotify` must be total — it runs on the driver's socket callback, where a throw has
   * nowhere to go. Delivery is best-effort by nature: a notification sent while this process was
   * disconnected is simply gone, so treat every arrival as "go and look", never as the record.
   */
  listen: (channel: string, onNotify: (payload: string) => void) => Promise<Unlisten>;
  /** Opens a connection pinned for advisory locking. See `LockSession`, and
   * `LockSessionOptions.selfHealing` for the one kind of caller that wants more. */
  lockSession: (options?: LockSessionOptions) => Promise<LockSession>;
  /** Closes the underlying connection. Idempotent. Every scope dies with it. */
  close: () => Promise<void>;
}

/** Opens `url` as a cluster. Use this when a process mounts more than one schema. */
export async function openDbCluster(url: string): Promise<DbCluster> {
  return await openDbClusterTarget(parseDbUrl(url));
}

/** As `openDbCluster`, for a caller that already parsed (a root validating config early). */
export async function openDbClusterTarget(target: DbTarget): Promise<DbCluster> {
  const description = describeDbTarget(target);
  const { scope, migrate, notify, listen, lockSession, close } = target.kind === "pglite"
    ? await openPglite(target)
    : await openPostgres(target);
  let closed = false;
  return {
    description,
    scope,
    migrate,
    notify,
    listen,
    lockSession,
    close: async () => {
      if (closed) return;
      closed = true;
      await close();
    },
  };
}

/**
 * Opens `url` for a single schema — the standalone-service case, where the process owns exactly
 * one database. A process mounting several schemas wants `openDbCluster` instead; see there for
 * why opening twice is a correctness problem and not just a cost.
 */
export async function openDb<TSchema extends Record<string, unknown>>(
  url: string,
  schema: TSchema,
): Promise<DbHandle<TSchema>> {
  const cluster = await openDbCluster(url);
  return {
    db: cluster.scope(schema),
    description: cluster.description,
    migrate: cluster.migrate,
    notify: cluster.notify,
    listen: cluster.listen,
    lockSession: cluster.lockSession,
    close: cluster.close,
  };
}

/** As `openDb`, for a caller that already parsed. */
export async function openDbTarget<TSchema extends Record<string, unknown>>(
  target: DbTarget,
  schema: TSchema,
): Promise<DbHandle<TSchema>> {
  const cluster = await openDbClusterTarget(target);
  return {
    db: cluster.scope(schema),
    description: cluster.description,
    migrate: cluster.migrate,
    notify: cluster.notify,
    listen: cluster.listen,
    lockSession: cluster.lockSession,
    close: cluster.close,
  };
}

interface DriverParts {
  scope: <TSchema extends Record<string, unknown>>(schema: TSchema) => RyphDb<TSchema>;
  migrate: (migrationsFolder: string, migrationsTable?: string) => Promise<void>;
  notify: (channel: string, payload: string) => Promise<void>;
  listen: (channel: string, onNotify: (payload: string) => void) => Promise<Unlisten>;
  lockSession: (options?: LockSessionOptions) => Promise<LockSession>;
  close: () => Promise<void>;
}

/**
 * On a `pglite:` path this LOCKS THE DATA DIRECTORY for the life of the handle, refusing one
 * another live process has open (`lockDataDir`): PGlite's own `postmaster.pid` never stops a
 * second opener, and two processes on one directory corrupt it.
 *
 * It also CREATES THE PARENT DIRECTORY first. PGlite makes only the leaf
 * directory of its data path and throws a bare `ENOENT … mkdir` if the parent is missing — which
 * is precisely `pglite:./data/ryph` on a machine that has never run ryph, i.e. the first
 * thing a downloaded binary does. Creating it here is what makes that URL work as a default.
 */
async function openPglite(target: Extract<DbTarget, { kind: "pglite" }>): Promise<DriverParts> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");

  if (target.dataDir !== null) await ensureParentDir(target.dataDir);
  const lock = target.dataDir === null ? null : await lockDataDir(target.dataDir);
  let client: InstanceType<typeof PGlite>;
  try {
    client = target.dataDir === null ? new PGlite() : new PGlite(target.dataDir);
  } catch (error) {
    await lock?.release();
    throw error;
  }
  return {
    notify: async (channel, payload) => {
      await client.query("SELECT pg_notify($1, $2)", [channel, payload]);
    },
    // PGlite delivers a NOTIFY to its own listeners, so publisher and subscriber inside one
    // process see each other exactly as two Postgres sessions would. There is nowhere else for
    // it to go: one process is the whole database.
    listen: async (channel, onNotify) => {
      const unlisten = await client.listen(channel, (payload) => {
        try {
          onNotify(payload);
        } catch {
          // The driver's socket callback has nowhere to put a throw.
        }
      });
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        await unlisten();
      };
    },
    // One connection is all there is, so every acquire succeeds — see `LockSession.tryLock` for
    // why that is the right answer here and not a stub.
    lockSession: () =>
      Promise.resolve({
        tryLock: async (key) => {
          checkKey(key);
          const res = await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock($1) AS locked",
            [key],
          );
          return res.rows[0]?.locked === true;
        },
        // Async, so a refused key rejects here exactly as it does on the other driver rather
        // than throwing where the caller is awaiting.
        held: async (key) => {
          checkKey(key);
          return await Promise.resolve(true);
        },
        unlock: async (key) => {
          await client.query("SELECT pg_advisory_unlock($1)", [key]);
        },
        close: () => Promise.resolve(),
      }),
    // Cast: the driver's own database type is narrower than the driver-erased handle we hand
    // out, and differs only in the branded result HKT the adapters never name.
    scope: (schema) => drizzle(client, { schema }) as unknown as RyphDb<typeof schema>,
    migrate: async (migrationsFolder, migrationsTable) => {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(drizzle(client) as never, { migrationsFolder, migrationsTable });
    },
    close: async () => {
      try {
        await client.close();
      } finally {
        await lock?.release();
      }
    },
  };
}

async function openPostgres(target: Extract<DbTarget, { kind: "postgres" }>): Promise<DriverParts> {
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");

  // The pool's shape rides on the URL; see `poolOptions` for why it is not left to the driver.
  // Server notices are dropped: postgres-js prints each to stdout by default, and the only ones
  // ryph causes are the migrator's "already exists, skipping", a screenful at every boot.
  const client = postgres(target.url, { ...poolOptions(target.url), onnotice: () => {} });
  return {
    notify: async (channel, payload) => {
      await client.notify(channel, payload);
    },
    // postgres-js gives LISTEN its own connection out of the pool and re-issues it on reconnect,
    // which is the behaviour we want: a listener that quietly stops receiving after a database
    // blip is worse than one that never started.
    listen: async (channel, onNotify) => {
      const meta = await client.listen(channel, (payload) => {
        try {
          onNotify(payload);
        } catch {
          // The driver's socket callback has nowhere to put a throw.
        }
      });
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        await meta.unlisten();
      };
    },
    // `reserve()` and not a pooled query: an advisory lock belongs to the SESSION that took it,
    // and a pooled unlock can land on a different connection, silently leaving the lock held.
    lockSession: async (options) => {
      if (options?.selfHealing) return selfHealingLockSession(postgres, target.url);
      const reserved = await client.reserve();
      let released = false;
      return {
        tryLock: async (key) => {
          checkKey(key);
          const rows = await reserved<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_lock(${key}) AS locked`;
          return rows[0]?.locked === true;
        },
        held: async (key) => {
          checkKey(key);
          // `pid = pg_backend_pid()` is what makes this OURS rather than anyone's: a lock the
          // database still lists against another session is not this caller's leadership. A
          // connection that has gone away cannot answer at all, which is the same "no".
          //
          // Postgres files a one-argument advisory key as `classid` (its high 32 bits), `objid`
          // (its low 32) and `objsubid` 1 — the two-argument form is `objsubid` 2 — so all three
          // are matched. `objid` alone would also match a key with the same low half.
          try {
            const rows = await reserved<{ held: boolean }[]>`
              SELECT EXISTS (
                SELECT 1 FROM pg_locks
                WHERE locktype = 'advisory'
                  AND classid = 0 AND objid = ${key} AND objsubid = 1
                  AND pid = pg_backend_pid()
              ) AS held`;
            return rows[0]?.held === true;
          } catch {
            return false;
          }
        },
        unlock: async (key) => {
          await reserved`SELECT pg_advisory_unlock(${key})`;
        },
        close: () => {
          if (released) return Promise.resolve();
          released = true;
          // Back to the pool, which drops every advisory lock the session still held.
          reserved.release();
          return Promise.resolve();
        },
      };
    },
    scope: (schema) => drizzle(client, { schema }) as unknown as RyphDb<typeof schema>,
    migrate: async (migrationsFolder, migrationsTable) => {
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      await migrate(drizzle(client) as never, { migrationsFolder, migrationsTable });
    },
    close: () => client.end(),
  };
}

type Postgres = typeof import("postgres");

/** A backend, named so that neither a reused pid nor a pooler's reuse is mistaken for it: the pid
 * with its start, in microseconds, as text — exact where a JS Date would round — and the
 * `application_name` the session gave it. */
interface Backend {
  pid: number;
  started: string;
  name: string;
}

/**
 * `LockSessionOptions.selfHealing`: a client of its own with one connection, opened again after
 * any call fails or misses its deadline.
 *
 * Not `reserve()`, which pinned a pool connection and was measured to hang for good once that
 * connection died (a restart, a failover, `pg_terminate_backend`): postgres-js hands the dead
 * connection back to its `closed` queue but leaves the reserved handle pointing at it, so every
 * later query neither resolved nor rejected — `held` with it, and the leader's whole delivery loop
 * behind it — while the driver threw an uncaught TypeError at the null socket. A one-connection
 * client reconnects on its next query like any pool does, and every call is raced against
 * LOCK_QUERY_DEADLINE_MS (plus LOCK_QUERY_GRACE_MS) besides, for the death no error announces.
 *
 * Exported for tests, which drive it with a fake driver and a shorter `deadlineMs`; callers open
 * one through `lockSession({ selfHealing: true })`.
 */
export function selfHealingLockSession(
  postgres: Postgres,
  url: string,
  deadlineMs = LOCK_QUERY_DEADLINE_MS,
): LockSession {
  // Every connection is introduced by the first call on it (see `introduce`), so one that closes is
  // given up, never reconnected: postgres-js would otherwise open the next on its own, unasked —
  // without the keepalive, and under the name of the backend that went.
  const open = (onclose: () => void) =>
    postgres(url, {
      max: 1,
      // Never idled or aged out: either would drop the locks this connection holds.
      idle_timeout: 0,
      max_lifetime: 0,
      connect_timeout: Math.ceil(LOCK_QUERY_DEADLINE_MS / 1000),
      // The client's own probes, for the same partition seen from this side.
      keep_alive: Number(LOCK_SESSION_KEEPALIVE.tcp_keepalives_idle),
      fetch_types: false,
      onnotice: () => {},
      onclose,
    });
  type Sql = ReturnType<typeof open>;
  interface Link {
    sql: Sql;
    /** Its backend, once the first call on it has asked. */
    backend: Backend | null;
    /** Given up: its connection closed, or a call on it failed. */
    gone: boolean;
    /** Settles when the last call queued on it has: the next one waits for it. */
    tail: Promise<unknown>;
  }
  let link: Link | null = null;
  let closed = false;
  // Backends of connections given up, until a later connection has ended them. A few at most: a
  // partition that outlasts several reconnects leaves the older ones to the server's keepalive.
  let orphans: Backend[] = [];

  // Again for the same link only records a backend named since, as when its connection closed
  // while `introduce` was asking.
  const giveUp = (gone: Link) => {
    if (link === gone) link = null;
    const backend = gone.backend;
    if (backend !== null && !orphans.includes(backend)) {
      orphans = [...orphans, backend].slice(-4);
    }
    if (gone.gone) return;
    gone.gone = true;
    // Not awaited: a partitioned socket may never finish closing, and the session must not wait
    // on it to answer.
    void gone.sql.end({ timeout: 0 }).catch(() => {});
  };

  const connect = (): Link => {
    const fresh: Link = {
      sql: undefined as never,
      backend: null,
      gone: false,
      tail: Promise.resolve(),
    };
    fresh.sql = open(() => giveUp(fresh));
    return fresh;
  };

  // The first call on a connection sets its keepalive, names and tags its backend and ends the
  // ones given up before it. A backend already gone, or replaced by another under its pid, matches
  // nothing; nor does one a session-mode pooler (PgBouncer) took back and lent to another client,
  // same pid and start: its DISCARD ALL reset the tag, a random one no other session carries.
  // One the server refuses to end (another role's), or a keepalive it refuses to set, is left
  // as it is rather than failing this connection.
  const introduce = async (fresh: Link) => {
    try {
      await fresh.sql`
        SELECT set_config('tcp_keepalives_idle', ${LOCK_SESSION_KEEPALIVE.tcp_keepalives_idle}, false),
          set_config('tcp_keepalives_interval', ${LOCK_SESSION_KEEPALIVE.tcp_keepalives_interval}, false),
          set_config('tcp_keepalives_count', ${LOCK_SESSION_KEEPALIVE.tcp_keepalives_count}, false),
          set_config('tcp_user_timeout', ${LOCK_SESSION_KEEPALIVE.tcp_user_timeout}, false)`;
    } catch (err) {
      if (!(err instanceof postgres.PostgresError)) throw err;
    }
    const name = `ryph-lock-${crypto.randomUUID()}`;
    const [me] = await fresh.sql<Omit<Backend, "name">[]>`
      SELECT set_config('application_name', ${name}, false),
        pid, (extract(epoch FROM backend_start) * 1000000)::bigint::text AS started
      FROM pg_stat_activity WHERE pid = pg_backend_pid()`;
    for (const orphan of orphans) {
      try {
        await fresh.sql`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE pid = ${orphan.pid}
            AND (extract(epoch FROM backend_start) * 1000000)::bigint::text = ${orphan.started}
            AND application_name = ${orphan.name}
            AND pid <> pg_backend_pid()`;
      } catch (err) {
        if (!(err instanceof postgres.PostgresError)) throw err;
      }
    }
    // Closed while asking: `me` may be a backend the driver opened behind it, and the orphans
    // still wait for a connection that will last.
    if (fresh.gone) throw new Error("lock connection closed");
    orphans = [];
    fresh.backend = me === undefined ? null : { pid: me.pid, started: me.started, name };
  };

  // One call at a time on a connection, each waiting for the one before it to settle or miss its
  // deadline. The driver queues what it cannot send yet in its pool, and a close with that queue
  // non-empty makes it dial again at once — before the give-up has ended the client, so the new
  // backend is never closed (postgres-js 3.4.9, `onclose`). One at a time, its queue stays empty,
  // a close fails only the call in flight, and only the first call introduces a connection.
  //
  // The deadline runs from the call, not from its turn: a caller's "no" comes in time however long
  // the call before it took. A call queued on a connection given up before its turn fails at its
  // turn, as it would have on that connection — the next call opens a fresh one.
  const run = async <T>(query: (sql: Sql) => Promise<T>): Promise<T> => {
    if (closed) throw new Error("lock session is closed");
    const current = link ??= connect();
    const turn = current.tail;
    let settled = false;
    let abandoned = false;
    const work = (async () => {
      await turn;
      if (closed) throw new Error("lock session is closed");
      if (current.gone || abandoned) throw new Error("lock connection closed");
      if (current.backend === null) await introduce(current);
      const answer = await query(current.sql);
      // Closed mid-call, the answer may have come from a backend the driver opened behind it.
      if (current.gone) throw new Error("lock connection closed");
      return answer;
    })().finally(() => {
      settled = true;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = Promise.race([
      work,
      new Promise<never>((_, reject) => {
        const fail = () => reject(new Error(`lock query timed out after ${deadlineMs}ms`));
        // A deadline timer fires on the first turn after a held loop, before the socket that
        // turn would read: look again a turn later, and an answer that came in time wins.
        timer = setTimeout(() => {
          timer = setTimeout(() => settled || fail(), LOCK_QUERY_GRACE_MS);
        }, deadlineMs);
      }),
    ]);
    // The next call goes once this one has an answer, or has given the connection up.
    current.tail = outcome.catch(() => {});
    try {
      return await outcome;
    } catch (err) {
      // Whatever failed, this connection's sessions are no longer known: give it up, so the next
      // call asks a fresh one instead of a socket that may never answer.
      abandoned = true;
      giveUp(current);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    tryLock: async (key) => {
      checkKey(key);
      const rows = await run((sql) =>
        sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${key}) AS locked`
      );
      return rows[0]?.locked === true;
    },
    held: async (key) => {
      checkKey(key);
      // As the plain session's `held`; one that does not answer by the deadline is the same "no".
      try {
        const rows = await run((sql) =>
          sql<{ held: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory'
                AND classid = 0 AND objid = ${key} AND objsubid = 1
                AND pid = pg_backend_pid()
            ) AS held`
        );
        return rows[0]?.held === true;
      } catch {
        return false;
      }
    },
    unlock: async (key) => {
      // No connection, no lock: one given up took its locks with it.
      if (link === null) return;
      await run((sql) => sql`SELECT pg_advisory_unlock(${key})`);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      const last = link;
      link = null;
      // Ends the connection, which drops every advisory lock the session still held.
      await last?.sql.end({ timeout: 5 });
    },
  };
}

/**
 * Creates the parent of a PGlite data directory. Deliberately not the directory itself: PGlite
 * initialises its own leaf, and pre-creating it can read as an already-initialised cluster.
 */
async function ensureParentDir(dataDir: string): Promise<void> {
  const normalized = dataDir.replace(/\/+$/, "");
  const cut = normalized.lastIndexOf("/");
  if (cut <= 0) return; // a bare name, or a path rooted at "/" — no parent to make
  await mkdir(normalized.slice(0, cut), { recursive: true });
}
