// The screen every proposal passes before it can be looked at: secret-shaped text is refused
// outright, instruction-shaped text is flagged. Neither is a judgement about truth — a secret
// must never be stored whatever it says, and an instruction is exactly what an injected README
// would try to persist, so it waits for a human rather than becoming canon on its own.

import type { ProposalFlag } from "./types.ts";

/** Shapes that are a credential whatever the surrounding prose says. */
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI-style
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bglpat-[A-Za-z0-9_-]{20,}\b/, // GitLab
  /\bbearer\s+[A-Za-z0-9._~+/=-]{24,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // a JWT
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
  /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i, // a connection URL with a password
];

export function isSecretShaped(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

/**
 * Text that addresses the reader and tells it what to do: imperative openers, "you must", and
 * the classic injection phrasings. A memory is an observation; an instruction is a human's to
 * give, through a `preference` they confirmed.
 */
const INSTRUCTION_SHAPES: RegExp[] = [
  /^\s*(?:always|never|do not|don't|make sure(?: to)?|remember to|ensure (?:that )?you|ignore|disregard|from now on|you (?:must|should|need to|have to|are (?:now|no longer)))\b/i,
  /\byou (?:must|should always|should never|are required to|are (?:now|no longer))\b/i,
  /\bignore (?:all|any|the|your|previous|prior|earlier) (?:\w+ )?(?:instructions|rules|guidance|prompt)/i,
  /\b(?:system prompt|developer message|your instructions)\b/i,
  /\bpush (?:directly )?to (?:main|master)\b/i,
  /\b(?:without|skip(?:ping)?) (?:asking|approval|review|confirmation)\b/i,
];

export function isInstructionShaped(text: string): boolean {
  return INSTRUCTION_SHAPES.some((re) => re.test(text));
}

/** Every flag the screen raises for a text. `secret-shaped` is a refusal at the caller. */
export function screen(text: string): ProposalFlag[] {
  const flags: ProposalFlag[] = [];
  if (isSecretShaped(text)) flags.push("secret-shaped");
  if (isInstructionShaped(text)) flags.push("instruction-shaped");
  return flags;
}

/** The dedupe key: lowercase, punctuation and whitespace folded. */
export function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"“”‘’*_]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
