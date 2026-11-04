// Minting: automation ids double as ingestion URL segments (the mailroom's slug shape), and
// webhook secrets are generated here, never chosen by a caller.

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomFrom(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Slug-shaped and unguessable enough to not collide; the secret, not this, is what a request
 * must prove. Matches the mailroom's registration id pattern. */
export function mintAutomationId(): string {
  return `am${randomFrom(SLUG_ALPHABET, 18)}`;
}

/** 256 bits, hex — pasted once into the sending service, held here for verification. */
export function mintSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** For fire rows that never entered the queue (rate-limited drops) and so have no hook id. */
export function mintFireId(): string {
  return `fire${randomFrom(SLUG_ALPHABET, 18)}`;
}
