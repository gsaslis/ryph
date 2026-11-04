// The enforced dependency rule, same shape as @ryph/runner's guard. Run via `bun run guard`.
//
// Walks the resolved module graph and fails if a fenced scope imports outside its allowance:
//   src/core     may reach only src/core, src/ports, src/helpers (and the shared @ryph/shared
//                kit)
//   src/helpers  may reach only src/helpers, src/core, @ryph/shared, and @ryph/process (which
//                spawns git)
//   src/ports    may reach only src/ports, src/core
// src/http and src/adapters are the outer layer and stay unfenced, like the composition root.
// Only local (file://) edges are fenced; a workspace package resolves to its real file under
// packages/ and is a local edge too. Registry imports (npm:) and node: built-ins live outside the
// graph and are always allowed. Type-only edges count.

import { checkArchitecture } from "../../../scripts/architecture_guard.ts";

await checkArchitecture({
  root: import.meta.url,
  entry: "src/main.ts",
  rules: [
    { scope: "src/core/", allowed: ["src/core/", "src/ports/", "src/helpers/", "../shared/"] },
    { scope: "src/helpers/", allowed: ["src/helpers/", "src/core/", "../shared/", "../process/"] },
    { scope: "src/ports/", allowed: ["src/ports/", "src/core/"] },
  ],
  docs: "the runner's docs/architecture.md",
});
