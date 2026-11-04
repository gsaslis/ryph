// Reading the PAGE a tool call fetches, with a byte cap that bites WHILE it streams: a chunked
// body announces no length, and buffering first to measure after is exactly the unbounded
// allocation the cap exists to prevent. Unlike @ryph/shared/http's readers, which refuse a body
// past the cap, this one keeps what fits and says it was cut — a page's first megabytes are
// still worth reading, and the agent is told where it ends.

export interface CappedRead {
  /** The bytes read, decoded by the caller — never more than the cap. */
  bytes: Uint8Array;
  /** Whether the stream had more and was cut here. */
  truncated: boolean;
}

/** Reads up to `max` bytes, cancelling the rest. Never throws for size; a reset still throws. */
export async function readTruncated(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<CappedRead> {
  if (body === null) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    seen += value.byteLength;
    if (seen < max) continue;
    // At or past the cap. `seen > max` proves there was more; landing EXACTLY on it proves
    // nothing, so read once more to find out — the difference between "cut" and "complete" is
    // what the agent is told, and a page whose length is a multiple of the chunk size must not
    // report itself whole when it is not. One extra read, discarded.
    if (seen > max) truncated = true;
    else {
      const next = await reader.read();
      if (!next.done) {
        truncated = true;
        seen += next.value.byteLength;
        chunks.push(next.value);
      }
    }
    reader.cancel().catch(() => {});
    break;
  }
  const all = new Uint8Array(seen);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: seen > max ? all.subarray(0, max) : all, truncated };
}
