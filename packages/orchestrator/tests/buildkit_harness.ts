// A BuildKit script (buildkit_script.ts `buildScript`) run for real under `sh`, with /work moved
// to a scratch directory and every tool it drives replaced by a stub that records its argv:
// `buildkitd` (and `rootlesskit` in front of it), `buildctl` and `iptables`. What a test reads is
// what the script DID — the daemon it started, each pass, each firewall rule, the files it wrote,
// the result it printed — whichever shell file or header the behaviour lives in.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";

/** The digest a stub pass reports for each target: one hex digit repeated, by target. */
export const STUB_DIGESTS: Record<string, string> = {
  machine: "sha256:" + "a".repeat(64),
  environment: "sha256:" + "e".repeat(64),
  baked: "sha256:" + "b".repeat(64),
};

export interface BuildRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Every stub call, `<tool> <args…>`, in order. */
  calls: string[];
  /** A file the script left on the work volume (`out/result`, `buildkitd.toml`, …), or null. */
  file(path: string): Promise<string | null>;
}

export interface BuildRunOptions {
  /** What the image's machine record says (a warm build reads it); the machine's own digest by
   * default, so a warm build stays warm. */
  recorded?: string;
  /** buildkitd dies at once and never answers. */
  daemonDies?: boolean;
  /** The env the script runs with, beyond PATH. */
  env?: Record<string, string>;
}

/**
 * Runs `script` and hands back what it did. The work volume is kept until `file` has been read
 * as often as the test likes; the scratch directory is removed when `use` returns.
 */
export async function runBuild<T>(
  script: string,
  use: (run: BuildRun) => Promise<T> | T,
  opts: BuildRunOptions = {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ryph-build-"));
  try {
    const bin = `${dir}/bin`;
    await mkdir(bin);
    const calls = `${dir}/calls`;
    const stub = async (name: string, body: string) => {
      await writeFile(`${bin}/${name}`, `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`);
      await chmod(`${bin}/${name}`, 0o755);
    };
    await stub("buildkitd", opts.daemonDies ? "exit 1" : "exec sleep 60");
    await stub("rootlesskit", 'exec "$@"');
    await stub("iptables", "exit 0");
    await stub(
      "buildctl",
      [
        // Ready once the daemon is up, as the real one answers: the script's own wait is tested.
        opts.daemonDies
          ? '[ "$1" = debug ] && exit 1'
          : `[ "$1" = debug ] && { grep -q '^buildkitd ' '${calls}'; exit; }`,
        "meta= out= target=",
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        "    --metadata-file) meta=$2 ;;",
        "    --output) out=$2 ;;",
        '    --opt) case "$2" in target=*) target=${2#target=} ;; esac ;;',
        "  esac",
        "  shift",
        "done",
        `case "$target" in`,
        `  machine-record) digest=x ;;`,
        `  environment) digest='${STUB_DIGESTS.environment}' ;;`,
        `  baked) digest='${STUB_DIGESTS.baked}' ;;`,
        `  *) digest='${STUB_DIGESTS.machine}' ;;`,
        "esac",
        `[ -z "$meta" ] || printf '{"containerimage.digest": "%s"}\\n' "$digest" > "$meta"`,
        'case "$out" in type=local,dest=*)',
        '  dest=${out#type=local,dest=}; mkdir -p "$dest"',
        `  printf '%s\\n' '${opts.recorded ?? STUB_DIGESTS.machine}' > "$dest/machine"`,
        `  printf '{\\n"rustc": "1.97.1"\\n}\\n' > "$dest/toolchains.json"`,
        ";; esac",
        'echo "#1 pushing manifest done"',
      ].join("\n"),
    );
    const work = `${dir}/work`;
    const out = await command("sh", {
      args: ["-c", script.replaceAll("/work", work)],
      cwd: dir,
      // Only what the test names: a proxy or XDG_RUNTIME_DIR of the machine running it would
      // change what the script does.
      env: { HOME: dir, ...opts.env, PATH: `${bin}:${process.env.PATH}` },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder();
    const recorded = await readFile(calls, "utf8").catch(() => "");
    return await use({
      code: out.code,
      stdout: text.decode(out.stdout),
      stderr: text.decode(out.stderr),
      calls: recorded.split("\n").filter((line) => line !== "")
        .map((line) => line.replaceAll(work, "/work")),
      file: (path) => readFile(`${work}/${path}`, "utf8").catch(() => null),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
