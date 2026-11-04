// The database handle: one drizzle handle over @ryph/db's driver factory, schema attached so
// the relational `db.query.*` API is available everywhere the handle travels.
//
// `url` is a ryph database URL, not a driver-specific one — `pglite:./data/ryph`,
// `pglite:memory://` or `postgres://…`. All three are real PostgreSQL 17, and the store adapters
// above this file are identical on every one of them.
//
// Schema lifecycle is drizzle-kit's job, not the handle's:
// - local dev + tests: `bun run db:push` (or `pushSchema` from drizzle-kit/api in tests)
//   applies the schema directly — fast iteration, no migration files
// - deployments: `bun run db:generate` produces SQL migrations from the schema, applied once
//   before the replicas roll rather than by each of them at boot

import { type DbCluster, type DbHandle, openDb, type RyphDb } from "@ryph/db";
import * as schema from "./schema.ts";

export type OrchestratorDb = RyphDb<typeof schema>;
export type OrchestratorDbHandle = DbHandle<typeof schema>;

export function makeDb(url: string): Promise<OrchestratorDbHandle> {
  return openDb(url, schema);
}

/**
 * A handle for these tables over a database connection SOMEONE ELSE owns — the single-process
 * deployment, where every module's tables share one instance. `close` is a no-op: the cluster
 * owns the connection, so closing the cluster closes this.
 *
 * Use this, never a second `makeDb` on the same URL. Two PGlite instances pointed at one data
 * directory BOTH open, then silently stop seeing each other's writes.
 */
export function scopeDb(cluster: DbCluster): OrchestratorDbHandle {
  return {
    db: cluster.scope(schema),
    description: cluster.description,
    // Migrations are the cluster owner's job, but a scoped handle can still ask for them.
    migrate: cluster.migrate,
    // Signals and locks belong to the CONNECTION, not to a schema, so a scope simply forwards
    // the cluster's. Two modules scoped off one cluster therefore share a channel namespace —
    // which is why the channel names are package-prefixed.
    notify: cluster.notify,
    listen: cluster.listen,
    lockSession: cluster.lockSession,
    close: () => Promise.resolve(),
  };
}
