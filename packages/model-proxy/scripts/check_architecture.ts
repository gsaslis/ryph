// The enforced dependency rule, same shape as @ryph/runner's guard. Run via `bun run guard`.
//
// Walks the resolved module graph and fails if a fenced scope imports outside its allowance:
//   src/core     may reach only src/core, src/ports (and the shared @ryph/sealed kit)
//   src/ports    may reach only src/ports, src/core
// src/http and src/adapters are the outer layer and stay unfenced, like the composition root.
// Only local (file://) edges are fenced. Registry packages and node:
// built-ins live outside the graph and are always allowed. Type-only edges count.
// A sibling workspace member resolves to file:// too, so it is fenced like local code and shows
// up as "../<member>/"; the only ones a fenced scope may name are the shared kits (@ryph/sealed).

import { checkArchitecture } from "../../../scripts/architecture_guard.ts";

await checkArchitecture({
  root: import.meta.url,
  entry: "src/main.ts",
  rules: [
    { scope: "src/core/", allowed: ["src/core/", "src/ports/", "../sealed/"] },
    { scope: "src/ports/", allowed: ["src/ports/", "src/core/"] },
  ],
  docs: "the runner's docs/architecture.md",
});
