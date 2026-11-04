// The SSHSIG verifier, against signatures `ssh-keygen` really made.
//
// A hand-written fixture would prove only that the parser agrees with whoever wrote the
// fixture. Every signature below comes out of a throwaway ed25519 key generated in the test,
// signed by the same binary a person will run — which is the only thing that makes "the
// namespace is checked" and "the key is checked" claims about reality rather than about us.
//
// Without `ssh-keygen` on PATH the suite skips with a message rather than failing: it is on
// every developer machine and every CI image this repo runs on, but it is not ours.

import { test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { command } from "@ryph/process";
import { radicleChallengeProvider } from "../src/adapters/challenge_provider/radicle.ts";
import {
  base58Decode,
  parseSshSig,
  publicKeyFromDid,
  verifySshSig,
} from "../src/helpers/sshsig.ts";

// Not `-h`: that flag means "host key", and on its own it starts generating a key and asks for a
// filename on stdin, which hangs the whole run whenever stdin is an open pipe nobody writes to.
// `-?` is an unknown option everywhere and exits 1 after printing usage. stdin is closed anyway.
const HAVE_SSH_KEYGEN = await (async () => {
  try {
    const out = await command("ssh-keygen", {
      args: ["-?"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return out.code === 1;
  } catch {
    return false;
  }
})();

/** A throwaway key, its DID, and a signer for it. */
async function throwawayKey(dir: string) {
  const path = `${dir}/key`;
  const gen = await command("ssh-keygen", {
    args: ["-t", "ed25519", "-N", "", "-C", "ryph-test", "-f", path],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (gen.code !== 0) throw new Error(new TextDecoder().decode(gen.stderr));

  // The public half, as a DID: base58btc of 0xed 0x01 plus the raw 32 bytes, which is exactly
  // what Radicle prints for the same key.
  const pub = await readFile(`${path}.pub`, "utf8");
  const blob = Uint8Array.from(atob(pub.split(/\s+/)[1]), (c) => c.charCodeAt(0));
  // "ssh-ed25519" (4-byte length + 11 bytes), then a 4-byte length and the 32 key bytes.
  const raw = blob.slice(4 + 11 + 4);
  assertEquals(raw.length, 32);
  const did = `did:key:z${base58Encode(new Uint8Array([0xed, 0x01, ...raw]))}`;

  const sign = async (message: string, namespace: string) => {
    const proc = await command("ssh-keygen", {
      args: ["-Y", "sign", "-n", namespace, "-f", path, "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(message));
    await writer.close();
    const out = await proc.output();
    if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout);
  };
  return { path, did, sign };
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Only the test needs to ENCODE; the helper only ever decodes. */
function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leading = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    leading += "1";
  }
  return leading + digits.reverse().map((d) => BASE58[d]).join("");
}

async function withKey(body: (key: Awaited<ReturnType<typeof throwawayKey>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ryph-sshsig-"));
  try {
    await body(await throwawayKey(dir));
  } finally {
    await rm(dir, { recursive: true });
  }
}

test.skipIf(!HAVE_SSH_KEYGEN)(
  "a signature ssh-keygen made over the nonce, in our namespace, by the DID's key, verifies",
  async () => {
    await withKey(async (key) => {
      const nonce = "ryph-link-6f1a2b3c4d5e";
      const armored = await key.sign(nonce, "ryph");

      // The armor really is SSHSIG, and it names the key the DID encodes.
      const parsed = parseSshSig(armored);
      assertEquals(parsed.namespace, "ryph");
      assertEquals([...parsed.publicKey], [...publicKeyFromDid(key.did)]);

      assert(await verifySshSig(armored, { did: key.did, namespace: "ryph", message: nonce }));
    });
  },
);

test.skipIf(!HAVE_SSH_KEYGEN)(
  "a signature made in another namespace never verifies here",
  async () => {
    await withKey(async (key) => {
      const nonce = "ryph-link-6f1a2b3c4d5e";
      // What a person already has lying around: a signature made for git, or for file.
      const elsewhere = await key.sign(nonce, "git");
      assertFalse(
        await verifySshSig(elsewhere, { did: key.did, namespace: "ryph", message: nonce }),
      );
      // And the namespace is bound INTO the signed bytes, so it cannot be re-labelled: a
      // verification against the namespace it was really made in still passes.
      assert(await verifySshSig(elsewhere, { did: key.did, namespace: "git", message: nonce }));
    });
  },
);

test.skipIf(!HAVE_SSH_KEYGEN)(
  "a signature by another key proves nothing about this DID",
  async () => {
    const dirs = [await mkdtemp(join(tmpdir(), "ryph-")), await mkdtemp(join(tmpdir(), "ryph-"))];
    try {
      const [mine, theirs] = await Promise.all(dirs.map(throwawayKey));
      const nonce = "ryph-link-6f1a2b3c4d5e";
      const signed = await theirs.sign(nonce, "ryph");
      // Valid — by the wrong key. The armor's key is the signer's CLAIM, and it is compared
      // against the one the DID encodes before anything is verified.
      assert(await verifySshSig(signed, { did: theirs.did, namespace: "ryph", message: nonce }));
      assertFalse(await verifySshSig(signed, { did: mine.did, namespace: "ryph", message: nonce }));
    } finally {
      for (const dir of dirs) await rm(dir, { recursive: true });
    }
  },
);

test.skipIf(!HAVE_SSH_KEYGEN)(
  "a signature over a different nonce never verifies — which is what makes replay useless",
  async () => {
    await withKey(async (key) => {
      const armored = await key.sign("ryph-link-aaaa", "ryph");
      assertFalse(
        await verifySshSig(armored, {
          did: key.did,
          namespace: "ryph",
          message: "ryph-link-bbbb",
        }),
      );
    });
  },
);

test("anything that is not a signature is a refusal, never a throw", async () => {
  const did = "did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";
  for (
    const armored of [
      "",
      "not a signature",
      "-----BEGIN SSH SIGNATURE-----\nnot base64 ***\n-----END SSH SIGNATURE-----",
      // Well-formed base64 that is not SSHSIG.
      "-----BEGIN SSH SIGNATURE-----\naGVsbG8gd29ybGQ=\n-----END SSH SIGNATURE-----",
    ]
  ) {
    assertFalse(await verifySshSig(armored, { did, namespace: "ryph", message: "n" }));
  }
});

test("a DID that is not an ed25519 did:key is refused rather than half-read", () => {
  const good = "did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";
  assertEquals(publicKeyFromDid(good).length, 32);
  for (
    const bad of [
      "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme", // secp256k1
      "did:web:example.com",
      "did:key:aaaa",
      "did:key:z0O0l", // not base58 at all
    ]
  ) {
    let threw = false;
    try {
      publicKeyFromDid(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

test("base58 decoding round-trips the leading zeroes multibase depends on", () => {
  assertEquals([...base58Decode("1112")], [0, 0, 0, 1]);
  assertEquals([...base58Decode(base58Encode(new Uint8Array([0xed, 0x01, 0, 7])))], [
    0xed,
    0x01,
    0,
    7,
  ]);
});

// ---- the ChallengeProvider over it -------------------------------------------------------
//
// What auth actually holds: the line a person runs, and "who made this signature over the
// nonce I minted". Auth owns the nonce, spends it, and writes the row; everything Radicle-
// shaped is here.

test.skipIf(!HAVE_SSH_KEYGEN)(
  "the challenge provider answers a real signature with the DID, as both account and login",
  async () => {
    await withKey(async (key) => {
      const provider = radicleChallengeProvider();
      assertEquals(provider.providers(), ["radicle"]);

      const nonce = "ryph-link-6f1a2b3c4d5e";
      const command = provider.command("radicle", nonce);
      // Pasteable as it stands, and it names the namespace the verifier checks.
      assertStringIncludes(command, "ssh-keygen -Y sign -n ryph");
      assertStringIncludes(command, nonce);

      const identity = await provider.verify("radicle", nonce, {
        subject: key.did,
        signature: await key.sign(nonce, "ryph"),
      });
      // An alias is a self-chosen label anyone may change or share, so the DID is both the
      // stable account id and the login inbound triggers resolve by.
      assertEquals(identity, {
        accountId: key.did,
        login: key.did,
        name: null,
        verifiedEmails: [],
      });
    });
  },
);

test.skipIf(!HAVE_SSH_KEYGEN)(
  "another namespace, another key, another nonce and a malformed DID all answer null",
  async () => {
    const dirs = [await mkdtemp(join(tmpdir(), "ryph-")), await mkdtemp(join(tmpdir(), "ryph-"))];
    try {
      const provider = radicleChallengeProvider();
      const [mine, theirs] = await Promise.all(dirs.map(throwawayKey));
      const nonce = "ryph-link-6f1a2b3c4d5e";
      const good = await mine.sign(nonce, "ryph");

      // A signature the person already had lying around, made for another tool.
      assertEquals(
        await provider.verify("radicle", nonce, {
          subject: mine.did,
          signature: await mine.sign(nonce, "git"),
        }),
        null,
      );
      // A real signature over the real nonce, by a key that is not the DID's.
      assertEquals(
        await provider.verify("radicle", nonce, {
          subject: mine.did,
          signature: await theirs.sign(nonce, "ryph"),
        }),
        null,
      );
      // The same signature against a different nonce — what makes a replay useless.
      assertEquals(
        await provider.verify("radicle", "ryph-link-other", {
          subject: mine.did,
          signature: good,
        }),
        null,
      );
      // A DID that is not an ed25519 did:key never reaches the verifier at all.
      assertEquals(
        await provider.verify("radicle", nonce, {
          subject: "did:web:example.com",
          signature: good,
        }),
        null,
      );
    } finally {
      for (const dir of dirs) await rm(dir, { recursive: true });
    }
  },
);
