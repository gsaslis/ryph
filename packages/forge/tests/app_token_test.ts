// App credentials: JWT minting verified against the real public key, both PEM encodings
// GitHub hands out, and the installation-token cache's reuse margin.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { serve } from "@ryph/service";
import { appTokenVendor, importAppKey, mintAppJwt } from "../src/helpers/app_token.ts";

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromB64url = (s: string): Uint8Array =>
  new Uint8Array(
    [...atob(s.replaceAll("-", "+").replaceAll("_", "/"))].map((c) => c.charCodeAt(0)),
  );

async function makeKeyPair() {
  return await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

function pem(label: string, der: Uint8Array): string {
  const lines = toB64(der).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/** Unwraps a PKCS#8 DER to its inner PKCS#1 bytes — so the PKCS#1 import path (what
 * GitHub's download button actually produces) is tested with a real key. */
function pkcs1FromPkcs8(pkcs8: Uint8Array): Uint8Array {
  // SEQUENCE hdr · INTEGER version (3 bytes) · AlgorithmIdentifier SEQUENCE · OCTET STRING.
  let i = 2 + (pkcs8[1] & 0x80 ? pkcs8[1] & 0x7f : 0); // past outer SEQUENCE header
  i += 3; // version INTEGER 0
  assert(pkcs8[i] === 0x30);
  i += 2 + pkcs8[i + 1]; // past AlgorithmIdentifier (short-form length, always here)
  assert(pkcs8[i] === 0x04);
  const lenByte = pkcs8[i + 1];
  let len: number, start: number;
  if (lenByte & 0x80) {
    const n = lenByte & 0x7f;
    len = 0;
    for (let j = 0; j < n; j++) len = (len << 8) | pkcs8[i + 2 + j];
    start = i + 2 + n;
  } else {
    len = lenByte;
    start = i + 2;
  }
  return pkcs8.slice(start, start + len);
}

test("a minted App JWT verifies against the public key and carries the claims", async () => {
  const pair = await makeKeyPair();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const key = await importAppKey(pem("PRIVATE KEY", pkcs8));

  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const jwt = await mintAppJwt("12345", key, nowMs);
  const [header, payload, signature] = jwt.split(".");

  assertEquals(JSON.parse(new TextDecoder().decode(fromB64url(header))), {
    alg: "RS256",
    typ: "JWT",
  });
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  assertEquals(claims.iss, "12345");
  assertEquals(claims.exp - claims.iat, 10 * 60); // -60s skew + 9min ahead

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    pair.publicKey,
    fromB64url(signature) as Uint8Array<ArrayBuffer>,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assert(valid, "the signature must verify against the public half");
});

test("GitHub's PKCS#1 PEM (and env-escaped newlines) import identically", async () => {
  const pair = await makeKeyPair();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pkcs1 = pkcs1FromPkcs8(pkcs8);

  const escaped = pem("RSA PRIVATE KEY", pkcs1).replaceAll("\n", "\\n");
  const key = await importAppKey(escaped);
  const jwt = await mintAppJwt("1", key, Date.now());
  const [h, p, s] = jwt.split(".");
  assert(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      fromB64url(s) as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(`${h}.${p}`),
    ),
  );
});

test("installation tokens are cached and refreshed inside the reuse margin", async () => {
  const pair = await makeKeyPair();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const key = await importAppKey(pem("PRIVATE KEY", pkcs8));

  let minted = 0;
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const url = new URL(req.url);
    if (req.method === "POST" && /\/app\/installations\/7\/access_tokens$/.test(url.pathname)) {
      minted++;
      return new Response(
        JSON.stringify({
          token: `ghs_token_${minted}`,
          expires_at: new Date(nowMs + 60 * 60 * 1000).toISOString(),
        }),
        { status: 201 },
      );
    }
    return new Response("{}", { status: 404 });
  });
  try {
    const vendor = appTokenVendor({
      appId: "1",
      key,
      apiBase: `http://127.0.0.1:${server.addr.port}`,
      diag: { debug() {} },
      now: () => nowMs,
    });
    assertEquals(await vendor.installationToken("7"), "ghs_token_1");
    assertEquals(await vendor.installationToken("7"), "ghs_token_1"); // cached
    nowMs += 45 * 60 * 1000; // 15 minutes of validity left — inside the 10-minute margin? no
    assertEquals(await vendor.installationToken("7"), "ghs_token_1"); // still >10min left
    nowMs += 6 * 60 * 1000; // now 9 minutes left — inside the margin, re-mint
    assertEquals(await vendor.installationToken("7"), "ghs_token_2");
    assertEquals(minted, 2);
  } finally {
    await server.shutdown();
  }
});

test("a mint against a GitHub that never answers fails within its budget", async () => {
  const pair = await makeKeyPair();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const key = await importAppKey(pem("PRIVATE KEY", pkcs8));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async () => {
    await gate;
    return new Response("{}", { status: 503 });
  });
  try {
    const vendor = appTokenVendor({
      appId: "1",
      key,
      apiBase: `http://127.0.0.1:${server.addr.port}`,
      diag: { debug() {} },
      timeoutMs: 200,
    });
    const started = performance.now();
    const err = await assertRejects(() => vendor.installationToken("7"), DOMException);
    assert(performance.now() - started < 5_000, "the mint gave up on its own");
    assertEquals(err.name, "TimeoutError");
  } finally {
    release();
    await server.shutdown();
  }
});
