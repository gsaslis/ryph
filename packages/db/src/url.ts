// `RYPH_DB` and its per-service siblings are URLs, and this is the one place that reads them.
// Three forms, all of them real PostgreSQL 17:
//
//   pglite:./data/ryph     embedded, on disk       — Mode A's default; survives restarts
//   pglite:memory://       embedded, in memory     — tests and throwaway runs
//   postgres://…           a server                — Mode B, and Mode A against a real cluster
//
// Parsing lives apart from driver construction so a composition root can validate its
// configuration (and name the offending value in the failure) before paying to open anything.

/** A parsed database target. `kind` picks the driver; `pglite` carries where its data lives. */
export type DbTarget =
  | { kind: "pglite"; dataDir: string | null }
  | { kind: "postgres"; url: string };

export class DbUrlError extends Error {
  override readonly name = "DbUrlError";
}

const PGLITE_PREFIX = "pglite:";
/** PGlite's own spelling for an ephemeral database, kept verbatim so the URL is copy-pasteable. */
const PGLITE_MEMORY = "memory://";

/**
 * Reads a database URL into a driver choice. Throws `DbUrlError` naming the value on anything
 * unrecognised — silently defaulting a typo'd URL to an ephemeral database would look like data
 * loss, which is the one failure mode worth being loud about.
 */
export function parseDbUrl(url: string): DbTarget {
  const trimmed = url.trim();
  if (trimmed === "") throw new DbUrlError("database URL is empty");

  if (trimmed.startsWith(PGLITE_PREFIX)) {
    const rest = trimmed.slice(PGLITE_PREFIX.length);
    if (rest === PGLITE_MEMORY || rest === "memory:") return { kind: "pglite", dataDir: null };
    if (rest === "") {
      throw new DbUrlError(
        `${JSON.stringify(url)} names no data directory — use pglite:memory:// or pglite:<path>`,
      );
    }
    return { kind: "pglite", dataDir: rest };
  }

  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return { kind: "postgres", url: trimmed };
  }

  // The three retired spellings, each named so an old .env or deploy config says what to do
  // rather than failing as a generic parse error.
  if (trimmed === "memory") {
    throw new DbUrlError(
      'RYPH_DB="memory" is retired — use "pglite:memory://", which runs the real schema',
    );
  }
  if (trimmed === ":memory:" || trimmed.startsWith("file:")) {
    throw new DbUrlError(
      `${JSON.stringify(url)} is a SQLite URL, and SQLite is no longer supported — ` +
        "use pglite:<path>, pglite:memory://, or postgres://…",
    );
  }
  throw new DbUrlError(
    `${JSON.stringify(url)} is not a database URL — ` +
      "expected pglite:<path>, pglite:memory://, or postgres://…",
  );
}

/** Whether this target keeps nothing across a restart — the one thing a boot log should say. */
export function isEphemeral(target: DbTarget): boolean {
  return target.kind === "pglite" && target.dataDir === null;
}

/**
 * A target rendered for a log line or an error message, with any postgres password removed.
 * Never reuse this to reconnect: it is lossy on purpose.
 */
export function describeDbTarget(target: DbTarget): string {
  if (target.kind === "pglite") {
    return target.dataDir === null ? "pglite (in memory)" : `pglite ${target.dataDir}`;
  }
  try {
    const parsed = new URL(target.url);
    if (parsed.password !== "") parsed.password = "***";
    // A password may ride the query instead (postgres-js and libpq both read it there).
    if (parsed.searchParams.has("password")) parsed.searchParams.set("password", "***");
    return parsed.href;
  } catch {
    return "postgres (unparseable url)";
  }
}

/** How wide a postgres pool is and how long an idle connection in it lives, as a URL says. */
export type PoolOptions = { max?: number; idle_timeout?: number };

/**
 * The pool's shape from a postgres URL's query — `?max=4&idle_timeout=30`. postgres-js reads
 * these itself, but hands `max` on as the string it found, and `Array("4")` is one element long:
 * a pool the URL sizes comes out one connection wide whatever the number says. So the two are
 * read here and passed as numbers, and a deployment sizes its pools where it mints its URLs
 * (`max=2&idle_timeout=30` in the Helm chart's `postgres.params`, say). Anything unparseable is a `DbUrlError`: a pool that silently
 * fell back to the driver's ten would be exactly the overrun the option exists to prevent.
 */
export function poolOptions(url: string): PoolOptions {
  const query = new URL(url).searchParams;
  const opts: PoolOptions = {};
  for (const key of ["max", "idle_timeout"] as const) {
    const raw = query.get(key);
    if (raw === null) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < (key === "max" ? 1 : 0)) {
      throw new DbUrlError(
        `${key}=${JSON.stringify(raw)} in the database URL is not a valid ${key}`,
      );
    }
    opts[key] = n;
  }
  return opts;
}
