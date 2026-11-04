// What a user-mode bridge checks about somebody's own Radicle setup before it starts, so that a
// key nobody can unlock is a line at boot rather than the first write failing with
// "A passphrase is required to read your Radicle key".
//
// A deployment needs none of this: its key is written unencrypted by its own entrypoint, and
// its passphrase (empty) is part of its configuration. A person's key is usually encrypted and
// unlocked in their ssh-agent by `rad auth`, which `rad` signs through when no passphrase is set.

import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { connectUnix, writeAll } from "./unix_socket.ts";

/**
 * Whether the OpenSSH private key at `path` is encrypted, or null when it cannot be read as one.
 *
 * Only the format's header is read: the magic, then the cipher name, which is `none` for a key
 * stored in the clear (PROTOCOL.key in OpenSSH). Both sit in the first base64 line, ahead of
 * anything secret.
 */
export async function keyIsEncrypted(path: string): Promise<boolean | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").map((l) => l.trim());
  const begin = lines.indexOf("-----BEGIN OPENSSH PRIVATE KEY-----");
  const first = begin === -1 ? undefined : lines[begin + 1];
  if (!first) return null;
  let bytes: Uint8Array;
  try {
    // A whole number of base64 quanta, so the line decodes on its own.
    bytes = Uint8Array.fromBase64(first.slice(0, first.length - (first.length % 4)));
  } catch {
    return null;
  }
  const magic = new TextEncoder().encode("openssh-key-v1\0");
  if (bytes.length < magic.length + 4 || magic.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(magic.length);
  const start = magic.length + 4;
  if (length > 64 || start + length > bytes.length) return null;
  return new TextDecoder().decode(bytes.subarray(start, start + length)) !== "none";
}

/** The key blob of an OpenSSH public key line (`ssh-ed25519 AAAA… comment`), or null. */
export function publicKeyBlob(line: string): Uint8Array | null {
  const field = line.trim().split(/\s+/)[1];
  if (!field) return null;
  try {
    return Uint8Array.fromBase64(field);
  } catch {
    return null;
  }
}

/**
 * Whether the ssh-agent at `socket` holds the key whose blob is `blob` — or null when the agent
 * could not be asked. One request, SSH_AGENTC_REQUEST_IDENTITIES (draft-miller-ssh-agent §3.5),
 * which lists public keys and touches nothing.
 */
export async function agentHoldsKey(
  socket: string,
  blob: Uint8Array,
  timeoutMs = 2_000,
): Promise<boolean | null> {
  let conn: Socket;
  try {
    conn = await connectUnix(socket);
  } catch {
    return null;
  }
  const timer = setTimeout(() => conn.destroy(), timeoutMs);
  try {
    // uint32 length, then the message: SSH_AGENTC_REQUEST_IDENTITIES is the single byte 11.
    await writeAll(conn, new Uint8Array([0, 0, 0, 1, 11]));
    const reply = await readMessage(conn[Symbol.asyncIterator]());
    // SSH_AGENT_IDENTITIES_ANSWER (12): uint32 nkeys, then (string blob, string comment) each.
    if (reply === null || reply[0] !== 12) return null;
    const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
    let at = 1;
    const string = (): Uint8Array | null => {
      if (at + 4 > reply.length) return null;
      const length = view.getUint32(at);
      at += 4;
      if (at + length > reply.length) return null;
      const out = reply.subarray(at, at + length);
      at += length;
      return out;
    };
    if (at + 4 > reply.length) return null;
    const count = view.getUint32(at);
    at += 4;
    for (let i = 0; i < count; i++) {
      const key = string();
      if (key === null || string() === null) return null;
      if (key.length === blob.length && key.every((b, j) => b === blob[j])) return true;
    }
    return false;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    conn.destroy();
  }
}

/** One length-prefixed agent message, or null when the connection ended first. */
async function readMessage(chunks: AsyncIterator<Uint8Array>): Promise<Uint8Array | null> {
  const read = exactly(chunks);
  const header = await read(4);
  if (header === null) return null;
  const length = new DataView(header.buffer, header.byteOffset).getUint32(0);
  if (length === 0 || length > 256 * 1024) return null;
  return await read(length);
}

/** Reads of exactly `n` bytes off a chunked stream, carrying what one read over-fetched. */
function exactly(chunks: AsyncIterator<Uint8Array>) {
  let pending = new Uint8Array(0);
  return async (n: number): Promise<Uint8Array | null> => {
    while (pending.length < n) {
      const next = await chunks.next();
      if (next.done) return null;
      const joined = new Uint8Array(pending.length + next.value.length);
      joined.set(pending);
      joined.set(next.value, pending.length);
      pending = joined;
    }
    const out = pending.slice(0, n);
    pending = pending.subarray(n);
    return out;
  };
}
