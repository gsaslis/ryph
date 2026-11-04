// A "manual" `Provisioner` for development: nothing is launched.
// It prints the container contract (the env a runner would receive) so a human can start a
// runner by hand — against this orchestrator, with real heartbeats and a real result report —
// without docker anywhere in the loop.

import type { Provisioner } from "../../ports/provisioner.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export function manualProvisioner(diag: Diagnostics): Provisioner {
  return {
    launch(spec) {
      // A single inline-env prefix so the contract pastes straight in front of the runner
      // command — no per-line `export`, no indentation to strip first.
      const envPrefix = Object.entries(spec.env)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(" ");
      const image = spec.image ?? "<no image configured>";
      const rule = "─".repeat(60);
      // Services are narrated rather than refused: this adapter's whole purpose is a
      // human-started runner, and it starts nothing, so the human must. Refusing instead would make the dev adapter the one
      // backend that cannot exercise the runner half of the feature it is used to develop.
      const services = (spec.services ?? []).map((s) =>
        `  ${s.name}:${s.port} ← ${s.image}${s.command ? ` ${s.command.join(" ")}` : ""}`
      );
      // Egress is narrated, and the narration says the uncomfortable half out loud. This adapter
      // launches nothing, so it confines nothing: a hand-started runner is a process on somebody's
      // laptop with that laptop's whole network. The env below may carry a proxy and an allowlist,
      // and the runner will honour them for its setup steps — but NOTHING STOPS the agent, or the
      // person, from reaching anything else. Silence here would let an operator read a configured
      // allowlist as an enforced one, which is the single most expensive thing this adapter could
      // imply.
      const egress = spec.env.RYPH_EGRESS_PROXY === undefined
        ? "no egress proxy is configured, and this adapter enforces no boundary of its own — " +
          "the runner reaches whatever this machine reaches"
        : `setup steps will use ${spec.env.RYPH_EGRESS_PROXY}, but NOTHING ENFORCES IT here: ` +
          "a hand-started runner has this machine's whole network. Use kubernetes for a real " +
          "boundary";
      // The size class, narrated: a hand-started runner gets whatever its machine has, and the
      // human starting it is the only one who can honour the class.
      const size = [
        spec.size.cpu === null ? null : `cpu=${spec.size.cpu}`,
        spec.size.memory === null ? null : `memory=${spec.size.memory}`,
        spec.size.ephemeralStorage === null
          ? null
          : `ephemeral-storage=${spec.size.ephemeralStorage}`,
        spec.size.workVolume === null ? null : `work-volume=${spec.size.workVolume} at /ryph/work`,
      ].filter((part) => part !== null).join(", ");
      // The wall clock, narrated: the reaper cancels the run at its limit; nothing here would
      // end a runner that ignores the cancel.
      const deadline = spec.deadlineSeconds === undefined
        ? ""
        : `deadline: ${spec.deadlineSeconds}s from launch — the reaper enforces it, this does not\n`;
      console.log(
        `\n${rule}\n` +
          `manual provisioner · run ${spec.runId} awaits a runner\n` +
          `image: ${image}\n` +
          `size: ${spec.size.name}${size === "" ? "" : ` (${size}) — not enforced here`}\n` +
          deadline +
          (services.length > 0
            ? `the run expects these reachable BY NAME before it starts:\n` +
              `${services.join("\n")}\n`
            : "") +
          `egress: ${egress}\n` +
          `prefix the runner command with this env, then the runner invocation:\n\n` +
          `${envPrefix}\n` +
          `${rule}`,
      );
      return Promise.resolve({ handle: `manual-${spec.runId}` });
    },
    kill(handle, { graceful }) {
      diag.debug("manual.kill_ignored", { handle, graceful });
      return Promise.resolve();
    },
    inspect() {
      // A manual runner's liveness is only knowable through its heartbeats.
      return Promise.resolve("unknown" as const);
    },
  };
}
