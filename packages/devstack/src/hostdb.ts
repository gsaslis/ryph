/**
 * The host's databases, resolved the way the host resolves them at boot: RYPH_DB and
 * RYPH_HISTORY_DB read from packages/host/.env, with the same defaults.
 *
 * These used to be SQLITE FILES. They are database URLs now (see @ryph/db), and all three
 * forms behave differently on disk:
 *
 *   pglite:<path>      a DIRECTORY holding a real PostgreSQL cluster
 *   pglite:memory://   nothing on disk at all
 *   postgres://…       somebody else's server; nothing here to inspect or delete
 *
 * Invariants:
 * - A relative path resolves against packages/host, the directory the host unit runs in.
 * - RYPH_HISTORY_DB unset is the Mode A default: the transcript shares the host's database
 *   rather than getting one of its own, so there is one store, not two.
 * - NOTHING HERE OPENS THE DATABASE. Two PGlite instances pointed at one data directory both
 *   succeed and then silently stop seeing each other's writes, so a `doctor` that connected to
 *   check the schema would corrupt the very stack it was inspecting.
 */

import { repoRoot } from "./stack.ts";
import { envOf } from "./wiring.ts";

const hostDir = `${repoRoot}/packages/host`;

export interface HostDatabase {
  /** The env var that declares this store. */
  key: string;
  /** The URL as configured, for messages. */
  url: string;
  /**
   * Where it lives on disk, or null when there is nothing local — an in-memory database, or a
   * server this checkout does not own.
   */
  dir: string | null;
}

const PGLITE = "pglite:";

/** Resolves one database URL to its on-disk directory, or null when it has none. */
function locate(key: string, url: string): HostDatabase {
  if (!url.startsWith(PGLITE)) return { key, url, dir: null };
  const rest = url.slice(PGLITE.length);
  if (rest === "memory://" || rest === "memory:" || rest === "") return { key, url, dir: null };
  // "./data/ryph" and "data/ryph" name the same directory; keeping the "./" would print
  // paths like packages/host/./data/ryph, which reads as a bug in the tool.
  const clean = rest.replace(/\/+$/, "").replace(/^\.\//, "");
  return { key, url, dir: clean.startsWith("/") ? clean : `${hostDir}/${clean}` };
}

/**
 * The stores the host will open. One entry unless RYPH_HISTORY_DB gives the transcript a
 * database of its own.
 */
export async function hostDatabases(): Promise<HostDatabase[]> {
  const host = await envOf("host");
  const stores = [
    locate("RYPH_DB", host.get("RYPH_DB") ?? "pglite:./data/ryph"),
  ];
  const history = host.get("RYPH_HISTORY_DB");
  if (history) stores.push(locate("RYPH_HISTORY_DB", history));
  return stores;
}
