// Where the files the binary carries live at runtime.
//
// They keep their layout relative to the module that resolves them, so the same
// `new URL(..., import.meta.url)` works both from source (`bun run dev`) and from the binary's
// unpacked copy (src/resources.ts). Resolving them through URLs rather than `process.cwd()` is
// what makes that true — cwd is wherever the user happened to run the binary, which is never the
// answer.

import { stat } from "node:fs/promises";
import { fromFileUrl } from "@std/path";
import type { MigrationSet } from "./schema_guard.ts";

/**
 * The generated SQL migrations, one set per schema owner this process mounts — the same files the
 * networked deployment applies to its own databases. Here they share one (the historian's goes to
 * the transcript's own database when there is one), each tracked in its own table. Applied at boot
 * by @ryph/db's runtime migrator.
 *
 * The table names are also in each package's drizzle.config.ts; keep the two in step.
 */
export const MIGRATION_SETS: readonly MigrationSet[] = [
  {
    // The control plane's own tables and @ryph/auth's, which it mounts.
    name: "orchestrator",
    dir: fromFileUrl(new URL("../../orchestrator/drizzle", import.meta.url)),
    table: "__drizzle_migrations_orchestrator",
  },
  {
    name: "model-proxy",
    dir: fromFileUrl(new URL("../../model-proxy/drizzle", import.meta.url)),
    table: "__drizzle_migrations_model_proxy",
  },
  {
    name: "mcp-gateway",
    dir: fromFileUrl(new URL("../../mcp-gateway/drizzle", import.meta.url)),
    table: "__drizzle_migrations_mcp_gateway",
  },
  {
    name: "historian",
    dir: fromFileUrl(new URL("../../historian/drizzle", import.meta.url)),
    table: "__drizzle_migrations_historian",
    history: true,
  },
  {
    // The automations tables plus the mailroom's webhooks table its set carries — in this
    // process both share the one database.
    name: "automations",
    dir: fromFileUrl(new URL("../../automations/drizzle", import.meta.url)),
    table: "__drizzle_migrations_automations",
  },
  {
    name: "memory",
    dir: fromFileUrl(new URL("../../memory/drizzle", import.meta.url)),
    table: "__drizzle_migrations_memory",
  },
  {
    name: "chat",
    dir: fromFileUrl(new URL("../../chat/drizzle", import.meta.url)),
    table: "__drizzle_migrations_chat",
  },
  {
    // The Radicle bridge's cursors and tracked repositories — applied whether or not
    // RYPH_RADICLE_URL=embedded turns the bridge on, so turning it on later needs no migrate.
    name: "radicle",
    dir: fromFileUrl(new URL("../../radicle/drizzle", import.meta.url)),
    table: "__drizzle_migrations_radicle",
  },
];

/** adapter-node's build output for the SvelteKit app, from `packages/app/build`. */
export const APP_BUILD_DIR: string = fromFileUrl(new URL("../../app/build", import.meta.url));

/**
 * Memory's embeddings runtime and weights, which only the binary carries (scripts/embeddings.ts
 * builds them for the target platform): @huggingface/transformers bundled into one module with
 * onnxruntime's addon and library beside it, and bge-small-en-v1.5's weights in the layout the
 * runtime's cache reads. Nothing is there in a source checkout.
 */
export const BUNDLED_EMBEDDINGS: { runtime: string; modelDir: string } = {
  runtime: new URL("../../memory/embeddings/runtime/transformers.mjs", import.meta.url).href,
  modelDir: fromFileUrl(new URL("../../memory/embeddings/models", import.meta.url)),
};

/** Defined `true` by the binary's build (scripts/compile.ts). */
declare const RYPH_STANDALONE: boolean | undefined;

/** Whether this process is the compiled binary rather than `bun` over the source. */
export function isCompiled(): boolean {
  return typeof RYPH_STANDALONE !== "undefined" && RYPH_STANDALONE === true;
}

/** Whether an embedded directory actually arrived — a missing one is a build mistake, not config. */
export async function embeddedDirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
