// A resolver for the suites: every name is a public address, so no test asks the real DNS.
// A test about where a name points passes its own.

import type { ResolveHost } from "../src/schema.ts";

/** An address `isBlockedAddress` lets through: globally routable, and nobody's in particular. */
export const PUBLIC_ADDRESS = "93.184.216.34";

export const publicDns: ResolveHost = () => Promise.resolve([PUBLIC_ADDRESS]);
