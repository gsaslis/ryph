// What the sanitizer process proves before it reads the author's HTML, when it runs confined
// (sanitizer.ts): that it is under Node's permission model, on a Node whose model covers the
// network (25 and later), and that the model grants it nothing but reading its own modules.
//
// Two checks, because `process.permission.has(scope)` without a path answers for the whole file
// system only: a process granted `--allow-fs-write=/tmp` (or `=/`, measured on 25.9) still says
// false to `has("fs.write")`, and one granted `--allow-fs-read=/etc` says false to
// `has("fs.read")`. So the flags it was started with are read too, and any but the three the
// parent passes is refused, as is a NODE_OPTIONS that could add more; each read it was granted
// must be one of its own modules (`sanitizerModules`) or one of the packages they import
// (`SANITIZER_PACKAGES`), and a few files it must never read are asked about by name.

import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/** The first Node whose permission model covers the network (`--allow-net`). */
export const MIN_CONFINED_NODE_MAJOR = 25;

/** Every scope the confined sanitizer must not hold. `fs.read` is granted for its own modules
 * only, so it must not hold that one unscoped either (checked below). */
export const DENIED_SCOPES = [
  "fs.write",
  "net",
  "child",
  "worker",
  "addon",
  "wasi",
  "inspector",
] as const;

/** The npm packages the sanitizer's modules import, with theirs: the only directories it may be
 * granted reading besides its own modules. A new dependency of parse5 must be added here. */
export const SANITIZER_PACKAGES: readonly string[] = ["parse5", "entities"];

/** The modules the confined process loads: sanitizer.ts, this module, and the parse it runs. An
 * import added to any of them must be added here (and its package to `SANITIZER_PACKAGES`), or
 * the confined process cannot load it. */
export function sanitizerModules(): string[] {
  return [
    fileURLToPath(new URL("./sanitizer.ts", import.meta.url)),
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL("../../helpers/artifact_html.ts", import.meta.url)),
  ];
}

/** A granted read that is one of `SANITIZER_PACKAGES`' directories: `…/node_modules/<name>`,
 * through a link or at Bun's real `…/node_modules/.bun/<name>@<version>/node_modules/<name>`. */
const PACKAGE_DIR = /\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)$/;

/** Files no grant the parent passes may cover, asked about by name. */
function forbiddenReads(): string[] {
  const home = homedir();
  return [
    "/etc/passwd",
    "/proc/self/environ",
    home,
    `${home}/.ryph`,
    fileURLToPath(new URL("../../main.ts", import.meta.url)),
  ];
}

interface Permission {
  has(scope: string, reference?: string): boolean;
}

/** Node's `process.permission`, when the permission model is on; null under any other runtime
 * or without `--permission`. */
export function permissionModel(): Permission | null {
  const permission = (process as { permission?: Permission }).permission;
  return typeof permission?.has === "function" ? permission : null;
}

/** Throws unless this process runs under Node's permission model, on a Node that covers the
 * network, holding none of `DENIED_SCOPES` and no read but its own modules and packages.
 * `ownModules` stands in for `sanitizerModules()` (a test's probe runs in the sanitizer's place). */
export function assertConfined(ownModules: string[] = sanitizerModules()): void {
  const permission = permissionModel();
  if (permission === null) {
    throw new Error("the sanitizer is not under Node's permission model (--permission)");
  }
  const major = Number(process.versions.node?.split(".")[0]);
  if (!(major >= MIN_CONFINED_NODE_MAJOR)) {
    throw new Error(
      `the sanitizer runs on Node ${process.versions.node}, whose permission model does not ` +
        `cover the network (${MIN_CONFINED_NODE_MAJOR} and later do)`,
    );
  }
  for (const scope of DENIED_SCOPES) {
    if (permission.has(scope)) throw new Error(`the sanitizer holds the ${scope} permission`);
  }
  if (permission.has("fs.read") || permission.has("fs.read", "/")) {
    throw new Error("the sanitizer may read beyond its own modules");
  }
  if (process.env.NODE_OPTIONS !== undefined) {
    throw new Error("the sanitizer was started with NODE_OPTIONS");
  }
  for (const flag of process.execArgv) {
    if (!ALLOWED_FLAG.test(flag)) throw new Error(`the sanitizer was started with ${flag}`);
    if (flag.startsWith(READ_FLAG) && !ownRead(flag.slice(READ_FLAG.length), ownModules)) {
      throw new Error(`the sanitizer was started with ${flag}, not its own modules`);
    }
  }
  for (const path of forbiddenReads()) {
    if (permission.has("fs.read", path)) throw new Error(`the sanitizer may read ${path}`);
  }
}

/** Whether `path` is one of `own`, or a directory of one of `SANITIZER_PACKAGES`. */
function ownRead(path: string, own: string[]): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  if (own.includes(path)) return true;
  const name = PACKAGE_DIR.exec(path)?.[1];
  return name !== undefined && SANITIZER_PACKAGES.includes(name);
}

const READ_FLAG = "--allow-fs-read=";

/** The flags the parent starts it with (process_preparer.ts `sanitizerCommand`). */
const ALLOWED_FLAG = /^(?:--permission|--allow-fs-read=.+|--max-old-space-size=\d+)$/;
