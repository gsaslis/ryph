// A run grant: a short-lived, HMAC-signed statement that its holder may read one run's records
// on a service that cannot decide that for itself. The orchestrator is the one place that knows
// whose a task is and who holds write on its repos, so it mints the grant when it shows a run;
// the historian, the model proxy and the tool gateway verify it with the service credential they
// already share with the orchestrator, and never ask anyone. The grant names the run and the
// person it was minted for (`sub`), and dies within minutes: it answers "may THIS person read
// run X", and only alongside a verified bearer for that same person.

const encoder = new TextEncoder();

/** The query parameter a grant travels in: a query, because an EventSource can set no header. */
export const RUN_GRANT_PARAM = "grant";

/** How long a grant is good for. Long enough for a page and its stream, short enough to be moot. */
export const RUN_GRANT_TTL_MS = 10 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(text.length / 4) * 4,
      "=",
    );
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sign(key: string, payload: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payload));
  return base64url(new Uint8Array(signature));
}

/**
 * Mints a grant for one run and one subject, signed with the credential the verifying service
 * shares. `sub` is the user id the grant was shown to, or null when nobody signed in (auth off).
 *
 * @example
 * const grant = await mintRunGrant(historyToken, run.id, caller.userId, new Date(Date.now() + RUN_GRANT_TTL_MS));
 */
export async function mintRunGrant(
  key: string,
  runId: string,
  sub: string | null,
  expiresAt: Date,
): Promise<string> {
  const payload = base64url(
    encoder.encode(JSON.stringify({ run: runId, sub, exp: expiresAt.getTime() })),
  );
  return `${payload}.${await sign(key, payload)}`;
}

/**
 * Whether a grant was minted with `key` for this run AND this subject, and has not expired.
 * False for anything else, including a grant for another run or another person: the signature
 * is checked in constant time, and a malformed grant confirms nothing.
 *
 * @example
 * if (await verifyRunGrant(historyToken, runGrantOf(req), params.id, sub, new Date())) return null;
 */
export async function verifyRunGrant(
  key: string,
  grant: string | null,
  runId: string,
  sub: string | null,
  now: Date,
): Promise<boolean> {
  if (grant === null) return false;
  const cut = grant.indexOf(".");
  if (cut <= 0) return false;
  const payload = grant.slice(0, cut);
  const presented = grant.slice(cut + 1);
  const expected = await sign(key, payload);
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) return false;
  const bytes = fromBase64url(payload);
  if (bytes === null) return false;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
  if (typeof claims !== "object" || claims === null) return false;
  const { run, sub: granted, exp } = claims as { run?: unknown; sub?: unknown; exp?: unknown };
  // A grant minted before grants named a subject has no `sub` at all: that is not null, so it
  // matches nobody.
  return run === runId && granted === sub && typeof exp === "number" && exp > now.getTime();
}

/**
 * The grant a request carries, or null.
 *
 * @example
 * const grant = runGrantOf(req); // from `?grant=…`
 */
export function runGrantOf(req: Request): string | null {
  return new URL(req.url).searchParams.get(RUN_GRANT_PARAM);
}

/**
 * The capability a bearer must hold for a grant to count: the one every role reads its own
 * tasks with. A grant proves the run is in the caller's scope; this keeps a token narrowed to
 * something else (`checks:request`, say) from riding a grant its owner's session was shown.
 */
export const RUN_GRANT_CAPABILITY = "tasks:read";

/** The verified bearer behind a grant: its subject and its `caps` claim (`"*"` for an owner). */
export type RunGrantBearer = { sub: string; caps: readonly string[] };

/**
 * A per-run read gate in the shape route lists want: null to proceed, a Response to send. A
 * grant minted with `grantKey` for this run passes ONLY alongside a bearer `bearer` verifies,
 * and only when that bearer's subject is the one the grant was minted for and its caps hold
 * `tasks:read` — the grant is scope proof for one person, never identity proof, so a URL
 * holding one (logs, a proxied redirect, browser history, a copy-paste) is nothing without that
 * same verified person behind it. Without a grant at all, the fallback gate's call is the
 * capability that reads every run. With no key, only the fallback decides.
 *
 * @example
 * const authenticateRunRead = makeRunReadGate({
 *   grantKey: historyToken,
 *   bearer: makeGrantBearer(gateOpts),
 *   fallback: makeCapabilityGate(gateOpts, "tasks:read-all"),
 * });
 */
export function makeRunReadGate(opts: {
  grantKey: string | null;
  /** Any signed-in, verified bearer: its subject and caps, a Response to refuse, or null when
   * auth is off and nobody signs in (grants are then minted for, and verified against, null). */
  bearer(req: Request): Promise<Response | RunGrantBearer | null>;
  fallback(req: Request): Promise<Response | null>;
  now?(): Date;
}): (req: Request, runId: string) => Promise<Response | null> {
  const now = opts.now ?? (() => new Date());
  return async (req, runId) => {
    const grant = opts.grantKey === null ? null : runGrantOf(req);
    if (opts.grantKey === null || grant === null) return await opts.fallback(req);
    const bearer = await opts.bearer(req);
    if (bearer instanceof Response) return bearer;
    if (
      bearer !== null && !bearer.caps.includes("*") && !bearer.caps.includes(RUN_GRANT_CAPABILITY)
    ) {
      return await opts.fallback(req);
    }
    if (await verifyRunGrant(opts.grantKey, grant, runId, bearer?.sub ?? null, now())) return null;
    return await opts.fallback(req);
  };
}
