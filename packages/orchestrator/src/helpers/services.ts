// The `.ryph/services.yml` parser. Hand-rolled and strict, in the exact idiom of
// @ryph/runner's `parseSteps` (helpers/environment.ts): unknown keys are refused rather than
// skipped, because in a CI-shaped config an unrecognised key is a typo and half-running the
// author's intent is worse than refusing it.
//
// This is the FIRST repo-authored text parsed inside the control plane's own process —
// everything repo-authored until now (setup.yml, environment.md) was parsed inside the run's
// sandbox, where the blast radius is one container. So:
//
// - the bytes are bounded before they arrive (the forge caps the read at 64 KiB) and bounded
//   again here, field by field
// - YAML anchors and aliases are refused outright. `*a` referenced ten times, ten times over,
//   is the billion-laughs expansion, and `@std/yaml`'s parser will happily build it
// - nothing here does I/O, reads the clock, or reaches a port. Given the same text it returns
//   the same answer, which is what makes the table test in tests/services_test.ts the whole
//   specification

import { parse as parseYaml } from "@std/yaml";
import { capabilityRefusal, type ServiceDeclaration } from "../core/services.ts";

/** Generous for any real declaration; small enough to bound a hostile one. */
export const MAX_SERVICES = 20;
export const MAX_COMMAND_ARGS = 64;
export const MAX_ARG_LEN = 1_000;
export const MAX_ENV_ENTRIES = 32;
export const MAX_ENV_VALUE_LEN = 2_000;

/**
 * RFC 1035 label — a DNS name, because that is literally what it becomes — four short of the
 * label's 63, because it also becomes the Kubernetes container `svc-<name>`, and a container
 * name is capped at 63 too. Refused here rather than by the API server at launch.
 */
