// A credential as a service holds it: the variable itself, or the file `<name>_FILE` names — the
// way a deployment that hands out no secrets passes one (deploy/compose mints the docker
// launcher's tokens into a volume its callers mount read-only), the precedent of
// RYPH_SECRETS_KEY_FILE. One reader for every service that takes such a pair, so `_FILE` works
// wherever the docs say it does.

import { readFileSync } from "node:fs";

/**
 * `name`, else the contents of the file `<name>_FILE` names, trimmed. Undefined when neither is
 * set. Throws, naming the file, when it is set and cannot be read or is empty.
 */
export function secretFromEnv(
  env: (name: string) => string | undefined,
  name: string,
): string | undefined {
  const value = env(name)?.trim();
  if (value) return value;
  const file = env(`${name}_FILE`)?.trim();
  if (!file) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (err) {
    throw new Error(
      `${name}_FILE=${file} could not be read: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (text === "") throw new Error(`${name}_FILE=${file} is empty`);
  return text;
}
