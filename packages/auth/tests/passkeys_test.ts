// Passkeys end to end against a software authenticator: a real P-256 key signs real WebAuthn
// payloads, so the verifier's cryptography runs for real rather than being stubbed around.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeAuthService } from "../src/core/service.ts";
import { asOperator } from "./operator.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { authRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { fromBase64Url, toBase64Url } from "../src/helpers/base64url.ts";
import { memoryAuthStore } from "./memory_store.ts";

const ORIGIN = "https://ryph.example";
const RP_ID = "ryph.example";

// ---- a minimal CBOR encoder: exactly the shapes an attestation object and a COSE key need ----

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function cbor(value: Cbor): Uint8Array {
  const head = (major: number, n: number): number[] =>
    n < 24 ? [(major << 5) | n] : [(major << 5) | 24, n];
  if (typeof value === "number") {
    return new Uint8Array(value >= 0 ? head(0, value) : head(1, -value - 1));
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return new Uint8Array([...head(3, bytes.length), ...bytes]);
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array([...head(2, value.length), ...value]);
  }
  const parts: number[] = head(5, value.size);
  for (const [k, v] of value) parts.push(...cbor(k), ...cbor(v));
  return new Uint8Array(parts);
}

const bytesOf = (data: Uint8Array | string): Uint8Array<ArrayBuffer> => {
  const view = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const copy = new Uint8Array(new ArrayBuffer(view.length));
  copy.set(view);
  return copy;
};

const sha256 = async (data: Uint8Array | string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytesOf(data)));

/** WebCrypto signs P-256 as raw r||s; WebAuthn carries DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array): number[] => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const body = [...bytes.slice(i)];
    if (body[0] & 0x80) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

/** One authenticator holding one credential for `RP_ID`. */
async function softwareAuthenticator() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  let counter = 0;
  const rpIdHash = await sha256(RP_ID);
  const clientData = (type: string, challenge: string): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }),
    );

  return {
    id: toBase64Url(credentialId),
    register(challenge: string) {
      const coseKey = cbor(
        new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [
          -3,
          raw.slice(33),
        ]]),
      );
      const authData = new Uint8Array([
        ...rpIdHash,
        0x41, // user present, attested credential data
        0,
        0,
        0,
        0,
        ...new Uint8Array(16), // aaguid
        0,
        credentialId.length,
        ...credentialId,
        ...coseKey,
      ]);
      const attestation = cbor(
        new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]),
      );
      return {
        id: this.id,
        rawId: this.id,
        type: "public-key",
        response: {
          clientDataJSON: toBase64Url(clientData("webauthn.create", challenge)),
          attestationObject: toBase64Url(attestation),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    async assert(challenge: string, opts: { counter?: number } = {}) {
      counter = opts.counter ?? counter + 1;
      const authData = new Uint8Array([
        ...rpIdHash,
        0x01, // user present
        (counter >>> 24) & 0xff,
        (counter >>> 16) & 0xff,
        (counter >>> 8) & 0xff,
        counter & 0xff,
      ]);
      const client = clientData("webauthn.get", challenge);
      const signed = new Uint8Array([...authData, ...(await sha256(client))]);
      const signature = derSignature(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            keys.privateKey,
            bytesOf(signed),
          ),
        ),
      );
      return {
        id: this.id,
        rawId: this.id,
        type: "public-key",
        response: {
          clientDataJSON: toBase64Url(client),
          authenticatorData: toBase64Url(authData),
          signature: toBase64Url(signature),
          userHandle: null,
        },
        clientExtensionResults: {},
      };
    },
  };
}

async function build(appUrl: string | null = ORIGIN) {
  const store = memoryAuthStore();
  const service = await makeAuthService({ store, now: () => new Date(), appUrl });
  const verifier = verifierFromJwksSource(() => service.jwks());
  const routes = authRoutes({ service, verifier, now: () => new Date() });
  const handler = makeRouter(routes);
  return { handler: asOperator(handler, service), service, store };
}

