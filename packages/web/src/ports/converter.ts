// Turning fetched HTML into markdown is the one EXPENSIVE thing this service does, and the input
// is a page an agent was talked into fetching — so it is a port rather than a function call:
// what stands behind it is a bounded, killable worker in the running service (adapters/convert),
// and the in-process conversion in a test that wants to check the markdown itself.
//
// Measured, per megabyte of adversarial HTML (which is the cap core/page.ts reads to): link-dense
// soup ~1.1 s and ~400 MB resident, table soup ~0.6 s, and a deeply nested page 53 SECONDS.
// Blocking is the worse half — this process serves every run's tool calls on one event loop, so
// one such page stalls everybody's, and no request-level timeout helps because nothing yields.
// Hence a budget that can actually be enforced (a worker that is terminated) and a ceiling on how
// many may run at once.

import type { ConvertedPage } from "../core/markdown.ts";

export interface Converter {
  /**
   * HTML → markdown, or a ConversionRefusedError. `url` resolves the page's relative links.
   * Never throws anything else: a library that dies on a page is the refusal too.
   */
  convert(html: string, url: string): Promise<ConvertedPage>;
  /** Frees whatever the converter holds. After it, `convert` refuses. */
  close(): void;
}

/**
 * A refusal the AGENT reads, because the agent is who has to do something about it: ask for a
 * smaller page, or try again. The message names the budget or the ceiling it hit — a number a
 * model can act on, and one that tells an operator reading the same line which knob it was.
 */
export class ConversionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionRefusedError";
  }
}
