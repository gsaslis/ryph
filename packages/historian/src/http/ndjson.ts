// Line splitting for a long-lived NDJSON body, without ever holding more than one line of it. The
// live uplink is a POST that stays open for the length of a run, so `req.text()` would never
// return and a line-buffering TextDecoderStream would hold an over-long line in full before anyone
// could refuse it. This measures in BYTES as they arrive and stops collecting a line the moment it
// passes the cap, skipping to the next newline instead.

/** A complete line (without its newline), or `null` for one that was over the cap and skipped. */
export async function* ndjsonLines(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
  maxLineBytes: number,
): AsyncGenerator<string | null> {
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [];
  let size = 0;
  let skipping = false;

  const line = (): string => {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    parts = [];
    size = 0;
    return decoder.decode(bytes);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    let start = 0;
    while (start <= value.length) {
      const newline = value.indexOf(0x0a, start);
      const end = newline === -1 ? value.length : newline;
      if (!skipping) {
        if (size + (end - start) > maxLineBytes) {
          skipping = true;
          parts = [];
          size = 0;
        } else if (end > start) {
          // A copy: the reader is free to reuse its chunk once we ask for the next one.
          parts.push(value.slice(start, end));
          size += end - start;
        }
      }
      if (newline === -1) break;
      if (skipping) {
        skipping = false;
        yield null;
      } else {
        yield line();
      }
      start = newline + 1;
    }
  }
  // A last line with no newline after it is still a line.
  if (skipping) yield null;
  else if (size > 0) yield line();
}
