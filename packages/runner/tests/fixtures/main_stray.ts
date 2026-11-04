// The runner's binary entry, with a stray beside it: a child in a session of its own that ignores
// every signal it could be sent and holds a pipe to the runner open — what a background job that
// will not die leaves behind. It keeps the event loop alive for as long as it lives, so the
// runner exits only by exiting explicitly (tests/runner_exit_test.ts). Its pid goes to stderr
// first, for the test to clear.

import { command } from "@ryph/process";
import { runToExit } from "../../src/main.ts";

const stray = await command("bash", {
  args: ["-c", "trap '' TERM INT HUP; exec sleep 600"],
  detached: true,
  stdin: "null",
  stdout: "piped",
  stderr: "null",
}).spawn();
console.error(`stray ${stray.pid}`);

await runToExit(process.argv.slice(2));
