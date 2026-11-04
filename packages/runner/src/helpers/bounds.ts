// Text cut to a bound, and a wait cut to a deadline: the small, exact pieces every bounded thing
// the runner hands on is made with (core/background.ts, core/subagents.ts, the subagent host).
// Never half a surrogate pair, and sizes in UTF-8 where a peer counts bytes.

/** Whether `code` opens a surrogate pair. */
export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** At most `max` characters, never ending on half a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

const encoder = new TextEncoder();
/** `text`'s length as UTF-8. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** How many UTF-8 bytes a code point takes. */
export const charBytes = (code: number): number =>
  code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;

/** The longest start of `text` that is at most `max` bytes as UTF-8, never half a pair. */
export function clipBytes(text: string, max: number): string {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i)!;
    if (bytes + charBytes(code) > max) break;
    bytes += charBytes(code);
    i += code < 0x10000 ? 1 : 2;
  }
  return text.slice(0, i);
}

/** Whether `promise` settled (either way) within `ms`. */
export async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}
