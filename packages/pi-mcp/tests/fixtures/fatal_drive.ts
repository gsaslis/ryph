// Drives the PRODUCTION extension instance (the default export, with its real `fatal`) from a
// child process, so the test can observe the exit code and the stderr line without taking the
// test runner down with it. Lives inside the package so the extension's bare imports resolve the
// way they do under `bun run test`.

import ext from "../../index.ts";

await ext({ registerTool() {}, on() {} });
console.log("unreachable: the factory should have exited the process");
