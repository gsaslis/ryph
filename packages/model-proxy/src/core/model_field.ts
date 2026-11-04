// The model a request body names, read straight off its bytes.
//
// Every model call passes through here, and since runs can see images every turn may carry
// twenty or thirty megabytes of base64. `JSON.parse` would build that whole document as objects
// and strings — measured at +77 MB of resident memory for a 27 MB body — to read one top-level
// string. This walks the bytes once instead and materialises only the keys of the top-level
// object and the value of `model`. The same walk hands the proxy any other top-level member it
// asks for (`background`, on a Responses call) as a span of the body, never as a parsed value.
//
// Invariants:
// - the answer is EXACTLY `JSON.parse`'s on the body strictly decoded (`TextDecoder` with
//   `fatal`, see below): the top-level value must be an object; the LAST top-level `model` key
//   wins, as it does there (and in the providers' own parsers), so a body with two cannot show
//   the allowlist one model and the provider another; a key is compared decoded, so
//   `"mod\u0065l"` is `model`; a `model` that is not a non-empty string is no model
// - read whatever the request's `content-type` claims: a policy that only reads bodies labelled
//   JSON is a policy the caller turns off with a header
// - a body `JSON.parse` would refuse names no model: the walk validates the whole document —
//   strings, escapes, numbers, literals, nesting, and nothing after the closing brace — rather
//   than stopping at the first `model` it sees
// - a leading UTF-8 byte order mark is skipped, as `TextDecoder` drops it before a parse
// - a body that is not valid UTF-8 names no model. A lenient decoder turns bad bytes into U+FFFD,
//   a careless one decodes an overlong `\xC1\xA5` as `e`: `{"model":"a","mod\xC1\xA5l":"b"}` is
//   model `a` to the first and `b` to the second, so a proxy reading it either way could judge
//   one model while the provider runs the other. Only bytes are refused — a `\ud800` escape is
//   JSON, and `JSON.parse` takes it — and since outside strings JSON is ASCII, the check lives in
//   the string walk.
// - iterative, never recursive: a body of a million `[` is a refusal, not a stack overflow; and
//   the open containers are a bit each, so a 60 MiB body of `[` costs 7.5 MiB, not gigabytes
// - pure; bytes in, a string or null out

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

const decoder = new TextDecoder();

/**
 * The model a request body names: the top-level `model` member when it is a non-empty string,
 * else null — for a body that is not a JSON object, or not JSON at all, too.
 */
export function modelNamedIn(bytes: Uint8Array): string | null {
  const members = topLevelMembers(bytes, MODEL_ONLY);
  return members === null ? null : modelOf(bytes, members);
}

const MODEL_ONLY: ReadonlySet<string> = new Set(["model"]);

/** Where one top-level member's value sits in the body: `[start, end)`, its raw JSON token. */
export interface ValueSpan {
  start: number;
  end: number;
}

/**
 * Where each top-level member named in `wanted` has its value, by name; or null when the body is
 * not one JSON object (`JSON.parse` would refuse it, or it is an array, a string, a number). The
 * same single walk `modelNamedIn` is, so asking about a second member costs no second pass over
 * a body of tens of megabytes. The LAST occurrence of a name wins, as it does in a parse.
 */
export function topLevelMembers(
  bytes: Uint8Array,
  wanted: ReadonlySet<string>,
): Map<string, ValueSpan> | null {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  i = skipSpace(bytes, i);
  if (bytes[i] !== OPEN_OBJECT) return null;
  i = skipSpace(bytes, i + 1);
  const found = new Map<string, ValueSpan>();
  if (bytes[i] === CLOSE_OBJECT) {
    i += 1;
  } else {
    for (;;) {
      if (bytes[i] !== QUOTE) return null;
      const keyEnd = skipString(bytes, i);
      if (keyEnd < 0) return null;
      const key = decodeString(bytes, i, keyEnd);
      i = skipSpace(bytes, keyEnd);
      if (bytes[i] !== COLON) return null;
      const valueStart = skipSpace(bytes, i + 1);
      const valueEnd = skipValue(bytes, valueStart);
      if (valueEnd < 0) return null;
      if (wanted.has(key)) found.set(key, { start: valueStart, end: valueEnd });
      i = skipSpace(bytes, valueEnd);
      if (bytes[i] === COMMA) {
        i = skipSpace(bytes, i + 1);
        continue;
      }
      if (bytes[i] !== CLOSE_OBJECT) return null;
      i += 1;
      break;
    }
  }
  if (skipSpace(bytes, i) !== bytes.length) return null;
  return found;
}

