// The enforced dependency rule for the kit — the same walk as the service guards, with the
// simplest rule any of them has: src/ imports src/ and nothing else. Run via `bun run guard`.
//
// Two things rest on this. The README's "no dependencies, WebCrypto only" is a property of the
// code, not a promise: a jsr:, npm: or node: edge added here lands in every service that seals a
// secret. And `../sealed/` is the one allowance in the service guards that points at a package
// rather than a directory inside one — those guards walk direct edges only, so their fences stay
// transitive only for as long as this package reaches nothing. An import of @ryph/orchestrator
// in src/tokens.ts would otherwise leave all seven of them reporting "clean".

import { checkSelfContained } from "../../../scripts/architecture_guard.ts";

await checkSelfContained({
  root: import.meta.url,
  failure: "The kit depends on nothing. WebCrypto and its own files, or it is not the kit.",
});
