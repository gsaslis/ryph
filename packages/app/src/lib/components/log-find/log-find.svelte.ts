import { logMatchLines, MAX_LOG_MATCHES } from "$lib/utils/checks";

/**
 * Find in a log: what the find bar holds and where it is in the matches. The log is read through
 * `log`, so the matches follow it as it grows. A page that wants the find to start over (another
 * suite, another build) makes a new one.
 */
export class LogFind {
  query = $state("");
  index = $state(0);
  readonly #log: () => string | null;

  constructor(log: () => string | null) {
    this.#log = log;
  }

  readonly matches = $derived.by(() => {
    const log = this.#log();
    return log === null ? [] : logMatchLines(log, this.query);
  });

  /** The current match's line, one-based, for the log view to show and mark. */
  readonly line = $derived(
    this.matches.length === 0 ? null : this.matches[Math.min(this.index, this.matches.length - 1)],
  );

  readonly label = $derived(
    this.matches.length === 0
      ? "No matches"
      : `${Math.min(this.index, this.matches.length - 1) + 1} of ${this.matches.length}${
        this.matches.length === MAX_LOG_MATCHES ? "+" : ""
      }`,
  );

  step(by: 1 | -1) {
    if (this.matches.length === 0) return;
    const at = Math.min(this.index, this.matches.length - 1);
    this.index = (at + by + this.matches.length) % this.matches.length;
  }

  /** Enter walks the matches, Shift+Enter back; Escape clears the query. */
  onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape" && this.query !== "") {
      e.preventDefault();
      this.query = "";
    }
  }
}
