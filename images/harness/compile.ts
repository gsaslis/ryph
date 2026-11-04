// Compiles the runner and the baker for the harness layer — run from packages/runner by
// images/harness/Dockerfile. A build script rather than `bun build` on the command line because
// @ryph/service's `realWs()` loads the real `ws` as `ryph:ws` in a binary, which only a plugin can
// map (packages/ryph/scripts/compile.ts does the same for the ryph binary).
//
// A compiled binary would otherwise read the cwd's .env and bunfig.toml — and run a bunfig's
// `preload` — so both are off: the runner works in checkouts of arbitrary repositories.
import { realpathSync } from "node:fs";

const realWsEntry = realpathSync(
  Bun.resolveSync("ws/package.json", "/src/packages/service").replace(/package\.json$/, "index.js"),
);

for (
  const [entry, outfile] of [
    ["src/main.ts", "/opt/ryph/bin/ryph-runner"],
    ["src/bake.ts", "/opt/ryph/bin/ryph-bake"],
  ]
) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    define: { RYPH_STANDALONE: "true" },
    compile: { outfile, autoloadDotenv: false, autoloadBunfig: false },
    plugins: [{
      name: "ryph-ws",
      setup(build) {
        build.onResolve({ filter: /^ryph:ws$/ }, () => ({ path: realWsEntry }));
      },
    }],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
