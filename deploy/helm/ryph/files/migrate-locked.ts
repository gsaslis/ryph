// Runs one owner's schema migrations while holding a Postgres advisory lock on its database.
//
//   bun --no-env-file /ryph-migrate/locked.ts <URL variable> <command…>
//
// Each service with a database applies its owner's migrations in an init container before it
// starts (deploy/helm/ryph, README "Migrations"). drizzle-kit's migrator takes no lock of its own:
// it reads the newest applied migration, then applies what is newer in one transaction. Two pods
// starting together would both read the same row and both apply — a CREATE fails and rolls back,
// but an UPDATE-only data migration would run twice. So every runner first takes this one
// session-level lock on the owner's database and holds it until the command exits; the next pod
// then finds nothing new to apply. The lock is released with the connection, so a runner that dies
// mid-migration frees it.
//
// The lock lives exactly as long as its connection, so that connection must not be closed under
// it while the command runs: no idle timeout and no maximum lifetime, whatever the URL's query
// string says (`idle_timeout=30` is how the services size their pools, and postgres.js also ends
// every connection after 30–60 minutes by default). Explicit options win over the URL's. For the
// same reason the URL must reach Postgres directly: through a transaction-mode pooler (PgBouncer,
// a "pooled" Neon or Supabase URL) a session lock is taken on whichever server connection the
// pooler lent, and released or kept by chance.
//
// The server's own timeouts are turned off for the lock's session too (idle_session_timeout,
// statement_timeout, lock_timeout): a managed Postgres that sets one for every role would
// otherwise end the idle lock connection while a long migration runs on another. They are set with
// set_config once connected, not in the startup packet: a session-mode PgBouncer closes any
// connection whose startup packet carries a parameter it does not track ("unsupported startup
// parameter"), and a reconnect after that first query is fatal anyway, so the one session is all
// that needs them.
//
// If the lock's connection closes anyway while the command runs, the lock went with it, and
// postgres.js would quietly open a new session holding nothing for the next query, letting another
// pod start migrating alongside. So a close then (the driver's onclose, or a backend pid that
// changed under a periodic check) stops the command — SIGTERM, then SIGKILL after 10 seconds — and
// the runner fails, so the pod is retried. A close while still waiting for the lock fails at once
// too, rather than letting the driver reconnect behind the poll.
//
// Connecting gives up after RYPH_MIGRATE_CONNECT_TIMEOUT seconds (default 120; the chart leaves it
// unset): with several hosts in the URL and none reachable, postgres.js would cycle through them
// forever and the init container would sit there saying nothing.
//
// It waits for the lock by polling, never by blocking: a runner stuck behind a holder that never
// lets go says who that is (pid, client, since when) and gives up after RYPH_MIGRATE_LOCK_TIMEOUT
// seconds (default 600; the chart's `migrations.lockTimeoutSeconds`), so the pod fails visibly and
// Kubernetes retries it, rather than hanging in Init forever.
//
// The URL carries the password, and every way of picking it apart has leaked a piece of it once
// (a password with `/`, `?` or `#` in it moves the boundaries every parser draws), so nothing this
// wrapper prints is derived from the URL: the database is "the database in <variable>", and an
// error is named by its code (a SQLSTATE, `ECONNREFUSED`, `CONNECTION_CLOSED`) or its class name,
// never its message or the error object, which may quote the URL or the driver's options. The
// lock holder's pid, client and since-when come from pg_locks, not from the URL.
//
// `postgres` is resolved from the working directory (the owner's package in the image), the same
// driver and URL handling the image's own scripts use.
import { createRequire } from "node:module";

const [variable, ...command] = process.argv.slice(2);
const where = `the database in ${variable}`;

/** An error as a word: its code or class name, when it looks like one; never its message. */
function kind(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | null;
  for (const v of [e?.code, e?.name]) {
    if (typeof v === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(v)) return v;
  }
  return "error";
}

/** Prints one line naming the variable and the error's kind, then exits. */
function fail(what: string, err: unknown, status = 1): never {
  console.error(`migrations: ${what} (${where}: ${kind(err)})`);
  process.exit(status);
}

// Nothing escapes as an error object: Bun would print it, message and properties and all.
process.on("uncaughtException", (err) => fail("failed", err));
process.on("unhandledRejection", (err) => fail("failed", err));

