// The gateway database handle. In the single process this is the same database as the
// orchestrator's; standalone, the gateway owns `ryph_mcp` and is the only reader of these tables.
//
// `url` is a ryph database URL: `pglite:<path>`, `pglite:memory://` or `postgres://…`.

import { type DbCluster, type DbHandle, openDb, type RyphDb } from "@ryph/db";
import * as schema from "./schema.ts";

export type McpGatewayDb = RyphDb<typeof schema>;
export type McpGatewayDbHandle = DbHandle<typeof schema>;

export function makeMcpGatewayDb(url: string): Promise<McpGatewayDbHandle> {
  return openDb(url, schema);
}

/**
 * A handle for these tables over a database connection SOMEONE ELSE owns — the single-process
 * deployment, where every module's tables share one instance. `close` is a no-op: the cluster
 * owns the connection, so closing the cluster closes this.
 *
 * Use this, never a second `makeMcpGatewayDb` on the same URL. Two PGlite instances pointed at
 * one data directory BOTH open, then silently stop seeing each other's writes.
 */
export function scopeMcpGatewayDb(cluster: DbCluster): McpGatewayDbHandle {
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
