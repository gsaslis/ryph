// Builds the `ryph` binary.
//
// A script rather than a script line, for three things a plain `bun build --compile` does not do:
//
// - It never lets the binary read a `bunfig.toml` or `.env` from the directory it runs in
//   (`autoloadBunfig: false`, `autoloadDotenv: false`). By default a compiled binary loads both,
//   and runs a bunfig's `preload` scripts: `ryph` runs inside arbitrary checked-out repositories,
//   so that would be code execution from any repo. Every build of this machine's own binary is
//   run once in a directory holding both, and fails if it read either; and once each under
//   BUN_OPTIONS, NODE_TLS_REJECT_UNAUTHORIZED=0, BUN_INSPECT and BUN_CONFIG_VERBOSE_FETCH, and fails
//   unless it refused to start
//   (@ryph/shared/env).
// - It packs what the binary reads as FILES rather than imports into one archive inside it (the
//   built UI, the migrations, the catalogues and skills, the three workers, bundled, and memory's
//   embeddings runtime and weights for the target platform, scripts/embeddings.ts), and
//   rewrites every workspace module's `import.meta.url` to that module's place in the archive's
//   tree. In a compiled binary every module's `import.meta.url` is the binary's own, so the
//   `new URL("../../../skills", import.meta.url)` every package resolves its files by would
//   point nowhere; src/resources.ts unpacks the archive at startup and says why.
// - It bakes in `RYPH_STANDALONE`, which is how the artifact sanitizer knows to re-execute this
//   binary when no Node 25 or later is there to run it confined
//   (packages/orchestrator/src/adapters/artifact_html/), and how @ryph/service loads the real
//   `ws` the build bundles (`ryph:ws`) rather than resolving one at run time.
// - It bakes in `RYPH_IMAGE_TAG`, the tag images/publish.ts gives this build's images (a tagged
//   release's `0.1.0`, else `sha-<12>`; scripts/version.ts), so the binary's default agent,
//   browser, tool guard and run gate are the ones published beside it (packages/host/src/images.ts),
//   and `ryph --version` says it. From RYPH_IMAGE_TAG in the environment when set
//   (images/ryph/Dockerfile passes it in: there is no .git in a build context), else from git;
//   `-dirty` for a tree with uncommitted changes, and empty where git cannot say.
//
// Another platform's binary: `--target=bun-linux-x64` (or bun-linux-arm64, bun-darwin-arm64,
// bun-darwin-x64), into dist/ryph-<target> unless `--output=` says where. `compileBinary` is the
// same build of another entry, for tests/binary_test.ts's probe.

import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "@ryph/process";
import { sanitizerPackages } from "../../orchestrator/src/adapters/artifact_html/process_preparer.ts";
import { sanitizerModules } from "../../orchestrator/src/adapters/artifact_html/sanitizer_permissions.ts";
import { MIGRATION_SETS } from "../src/embedded.ts";
import { packResources, removeTree } from "../src/resources.ts";
import { embeddingResources } from "./embeddings.ts";
import { buildVersion } from "./version.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

const packageDir = (...parts: string[]) => join(REPO_ROOT, "packages", ...parts);
/** A repository-relative path, with forward slashes: the archive's spelling. */
const repoPath = (abs: string) => relative(REPO_ROOT, abs).split("\\").join("/");

const appBuild = packageDir("app", "build");
// The hosted-MCP catalogue, read at boot through import.meta.url by the gateway's directory
// adapter.
const catalogue = packageDir("mcp-gateway", "catalogue");
// The service catalogue, read the same way by the orchestrator's directory adapter.
const serviceCatalogue = packageDir("orchestrator", "catalogue");
// The ryph skills catalogue, read the same way by the orchestrator's skill catalogue adapter. Not
// optional: every boot loads it, so a binary without it would refuse to start.
const skillCatalogue = packageDir("orchestrator", "skills");
// The workers. A Worker's module is not an import, so the bundler does not follow
// `new Worker(new URL("./convert_worker.ts", import.meta.url))`: each is bundled on its own here
// and packed at its source path, where that URL points once rewritten. The web tools' converter,
// because a worker is the only way to put a wall-clock budget on a synchronous parse
// (packages/web/src/adapters/convert/worker_converter.ts); the artifact sanitizer's, because the
// binary re-executes itself as the sanitizer for every publish (`ryph __artifact-sanitizer`,
// src/entry.ts) and that process parses in it. Without either, a web__fetch of an HTML page or a
// publish_artifact fails with "module not found". And memory's embedder, which runs the model on
// a thread of its own (packages/memory/src/adapters/embed/worker_embedder.ts says why).
const workers = [
  [packageDir("web", "src", "adapters", "convert", "convert_worker.ts"), "web conversion worker"],
  [
    packageDir("orchestrator", "src", "adapters", "artifact_html", "sanitizer_worker.ts"),
    "artifact sanitizer worker",
  ],
  [packageDir("memory", "src", "adapters", "embed", "worker.ts"), "memory embeddings worker"],
];

