// A hosted server's way to the internet where the tool host confines it (docker: the launcher's
// internal tools network, whose only way out is an egress relay to the egress proxy's tool
// listener — packages/launcher/src/tools.ts). The parity it buys is Kubernetes's ryph-tools: the
// public internet, on any port, and nothing private.
//
// What this half does is mint the claim and spell the env that carries it; the egress proxy
// (images/egress-proxy/main.ts, `verifyToolToken`) verifies it, and the two cannot import each
// other, so the format is kept in step by hand and by tests/tool_egress_test.ts, which drives the
// proxy's own code.
//
//   t1.<b64url({"s": <container name>, "i": <issued, epoch s>})>.<b64url(HMAC-SHA256(key, "t1." + payload))>
//
// No host list and no expiry: the claim grants every public host, so a list would say nothing,
// and it is bound instead by its key — RYPH_EGRESS_TOOL_KEY, which only this gateway and the proxy
// hold and which is never a run's (the proxy refuses to start with one key for both). Where the
// key is minted per boot (the binary), every claim dies with the process that minted it, and boot
// relaunches every hosted server for a fresh one (core/hosting.ts). The subject is the container's
// name: the proxy's trail and its per-subject tunnel cap, never authorization.
//
// The claim rides the container's plain env (`HTTPS_PROXY=http://tool:<claim>@<relay>:7460`), not
// its secretEnv, because the launcher refuses proxy names as secrets (they would steer its own
// docker CLI). So `docker inspect` shows it, and so does the launching command line for a moment:
// what it is worth to whoever reads it is the public internet through the proxy, which a reader on
// the docker host already has.

/** The env names a hosted server's proxy is spelled with, and the ones near enough to steer a
 * client's proxy that a catalogue entry may not set them either (core/catalogue.ts). */
export const TOOL_PROXY_ENV_NAMES: ReadonlySet<string> = new Set([
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NODE_USE_ENV_PROXY",
]);

/** The user name a claim is presented under. The proxy reads the password; the name is narration. */
const PROXY_USER = "tool";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** A hosted server's egress claim, signed with the tool key. See the header for the format. */
export async function mintToolEgressClaim(
  key: Uint8Array,
  claim: { subject: string; issuedAt: number },
): Promise<string> {
  const payload = b64url(
    new TextEncoder().encode(JSON.stringify({ s: claim.subject, i: claim.issuedAt })),
  );
  const imported = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(`t1.${payload}`)),
  );
  return `t1.${payload}.${b64url(signature)}`;
}

/**
 * The env a hosted server finds its proxy in: every spelling of HTTPS_PROXY and HTTP_PROXY that
 * curl, Go, Python and Node read, loopback left out of it, and NODE_USE_ENV_PROXY so Node's own
 * fetch (24 and later) takes it too. A client that reads none of these — raw TCP, a JVM without
 * its flags — has no way out, which is the boundary rather than a bug. `proxy` is the relay's
 * origin as the tool host said it (`ToolHost.egressProxy`).
 */
export function toolProxyEnv(proxy: string, claim: string): Record<string, string> {
  const url = new URL(proxy);
  url.username = PROXY_USER;
  url.password = claim;
  const spelled = url.href.replace(/\/$/, "");
  return {
    HTTPS_PROXY: spelled,
    https_proxy: spelled,
    HTTP_PROXY: spelled,
    http_proxy: spelled,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
  };
}

/** A fresh tool key, for a process that mints and verifies alike (the binary) and keeps none. */
export function mintToolEgressKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** RYPH_EGRESS_TOOL_KEY as bytes, null unset; `fail` on a value that is not ≥ 32 hex characters. */
export function toolEgressKeyFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): Uint8Array | null {
  const hex = env("RYPH_EGRESS_TOOL_KEY")?.trim();
  if (hex === undefined || hex === "") return null;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0 || hex.length < 32) {
    // Never echoes the value.
    fail(
      "RYPH_EGRESS_TOOL_KEY must be at least 32 hex characters (the egress proxy holds the same)",
    );
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
