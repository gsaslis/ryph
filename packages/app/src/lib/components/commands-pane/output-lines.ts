import type { OutputChunk } from "./commands-view";

/** How a line reads at a glance: tinted when it reports a failure, or a run that passed. */
export type LineTone = "error" | "success" | null;

/** One line of a command's output as drawn: its text, without the newline that ended it. */
export interface OutputLine {
  text: string;
  /** Ended by a newline in the output, which counts toward the chunks it came from. */
  ended: boolean;
  /** A note of ours (output the runner skipped), not the command's own text. */
  note: boolean;
}

/** What one change did to the lines: the view drops `dropped` from the front, then redraws from
 * `from` (an index after the drop) to the end. */
export interface LinesChange {
  dropped: number;
  from: number;
}

/**
 * A command's output cut into lines, kept in step with the chunks it arrives in. Chunks do not
 * align with lines, so a chunk may extend the open last line and add more; and when the buffer lets
 * its oldest chunks go, as many characters go from the front here, part of a line if need be.
 * Each change says which lines moved, so a view redraws only those: output that keeps arriving
 * costs the lines it adds, never the whole log.
 */
export class OutputLines {
  readonly lines: OutputLine[] = [];
  /** The characters each chunk held, oldest first: what a trim of so many chunks takes away. */
  #chunkChars: number[] = [];

  /** Start over from these chunks. */
  reset(chunks: readonly OutputChunk[]): LinesChange {
    const dropped = this.lines.length;
    this.lines.length = 0;
    this.#chunkChars = [];
    for (const chunk of chunks) this.append(chunk);
    return { dropped, from: 0 };
  }

  append(chunk: OutputChunk): LinesChange {
    this.#chunkChars.push(chunk.text.length);
    const last = this.lines.at(-1);
    const open = last !== undefined && !last.ended && !last.note ? last : undefined;
    if (chunk.skipped) {
      // A note stands on a line of its own, whatever the line it interrupted.
      const from = this.lines.length;
      this.lines.push({ text: chunk.text.replace(/\n$/, ""), ended: false, note: true });
      return { dropped: 0, from };
    }
    const parts = chunk.text.split("\n");
    let from = this.lines.length;
    if (open !== undefined) {
      open.text += parts[0];
      from -= 1;
    } else {
      this.lines.push({ text: parts[0], ended: false, note: false });
    }
    for (let i = 1; i < parts.length; i++) {
      (this.lines.at(-1) as OutputLine).ended = true;
      // The text after a final newline is the next line, still empty: it opens only once
      // something is written to it.
      if (i === parts.length - 1 && parts[i] === "") break;
      this.lines.push({ text: parts[i], ended: false, note: false });
    }
    return { dropped: 0, from };
  }

  /** The buffer let its oldest `count` chunks go. */
  trim(count: number): LinesChange {
    let chars = 0;
    for (const length of this.#chunkChars.splice(0, count)) chars += length;
    let dropped = 0;
    while (chars > 0 && dropped < this.lines.length) {
      const line = this.lines[dropped];
      const length = line.note ? line.text.length + 1 : line.text.length + (line.ended ? 1 : 0);
      if (length > chars) {
        line.text = line.text.slice(chars);
        break;
      }
      chars -= length;
      dropped++;
    }
    this.lines.splice(0, dropped);
    return { dropped, from: 0 };
  }
}

const FAILURE =
  /\b(error|errors|failed|failure|failures|fatal|panic|panicked|exception|traceback)\b|\bERR!/i;
const NOT_A_FAILURE = /\b(0|no) (errors?|failed|failures?)\b/i;
const PASSED = /^\s*(ok\b|pass(ed)?\b|success\b|✓)|\b\d+ passed\b/i;

/**
 * A guess at what a line says: a failure, or a summary that passed. Only a tint for the eye; the
 * text is the command's own and is never changed.
 */
export function lineTone(text: string): LineTone {
  if (text.length > 500) return null;
  if (FAILURE.test(text)) {
    // "ok | 2 passed | 0 failed" is a pass, however it says it.
    if (NOT_A_FAILURE.test(text) && !/\b[1-9]\d* (failed|errors?)\b/i.test(text)) {
      return PASSED.test(text) ? "success" : null;
    }
    return "error";
  }
  return PASSED.test(text) ? "success" : null;
}