/** The `model` out of a walk that asked for it: a non-empty string, else null. */
export function modelOf(bytes: Uint8Array, members: Map<string, ValueSpan>): string | null {
  const span = members.get("model");
  if (span === undefined || bytes[span.start] !== QUOTE) return null;
  const model = decodeString(bytes, span.start, span.end);
  return model === "" ? null : model;
}

/** A member's value token as written (`true`, `null`, `"x"`); for small scalars only. */
export function rawValue(bytes: Uint8Array, span: ValueSpan): string {
  return decoder.decode(bytes.subarray(span.start, span.end));
}

/** The string token `[start, end)` — quotes included — as the string it spells. Small: a key or
 * the model's name. */
function decodeString(bytes: Uint8Array, start: number, end: number): string {
  const raw = decoder.decode(bytes.subarray(start, end));
  // No escape, nothing to interpret: the text between the quotes is the string.
  return bytes.subarray(start, end).includes(BACKSLASH) ? JSON.parse(raw) : raw.slice(1, -1);
}

/** JSON's whitespace — exactly its four, not JavaScript's `\s`. */
function skipSpace(bytes: Uint8Array, i: number): number {
  while (i < bytes.length) {
    const c = bytes[i];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    i += 1;
  }
  return i;
}

function isHex(c: number | undefined): boolean {
  return c !== undefined &&
    ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66));
}

/**
 * Past the string token starting at `i` (its opening quote), or -1 for one `JSON.parse` would
 * refuse — unterminated, a raw control character, or a bad escape — or that is not valid UTF-8.
 * Byte-wise is exact in UTF-8: a quote or a backslash byte never occurs inside a multi-byte
 * character.
 */
function skipString(bytes: Uint8Array, i: number): number {
  i += 1;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c === QUOTE) return i + 1;
    if (c < 0x20) return -1;
    if (c >= 0x80) {
      const n = utf8Length(bytes, i);
      if (n < 0) return -1;
      i += n;
      continue;
    }
    if (c === BACKSLASH) {
      const e = bytes[i + 1];
      if (e === 0x75) { // \uXXXX
        if (!isHex(bytes[i + 2]) || !isHex(bytes[i + 3])) return -1;
        if (!isHex(bytes[i + 4]) || !isHex(bytes[i + 5])) return -1;
        i += 6;
        continue;
      }
      // \" \\ \/ \b \f \n \r \t
      if (
        e === QUOTE || e === BACKSLASH || e === 0x2f || e === 0x62 || e === 0x66 ||
        e === 0x6e || e === 0x72 || e === 0x74
      ) {
        i += 2;
        continue;
      }
      return -1;
    }
    i += 1;
  }
  return -1;
}

/**
 * The length of the well-formed UTF-8 character starting at `i` (a non-ASCII lead byte), or -1:
 * Unicode's table of well-formed byte sequences (Table 3-7), which rules out overlong forms,
 * encoded surrogates, and anything past U+10FFFF — what `TextDecoder` with `fatal` refuses.
 */
function utf8Length(bytes: Uint8Array, i: number): number {
  const c = bytes[i];
  const within = (k: number, lo: number, hi: number) =>
    i + k < bytes.length && bytes[i + k] >= lo && bytes[i + k] <= hi;
  if (c >= 0xc2 && c <= 0xdf) return within(1, 0x80, 0xbf) ? 2 : -1;
  if (c >= 0xe0 && c <= 0xef) {
    const lo = c === 0xe0 ? 0xa0 : 0x80;
    const hi = c === 0xed ? 0x9f : 0xbf;
    return within(1, lo, hi) && within(2, 0x80, 0xbf) ? 3 : -1;
  }
  if (c >= 0xf0 && c <= 0xf4) {
    const lo = c === 0xf0 ? 0x90 : 0x80;
    const hi = c === 0xf4 ? 0x8f : 0xbf;
    return within(1, lo, hi) && within(2, 0x80, 0xbf) && within(3, 0x80, 0xbf) ? 4 : -1;
  }
  return -1;
}

