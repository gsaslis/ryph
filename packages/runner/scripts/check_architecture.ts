// The enforced dependency rule (see docs/architecture.md). Run via `bun run guard`; wired into CI.
//
// Walks the resolved module graph and fails if a fenced scope imports outside its allowance:
//   src/core     may reach only src/core, src/ports, src/helpers, @ryph/process and the kits
//   src/helpers  may reach only src/helpers, src/core, @ryph/process and the kits
//   src/ports    may reach only src/ports, src/core
// Only local (file://) edges are fenced, a workspace package's included: it resolves to its own
// files under packages/. Registry imports (npm:) and node: built-ins live outside the graph and
// are always allowed. @ryph/process is how the core and the helpers spawn bash and git, so it is
// allowed to them as a runtime built-in would be; so are the kits @ryph/shared and @ryph/sealed,
// which import nothing outside themselves. Type-only edges (`import type`)
// count: a fenced scope may not even name a forbidden module in a type position.

import { checkArchitecture } from "../../../scripts/architecture_guard.ts";

await checkArchitecture({
  root: import.meta.url,
  entry: "src/main.ts",
  rules: [
    {
      scope: "src/core/",
      allowed: [
        "src/core/",
        "src/ports/",
        "src/helpers/",
        "../process/",
        "../shared/",
        "../sealed/",
      ],
    },
    {
      scope: "src/helpers/",
      allowed: ["src/helpers/", "src/core/", "../process/", "../shared/", "../sealed/"],
    },
    { scope: "src/ports/", allowed: ["src/ports/", "src/core/"] },
  ],
  docs: "docs/architecture.md",
});
