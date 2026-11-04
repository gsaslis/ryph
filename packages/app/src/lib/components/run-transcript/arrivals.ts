import type { TranscriptRow } from "$lib/components/run-history/run-history.svelte";

/** One tracker per transcript. Logical keys survive virtualiser remounts; sequence high-water
 * marks distinguish new speech from older pages or previously hidden rows becoming visible. */
export class TranscriptArrivals {
  #previous: Set<string> | null = null;
  #lastSeq = -1;
  #messageSeq = -1;

  update(rows: readonly TranscriptRow[], lastSeq: number): Set<string> {
    const arrivals = new Set<string>();
    const keys = new Set<string>();
    let messageSeq = this.#messageSeq;
    for (const row of rows) {
      keys.add(row.key);
      if (row.kind === "message") messageSeq = Math.max(messageSeq, row.message.seq);
      if (this.#previous === null || this.#previous.has(row.key)) continue;
      switch (row.kind) {
        case "event":
          if (row.event.seq > this.#lastSeq) arrivals.add(row.key);
          break;
        case "tool":
          if (row.call.seq > this.#lastSeq) arrivals.add(row.key);
          break;
        case "background":
        case "subagent":
          if (row.seq > this.#lastSeq) arrivals.add(row.key);
          break;
        case "message":
          if (row.message.seq > this.#messageSeq) arrivals.add(row.key);
          break;
        case "result":
          arrivals.add(row.key);
          break;
      }
    }
    this.#previous = keys;
    this.#lastSeq = Math.max(this.#lastSeq, lastSeq);
    this.#messageSeq = messageSeq;
    return arrivals;
  }
}
