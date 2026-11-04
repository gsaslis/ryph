// A background job's output as it may be shown anywhere: cleaned as a terminal would leave it,
// once, upstream of every consumer — the ring, the live channel, the agent's tail, the notice and
// the stored log all read the same clean stream (core/background.ts).
//
// The cleaner reads terminal escapes by their grammar (ECMA-48): a CSI (`ESC [` or C1 `0x9B`,
// parameters, intermediates, a final byte), a control string (OSC, DCS, SOS, PM, APC, by ESC or
// their C1 form, up to BEL or ST), and the two- and three-byte nF/Fp/Fe/Fs forms. Each is removed
// whole; an ESC that starts none of them is removed alone and what follows it is text. Every
// other control character but `\t` and `\n` goes, C1 and bidi controls too. A `\r` that opens a
// line goes (it redraws an empty one), `\r\n` is `\n`, and any other `\r` — a redraw, a progress
// bar — stays, a run of them as one: the ring keeps only a line's last redraw, and what people
// read makes it a line break. Only a real prefix of an escape is carried to the next push (and
// a trailing `\r`, to see whether a `\n` follows); a pause never drops one, so its remainder can
// never surface as text. Nothing it emits holds an ESC or a control character, so the control
// plane's own cleaning passes it through unchanged.
//
// Invariants:
// - cleaning is linear in what is pushed, and what is carried is bounded

/** The longest CSI or nF escape, and the longest control string body, carried for completion;
 * past either it is no escape that will complete, and is read as text. */
const ESCAPE_MAX = 256;
const STRING_MAX = 4_096;

const ESC = 0x1b;
const BEL = 0x07;
const ST = 0x9c;

/** Never shown: C0 controls but `\t`, `\n` and `\r` (each dealt with on its own), DEL, C1
 * controls, and the bidi controls that make text read other than it is. */
function unshown(c: number): boolean {
  return (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f) ||
    c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069);
}

/** Whether ESC followed by this byte opens a control string: OSC, DCS, SOS, PM, APC. */
const STRING_INTRODUCER = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);
/** ...and the C1 forms of the same. */
const C1_STRING = new Set([0x9d, 0x90, 0x98, 0x9e, 0x9f]);

/**
 * Where the escape at `at` ends: the index just past it, removed whole; or "partial" when the
 * text ends inside a real prefix of one. An ESC that opens none ends at once, removed alone.
 */
function escapeEnd(text: string, at: number, memo: { stop: number }): number | "partial" {
  const n = text.length;
  const c = text.charCodeAt(at);
  if (c === 0x9b) return csiEnd(text, at, at + 1);
  if (C1_STRING.has(c)) return stringEnd(text, at + 1, memo);
  // ESC
  if (at + 1 === n) return "partial";
  const next = text.charCodeAt(at + 1);
  if (next === 0x5b) return csiEnd(text, at, at + 2);
  if (STRING_INTRODUCER.has(next)) return stringEnd(text, at + 2, memo);
  if (next >= 0x20 && next <= 0x2f) {
    // nF: intermediates, then a final byte.
    let j = at + 2;
    while (j < n && j - at <= ESCAPE_MAX) {
      const b = text.charCodeAt(j);
      if (b >= 0x20 && b <= 0x2f) j++;
      else return b >= 0x30 && b <= 0x7e ? j + 1 : j;
    }
    return j === n && j - at <= ESCAPE_MAX ? "partial" : j;
  }
  // Fp, Fe, Fs: one byte more.
  if (next >= 0x30 && next <= 0x7e) return at + 2;
  return at + 1;
}

/** A CSI from `body`: parameters, then intermediates, then a final byte. Anything else ends it
 * there, and is read as what it is. */
function csiEnd(text: string, at: number, body: number): number | "partial" {
  const n = text.length;
  let intermediates = false;
  let j = body;
  while (j < n && j - at <= ESCAPE_MAX) {
    const b = text.charCodeAt(j);
    if (b >= 0x30 && b <= 0x3f && !intermediates) j++;
    else if (b >= 0x20 && b <= 0x2f) {
      intermediates = true;
      j++;
    } else return b >= 0x40 && b <= 0x7e ? j + 1 : j;
  }
  return j === n && j - at <= ESCAPE_MAX ? "partial" : j;
}