export const MAX_NAME_LEN = 59;
export const SERVICE_NAME = /^[a-z]([a-z0-9-]{0,57}[a-z0-9])?$/;
/** `<catalogue id>@<version>`, e.g. `postgres@18`. */
const USES = /^[a-z0-9][a-z0-9-]{0,30}@[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A Linux capability, as both docker and Kubernetes spell it: no `CAP_` prefix. */
const CAPABILITY = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * An anchor or alias in NODE POSITION — at the start of a line, after `:`, `,`, `[` or `{`, or
 * after a `- ` entry or `? ` key — optionally behind the one tag a node may carry
 * (`!!map &a`, `!<tag:yaml.org,2002:map> &a`). Deliberately not a bare search for `&` or `*`:
 * `POSTGRES_PASSWORD: p&ssword` and `command: ["sh", "-c", "a && b"]` are ordinary scalars, and
 * refusing those would be refusing the thing people actually write.
 *
 * The name is matched with the parser's own grammar rather than a guess at a sensible one:
 * `@std/yaml` reads an anchor or alias name as any run of characters that are neither
 * whitespace nor a flow indicator, so `&-base` and `*.base` are anchors too.
 *
 * This is a screen, not the bound. The bound is that nothing downstream deep-walks the parsed
 * document — every loop below is capped — so an alias DAG could not blow up anyway. Anchors are
 * refused because a service declaration has no use for them and one less feature is one less
 * question, not because this line is load-bearing.
 */
const ANCHOR_OR_ALIAS =
  /(?:^|[:,[{]|[-?]\s)\s*(?:(?:!<[^>]*>|![^\s,[\]{}]*)\s+)?([&*][^\s,[\]{}]+)/m;

/**
 * Throws when the text carries a YAML anchor or alias in node position — the screen every
 * repo-authored YAML the control plane parses goes through first (this file's, and
 * `.ryph/checks.yml`'s in helpers/checks.ts).
 */
export function refuseAnchors(text: string): void {
  const anchor = text.match(ANCHOR_OR_ALIAS);
  if (anchor !== null) {
    throw new Error(
      `anchors and aliases are not allowed here (found \`${anchor[1]}\`) — ` +
        `write the values out`,
    );
  }
}

/**
 * Parses the declaration, or throws with a message written for the repo's author — it is their
 * file, and it will be shown to them in the refusal.
 *
 * An empty or comments-only file is an empty list, not an error: a placeholder is a legitimate
 * thing to commit, exactly as `setup.yml` treats one.
 */
export function parseServicesYaml(text: string): ServiceDeclaration[] {
  refuseAnchors(text);
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new Error(`not valid YAML: ${err instanceof Error ? err.message : err}`);
  }
  if (doc === null || doc === undefined) return [];
  if (!isMapping(doc)) throw new Error("top level must be a mapping with a `services` key");
  for (const key of Object.keys(doc)) {
    if (key !== "services") throw new Error(`unknown key \`${key}\``);
  }
  const services = doc.services;
  if (services === null || services === undefined) return [];
  if (!isMapping(services)) {
    throw new Error("`services` must be a mapping of name → service");
  }
  const names = Object.keys(services);
  if (names.length > MAX_SERVICES) {
    throw new Error(`${names.length} services exceeds the limit of ${MAX_SERVICES}`);
  }
  return names.map((name) => parseOne(name, services[name]));
}

function parseOne(name: string, raw: unknown): ServiceDeclaration {
  if (!SERVICE_NAME.test(name)) {
    throw new Error(
      `services.${name}: a service name is its HOSTNAME, so it must be a DNS label — ` +
        `lowercase letters, digits and dashes, starting with a letter, at most ${MAX_NAME_LEN} ` +
        "characters",
    );
  }
  const at = `services.${name}`;
  if (!isMapping(raw)) throw new Error(`${at}: must be a mapping`);
  const known = ["uses", "image", "capabilities", "command", "env", "port", "checks_only"];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw new Error(`${at}: unknown key \`${key}\``);
  }

  const { uses, image, capabilities, command, env, port, checks_only } = raw;
  if (uses === undefined && image === undefined) {
    throw new Error(`${at}: needs \`uses\` (a catalogue entry, e.g. \`postgres@18\`)`);
  }
  if (uses !== undefined && (typeof uses !== "string" || !USES.test(uses))) {
    throw new Error(`${at}.uses: must name a catalogue entry and version, e.g. \`postgres@18\``);
  }
  if (image !== undefined && (typeof image !== "string" || !isImageRef(image))) {
    throw new Error(`${at}.image: must be an image reference`);
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${at}.port: required — the port your service listens on, which is what the run dials ` +
        `and what the health gate waits for`,
    );
  }

  // A boolean and nothing else. YAML 1.2 reads `yes` and `"true"` as strings, and guessing what
  // they meant would decide whether every run of the repo starts a container.
  if (checks_only !== undefined && typeof checks_only !== "boolean") {
    throw new Error(
      `${at}.checks_only: must be true or false — true starts it only for the checks that ` +
        "name it, never beside a run",
    );
  }

  const declaration: ServiceDeclaration = { name, env: {}, port };
  if (checks_only === true) declaration.checksOnly = true;
  if (typeof uses === "string") declaration.uses = uses;
  if (typeof image === "string") declaration.image = image;
  if (capabilities !== undefined) declaration.capabilities = parseCapabilities(capabilities, at);
  if (command !== undefined) declaration.command = parseCommand(command, at);
  if (env !== undefined && env !== null) declaration.env = parseEnv(env, at);
  return declaration;
}

function parseCommand(raw: unknown, at: string): string[] {
  if (!Array.isArray(raw)) {
    // No string form, and deliberately no shell: `command: postgres -p 5433` would have to be
    // split by someone, and the someone is always a shell nobody asked for.
    throw new Error(`${at}.command: must be a list of arguments, e.g. ["postgres", "-p", "5433"]`);
  }
  if (raw.length > MAX_COMMAND_ARGS) {
    throw new Error(`${at}.command: ${raw.length} arguments exceeds ${MAX_COMMAND_ARGS}`);
  }
  return raw.map((arg, i) => {
    // YAML would hand us a number for `-p 5433` written unquoted in a flow list; say so rather
    // than stringifying it, because the next surprise would be a float.
    if (typeof arg !== "string") throw new Error(`${at}.command[${i}]: must be a string`);
    if (arg === "" || arg.length > MAX_ARG_LEN) {
      throw new Error(`${at}.command[${i}]: must be 1–${MAX_ARG_LEN} characters`);
    }
    return arg;
  });
}

function parseEnv(raw: unknown, at: string): Record<string, string> {
  if (!isMapping(raw)) throw new Error(`${at}.env: must be a mapping of name → value`);
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENV_ENTRIES) {
    throw new Error(`${at}.env: ${entries.length} entries exceeds ${MAX_ENV_ENTRIES}`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ENV_NAME.test(key)) throw new Error(`${at}.env.${key}: not an environment variable name`);
    // Numbers and booleans are what a YAML author means to write here more often than not
    // (`POSTGRES_PORT: 5433`), so they are carried rather than refused — but nothing else is.
    const text = typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : null;
    if (text === null) throw new Error(`${at}.env.${key}: must be a string, number or boolean`);
    if (text.length > MAX_ENV_VALUE_LEN) {
      throw new Error(`${at}.env.${key}: exceeds ${MAX_ENV_VALUE_LEN} characters`);
    }
    env[key] = text;
  }
  return env;
}

function parseCapabilities(raw: unknown, at: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${at}.capabilities: must be a list`);
  return raw.map((cap, i) => {
    if (typeof cap !== "string" || !CAPABILITY.test(cap)) {
      throw new Error(`${at}.capabilities[${i}]: a capability name like "CHOWN", without CAP_`);
    }
    // The escape hatch lets a repo name an image no catalogue reviewed; it must not also let
    // the repo restore the capabilities `drop: ALL` exists to remove. The same rule the
    // catalogue's own schema applies, so neither road reaches further than the other.
    const refused = capabilityRefusal(cap);
    if (refused !== null) throw new Error(`${at}.capabilities[${i}]: ${refused}`);
    return cap;
  });
}

/** Shape only — whether this deployment will RUN it is core/services.ts's question. */
function isImageRef(image: string): boolean {
  return image.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(image) &&
    !image.includes("..");
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
