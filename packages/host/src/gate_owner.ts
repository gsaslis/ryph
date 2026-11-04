// The run gate's owner label (see the docker provisioner's `GateOptions.owner`): which deployment
// INSTANCE made a gate, so two deployments that share a gate name tell each other's apart.

import { parseDbUrl } from "@ryph/db";
import { EPHEMERAL_GATE_OWNER } from "@ryph/orchestrator";
import { resolve as resolvePath } from "@std/path";

const SOCKET = "unix-socket.invalid";

/**
 * The identity a database gives a deployment: what names the database itself, and nothing about
 * how this process happens to connect to it. A PGlite data directory, resolved, so one directory
 * is one owner however the binary was started; a Postgres database by scheme, host, port and
 * name, so a pool size, a password rotation or a timeout in the query string is not a new owner.
 * Null for an in-memory database, which is a new deployment every boot and has no identity to
 * keep.
 */
export function dbIdentity(dbUrl: string): string | null {
  const target = parseDbUrl(dbUrl);
  if (target.kind === "pglite") {
    return target.dataDir === null ? null : `pglite ${resolvePath(target.dataDir)}`;
  }
  // A unix-socket URL names its host in the query (`postgres://u@/db?host=/run/postgresql`), and
  // WHATWG URL refuses credentials with no host, so that one is read with a placeholder host.
  const url = URL.parse(target.url) ??
    new URL(target.url.replace(/^([a-z]+:\/\/[^/]*@)\//i, `$1${SOCKET}/`));
  const named = url.hostname.toLowerCase();
  const host = named === "" || named === SOCKET ? (url.searchParams.get("host") ?? "") : named;
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  return `postgres ${host} ${url.port || "5432"} ${database}`;
}

/** The owner label: `dbIdentity` hashed, or `EPHEMERAL_GATE_OWNER` when there is none. */
export async function gateOwner(dbUrl: string): Promise<string> {
  const identity = dbIdentity(dbUrl);
  if (identity === null) return EPHEMERAL_GATE_OWNER;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
