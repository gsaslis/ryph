// The enforced dependency rule for the shared helpers — the same rule as @ryph/sealed's: src/
// imports src/ and nothing else, node: built-ins included. Run via `bun run guard`.
//
// Two things rest on this. The app's browser code and the services' fenced core/ scopes import
// these modules, so an edge added here — a registry package, a node: built-in, a sibling member —
// lands in all of them, including a bundle that has no node: to give. And the service guards walk
// direct edges only: `../shared/` stays an allowance to a leaf only for as long as this package
// reaches nothing, or a fence that names it would report "clean" while reaching anything at all.

import { checkSelfContained } from "../../../scripts/architecture_guard.ts";

await checkSelfContained({
  root: import.meta.url,
  failure: "The shared helpers depend on nothing. Web-platform globals and their own files only.",
});
