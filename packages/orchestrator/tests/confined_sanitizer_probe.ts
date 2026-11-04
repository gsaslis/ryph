// For tests/artifact_html_test.ts: run with the confined sanitizer's own flags in its place, it
// proves its confinement as the sanitizer does, then answers how each thing a parse gone wrong
// might try fails: writing a file, reading one that is not its own, opening a socket, fetching,
// starting a program or a worker. `argv[2]` is a file to try to write, `argv[3]` a port that
// accepts connections.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import {
  assertConfined,
  sanitizerModules,
} from "../src/adapters/artifact_html/sanitizer_permissions.ts";

const [target, port] = process.argv.slice(2);
// Granted reading itself too, as the sanitizer's stand-in.
assertConfined([...sanitizerModules(), fileURLToPath(import.meta.url)]);
const failure = async (attempt: () => unknown) => {
  try {
    await attempt();
    return "allowed";
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).name;
  }
};
const result = {
  write: await failure(() => writeFileSync(target, "x")),
  read: await failure(() => readFileSync("/etc/hosts")),
  net: await failure(() =>
    new Promise<void>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    })
  ),
  fetch: await failure(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch (err) {
      throw (err as { cause?: unknown }).cause ?? err;
    }
  }),
  spawn: await failure(() => {
    const out = spawnSync("/bin/sh", ["-c", "true"]);
    if (out.error) throw out.error;
  }),
  worker: await failure(() => new Worker("1", { eval: true })),
};
process.stdout.write(JSON.stringify(result), () => process.exit(0));
