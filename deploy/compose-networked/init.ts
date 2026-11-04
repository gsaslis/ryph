/**
 * `bun run compose:init` — writes the compose stack's secrets into .env beside compose.yaml in
 * this directory, the project directory compose reads it from.
 *
 * compose.yaml gives no secret a default: each is `${VAR:?…}`, so compose refuses to start
 * without it. This finds every such variable in compose.yaml and perf/compose.perf.yaml, and
 * appends a fresh random value for each one .env does not already set. It never changes a value
 * that is there, so running it again (`compose:up` does, every time) is a no-op, and a value you
 * set by hand stays yours.
 *
 * Every value is 32 random bytes as hex: the right shape for the hex master keys, and as good as
 * anything for the tokens, the Postgres password and the object store's keys.
 *
 * It also writes DOCKER_GID, the docker socket's group the launcher joins, when neither .env nor
 * the shell sets it and the engine is Docker Engine on this Linux machine: there the socket is
 * root:docker, and the compose default of 0 would leave the launcher unable to use it. Docker
 * Desktop's socket is root:root, so 0 is right there and nothing is written.
 */

import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { command } from "../../packages/process/src/mod.ts";
import { findPublicDevSecrets } from "../../packages/service/src/dev_secrets.ts";

const here = new URL("./", import.meta.url);
const sources = [new URL("compose.yaml", here), new URL("../../perf/compose.perf.yaml", here)];
const envPath = new URL(".env", here);

const required = new Set<string>();
for (const source of sources) {
  const text = await readFile(source, "utf8");
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    for (const match of line.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)) required.add(match[1]);
  }
}

let existing = "";
try {
  existing = await readFile(envPath, "utf8");
} catch (err) {
  if (!((err as NodeJS.ErrnoException)?.code === "ENOENT")) throw err;
}

/** NAME=value lines as a map, quotes stripped; an empty value counts as unset. */
function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return values;
}

const present = parseEnv(existing);

// A stack started before this directory existed kept its secrets in the repository root's .env.
// Fresh ones here would not match its database volume or anything sealed under its keys, so
// refuse rather than mint them: when this .env lacks either of the two a volume and its sealed
// rows depend on, and the root one has both (a root .env with only an unrelated
// POSTGRES_PASSWORD is not this stack's).
const PINNED = ["POSTGRES_PASSWORD", "RYPH_SECRETS_KEY"];
if (PINNED.some((name) => !present.get(name))) {
  let legacy = "";
  try {
    legacy = await readFile(new URL("../../.env", here), "utf8");
  } catch (err) {
    if (!((err as NodeJS.ErrnoException)?.code === "ENOENT")) throw err;
  }
  const root = parseEnv(legacy);
  if (PINNED.every((name) => root.get(name))) {
    console.error(
      ".env: the repository root's .env holds this stack's secrets. Move it to " +
        "deploy/compose-networked/.env, keeping its values over any already there, and run this again.",
    );
    process.exit(1);
  }
}

const missing = [...required].filter((name) => !present.get(name)).sort();

/**
 * The docker socket's group when the engine is the one at /var/run/docker.sock on this Linux
 * machine, or null where 0 is right or nothing can be told: macOS and Windows, Docker Desktop
 * on Linux (its socket is elsewhere), a rootless or remote engine, no docker at all.
 */
async function dockerSocketGid(): Promise<string | null> {
  if (process.platform !== "linux") return null;
  let host = process.env.DOCKER_HOST;
  if (!host) {
    const context = await command("docker", {
      args: ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      stdout: "piped",
      stderr: "null",
    }).output().catch(() => null);
    if (context === null || context.code !== 0) return null;
    host = new TextDecoder().decode(context.stdout).trim();
  }
  if (host !== "unix:///var/run/docker.sock") return null;
  const socket = await stat("/var/run/docker.sock").catch(() => null);
  if (socket === null || socket.gid === 0) return null;
  return String(socket.gid);
}

const dockerGid = present.get("DOCKER_GID") || process.env.DOCKER_GID
  ? null
  : await dockerSocketGid();

if (missing.length > 0 || dockerGid !== null) {
  const hex = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const lines = missing.map((name) => `${name}=${hex()}`);
  if (dockerGid !== null) lines.push(`DOCKER_GID=${dockerGid}`);
  const header = existing === ""
    ? "# The compose stack's secrets. Written by `bun run compose:init`.\n"
    : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  // A fresh owner-only file renamed over the old: writeFile's mode applies only when it creates
  // the file, so writing in place would put the secrets in an existing, wider .env first.
  const tmp = new URL(`.env.${crypto.randomUUID()}.tmp`, here);
  try {
    await writeFile(tmp, `${existing}${separator}${header}${lines.join("\n")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(tmp, envPath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  if (missing.length > 0) console.log(`.env: generated ${missing.join(", ")}`);
  if (dockerGid !== null) console.log(`.env: DOCKER_GID=${dockerGid}, the docker socket's group`);
} else {
  console.log(".env: every secret is set");
}

const placeholders = findPublicDevSecrets(Object.fromEntries(present));
if (placeholders.length > 0) {
  console.warn(
    `.env: public dev secret in ${placeholders.join(", ")}; the services will refuse to ` +
      "boot. Delete those lines and run this again.",
  );
}
