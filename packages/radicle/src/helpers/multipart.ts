// `multipart/form-data`, read as a STREAM.
//
// Why this exists rather than `Request.formData()`: that method buffers the entire body before
// anything can look at it, so a cap checked on the parsed parts is not a cap at all — a
// four-gigabyte "bundle" is already resident by the time its size is known. This package's one
// multipart route takes a git bundle whose ceiling is an operator setting
// (`RYPH_RADICLE_MAX_BUNDLE_BYTES`), and that ceiling has to bite WHILE the bytes arrive, on a
// chunked body that announces no length. Same rule as `@ryph/shared/http`'s capped readers, one
// framing up.
//
// The parser is deliberately small and strict, because it is a door open to the forge and to
// whatever else can reach this port: one file part streamed to a sink, every other part held in
// memory under a separate small cap, no nesting, no `multipart/mixed`, no transfer encodings.
// Anything it does not understand is a refusal, never a guess.

/** A body this parser refuses. `tooLarge` separates a 413 from a 400 at the route. */
export class MultipartError extends Error {
  constructor(message: string, readonly tooLarge = false) {
    super(message);
    this.name = "MultipartError";
  }
}

/** The boundary out of a content-type, or null when this is not multipart/form-data. */
export function multipartBoundary(contentType: string): string | null {
  const value = contentType.trim();
  if (!value.toLowerCase().startsWith("multipart/form-data")) return null;
  const match = value.match(/;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = match?.[1] ?? match?.[2] ?? "";
  // RFC 2046 bounds a boundary at 70 characters; an empty one would match everywhere.
  if (boundary === "" || boundary.length > 70) return null;
  return boundary;
}

/** The headers of one part never legitimately run past this. */
const MAX_PART_HEADERS = 8 * 1024;
/** How many parts are read before the body is called abusive. */
const MAX_PARTS = 16;

export interface MultipartLimits {
  /** The cap on the one streamed part — the operator's bundle ceiling. */
  maxFileBytes: number;
  /** The cap on every other part, which is held in memory. */
  maxFieldBytes: number;
}

function indexOfSub(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** `name` and `filename` out of a part's header block. */
function dispositionOf(headers: string): { name: string; filename: string | null } {
  for (const line of headers.split("\r\n")) {
    const [key, ...rest] = line.split(":");
    if (key.trim().toLowerCase() !== "content-disposition") continue;
    const value = rest.join(":");
    const name = value.match(/;\s*name="([^"]*)"/i)?.[1] ??
      value.match(/;\s*name=([^;\s]+)/i)?.[1];
    if (name === undefined) break;
    const filename = value.match(/;\s*filename="([^"]*)"/i)?.[1] ??
      value.match(/;\s*filename=([^;\s]+)/i)?.[1] ?? null;
    return { name, filename };
  }
  throw new MultipartError("a part carries no usable content-disposition");
}

/**
 * Reads a `multipart/form-data` body, streaming the part named `fileField` into `sink` and
 * collecting every other part as text.
 *
 * `sink` is called with borrowed slices, in order, and must copy anything it keeps. It is never
 * called after this function throws — but bytes written before a cap bit ARE already in it, so
 * the caller owns cleaning that up (the route deletes the spool file).
 */
