// The compiled binary's entry (scripts/compile.ts): the CLI, or, as
// `ryph __artifact-sanitizer <runtimeDir> <budgetMs> <heapMb>`, the artifact sanitizer process
// the control plane starts per publish (@ryph/orchestrator's adapters/artifact_html/). Inside a
// compiled binary, `process.execPath` is this binary, so that is how the control plane
// re-executes itself as a sanitizer with no runtime installed. Decided before main.ts is imported: the sanitizer
// loads its own few modules, never the whole control plane's graph.

import {
  ARTIFACT_SANITIZER_SUBCOMMAND,
  runArtifactSanitizer,
} from "@ryph/orchestrator/artifact-sanitizer";
import { hostileEnvironment } from "@ryph/shared/env";

const hostile = hostileEnvironment(process.env);
if (hostile !== null) {
  console.error(`ryph: refusing to start: ${hostile.message}`);
  process.exit(2);
}
if (process.argv.slice(2)[0] === ARTIFACT_SANITIZER_SUBCOMMAND) {
  // The runtime directory was taken by the build's resources module (src/resources.ts).
  await runArtifactSanitizer(process.argv.slice(2).slice(2));
} else {
  const { cli } = await import("./main.ts");
  await cli(process.argv.slice(2));
}
