// The enforced dependency rule, same shape as @ryph/web's guard. Run via `bun run guard`.
//
// Walks the resolved module graph and fails if a fenced scope imports outside its allowance:
//   src/core     may reach only src/core and @ryph/shared — and never playwright-core: the core is what the unit
//                tests cover without a browser, so a Chromium type creeping into it is a test
//                that silently needs one
// src/http, src/mcp and src/adapters are the outer layer and stay unfenced. The graph roots at
// src/main.ts, the process the image runs.
// Only local (file://) edges are fenced, plus the one named registry import above. Type-only
// edges count.

import { checkArchitecture } from "../../../scripts/architecture_guard.ts";

await checkArchitecture({
  root: import.meta.url,
  entry: "src/main.ts",
  rules: [
    { scope: "src/core/", allowed: ["src/core/", "../shared/"], forbidden: ["playwright-core"] },
  ],
});
