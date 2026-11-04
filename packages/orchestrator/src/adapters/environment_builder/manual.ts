// A "manual" `EnvironmentBuilder` for development: nothing is built. Like the manual provisioner,
// it narrates — the clone, the generated Dockerfile and the build a human would run — so the
// scheduling around a build can be exercised with no docker in the loop. The build itself is
// refused, because there is no image for a run to freeze.

import type { AdoptResult, EnvironmentBuilder } from "../../ports/environment_builder.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  assertBuildable,
  cloneArgs,
  cloneScript,
  environmentDockerfile,
  relayerDockerfile,
  shellQuote,
} from "./dockerfile.ts";

export const MANUAL_REFUSAL =
  "the manual builder builds nothing: set RYPH_ENV_BUILDER=docker (or kubernetes) to build " +
  "environments. Runs use the default image meanwhile.";

export function manualEnvironmentBuilder(diag: Diagnostics): EnvironmentBuilder {
  return {
    kind: "manual",
    /** This builder narrates and refuses; it never starts anything, so it has nothing to hand
     * back and says so rather than leave a row waiting on a build that does not exist. */
    adopt(): Promise<AdoptResult> {
      return Promise.resolve({ kind: "gone" });
    },
    /** It narrates and builds nothing, so there is nothing to drop either. */
    discard(): Promise<void> {
      return Promise.resolve();
    },
    /** Nothing ever runs here, so there is nothing to show. */
    liveLog(): Promise<string | null> {
      return Promise.resolve(null);
    },
    build(spec) {
      assertBuildable(spec);
      const rule = "─".repeat(60);
      const narration = spec.relayerFrom !== null
        ? [
          rule,
          `environment ${spec.environmentId} for ${spec.subjectKey} — a re-layer, by hand:`,
          `# build this file with --build-arg RYPH_BAKED=${spec.relayerFrom} ` +
          `--build-arg RYPH_HARNESS=${spec.harnessImage}:`,
          relayerDockerfile().trimEnd(),
          rule,
        ].join("\n")
        : [
          rule,
          `environment ${spec.environmentId} for ${spec.subjectKey} — built by hand, if at all:`,
          "",
          "# 1. clone, into an empty directory (the git credential is not shown), with this script",
          `#    as \`bash clone.sh ${cloneArgs(spec).map(shellQuote).join(" ")}\`:`,
          cloneScript().trimEnd(),
          "",
          spec.dockerfileFrom === null
            ? `# 2. the machine is the universal image: ${spec.baseImage}`
            : `# 2. build the machine: docker build -f ${spec.dockerfileFrom}/.ryph/Dockerfile ` +
              `${spec.dockerfileFrom}`,
          "",
          "# 3. build this file with --build-arg RYPH_MACHINE=<machine> " +
          `--build-arg RYPH_HARNESS=${spec.harnessImage} --build-context checkout=<clones>:`,
          environmentDockerfile().trimEnd(),
          rule,
        ].join("\n");
      diag.warn("environment_builder.manual", { environmentId: spec.environmentId, narration });
      return Promise.resolve({
        ok: false,
        kind: "refused",
        message: MANUAL_REFUSAL,
        logTail: MANUAL_REFUSAL,
        log: `${narration}\n${MANUAL_REFUSAL}\n`,
      });
    },
  };
}
