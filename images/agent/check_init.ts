import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../../packages/process/src/mod.ts";

/**
 * The agent image's init, tested as a run uses it: the image's own ENTRYPOINT with the runner
 * swapped for images/harness/test-init.sh, so tini is PID 1 with exactly the flags it ships with.
 * The harness build runs the same script, but there the RUN's shell is PID 1, not tini, so it
 * only tests tini as a subreaper. Used by `bun run agent-image` (images/agent/build.ts) and
 * `bun run images:publish` (images/publish.ts).
 *
 * It runs on docker's default runtime, runc. Production runs gVisor (runsc), which this does not
 * exercise: Docker Desktop has no runsc.
 *
 * The script travels as an argument to `bash -c`, never a bind mount, so it works against a
 * remote docker host and whatever the file's mode is. A docker failure is reported as one, never
 * as init's.
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "harness", "test-init.sh");
const RUNNER = "/opt/ryph/bin/ryph-runner";
const MARKER = "RYPH_INIT=tini";

const decoder = new TextDecoder();

/** One docker call, its output decoded. Never throws for a non-zero exit. */
async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code, stdout: decoder.decode(stdout).trim(), stderr: decoder.decode(stderr).trim() };
}

/**
 * Whether `image`'s init reaps an orphan as PID 1 and forwards TERM to its child. Prints what
 * failed, and whether docker or init failed it. `platform` (e.g. `linux/amd64`) runs an image
 * of another architecture under emulation; the image must be in the local store already.
 */
export async function checkInit(
  image: string,
  opts: { platform?: string } = {},
): Promise<boolean> {
  const fail = (what: string, detail = "") => {
    console.error(`✗ ${image}: ${what}`);
    if (detail) console.error(detail);
    return false;
  };
  const plat = opts.platform ? ["--platform", opts.platform] : [];

  // A local image only, as both callers just built it. Pulling one of another platform would
  // need `image inspect --platform`, which older docker lacks, and without it the containerd
  // store reads the host platform's config from a pulled index.
  const config = await docker(["image", "inspect", "--format", "{{json .Config}}", image]);
  if (config.code !== 0) return fail("docker could not inspect the local image", config.stderr);
  const { Entrypoint: entrypoint, Env: env } = JSON.parse(config.stdout) as {
    Entrypoint: string[] | null;
    Env: string[] | null;
  };
  if (entrypoint?.at(-1) !== RUNNER || entrypoint.length < 2) {
    return fail(
      `the ENTRYPOINT is not an init in front of the runner: ${JSON.stringify(entrypoint ?? null)}`,
    );
  }
  if (!env?.includes(MARKER)) return fail(`the image does not set ${MARKER}`);

  const script = await readFile(SCRIPT, "utf8");
  const [init, ...flags] = entrypoint.slice(0, -1);
  const run = (worker: string) =>
    docker([
      "run",
      "--rm",
      ...plat,
      "--entrypoint",
      init,
      image,
      ...flags,
      "bash",
      "-c",
      script,
      "test-init.sh",
      worker,
    ]);
  const checks = [
    { worker: "worker", expect: 42, what: "reap an orphan" },
    { worker: "signal-worker", expect: 43, what: "forward TERM to its child" },
  ];
  for (const { worker, expect, what } of checks) {
    const { code, stdout, stderr } = await run(worker);
    // Only 125 is docker's own failure. 126 and 127 come from the image: its init could not be
    // run, or could not run bash.
    if (code === 125) return fail("docker run failed (exit 125)", stderr);
    const output = `${stdout}\n${stderr}`.trim();
    if (code === 126 || code === 127) {
      return fail(`the image's init or bash could not start (exit ${code})`, output);
    }
    if (code !== expect) {
      return fail(`init did not ${what} as PID 1 (exit ${code})`, output);
    }
  }
  return true;
}