export async function readMultipart(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
  fileField: string,
  sink: (chunk: Uint8Array) => Promise<void>,
  limits: MultipartLimits,
): Promise<{ fields: Record<string, string>; fileBytes: number | null }> {
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const reader = (body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })).getReader();
  // The leading CRLF is synthetic: the FIRST boundary in a body has no line before it, and
  // prepending one lets a single delimiter match every boundary including that one.
  let buf: Uint8Array<ArrayBuffer> = encoder.encode("\r\n");
  let eof = false;

  const pull = async (): Promise<boolean> => {
    if (eof) return false;
    const { value, done } = await reader.read();
    if (done) {
      eof = true;
      return false;
    }
    buf = concat(buf, value);
    return true;
  };
  /** Grows the buffer until `needed` bytes are there, or the body ended. */
  const fill = async (needed: number): Promise<boolean> => {
    while (buf.length < needed) {
      if (!await pull()) return false;
    }
    return true;
  };

  const fields: Record<string, string> = {};
  let fileBytes: number | null = null;
  const decoder = new TextDecoder();

  try {
    // Skip anything before the first boundary (the preamble: legal, and never ours).
    for (;;) {
      const at = indexOfSub(buf, delimiter, 0);
      if (at >= 0) {
        buf = buf.subarray(at);
        break;
      }
      // Keep only what could still be the start of a delimiter.
      if (buf.length > delimiter.length) buf = buf.subarray(buf.length - delimiter.length + 1);
      if (!await pull()) throw new MultipartError("the multipart body has no boundary");
    }

    for (let part = 0;; part++) {
      if (part >= MAX_PARTS) throw new MultipartError("too many parts in the multipart body");
      // Positioned on a delimiter. What follows is "--" (the end) or CRLF (another part).
      if (!await fill(delimiter.length + 2)) {
        throw new MultipartError("the multipart body ends mid-boundary");
      }
      const after = buf.subarray(delimiter.length, delimiter.length + 2);
      if (after[0] === 0x2d && after[1] === 0x2d) return { fields, fileBytes };
      // Tolerate the transport padding a boundary line with whitespace before its CRLF.
      let skip = delimiter.length;
      while (skip < buf.length && (buf[skip] === 0x20 || buf[skip] === 0x09)) skip++;
      if (!await fill(skip + 2)) throw new MultipartError("the multipart body ends mid-boundary");
      if (buf[skip] !== 0x0d || buf[skip + 1] !== 0x0a) {
        throw new MultipartError("a multipart boundary is not followed by a line break");
      }
      buf = buf.subarray(skip + 2);

      // The part's header block, up to the blank line.
      const blank = encoder.encode("\r\n\r\n");
      let headEnd = indexOfSub(buf, blank, 0);
      while (headEnd < 0) {
        if (buf.length > MAX_PART_HEADERS) {
          throw new MultipartError("a multipart part's headers are too long");
        }
        if (!await pull()) throw new MultipartError("a multipart part has no headers");
        headEnd = indexOfSub(buf, blank, 0);
      }
      const { name, filename } = dispositionOf(decoder.decode(buf.subarray(0, headEnd)));
      buf = buf.subarray(headEnd + blank.length);

      // The part's body, up to the next delimiter — streamed for the file, collected otherwise.
      const isFile = name === fileField;
      if (isFile && fileBytes !== null) {
        throw new MultipartError(`the multipart body carries \`${fileField}\` twice`);
      }
      const max = isFile ? limits.maxFileBytes : limits.maxFieldBytes;
      let seen = 0;
      let collected: Uint8Array<ArrayBuffer> = new Uint8Array(0);
      const take = async (bytes: Uint8Array) => {
        seen += bytes.length;
        if (seen > max) {
          throw new MultipartError(
            isFile
              ? `the bundle exceeds ${limits.maxFileBytes} bytes`
              : `a multipart field exceeds ${limits.maxFieldBytes} bytes`,
            true,
          );
        }
        if (isFile) await sink(bytes);
        else collected = concat(collected, bytes);
      };
      for (;;) {
        const at = indexOfSub(buf, delimiter, 0);
        if (at >= 0) {
          await take(buf.subarray(0, at));
          buf = buf.subarray(at);
          break;
        }
        // Everything but a possible partial delimiter is settled and can be handed on.
        const keep = delimiter.length - 1;
        if (buf.length > keep) {
          await take(buf.subarray(0, buf.length - keep));
          buf = buf.subarray(buf.length - keep);
        }
        if (!await pull()) throw new MultipartError("a multipart part is not terminated");
      }
      if (isFile) fileBytes = seen;
      else if (filename === null) fields[name] = decoder.decode(collected);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
