// Password hashing on scrypt via node:crypto — built into the runtime, zero dependencies, and
// deliberately boring: this is the code nobody gets creative with.
//
// Stored format: `scrypt:N=<cost>:<saltB64>:<hashB64>` — self-describing, so cost can be
// raised later and old hashes keep verifying with their recorded parameters.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const COST = 16384; // scrypt N; r=8, p=1 (node defaults)
const KEY_LEN = 64;
const SALT_LEN = 16;

function scryptAsync(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: cost }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, COST);
  return `scrypt:N=${COST}:${salt.toString("base64")}:${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = /^scrypt:N=(\d+):([^:]+):([^:]+)$/.exec(stored);
  if (!match) return false;
  const [, cost, saltB64, hashB64] = match;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), Number(cost));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A valid hash of an unknowable password. Verified against when a login names a user that
 * does not exist, so "no such user" and "wrong password" cost the same time.
 */
export const DECOY_HASH =
  "scrypt:N=16384:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
