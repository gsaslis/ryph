// Which servers the platform knows how to host, as the core sees it. Today one adapter stands
// behind this — a directory of JSON files shipped with the package (adapters/catalogue/
// directory.ts) — and nothing reaches the network to learn what to run, which is the right
// default for the thing that decides which images the platform launches. A separately run
// catalogue service, once entries outnumber releases, replaces the directory here without the
// gateway noticing: that is why this is a port and not an import.

import type { CatalogueEntry } from "../core/catalogue.ts";

export interface Catalogue {
  /** Every entry, sorted by name. Already validated: an invalid entry never gets this far. */
  list(): Promise<CatalogueEntry[]>;
  get(id: string): Promise<CatalogueEntry | null>;
}