/**
 * The artifact sanitizer as a Node 25 or later runs it confined: its three modules as source, at
 * their repository paths, and parse5 with its dependencies under `node_modules/`, where node finds
 * them from there. The binary's control plane starts `node --permission` on the unpacked copy
 * when such a node is on PATH (process_preparer.ts), reading only those files.
 */
async function sanitizerFiles(): Promise<{ path: string; bytes: Uint8Array }[]> {
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const module of sanitizerModules()) {
    files.push({ path: repoPath(module), bytes: new Uint8Array(await readFile(module)) });
  }
  const packed = new Map<string, string>();
  for (const { name, real } of sanitizerPackages()) {
    const already = packed.get(name);
    if (already === real) continue;
    if (already !== undefined) {
      throw new Error(`the sanitizer needs two copies of ${name} (${already}, ${real})`);
    }
    packed.set(name, real);
    for (const [, abs] of await walk(real)) {
      const rel = relative(real, abs).split("\\").join("/");
      if (rel.split("/").includes("node_modules")) continue;
      files.push({
        path: `node_modules/${name}/${rel}`,
        bytes: new Uint8Array(await readFile(abs)),
      });
    }
  }
  return files;
}

/** Every file under `dir`, as [repository-relative path, absolute path]. */
async function walk(dir: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out.push([repoPath(abs), abs]);
  }
  return out;
}

/** What a build needs that is not source: a missing one is named with the step that makes it. */
async function missingInputs(): Promise<string[]> {
  const problems: string[] = [];
  const dirs = [
    ...MIGRATION_SETS.map((set) => [
      set.dir,
      `${set.name} migrations`,
      "run `bun run db:generate` from the repo root",
    ]),
    [appBuild, "app build", "run `bun run build:app` first — the UI is built by vite, not by bun"],
    [catalogue, "MCP catalogue", "it moved or was renamed — update this script"],
    [serviceCatalogue, "service catalogue", "it moved or was renamed — update this script"],
    [skillCatalogue, "skills catalogue", "it moved or was renamed — update this script"],
  ];
  for (const [path, what, fix] of dirs) {
    if (!await stat(path).then((s) => s.isDirectory(), () => false)) {
      problems.push(`no ${what} at ${path}\n  ${fix}`);
    }
  }
  for (const [worker, what] of workers) {
    if (!await stat(worker).then((s) => s.isFile(), () => false)) {
      problems.push(`no ${what} at ${worker}\n  it moved or was renamed — update this script`);
    }
  }
  return problems;
}

/**
 * The image tag this build is published under (images/publish.ts, version.ts): a tagged release's
 * `0.1.0`, else `sha-<12>`, with `-dirty` when the tree has uncommitted changes, or "" when there
 * is no git to ask. RYPH_IMAGE_TAG in the environment wins.
 */
export async function imageTag(): Promise<string> {
  const given = process.env.RYPH_IMAGE_TAG;
  if (given !== undefined) return given;
  return await buildVersion();
}

/** Whether a build can run here: false when the UI is not built yet, for a test to skip on. */
export async function canCompile(): Promise<boolean> {
  return (await missingInputs()).length === 0;
}

// npm packages that read files beside their own modules by `import.meta.url`, the same way: those
// files are packed under `node_modules/<name>/` and the package's modules rewritten like the
// workspace's. PGlite loads its Postgres build (the WASM and its data image) so.
const pgliteRoot = realpathSync(
  dirname(dirname(Bun.resolveSync("@electric-sql/pglite", packageDir("db")))),
);
const npmAssets = [{
  name: "@electric-sql/pglite",
  root: pgliteRoot,
  files: ["dist/pglite.data", "dist/pglite.wasm"],
}];

/** Where a module sits in the archive's tree, when its `import.meta.url` is to be rewritten. */
function archivePathOf(path: string): string | null {
  for (const pkg of npmAssets) {
    if (path.startsWith(`${pkg.root}/`)) {
      return `node_modules/${pkg.name}/${relative(pkg.root, path)}`;
    }
  }
  if (relative(REPO_ROOT, path).startsWith("..") || path.includes("/node_modules/")) return null;
  return repoPath(path);
}

/** The archive's files: the npm assets, the directories, the workers, bundled, and memory's
 * embeddings for `target`. */