async function main(): Promise<number> {
  const url = variable ? process.env[variable]?.trim() : undefined;
  if (!url || command.length === 0) {
    console.error("usage: locked.ts <URL variable> <command…> (and the variable set)");
    return 2;
  }
  if (url.startsWith("pglite:")) {
    // An embedded database is one process's own; there is nobody to race.
    return await run();
  }

  const timeoutSeconds = Number(process.env.RYPH_MIGRATE_LOCK_TIMEOUT ?? "600");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    console.error("RYPH_MIGRATE_LOCK_TIMEOUT must be a positive number of seconds");
    return 2;
  }
  const connectSeconds = Number(process.env.RYPH_MIGRATE_CONNECT_TIMEOUT ?? "120");
  // setTimeout fires at once past 2^31-1 ms, so a larger deadline would fail every connect.
  if (!Number.isFinite(connectSeconds) || connectSeconds <= 0 || connectSeconds > 2_147_483) {
    console.error(
      "RYPH_MIGRATE_CONNECT_TIMEOUT must be a positive number of seconds, at most 2147483",
    );
    return 2;
  }

  /** Called with an error code when the lock's connection closes; a no-op unless it is held. */
  let onLost: (code: string) => void = () => {};

  // oxlint-disable-next-line typescript/no-explicit-any -- postgres.js, resolved at run time
  let sql: any;
  try {
    const required = createRequire(`${process.cwd()}/`)("postgres");
    const postgres = required.default ?? required;
    sql = postgres(url, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: 0,
      connect_timeout: 30,
      connection: { application_name: "ryph-migrate" },
      onnotice: () => {},
      onclose: () => onLost("CONNECTION_CLOSED"),
    });
  } catch (err) {
    fail(`${variable} is not a URL the Postgres driver accepts`, err, 2);
  }

  /** Who holds the lock now, as a log line: pid, client and since when. */
  async function holder(): Promise<string> {
    try {
      // An advisory lock on a bigint key is filed as two 32-bit halves (classid high, objid low).
      const rows = await sql`
        SELECT l.pid, a.application_name, a.client_addr, a.backend_start, a.state
        FROM pg_locks l
        LEFT JOIN pg_stat_activity a ON a.pid = l.pid,
          (SELECT hashtextextended('ryph.migrations', 0) AS k) key
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.classid::bigint = ((key.k >> 32) & 4294967295)
          AND l.objid::bigint = (key.k & 4294967295)`;
      if (rows.length === 0) return "nobody (released just now)";
      const r = rows[0];
      return `pid ${r.pid} (${r.application_name || "?"} from ${r.client_addr ?? "local"}, ` +
        `connected ${r.backend_start?.toISOString?.() ?? r.backend_start}, ${r.state ?? "?"})`;
    } catch (err) {
      fail("lost the connection while waiting for the lock", err);
    }
  }

  try {
    // Session-level, on the one connection the lock lives on. The first query is also the first
    // connection, so it carries the connect deadline.
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sql`SELECT set_config('idle_session_timeout', '0', false),
          set_config('statement_timeout', '0', false), set_config('lock_timeout', '0', false)`,
        new Promise((_, reject) => {
          connectTimer = setTimeout(
            () => reject({ code: "CONNECT_TIMEOUT" }),
            connectSeconds * 1000,
          );
        }),
      ]);
    } catch (err) {
      fail("could not connect", err);
    } finally {
      clearTimeout(connectTimer);
    }
    // From here on a close is fatal. The driver would reconnect on the next poll by itself, and
    // against hosts that all refuse it retries forever, past every deadline, saying nothing.
    onLost = (code) => fail("lost the connection while waiting for the lock", { code });
    const deadline = Date.now() + timeoutSeconds * 1000;
    let nextReport = 0;
    let pid: number;
    for (;;) {
      let locked: boolean;
      try {
        // One key for every owner: an advisory lock is per database, and each owner has its own.
        [{ locked, pid }] = await sql`
          SELECT pg_try_advisory_lock(hashtextextended('ryph.migrations', 0)) AS locked,
            pg_backend_pid() AS pid`;
      } catch (err) {
        fail("lost the connection while waiting for the lock", err);
      }
      if (locked) break;
      if (Date.now() >= deadline) {
        console.error(
          `migrations: gave up after ${timeoutSeconds}s waiting for the lock on ${where}; ` +
            `held by ${await holder()}. The pod retries. Only if no migration is actually ` +
            "running (check pg_stat_activity for that pid's query), end it: " +
            "SELECT pg_terminate_backend(<pid>).",
        );
        return 1;
      }
      if (Date.now() >= nextReport) {
        console.log(`migrations: waiting for the lock on ${where}, held by ${await holder()}`);
        nextReport = Date.now() + 30_000;
      }
      await Bun.sleep(2000);
    }
    console.log(`migrations: lock held on ${where}, running ${command.join(" ")}`);
    return await runHolding(pid!);
  } finally {
    onLost = () => {};
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // Closing a connection that is already gone: the exit code already says what happened.
    }
  }

  /**
   * The command while the lock is held; its exit status. Stops it and fails if the lock's
   * connection closes first: the driver's onclose, or a backend pid that is no longer `lockPid`.
   */
  async function runHolding(lockPid: number): Promise<number> {
    let lost!: (code: string) => void;
    const lostCode = new Promise<string>((resolve) => (lost = resolve));
    onLost = lost;
    const check = setInterval(async () => {
      try {
        const [row] = await sql`SELECT pg_backend_pid() AS pid`;
        if (row?.pid !== lockPid) lost("BACKEND_CHANGED");
      } catch (err) {
        lost(kind(err));
      }
    }, 15_000);
    try {
      const child = spawn();
      const first = await Promise.race([
        child.exited.then((status) => ({ status })),
        lostCode.then((code) => ({ code })),
      ]);
      if ("status" in first) return first.status;
      console.error(`migrations: the lock's connection closed; stopping ${command[0]}`);
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await child.exited;
      clearTimeout(force);
      fail("lost the lock while the migration ran; the pod retries", { code: first.code });
    } finally {
      clearInterval(check);
      onLost = () => {};
    }
  }
}

function spawn() {
  try {
    return Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
  } catch (err) {
    fail(`could not run ${command[0]}`, err);
  }
}

/** The command, with the terminal; its exit status. */
async function run(): Promise<number> {
  return await spawn().exited;
}

main().then((code) => process.exit(code), (err) => fail("failed", err));
