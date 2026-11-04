// The automations database handle, in the two shapes a host can supply one — the same
// contract as the mailroom's: open a connection of your own, or scope a cluster someone else
// owns, never both against one store.
//
// `url` is a ryph database URL: `pglite:<path>`, `pglite:memory://` or `postgres://…`.

import { type DbCluster, type DbHandle, openDb, type RyphDb } from "@ryph/db";
import * as schema from "./schema.ts";

export type AutomationsDb = RyphDb<typeof schema>;
export type AutomationsDbHandle = DbHandle<typeof schema>;

export function makeAutomationsDb(url: string): Promise<AutomationsDbHandle> {
  return openDb(url, schema);
}

/**
 * A handle for these tables over a database connection SOMEONE ELSE owns. `close` is a no-op:
 * the cluster owns the connection, so closing the cluster closes this.
 */
export function scopeAutomationsDb(cluster: DbCluster): AutomationsDbHandle {
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
