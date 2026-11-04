// The enforced dependency rule, same shape as @ryph/runner's guard. Run via `bun run guard`.
//
// Walks the resolved module graph and fails if a fenced scope imports outside its allowance:
//   src/core     may reach only src/core, src/ports
//   src/ports    may reach only src/ports, src/core
// src/http and src/adapters are the outer layer and stay unfenced. The chat service has no
// process of its own in the default deployment (it mounts inside a host), so the graph roots at src/mod.ts.
// Only local (file://) edges are fenced. Registry imports (jsr:, npm:, https:) and node:
// built-ins live outside the graph and are always allowed. Type-only edges count.

import { checkArchitecture } from "../../../scripts/architecture_guard.ts";

await checkArchitecture({
  root: import.meta.url,
  entry: "src/mod.ts",
  rules: [
    { scope: "src/core/", allowed: ["src/core/", "src/ports/"] },
    { scope: "src/ports/", allowed: ["src/ports/", "src/core/"] },
  ],
  docs: "the runner's docs/architecture.md",
});
