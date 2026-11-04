// The webhook module's database handle, in the two shapes a host can supply one. A host with no
// database of its own opens one — the forge process does, against RYPH_FORGE_DB. A host that
// already owns a cluster scopes that instead, never opening a second connection to the same store.
//
// `url` is a ryph database URL: `pglite:<path>`, `pglite:memory://` or `postgres://…`.

import { type DbCluster, type DbHandle, openDb, type RyphDb } from "@ryph/db";
import * as schema from "./schema.ts";

export type WebhooksDb = RyphDb<typeof schema>;
export type WebhooksDbHandle = DbHandle<typeof schema>;

export function makeWebhooksDb(url: string): Promise<WebhooksDbHandle> {
  return openDb(url, schema);
}

/**
 * A handle for these tables over a database connection SOMEONE ELSE owns. `close` is a no-op:
 * the cluster owns the connection, so closing the cluster closes this.
 *
 * Use this, never a second `makeWebhooksDb` on the same URL. Two PGlite instances pointed at
 * one data directory BOTH open, then silently stop seeing each other's writes.
 */
export function scopeWebhooksDb(cluster: DbCluster): WebhooksDbHandle {
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
