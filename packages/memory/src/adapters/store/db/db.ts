// The memory database handle — its own database when the service is standalone, a scope of the
// shared cluster under the single process (see schema.ts for why that difference is deliberate).
//
// `url` is a ryph database URL: `pglite:<path>`, `pglite:memory://` or `postgres://…`.

import { type DbCluster, type DbHandle, openDb, type RyphDb } from "@ryph/db";
import * as schema from "./schema.ts";

export type MemoryDb = RyphDb<typeof schema>;
export type MemoryDbHandle = DbHandle<typeof schema>;

export function makeMemoryDb(url: string): Promise<MemoryDbHandle> {
  return openDb(url, schema);
}

/**
 * A handle for these tables over a database connection SOMEONE ELSE owns — the single-process
 * deployment, where every module's tables share one instance. `close` is a no-op: the cluster
 * owns the connection, so closing the cluster closes this.
 *
 * Use this, never a second `makeMemoryDb` on the same URL: two PGlite instances pointed at one
 * data directory both open, then silently stop seeing each other's writes.
 */
export function scopeMemoryDb(cluster: DbCluster): MemoryDbHandle {
  return {
    db: cluster.scope(schema),
    description: cluster.description,
    migrate: cluster.migrate,
    notify: cluster.notify,
    listen: cluster.listen,
    lockSession: cluster.lockSession,
    close: () => Promise.resolve(),
  };
}
