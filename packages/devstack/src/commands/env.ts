import { readFile } from "node:fs/promises";
import { envPackages } from "../stack.ts";
import { bold, dim, yellow } from "../ui.ts";

const SECRET = /key|secret|token|password|private/i;

const baseName = (dir: string) => dir.split("/").pop()!;

/** The .env files the running stack actually consumes; the rest are standalone-mode config. */
const STACK_PACKAGES = ["host", "forge", "app"];

/**
 * Shows the declared .env vars per package — the inputs, as written; what the services actually
 * resolved from them is `./dev config`. The default covers only the files the running stack
 * consumes; standalone-mode packages appear when named explicitly. Values under secret-looking
 * keys are always redacted; reading a secret's value means opening the file itself.
 */
export async function env(names: string[]): Promise<number> {
  const wanted = names.length === 0 ? STACK_PACKAGES : names;
  const selected = envPackages.filter((dir) => wanted.includes(baseName(dir)));
  for (const dir of selected) {
    console.log(bold(baseName(dir)));
    const text = await readIfExists(`${dir}/.env`);
    if (text === null) {
      console.log(dim("  no .env — ./dev init creates it"));
      continue;
    }
    let printed = 0;
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const [, key, raw] = m;
      const value = raw.split(/\s+#/)[0].trim().replace(/^["']|["']$/g, "");
      const secret = SECRET.test(key) && !/_PATH$/.test(key);
      const shown = value === "" ? yellow("(unset)") : secret ? dim(redact(value)) : value;
      console.log(`  ${dim(`${key}:`)} ${shown}`);
      printed++;
    }
    if (printed === 0) console.log(dim("  empty"));
  }
  return 0;
}

/**
 * Masks a secret, keeping the first and last four characters when the value is long enough
 * that the reveal costs no meaningful entropy — enough to recognize which secret it is and
 * eyeball that two sides match. Short values mask fully.
 */
function redact(value: string): string {
  if (value.length < 20) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