async function resourceFiles(target?: string): Promise<{ path: string; bytes: Uint8Array }[]> {
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const pkg of npmAssets) {
    for (const file of pkg.files) {
      files.push({
        path: `node_modules/${pkg.name}/${file}`,
        bytes: new Uint8Array(await readFile(join(pkg.root, file))),
      });
    }
  }
  const dirs = [
    ...MIGRATION_SETS.map((set) => set.dir),
    catalogue,
    serviceCatalogue,
    skillCatalogue,
    appBuild,
  ];
  for (const dir of dirs) {
    for (const [path, abs] of await walk(dir)) {
      // Source maps: 12 MB of the UI's 42, read by nobody at runtime.
      if (path.endsWith(".map")) continue;
      files.push({ path, bytes: new Uint8Array(await readFile(abs)) });
    }
  }
  files.push(...await sanitizerFiles());
  for (const [worker, what] of workers) {
    const built = await Bun.build({ entrypoints: [worker], target: "bun", format: "esm" });
    if (!built.success || built.outputs.length !== 1) {
      throw new Error(`could not bundle the ${what}:\n${built.logs.join("\n")}`);
    }
    files.push({
      path: repoPath(worker),
      bytes: new Uint8Array(await built.outputs[0].arrayBuffer()),
    });
  }
  files.push(...await embeddingResources(target));
  return files;
}

/**
 * Builds `entry` (default src/entry.ts) into a binary at `output`, for `target` or this machine.
 * Throws with what is missing or what failed.
 */
export async function compileBinary(opts: {
  output: string;
  target?: string;
  entry?: string;
  /** The published image tag to bake in; default: this checkout's (`imageTag`). */
  imageTag?: string;
}): Promise<{ size: number; resources: number }> {
  const missing = await missingInputs();
  if (missing.length > 0) throw new Error(missing.join("\n"));
  const archive = packResources(await resourceFiles(opts.target));
  const archivePath = join(
    dirname(opts.output),
    `.${relative(dirname(opts.output), opts.output)}.resources`,
  );
  await mkdir(dirname(opts.output), { recursive: true });
  await writeFile(archivePath, archive);

  const resourcesModule = join(PACKAGE_ROOT, "src", "resources.ts");
  const reflectMetadata = Bun.resolveSync(
    "reflect-metadata",
    Bun.resolveSync(
      "@peculiar/x509",
      Bun.resolveSync("@simplewebauthn/server", packageDir("auth")),
    ),
  );
  const realWsEntry = realpathSync(
    Bun.resolveSync("ws/package.json", packageDir("service")).replace(/package\.json$/, "index.js"),
  );
  // Embedded in the binary, then removed: the build reads it, nothing else does.
  const result = await Bun.build({
    // Not main.ts: the entry decides between the CLI and the artifact sanitizer before the CLI's
    // module graph is loaded.
    entrypoints: [opts.entry ?? join(PACKAGE_ROOT, "src", "entry.ts")],
    target: "bun",
    define: {
      RYPH_STANDALONE: "true",
      RYPH_IMAGE_TAG: JSON.stringify(opts.imageTag ?? await imageTag()),
    },
    compile: {
      outfile: opts.output,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
      ...(opts.target ? { target: opts.target as Bun.Build.CompileTarget } : {}),
    },
    plugins: [{
      name: "ryph-resources",
      setup(build) {
        // The real `ws` package, bundled whole: @ryph/service's `realWs()` loads it as `ryph:ws`
        // in a binary, never by resolving `ws` at run time (Bun's stand-in ignores `maxPayload`,
        // and a run-time lookup would load whatever `node_modules/ws` it found).
        build.onResolve({ filter: /^ryph:ws$/ }, () => ({ path: realWsEntry }));
        // The archive and where it unpacks: one module, evaluated before any module that names it.
        build.onResolve({ filter: /^ryph:resources$/ }, () => ({
          path: "resources",
          namespace: "ryph",
        }));
        build.onLoad({ filter: /.*/, namespace: "ryph" }, () => ({
          loader: "ts",
          contents: [
            `import archive from ${JSON.stringify(archivePath)} with { type: "file" };`,
            `import { fileUrlIn, resourcesRootOrExit, RUNTIME_ROOT_GLOBAL } from ${
              JSON.stringify(resourcesModule)
            };`,
            `const root = resourcesRootOrExit(archive);`,
            // For the control plane, which names it to the sanitizer it starts as this binary.
            `(globalThis as Record<symbol, unknown>)[Symbol.for(RUNTIME_ROOT_GLOBAL)] = root;`,
            `export const fileUrl = (rel: string): string => fileUrlIn(root, rel);`,
          ].join("\n"),
        }));
        // Bun 1.4.2's bundler, inside a lazily initialised module, runs the ESM imports' setup
        // before the CommonJS ones, whatever their order in the source. @peculiar/x509 (passkeys,
        // via @simplewebauthn/server) imports the CommonJS `reflect-metadata` polyfill and then
        // tsyringe, which refuses to load without it: the binary died at boot with "tsyringe
        // requires a reflect polyfill". So the polyfill runs at the top of tsyringe's own entry.
        build.onLoad({ filter: /\/tsyringe\/dist\/esm5\/index\.js$/ }, async (args) => ({
          loader: "js",
          contents: `(function () {\n${await readFile(reflectMetadata, "utf8")}\n})();\n` +
            await readFile(args.path, "utf8"),
        }));
        // Every rewritten module's `import.meta.url`, as where it sits in the unpacked tree.
        build.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
          const rel = archivePathOf(args.path);
          if (rel === null) return undefined;
          const contents = await readFile(args.path, "utf8");
          const loader = args.path.endsWith(".ts") ? "ts" : "js";
          if (!contents.includes("import.meta.url")) return { contents, loader };
          return {
            loader,
            contents: `import { fileUrl as __ryphFileUrl } from "ryph:resources";\n` +
              contents.replaceAll("import.meta.url", `__ryphFileUrl(${JSON.stringify(rel)})`),
          };
        });
      },
    }],
  }).finally(() => rm(archivePath, { force: true }));
  if (!result.success) throw new Error(result.logs.join("\n"));
  return { size: (await stat(opts.output)).size, resources: archive.length };
}

