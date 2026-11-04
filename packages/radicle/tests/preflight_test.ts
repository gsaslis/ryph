// The user-mode boot checks: telling an encrypted key from a clear one by its header alone, and
// asking an ssh-agent which keys it holds — against real `rad auth` keys and an agent we serve.

import { test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { assertEquals } from "@std/assert";
import { command } from "@ryph/process";
import { agentHoldsKey, keyIsEncrypted, publicKeyBlob } from "../src/helpers/preflight.ts";
import { RAD_MISSING, radBinDir, socketPath, tempDir } from "./util.ts";

async function authed(passphrase: string): Promise<{ home: string; dispose(): Promise<void> }> {
  const dir = await tempDir("preflight");
  const out = await command(`${radBinDir()}/rad`, {
    args: ["auth", "--alias", "preflight"],
    clearEnv: true,
    env: {
      RAD_HOME: dir.path,
      HOME: dir.path,
      RAD_PASSPHRASE: passphrase,
      RAD_SOCKET: "/dev/null",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
  return { home: dir.path, dispose: dir.dispose };
}

test.skipIf(RAD_MISSING)(
  "a key `rad auth` wrote with a passphrase is encrypted, and one without is not",
  async () => {
    const clear = await authed("");
    const locked = await authed("a passphrase");
    try {
      assertEquals(await keyIsEncrypted(`${clear.home}/keys/radicle`), false);
      assertEquals(await keyIsEncrypted(`${locked.home}/keys/radicle`), true);
    } finally {
      await clear.dispose();
      await locked.dispose();
    }
  },
);

test("a missing or foreign key file is not a verdict either way", async () => {
  const dir = await tempDir("preflight");
  try {
    assertEquals(await keyIsEncrypted(`${dir.path}/nope`), null);
    await writeFile(`${dir.path}/pem`, "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n");
    assertEquals(await keyIsEncrypted(`${dir.path}/pem`), null);
  } finally {
    await dir.dispose();
  }
});

/** An ssh-agent that answers REQUEST_IDENTITIES with `keys`, and nothing else. */
function fakeAgent(path: string, keys: Uint8Array[]): { close(): void } {
  const listener = createServer((conn) => {
    conn.on("error", () => {});
    conn.once("data", () => {
      const parts: number[] = [12, ...u32(keys.length)];
      for (const key of keys) {
        parts.push(...u32(key.length), ...key, ...u32(1), 99); // comment "c"
      }
      conn.end(new Uint8Array([...u32(parts.length), ...parts]));
    });
  });
  listener.listen(path);
  return { close: () => listener.close() };
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

test("an agent is asked which keys it holds, and the answer is read", async () => {
  const ours = publicKeyBlob("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7ws0cWaPS9Yd3hOJVkeDyXbHN8 x")!;
  const other = new Uint8Array([1, 2, 3]);
  const sock = await socketPath();
  const agent = fakeAgent(sock.path, [other, ours]);
  try {
    assertEquals(await agentHoldsKey(sock.path, ours), true);
    assertEquals(await agentHoldsKey(sock.path, new Uint8Array([9])), false);
  } finally {
    agent.close();
    await sock.dispose();
  }
  // Nobody listening: unknown, not "no".
  assertEquals(await agentHoldsKey(sock.path, ours), null);
});
