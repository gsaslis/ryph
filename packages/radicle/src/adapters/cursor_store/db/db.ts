// The bridge's database handle, in the two shapes a host can supply one: its own (the pod,
// where `RYPH_RADICLE_DB` names `ryph_radicle`) or a scope of a cluster somebody else opened.
//
// `url` is a ryph database URL: `pglite:<path>`, `pglite:memory://` or `postgres://…`.

import { type DbCluster, type DbHandle, openDb, type RyphDb } from "@ryph/db";
import * as schema from "./schema.ts";

export type RadicleDb = RyphDb<typeof schema>;
export type RadicleDbHandle = DbHandle<typeof schema>;

export function makeRadicleDb(url: string): Promise<RadicleDbHandle> {
  return openDb(url, schema);
}

/**
 * A handle over a connection SOMEONE ELSE owns. `close` is a no-op: the cluster owns the
 * connection. Use this, never a second `makeRadicleDb` on the same URL — two PGlite instances
 * pointed at one data directory both open, then silently stop seeing each other's writes.
 */
export function scopeRadicleDb(cluster: DbCluster): RadicleDbHandle {
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