const call = (
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) =>
  handler(
    new Request(`http://auth.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const ADA = { email: "ada@example.com", name: "Ada", password: "correct horse battery" };

async function admin(handler: (req: Request) => Promise<Response>) {
  await call(handler, "POST", "/v1/auth/users", ADA);
  return await (await call(handler, "POST", "/v1/auth/login", {
    email: ADA.email,
    password: ADA.password,
  })).json();
}

test("a passkey registers, signs in without an email, and trips on replay", async () => {
  const { handler, store } = await build();
  const ada = await admin(handler);
  const device = await softwareAuthenticator();

  const opts = await (await call(
    handler,
    "POST",
    "/v1/auth/passkeys/register/options",
    {},
    ada.accessToken,
  )).json();
  assertEquals(opts.options.rp.id, RP_ID);
  assertEquals(opts.options.authenticatorSelection.residentKey, "required");
  const registered = await call(handler, "POST", "/v1/auth/passkeys/register/verify", {
    challengeId: opts.challengeId,
    response: await device.register(opts.options.challenge),
    name: "MacBook",
  }, ada.accessToken);
  assertEquals(registered.status, 201);
  const passkey = await registered.json();
  assertEquals(passkey.id, device.id);
  assertEquals(passkey.name, "MacBook");
  assert(!("publicKey" in passkey));
  // A challenge answers once.
  assertEquals(
    (await call(handler, "POST", "/v1/auth/passkeys/register/verify", {
      challengeId: opts.challengeId,
      response: await device.register(opts.options.challenge),
      name: "again",
    }, ada.accessToken)).status,
    400,
  );

  // Sign in: no email typed, the authenticator names the account.
  const login = await (await call(handler, "POST", "/v1/auth/passkeys/login/options")).json();
  assertEquals(login.options.rpId, RP_ID);
  assertEquals(login.options.allowCredentials ?? [], []);
  const signedIn = await call(handler, "POST", "/v1/auth/passkeys/login/verify", {
    challengeId: login.challengeId,
    response: await device.assert(login.options.challenge),
  });
  assertEquals(signedIn.status, 200);
  const tokens = await signedIn.json();
  assertEquals(tokens.user.id, ada.user.id);
  const stored = (await store.getPasskeyById(device.id))!;
  assertEquals(stored.counter, 1);
  assert(stored.lastUsedAt !== null);

  // A cloned authenticator replaying an old counter is refused.
  const again = await (await call(handler, "POST", "/v1/auth/passkeys/login/options")).json();
  assertEquals(
    (await call(handler, "POST", "/v1/auth/passkeys/login/verify", {
      challengeId: again.challengeId,
      response: await device.assert(again.options.challenge, { counter: 1 }),
    })).status,
    401,
  );
  // And a signature for a different challenge is refused too.
  const other = await (await call(handler, "POST", "/v1/auth/passkeys/login/options")).json();
  assertEquals(
    (await call(handler, "POST", "/v1/auth/passkeys/login/verify", {
      challengeId: other.challengeId,
      response: await device.assert("not-the-challenge"),
    })).status,
    401,
  );
});

test("passkeys list, rename, and keep the last way in", async () => {
  const { handler, store } = await build();
  const ada = await admin(handler);
  const device = await softwareAuthenticator();
  const opts = await (await call(
    handler,
    "POST",
    "/v1/auth/passkeys/register/options",
    {},
    ada.accessToken,
  )).json();
  await call(handler, "POST", "/v1/auth/passkeys/register/verify", {
    challengeId: opts.challengeId,
    response: await device.register(opts.options.challenge),
    name: "MacBook",
  }, ada.accessToken);

  const listed = await (await call(handler, "GET", "/v1/auth/passkeys", undefined, ada.accessToken))
    .json();
  assertEquals(listed.passkeys.map((p: { name: string }) => p.name), ["MacBook"]);
  const renamed = await call(handler, "PATCH", `/v1/auth/passkeys/${device.id}`, {
    name: "Work laptop",
  }, ada.accessToken);
  assertEquals((await renamed.json()).name, "Work laptop");

  // With a password the passkey is not the only way in, so it goes; without one it stays.
  await store.saveUser({ ...(await store.getUserById(ada.user.id))!, passwordHash: null });
  assertEquals(
    (await call(handler, "DELETE", `/v1/auth/passkeys/${device.id}`, undefined, ada.accessToken))
      .status,
    409,
  );
  await store.saveUser({ ...(await store.getUserById(ada.user.id))!, passwordHash: "scrypt:x" });
  assertEquals(
    (await call(handler, "DELETE", `/v1/auth/passkeys/${device.id}`, undefined, ada.accessToken))
      .status,
    200,
  );
  assertEquals(
    (await call(handler, "DELETE", `/v1/auth/passkeys/${device.id}`, undefined, ada.accessToken))
      .status,
    404,
  );
});

test("without an app origin there is nothing to bind a passkey to", async () => {
  const { handler } = await build(null);
  const ada = await admin(handler);
  assertEquals(
    (await call(handler, "POST", "/v1/auth/passkeys/register/options", {}, ada.accessToken)).status,
    503,
  );
  assertEquals((await call(handler, "POST", "/v1/auth/passkeys/login/options")).status, 503);
});

test("base64url round-trips bytes", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
  assertEquals(fromBase64Url(toBase64Url(bytes)), bytes);
});

test("an unproven account may not register a passkey", async () => {
  const { handler, service, store } = await build();
  await admin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  await call(handler, "POST", "/v1/auth/users", { email: "bob@example.com", name: "Bob" });
  const bob = (await store.getUserByEmail("bob@example.com"))!;
  assertEquals(await service.passkeyRegistrationOptions(bob.id), {
    ok: false,
    error: "unverified",
  });
});

test("failed passkey assertions cannot lock a real one out", async () => {
  const { handler } = await build();
  const ada = await admin(handler);
  const device = await softwareAuthenticator();
  const opts = await (await call(
    handler,
    "POST",
    "/v1/auth/passkeys/register/options",
    {},
    ada.accessToken,
  )).json();
  await call(handler, "POST", "/v1/auth/passkeys/register/verify", {
    challengeId: opts.challengeId,
    response: await device.register(opts.options.challenge),
    name: "MacBook",
  }, ada.accessToken);

  // Every caller here is unvouched, so all of them share one address, as a run on Docker Desktop
  // shares the owner's loopback.
  for (let i = 0; i < 12; i++) {
    const login = await (await call(handler, "POST", "/v1/auth/passkeys/login/options")).json();
    const bad = await call(handler, "POST", "/v1/auth/passkeys/login/verify", {
      challengeId: login.challengeId,
      response: await device.assert("not-the-challenge"),
    });
    assertEquals(bad.status, 401);
  }
  const login = await (await call(handler, "POST", "/v1/auth/passkeys/login/options")).json();
  assertEquals(
    (await call(handler, "POST", "/v1/auth/passkeys/login/verify", {
      challengeId: login.challengeId,
      response: await device.assert(login.options.challenge),
    })).status,
    200,
  );
});
