// What the compiled binary reads as files, read from inside one: built by tests/binary_test.ts
// through scripts/compile.ts, exactly as the shipping binary is, and run there. Prints what it
// found as JSON; as `__artifact-sanitizer`, it is the sanitizer process, as the binary's entry is.

import { readdir, stat } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  ARTIFACT_SANITIZER_SUBCOMMAND,
  runArtifactSanitizer,
} from "@ryph/orchestrator/artifact-sanitizer";
import {
  APP_BUILD_DIR,
  BUNDLED_EMBEDDINGS,
  isCompiled,
  MIGRATION_SETS,
} from "../../src/embedded.ts";
import { hostileEnvironment } from "@ryph/shared/env";
import { workerConverter } from "../../../web/src/adapters/convert/worker_converter.ts";
import { serve } from "../../../service/src/mod.ts";
import { workerEmbedder } from "../../../memory/src/adapters/embed/worker_embedder.ts";
import { cosine } from "../../../memory/src/core/vector.ts";
import {
  processArtifactHtml,
  sanitizerRuntime,
} from "../../../orchestrator/src/adapters/artifact_html/process_preparer.ts";

// As the binary's entry (src/entry.ts) does first.
const hostile = hostileEnvironment(process.env);
if (hostile !== null) {
  console.error(`probe: refusing to start: ${hostile.message}`);
  process.exit(2);
}

if (process.argv[2] === ARTIFACT_SANITIZER_SUBCOMMAND) {
  await runArtifactSanitizer(process.argv.slice(4));
}

// One publish through the control plane's sanitizer, started as the host starts it: how it ran
// (confined under a node on PATH, or unconfined as this binary), what it said, and the answer.
if (process.argv[2] === "sanitize") {
  const told: string[] = [];
  const preparer = processArtifactHtml({
    onUnconfined: (why) => told.push(`unconfined: ${why}`),
    onUnavailable: (why) => told.push(`unavailable: ${why}`),
  });
  const slot = preparer.reserve("probe");
  const answer = slot.kind === "slot" ? await slot.prepare("<h1>published</h1>") : slot;
  preparer.close();
  console.log(JSON.stringify({ runtime: sanitizerRuntime(), told, answer }));
  process.exit(0);
}

// Memory's embedder as the host runs it: the bundled runtime and weights, on its worker. Prints
// the dimensions and how near a paraphrase is against an unrelated sentence, then exits the way
// the host does, after the worker is gone.
if (process.argv[2] === "embed") {
  const embedder = workerEmbedder({ ...BUNDLED_EMBEDDINGS, offline: true });
  const [claim, paraphrase, unrelated] = await embedder.embed([
    "The frontend tests run under vitest.",
    "Which framework executes the UI test suite?",
    "The office coffee machine is on the third floor.",
  ]);
  await embedder.close();
  console.log(JSON.stringify({
    dimensions: claim.length,
    near: cosine(claim, paraphrase),
    far: cosine(claim, unrelated),
  }));
  process.exit(0);
}

// A WebSocket upgrade through `serve`, which loads the real `ws` package: prints what the socket
// echoed back.
if (process.argv[2] === "ws-upgrade") {
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req, info) => {
      const { socket, response } = info.upgradeWebSocket(req);
      socket.onmessage = (event) => socket.send(`echo:${event.data}`);
      return response;
    },
  );
  const echoed = await new Promise<string>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${server.addr.port}/`);
    client.onopen = () => client.send("ping");
    client.onmessage = (event) => resolve(String(event.data));
    client.onerror = () => reject(new Error("the upgrade failed"));
  });
  console.log(JSON.stringify({ echoed }));
  process.exit(0);
}

const converter = workerConverter({ budgetMs: 10_000 });
const page = await converter.convert(
  "<html><head><title>Probe</title></head><body><main><h1>Hello</h1>" +
    "<p>From a <b>worker</b> inside the binary.</p></main></body></html>",
  "https://example.com/probe",
);
converter.close();

let migrations = 0;
for (const set of MIGRATION_SETS) {
  migrations += (await readdir(set.dir)).filter((f) => f.endsWith(".sql")).length;
}

const db = new PGlite();
const { rows } = await db.query<{ answer: number }>("select 41 + 1 as answer");
await db.close();

console.log(JSON.stringify({
  compiled: isCompiled(),
  markdown: page.markdown,
  migrations,
  app: (await stat(`${APP_BUILD_DIR}/handler.js`)).isFile(),
  postgres: rows[0].answer,
}));