const LITERALS: ReadonlyArray<readonly number[]> = [
  [0x74, 0x72, 0x75, 0x65], // true
  [0x66, 0x61, 0x6c, 0x73, 0x65], // false
  [0x6e, 0x75, 0x6c, 0x6c], // null
];

function isDigit(c: number | undefined): boolean {
  return c !== undefined && c >= 0x30 && c <= 0x39;
}

/** Past the number or literal at `i`, or -1. Numbers by JSON's grammar:
 * `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`. */
function skipScalar(bytes: Uint8Array, i: number): number {
  for (const literal of LITERALS) {
    if (literal.every((b, k) => bytes[i + k] === b)) return i + literal.length;
  }
  if (bytes[i] === 0x2d) i += 1; // -
  if (bytes[i] === 0x30) {
    i += 1;
  } else if (isDigit(bytes[i])) {
    while (isDigit(bytes[i])) i += 1;
  } else {
    return -1;
  }
  if (bytes[i] === 0x2e) { // .
    i += 1;
    if (!isDigit(bytes[i])) return -1;
    while (isDigit(bytes[i])) i += 1;
  }
  if (bytes[i] === 0x65 || bytes[i] === 0x45) { // e E
    i += 1;
    if (bytes[i] === 0x2b || bytes[i] === 0x2d) i += 1;
    if (!isDigit(bytes[i])) return -1;
    while (isDigit(bytes[i])) i += 1;
  }
  return i;
}

/** After a member's name in an object being skipped: the name, then the colon. */
function skipMemberName(bytes: Uint8Array, i: number): number {
  if (bytes[i] !== QUOTE) return -1;
  const end = skipString(bytes, i);
  if (end < 0) return -1;
  i = skipSpace(bytes, end);
  return bytes[i] === COLON ? i + 1 : -1;
}

/**
 * The containers open around the walk, innermost last, one bit each: set for an object, clear
 * for an array. A plain array of them would cost eight bytes or more a level, so a body of tens of
 * megabytes of `[` a gigabyte of memory.
 */
