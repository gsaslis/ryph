import { command } from "@ryph/process";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { hostDatabases } from "../hostdb.ts";
import { taskArgv } from "../toolchain.ts";
import { envPackages, repoRoot } from "../stack.ts";
import { dim, green, red, yellow } from "../ui.ts";
import { envOf } from "../wiring.ts";

/**
 * Idempotent init: scaffolds each package's .env from its .env.example when missing, then pushes
 * the schema. Reports did vs skipped per step.
 *
 * ONE push, not two. The host's config covers every module mounted in it — orchestrator, auth,
 * model-proxy, historian, automations, webhooks AND memory — because in the single-process
 * deployment they all share one database. The separate history push exists only for a deployment that gives the transcript a
 * database of its own, and running it unconditionally built a second PGlite cluster on disk that
 * nothing ever opened.
 */
export async function init(): Promise<number> {
  console.log(dim("env files"));
  // One value each, written into both sides of the pair that must agree. Read before any file
  // is created: a side whose .env already exists keeps its value, and a side created now takes
  // that one rather than a fresh value that would never match it.
  const [host, app, forge] = await Promise.all(["host", "app", "forge"].map(envOf));
  const forgeToken = host.get("RYPH_FORGE_TOKEN") || forge.get("RYPH_FORGE_TOKEN") ||
    `dev-${crypto.randomUUID()}`;
  const proxySecret = host.get("RYPH_PROXY_SECRET") || app.get("RYPH_PROXY_SECRET") || hex(32);
  for (const dir of envPackages) {
    const name = dir.split("/").pop()!;
    const env = `${dir}/.env`;
    const example = `${dir}/.env.example`;
    if (await exists(env)) {
      console.log(`  ${name.padEnd(12)} .env exists ${dim("skipped")}`);
      continue;
    }
    if (!(await exists(example))) {
      console.log(
        `  ${name.padEnd(12)} ${yellow("no .env.example")} ${dim("skipped")}`,
      );
      continue;
    }
    await copyFile(example, env);
    const wired = await applyLocalWiring(name, env, { forgeToken, proxySecret });
    console.log(
      `  ${name.padEnd(12)} ${green("created from .env.example")}` +
        (wired.length > 0 ? ` ${dim(`+ ${wired.join(", ")}`)}` : ""),
    );
    const unset = await unsetKeys(env);
    if (unset.length > 0) {
      console.log(
        `  ${" ".repeat(12)} ${yellow(`unset: ${unset.join(", ")}`)}`,
      );
    }
  }

  await backfillProxySecret(proxySecret);

  console.log(dim("database schema"));
  const separateHistory = (await hostDatabases()).some((db) => db.key === "RYPH_HISTORY_DB");
  const tasks = separateHistory ? ["db:push", "db:push:history"] : ["db:push"];
  for (const task of tasks) {
    console.log(`  ${task}`);
    const [bin, ...args] = await taskArgv(task);
    const { success } = await command(bin, {
      args,
      cwd: `${repoRoot}/packages/host`,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!success) {
      console.error(red(`${task} failed`));
      return 1;
    }
  }
  console.log(green("init complete"));
  return 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Finds keys left without a value, e.g. `RYPH_FORGE_TOKEN=`. */
async function unsetKeys(envPath: string): Promise<string[]> {
  const text = await readFile(envPath, "utf8");
  return text
    .split("\n")
    .map((line) => line.match(/^([A-Z0-9_]+)=\s*$/)?.[1])
    .filter((key): key is string => key !== undefined);
}

/**
 * The wiring a local stack cannot boot without, written into a .env this command just created.
 *
 * The .env.example files are documentation: every line is commented, showing the default rather
 * than setting it. Copying one therefore produces a forge that exits at boot — RYPH_ORCHESTRATOR_URL
 * and RYPH_FORGE_TOKEN are both required — so `init` would hand you a stack with a permanently
 * red unit and a doctor line explaining why. Filling in the values a human would type anyway is
 * the whole job of a scaffold.
 *
 * Deliberately minimal: only keys that are REQUIRED and have one obvious local answer. Anything
 * with a real choice behind it (a GitHub App, a provider key, a secrets master) stays commented,
 * and `doctor` reports it as dark rather than guessing.
 *
 * Only ever touches a file this run created — an existing .env is skipped before we get here.
 * backfillProxySecret below is the one exception.
 */
async function applyLocalWiring(
  pkg: string,
  envPath: string,
  { forgeToken, proxySecret }: { forgeToken: string; proxySecret: string },
) {
  // Service-to-service URLs, which carry bearer tokens, name 127.0.0.1: the host binds that
  // alone, and `localhost` may resolve to ::1 first, where something else could answer. Only
  // the browser's URL stays on `localhost`.
  const wiring: Record<string, Record<string, string>> = {
    forge: {
      // Both required; without them the forge can resolve no run's credential and exits.
      RYPH_ORCHESTRATOR_URL: "http://127.0.0.1:7411",
      RYPH_FORGE_TOKEN: forgeToken,
    },
    host: {
      // The other half of the pair. The two tokens must match or the link is dead in both
      // directions, which is why one value is generated per init and written to both files.
      RYPH_FORGE_URL: "http://127.0.0.1:7412",
      RYPH_FORGE_TOKEN: forgeToken,
      // Where the vite dev server is: mailed links, run links, and the passkey origin.
      RYPH_APP_URL: "http://localhost:5173",
      // Without it the host takes x-client-ip from any caller, and a run reaching it through
      // host.docker.internal could claim to be ::1 and spend the owner's login-link budget.
      RYPH_PROXY_SECRET: proxySecret,
    },
    app: {
      // The host's value, sent beside every client address the app vouches for.
      RYPH_PROXY_SECRET: proxySecret,
    },
  };
  const values = wiring[pkg];
  if (!values) return [];
  await setKeys(envPath, values);
  return Object.keys(values);
}

/**
 * RYPH_PROXY_SECRET for a host or app .env that predates it: the one exception to touching only
 * files this run created. A side without a value gets the other side's, or both get a fresh one,
 * and nothing else in either file changes. Two different values are left for `doctor` to report.
 */
async function backfillProxySecret(fresh: string) {
  const key = "RYPH_PROXY_SECRET";
  const files = { host: `${repoRoot}/packages/host/.env`, app: `${repoRoot}/packages/app/.env` };
  if (!(await exists(files.host)) || !(await exists(files.app))) return;
  const host = (await envOf("host")).get(key);
  const app = (await envOf("app")).get(key);
  if (host && app) return;
  // `||`, not `??`: an uncommented but empty line (host/.env.example ships one) is no value.
  const value = host || app || fresh;
  const missing = (["host", "app"] as const).filter((side) => !(side === "host" ? host : app));
  for (const side of missing) await setKeys(files[side], { [key]: value });
  console.log(`  ${missing.join(", ").padEnd(12)} ${green(`+ ${key}`)}`);
}

async function setKeys(envPath: string, values: Record<string, string>) {
  let text = await readFile(envPath, "utf8");
  for (const [key, value] of Object.entries(values)) {
    // Replace the example line in place, commented or left empty, so the value lands under the
    // heading that explains it rather than orphaned (or duplicated) at the end of the file.
    // `[ \t]*`, not `\s*`: under `m`, `\s` would swallow the line break and the blank line after.
    const commented = new RegExp(`^(#${key}=.*|${key}=[ \\t]*)$`, "m");
    if (commented.test(text)) text = text.replace(commented, `${key}=${value}`);
    else text += `${text.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
  }
  await writeFile(envPath, text);
}

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
