/**
 * Read-side view of agent run containers (the ephemeral "Jobs" of the stack).
 * The docker provisioner names them `ryph-run-<runId>` and labels them `ryph.run=<runId>`.
 */

import { command } from "@ryph/process";

export interface RunContainer {
  id: string;
  runId: string;
  state: string;
  status: string;
  running: boolean;
}

/** Lists run containers newest-first, or null when docker is unavailable. */
export async function listRuns(): Promise<RunContainer[] | null> {
  let out;
  try {
    out = await command("docker", {
      args: [
        "ps",
        "-a",
        "--filter",
        "label=ryph.run",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}",
      ],
    }).output();
  } catch {
    return null;
  }
  if (!out.success) return null;
  return new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, name, state, status] = line.split("\t");
      return {
        id,
        runId: name.replace(/^ryph-run-/, ""),
        state,
        status,
        running: state === "running",
      };
    });
}

/** Removes the given containers, force-stopping any that still run. */
export async function removeContainers(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { success, stderr } = await command("docker", {
    args: ["rm", "-f", ...ids],
  }).output();
  if (!success) {
    throw new Error(
      `docker rm failed: ${new TextDecoder().decode(stderr).trim()}`,
    );
  }
}

/** Gets a container's exit code, or null when docker can't say. */
export async function exitCode(id: string): Promise<number | null> {
  try {
    const out = await command("docker", {
      args: ["inspect", "-f", "{{.State.ExitCode}}", id],
    }).output();
    if (!out.success) return null;
    const code = parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
    return Number.isNaN(code) ? null : code;
  } catch {
    return null;
  }
}

/** Streams a container's logs line-by-line to `onLine`, stdout and stderr merged. */
export async function pipeLogs(
  id: string,
  follow: boolean,
  onLine: (line: string) => void,
): Promise<void> {
  const child = await command("docker", {
    args: follow ? ["logs", "-f", id] : ["logs", id],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await Promise.all([
    readLines(child.stdout, onLine),
    readLines(child.stderr, onLine),
  ]);
  await child.status;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  let buf = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  }
  if (buf.length > 0) onLine(buf);
}

/** Streams a container's logs to the terminal; resolves when the stream ends. */
export async function streamLogs(id: string, follow: boolean): Promise<void> {
  const args = follow ? ["logs", "-f", id] : ["logs", id];
  await command("docker", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
}