class OpenContainers {
  #bits = new Uint8Array(64);
  length = 0;
  push(close: number): void {
    if (this.length >> 3 === this.#bits.length) {
      const bigger = new Uint8Array(this.#bits.length * 2);
      bigger.set(this.#bits);
      this.#bits = bigger;
    }
    const byte = this.length >> 3;
    const bit = 1 << (this.length & 7);
    this.#bits[byte] = close === CLOSE_OBJECT ? this.#bits[byte] | bit : this.#bits[byte] & ~bit;
    this.length += 1;
  }
  /** The bracket that closes the innermost container. */
  top(): number {
    const at = this.length - 1;
    return (this.#bits[at >> 3] >> (at & 7)) & 1 ? CLOSE_OBJECT : CLOSE_ARRAY;
  }
  pop(): void {
    this.length -= 1;
  }
}

/**
 * Past the whole value starting at `i` — nested objects and arrays included — or -1 for one
 * `JSON.parse` would refuse. Iterative, with the open containers on a stack.
 */
function skipValue(bytes: Uint8Array, i: number): number {
  const open = new OpenContainers();
  for (;;) {
    // One value starts here.
    i = skipSpace(bytes, i);
    const c = bytes[i];
    if (c === OPEN_OBJECT || c === OPEN_ARRAY) {
      const close = c === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY;
      i = skipSpace(bytes, i + 1);
      if (bytes[i] === close) {
        i += 1;
      } else {
        open.push(close);
        if (close === CLOSE_OBJECT) {
          i = skipMemberName(bytes, i);
          if (i < 0) return -1;
        }
        continue;
      }
    } else if (c === QUOTE) {
      i = skipString(bytes, i);
    } else {
      i = skipScalar(bytes, i);
    }
    if (i < 0) return -1;
    // The value ended: a comma starts the next one in its container, a bracket closes it.
    for (;;) {
      if (open.length === 0) return i;
      i = skipSpace(bytes, i);
      const close = open.top();
      if (bytes[i] === COMMA) {
        i = skipSpace(bytes, i + 1);
        if (close === CLOSE_OBJECT) {
          i = skipMemberName(bytes, i);
          if (i < 0) return -1;
        }
        break;
      }
      if (bytes[i] !== close) return -1;
      open.pop();
      i += 1;
    }
  }
}

/** What `visitObjects` saw of one object when it closed. */
export interface ObjectSeen {
  /** The member name this object is the value of — or, for an element of an array, that
   * array's member name; null at the top level and inside an array of arrays. */
  key: string | null;
  /** Whether it is an element of an array (`key` then names the array). */
  inArray: boolean;
  /** The watched members whose value is a string, decoded up to their first
   * `STRING_PREFIX_CHARS` characters (see `decodePrefix`). A watched member whose value is not
   * a string is here as `NOT_A_STRING`; one that is `null` is absent. */
  strings: Map<string, string>;
  /** The watched members whose value is an object: that object's own `strings`. */
  children: Map<string, Map<string, string>>;
  /** The path to it (`messages[2].content[0]`), worked out only when asked. */
  path(): string;
}

/** The marker in `ObjectSeen.strings` for a watched member whose value is not a string. */
export const NOT_A_STRING = "\u0000";

/** How much of a watched string `visitObjects` decodes: enough for any type name and a URL's
 * scheme, never a whole base64 image. */
export const STRING_PREFIX_CHARS = 64;

interface Frame {
  object: boolean;
  /** Its place in its parent: a member name or an index. */
  segment: string | number | null;
  key: string | null;
  inArray: boolean;
  /** Objects: the member whose value is being read. Arrays: the next element's index. */
  member: string | null;
  index: number;
  strings: Map<string, string>;
  children: Map<string, Map<string, string>>;
}

/**
 * Walks every object in a body and hands each, as it closes, to `visit` with the members asked
 * about — strings by prefix, objects by their own string members — without building the body as
 * values: one pass, like `topLevelMembers`, and only short prefixes decoded. False when the body
 * is not one JSON value, or nests past `maxDepth` (the frames are objects here, not bits, so the
 * depth is bounded instead).
 */
export function visitObjects(
  bytes: Uint8Array,
  watch: { strings: ReadonlySet<string>; children: ReadonlySet<string> },
  maxDepth: number,
  visit: (seen: ObjectSeen) => void,
): boolean {
  const frames: Frame[] = [];
  const pathOf = (upTo: number): string => {
    let out = "";
    for (let k = 1; k <= upTo; k++) {
      const segment = frames[k].segment;
      out += typeof segment === "number" ? `[${segment}]` : out === "" ? segment : `.${segment}`;
    }
    return out;
  };
  /** The value that starts now sits in the innermost frame's current slot. */
  const slot = (): { frame: Frame | undefined; name: string | null } => {
    const frame = frames[frames.length - 1];
    return { frame, name: frame?.object ? frame.member : null };
  };
  const close = (): void => {
    const frame = frames.pop()!;
    if (!frame.object) return;
    const depth = frames.length;
    visit({
      key: frame.key,
      inArray: frame.inArray,
      strings: frame.strings,
      children: frame.children,
      path: () => {
        frames.push(frame);
        const text = pathOf(depth);
        frames.pop();
        return text;
      },
    });
    const parent = frames[frames.length - 1];
    if (parent?.object && parent.member !== null && watch.children.has(parent.member)) {
      parent.children.set(parent.member, frame.strings);
    }
  };

  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  for (;;) {
    i = skipSpace(bytes, i);
    const c = bytes[i];
    const { frame: parent, name } = slot();
    if (parent?.object && name !== null) {
      // Whatever this member held before (a duplicate name) is replaced, as a parse replaces it.
      parent.strings.delete(name);
      parent.children.delete(name);
    }
    if (c === OPEN_OBJECT || c === OPEN_ARRAY) {
      if (frames.length >= maxDepth) return false;
      if (parent?.object && name !== null && watch.strings.has(name)) {
        parent.strings.set(name, NOT_A_STRING);
      }
      const object = c === OPEN_OBJECT;
      frames.push({
        object,
        segment: parent === undefined ? null : parent.object ? parent.member : parent.index,
        key: parent === undefined ? null : parent.object ? parent.member : parent.key,
        inArray: parent !== undefined && !parent.object,
        member: null,
        index: 0,
        strings: new Map(),
        children: new Map(),
      });
      i = skipSpace(bytes, i + 1);
      const closer = object ? CLOSE_OBJECT : CLOSE_ARRAY;
      if (bytes[i] === closer) {
        i += 1;
        close();
      } else {
        if (object) {
          const top = frames[frames.length - 1];
          i = readMemberName(bytes, i, top);
          if (i < 0) return false;
        }
        continue;
      }
    } else if (c === QUOTE) {
      const end = skipString(bytes, i);
      if (end < 0) return false;
      if (parent?.object && name !== null && watch.strings.has(name)) {
        parent.strings.set(name, decodePrefix(bytes, i, end));
      }
      i = end;
    } else {
      const end = skipScalar(bytes, i);
      if (end < 0) return false;
      const isNull = end - i === 4 && bytes[i] === 0x6e;
      if (parent?.object && name !== null && watch.strings.has(name) && !isNull) {
        parent.strings.set(name, NOT_A_STRING);
      }
      i = end;
    }
    // The value ended: a comma starts the next one in its container, a bracket closes it.
    for (;;) {
      const top = frames[frames.length - 1];
      if (top === undefined) return skipSpace(bytes, i) === bytes.length;
      i = skipSpace(bytes, i);
      if (bytes[i] === COMMA) {
        i = skipSpace(bytes, i + 1);
        if (top.object) {
          i = readMemberName(bytes, i, top);
          if (i < 0) return false;
        } else {
          top.index += 1;
        }
        break;
      }
      if (bytes[i] !== (top.object ? CLOSE_OBJECT : CLOSE_ARRAY)) return false;
      i += 1;
      close();
    }
  }
}

/** A member's name into its frame, and past the colon after it; -1 when there is none. */
function readMemberName(bytes: Uint8Array, i: number, frame: Frame): number {
  if (bytes[i] !== QUOTE) return -1;
  const end = skipString(bytes, i);
  if (end < 0) return -1;
  frame.member = decodeString(bytes, i, end);
  i = skipSpace(bytes, end);
  return bytes[i] === COLON ? i + 1 : -1;
}

/**
 * The first `STRING_PREFIX_CHARS` characters of the string token `[start, end)`, escapes
 * interpreted as a parse interprets them. A non-ASCII character ends the prefix early with
 * U+FFFD: nothing this is asked about (a type name, a URL scheme) is spelled outside ASCII, so a
 * value that is reads as no known one — and every rule over it fails closed.
 */
function decodePrefix(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  let i = start + 1;
  const last = end - 1;
  while (i < last && out.length < STRING_PREFIX_CHARS) {
    const c = bytes[i];
    if (c >= 0x80) return `${out}�`;
    if (c !== BACKSLASH) {
      out += String.fromCharCode(c);
      i += 1;
      continue;
    }
    const e = bytes[i + 1];
    if (e === 0x75) {
      out += String.fromCharCode(
        parseInt(String.fromCharCode(...bytes.subarray(i + 2, i + 6)), 16),
      );
      i += 6;
      continue;
    }
    const simple: Record<number, string> = {
      0x22: '"',
      0x5c: "\\",
      0x2f: "/",
      0x62: "\b",
      0x66: "\f",
      0x6e: "\n",
      0x72: "\r",
      0x74: "\t",
    };
    out += simple[e] ?? "";
    i += 2;
  }
  return out;
}
