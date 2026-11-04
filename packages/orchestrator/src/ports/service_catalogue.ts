// Which service images this platform knows how to run safely, as the core sees it.
//
// One adapter stands behind it today — a directory of JSON files shipped with the package —
// and nothing reaches the network to learn what to run, which is the right default for the
// thing that decides what the platform launches on an operator's machines. A catalogue service,
// once entries outnumber releases, replaces the directory without the core noticing: that is
// why this is a port and not an import, and it is the same argument
// @ryph/mcp-gateway's ports/catalogue.ts makes for its own.

import type { ServiceCatalogueEntry } from "../core/services.ts";

export interface ServiceCatalogue {
  /** Every entry, sorted by name. Already validated: an invalid entry never gets this far. */
  list(): Promise<ServiceCatalogueEntry[]>;
}