/**
 * Throws unless `binary`, run in a directory holding a bunfig.toml whose preload would leave a
 * mark and a .env that would move its runtime copy elsewhere, read neither, and unpacked its
 * resources under the HOME it was given; and unless, started under BUN_OPTIONS,
 * NODE_TLS_REJECT_UNAUTHORIZED=0, BUN_INSPECT or BUN_CONFIG_VERBOSE_FETCH, it refused to.
 */
export async function refusesHostileStart(binary: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ryph-hostile-"));
  try {
    const cwd = join(dir, "repo");
    const home = join(dir, "home");
    await mkdir(cwd);
    await mkdir(home);
    const mark = join(dir, "preloaded");
    await writeFile(
      join(cwd, "preload.ts"),
      `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\n`,
    );
    await writeFile(join(cwd, "bunfig.toml"), `preload = ["./preload.ts"]\n`);
    await writeFile(join(cwd, ".env"), `RYPH_HOME=${join(dir, "env-home")}\n`);
    const out = await command(binary, {
      args: ["--version"],
      cwd,
      env: { HOME: home, PATH: process.env.PATH ?? "" },
      clearEnv: true,
      stdin: "null",
    }).output();
    if (!out.success) {
      throw new Error(
        `${binary} --version failed in a scratch directory:\n${
          new TextDecoder().decode(out.stderr)
        }`,
      );
    }
    if (existsSync(mark)) {
      throw new Error(`${binary} ran a preload from the bunfig.toml where it was started`);
    }
    if (existsSync(join(dir, "env-home"))) {
      throw new Error(`${binary} read the .env where it was started`);
    }
    if (!existsSync(join(home, ".ryph", "runtime"))) {
      throw new Error(`${binary} did not unpack its resources under HOME`);
    }
    for (
      const [name, value] of [
        ["BUN_OPTIONS", "--smol"],
        ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
        // Port 0: the listener it opens before refusing must not collide with anything.
        ["BUN_INSPECT", "127.0.0.1:0"],
        ["BUN_CONFIG_VERBOSE_FETCH", "1"],
        // Not BUN_BE_BUN, the rule's other variable: under it the binary is the `bun` CLI, its
        // entry never runs, and `--version` prints Bun's (measured on Bun 1.4.2).
      ]
    ) {
      const refused = await command(binary, {
        args: ["--version"],
        cwd: home,
        env: { HOME: home, PATH: process.env.PATH ?? "", [name]: value },
        clearEnv: true,
        stdin: "null",
      }).output();
      const said = new TextDecoder().decode(refused.stderr);
      if (refused.code !== 2 || !said.includes("refusing to start")) {
        throw new Error(`${binary} started under ${name}=${value} (exit ${refused.code}): ${said}`);
      }
    }
  } finally {
    // Its unpacked copy is read-only: removeTree makes it writable first.
    removeTree(dir);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
  const output = argv.find((a) => a.startsWith("--output="))?.slice("--output=".length) ??
    join(REPO_ROOT, "dist", target ? `ryph-${target}` : "ryph");
  const tag = await imageTag();
  console.error(
    `compiling ${output}${target ? ` for ${target}` : ""}, default images at ${tag || "edge"}…`,
  );
  try {
    const { size, resources } = await compileBinary({ output, target, imageTag: tag });
    // Only this machine's own binary can be run here.
    if (target === undefined) await refusesHostileStart(output);
    console.error(
      `built ${output} (${(size / 1024 / 1024).toFixed(0)} MB, resources ${
        (resources / 1024 / 1024).toFixed(0)
      } MB packed)`,
    );
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
