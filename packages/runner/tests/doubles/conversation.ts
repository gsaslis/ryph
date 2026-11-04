// A conversation nobody speaks to, whose run ends at the agent's first settle: what a harness
// sees of a run the agent finished in its first turn.

import type { HarnessConversation, HarnessMessage } from "../../src/ports/harness.ts";

export function endsAtSettle(): HarnessConversation {
  const done = new AbortController();
  // No message ever arrives: the iteration ends once the run is over.
  const ended = (): Promise<IteratorResult<HarnessMessage>> =>
    new Promise((resolve) => {
      const end = () => resolve({ done: true, value: undefined });
      if (done.signal.aborted) end();
      else done.signal.addEventListener("abort", end, { once: true });
    });
  return {
    messages: { [Symbol.asyncIterator]: () => ({ next: ended }) },
    done: done.signal,
    onSettled() {
      done.abort();
    },
  };
}
