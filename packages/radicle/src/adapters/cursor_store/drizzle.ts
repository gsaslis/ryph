// `CursorStore` on Postgres (or PGlite) through drizzle — the repo's db.query conventions.
//
// `set` is an upsert on the composite key rather than a read-then-write: two reconcile passes
// racing the same reference is ordinary, and the later write simply wins. There is nothing to
// lose by it — a cursor that goes backwards costs a replay of stable delivery ids.

import { and, eq } from "drizzle-orm";
import type { Cursor, CursorStore } from "../../ports/cursor_store.ts";
import type { RadicleDbHandle } from "./db/db.ts";
import { radicleCursors } from "./db/schema.ts";

export function drizzleCursorStore(handle: RadicleDbHandle): CursorStore {
  const { db } = handle;
  return {
    async get(rid, ref) {
      const row = await db.query.radicleCursors.findFirst({
        where: and(eq(radicleCursors.rid, rid), eq(radicleCursors.ref, ref)),
      });
      return row?.oid ?? null;
    },
    async set(rid, ref, oid) {
      await db.insert(radicleCursors)
        .values({ rid, ref, oid, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: [radicleCursors.rid, radicleCursors.ref],
          set: { oid, updatedAt: new Date().toISOString() },
        });
    },
    async listByRepo(rid): Promise<Cursor[]> {
      const rows = await db.query.radicleCursors.findMany({
        where: eq(radicleCursors.rid, rid),
      });
      return rows.map((r) => ({ rid: r.rid, ref: r.ref, oid: r.oid }));
    },
    async clearRepo(rid) {
      await db.delete(radicleCursors).where(eq(radicleCursors.rid, rid));
    },
    close: () => handle.close(),
  };
}
