// The auth database handle. Auth's tables live in the control plane's database in both modes
// (see schema.ts), so this is normally handed the same URL the orchestrator got.
//
// `url` is a ryph database URL: `pglite:<path>`, `pglite:memory://` or `postgres://…`.

import { type DbCluster, type DbHandle, openDb, type RyphDb } from "@ryph/db";
import * as schema from "./schema.ts";

export type AuthDb = RyphDb<typeof schema>;
export type AuthDbHandle = DbHandle<typeof schema>;

export function makeAuthDb(url: string): Promise<AuthDbHandle> {
  return openDb(url, schema);
}

/**
 * A handle for these tables over a database connection SOMEONE ELSE owns — the single-process
 * deployment, where every module's tables share one instance. `close` is a no-op: the cluster
 * owns the connection, so closing the cluster closes this.
 *
 * Use this, never a second `makeAuthDb` on the same URL. Two PGlite instances pointed at one data
 * directory BOTH open, then silently stop seeing each other's writes.
 */
export function scopeAuthDb(cluster: DbCluster): AuthDbHandle {
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
