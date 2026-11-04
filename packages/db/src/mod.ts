// @ryph/db — the database URL contract and driver construction, shared by every service that
// owns a store. A leaf package like @ryph/logger: it knows about drizzle and nothing about
// ryph, so depending on it couples no two services to each other.
//
// The point of it being shared is that the awkward parts are stated once — what a RYPH_DB URL
// may say, which driver each form means, the PGlite parent-directory rule that a fresh
// `pglite:./data/ryph` depends on, and above all `openDbCluster`, which is what keeps a
// single-process deployment from opening one PGlite data directory several times over.

export {
  type DataDirLock,
  DataDirLockedError,
  type DataDirLockHolder,
  lockDataDir,
} from "./datadir_lock.ts";
export {
  type DbCluster,
  type DbHandle,
  LOCK_QUERY_DEADLINE_MS,
  LOCK_SESSION_KEEPALIVE,
  type LockSession,
  type LockSessionOptions,
  openDb,
  openDbCluster,
  openDbClusterTarget,
  openDbTarget,
  rowsOf,
  type RyphDb,
  type Unlisten,
} from "./open.ts";
export {
  type DbTarget,
  DbUrlError,
  describeDbTarget,
  isEphemeral,
  parseDbUrl,
  type PoolOptions,
  poolOptions,
} from "./url.ts";