/** A control string from `body` up to BEL or ST. An ESC that is no ST ends it there (the ESC
 * starts what comes next); a body past STRING_MAX is no string: its introducer goes, and the rest
 * is read as text. `memo` holds, for one pass, the next BEL, ST or ESC at or past the last body
 * looked at: a flood of introducers each finding the same stop costs it once, not once each. */
function stringEnd(text: string, body: number, memo: { stop: number }): number | "partial" {
  const n = text.length;
  if (memo.stop < body) {
    let j = body;
    while (j < n) {
      const b = text.charCodeAt(j);
      if (b === BEL || b === ST || b === ESC) break;
      j++;
    }
    memo.stop = j;
  }
  const j = memo.stop;
  if (j - body > STRING_MAX) return body;
  if (j === n) return "partial";
  const b = text.charCodeAt(j);
  if (b === BEL || b === ST) return j + 1;
  if (j + 1 === n) return "partial";
  return text.charCodeAt(j + 1) === 0x5c ? j + 2 : j;
}

/** One whole piece of text — a label, a command, a cwd — as it may be shown: cleaned, every line
 * break and redraw a `\n`, nothing carried. */
export function shownText(text: string): string {
  const stream = new OutputStream();
  return (stream.push(text) + stream.end()).replace(/\r/g, "\n");
}

/** One job's output, cleaned as it streams. */
export class OutputStream {
  /** A real prefix of an escape, carried to the next push. */
  #escape = "";
  /** A `\r` seen and not yet placed: a redraw, or the start of a `\r\n`. */
  #return = false;
  /** Whether what was cleaned last ended a line, or nothing has been. */
  #lineStart = true;

  /** Whether the cleaner holds a `\r` — what `release` would let go. */
  get holding(): boolean {
    return this.#return;
  }

  /** How much the stream holds back, in characters: bounded, whatever was pushed. */
  get held(): number {
    return this.#escape.length + (this.#return ? 1 : 0);
  }

  /** More decoded output; answers what of it may now be shown. */
  push(text: string): string {
    return this.#clean(this.#escape + text);
  }

  /** What the stream holds, let go after a pause: a trailing `\r` is the redraw it would have
   * been. A partial escape stays — whatever completes it is never text. */
  release(): string {
    return this.#placeReturn(false);
  }

  /** The end of the output: everything left. A partial escape is nothing. */
  end(): string {
    this.#escape = "";
    return this.release();
  }
  /** A pending `\r`, placed before what follows it: nothing before a `\n` (it is a `\r\n`) or at
   * a line's start, a redraw anywhere else. */
  #placeReturn(newline: boolean): string {
    if (!this.#return) return "";
    this.#return = false;
    if (newline || this.#lineStart) return "";
    this.#lineStart = false;
    return "\r";
  }

  #clean(text: string): string {
    this.#escape = "";
    const out: string[] = [];
    const n = text.length;
    const memo = { stop: -1 };
    let from = 0;
    /** Ordinary text from `from` to `to`, after any `\r` it follows. */
    const keep = (to: number) => {
      if (to <= from) return;
      const placed = this.#placeReturn(text.charCodeAt(from) === 0x0a);
      if (placed !== "") out.push(placed);
      out.push(text.slice(from, to));
      this.#lineStart = text.charCodeAt(to - 1) === 0x0a;
    };
    let i = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x0d) {
        keep(i);
        this.#return = true;
        from = ++i;
        continue;
      }
      if (c !== ESC && c !== 0x9b && !C1_STRING.has(c) && !unshown(c)) {
        i++;
        continue;
      }
      keep(i);
      if (c === ESC || c === 0x9b || C1_STRING.has(c)) {
        const end = escapeEnd(text, i, memo);
        if (end === "partial") {
          this.#escape = text.slice(i);
          return out.join("");
        }
        i = end;
      } else i++;
      from = i;
    }
    keep(n);
    return out.join("");
  }
}
