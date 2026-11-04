// Runs a package.json script in every workspace member that has it, except the ones named, one
// member at a time. checks.yml gives the heavy packages a check each and hands the rest to this, so
// a package added later is checked without anyone remembering to list it.
//
//   bun --no-env-file .ryph/each.ts check guard --skip orchestrator,forge
//
// Unlike `bun run --filter`, it runs the members one after the other rather than side by side,
// and it does not stop at the first failure: every member runs, and the end names each one that
// failed.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const args = parseArgs({
  args: process.argv.slice(2),
  options: { skip: { type: "string" } },
  allowPositionals: true,
});
const tasks = args.positionals;
if (tasks.length === 0) {
  console.error("usage: each.ts <task>... [--skip <dir>,<dir>]");
  process.exit(2);
}
const skip = new Set(
  (args.values.skip ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""),
);

const root = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const members: string[] | undefined = config.workspaces;
if (!Array.isArray(members)) throw new Error("package.json has no workspaces list");

const unknown = [...skip].filter((s) => !members.some((m) => m.split("/").at(-1) === s));
if (unknown.length > 0) {
  console.error(`not a workspace member: ${unknown.join(", ")}`);
  process.exit(2);
}

const failed: string[] = [];
for (const member of members) {
  if (skip.has(member.split("/").at(-1)!)) continue;
  const scripts: Record<string, string> =
    JSON.parse(await readFile(new URL(`${member}/package.json`, root), "utf8")).scripts ?? {};
  for (const task of tasks) {
    // Only a script the member defines: `bun run <task>` without one runs a program of that name
    // from PATH instead (`test` is /bin/test, which exits 1), and `--if-present` does not stop it.
    if (!(task in scripts)) continue;
    console.error(`\n== ${member}: ${task}`);
    // The bun running this script, so the members get the same one.
    const code = await new Promise<number | null>((resolve) => {
      spawn(process.execPath, ["run", task], {
        cwd: new URL(`${member}/`, root),
        stdio: "inherit",
      }).on("error", () => resolve(null)).on("exit", (c) => resolve(c));
    });
    if (code !== 0) failed.push(`${member}: ${task}`);
  }
}

if (failed.length > 0) {
  console.error(`\nfailed:\n${failed.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
