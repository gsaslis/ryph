// What the ryph skills catalogue says about the runner, held to the runner. The catalogue ships
// with the orchestrator (packages/orchestrator/skills), which checks what it says about the
// formats the control plane parses; setup.yml and environment.md are read here, and the tools
// the skills steer the agent to are served here, so those are checked here, by reading the
// catalogue by relative path. A setup.yml example the runner would refuse, a limit the runner
// does not enforce, or a tool it does not serve cannot ship.

import { test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  discoverEnvironment,
  MAX_ENVIRONMENT_BYTES,
  MAX_NAME_LEN,
  MAX_RUN_LEN,
  MAX_SETUP_BYTES,
  MAX_STEPS,
} from "../src/helpers/environment.ts";
import { REPO_CONFIG_DIR } from "../src/core/brand.ts";
import { LOOPBACK_SERVER_SLUG, LOOPBACK_TOOLS } from "../src/adapters/loopback/mcp.ts";

const CATALOGUE = fromFileUrl(new URL("../../orchestrator/skills", import.meta.url));

async function markdown(dir: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await markdown(path));
    else if (entry.name.endsWith(".md")) out.push({ path, text: await readFile(path, "utf8") });
  }
  return out;
}

test("every .ryph/setup.yml example in the skills catalogue parses with the runner's parser", async () => {
  const examples = (await markdown(CATALOGUE)).flatMap(({ path, text }) =>
    [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)]
      .map((m) => m[1])
      .filter((block) => block.split("\n")[0].trim() === `# ${REPO_CONFIG_DIR}/setup.yml`)
      .map((block) => ({ path, block }))
  );
  assert(examples.length > 0, "the catalogue shows at least one setup.yml");
  for (const { path, block } of examples) {
    const checkout = await mkdtemp(join(tmpdir(), "runner-skill-example-"));
    try {
      await mkdir(`${checkout}/${REPO_CONFIG_DIR}`);
      await writeFile(`${checkout}/${REPO_CONFIG_DIR}/setup.yml`, block);
      const env = await discoverEnvironment(checkout);
      assert(env.setup.length > 0, `${path}: an example declares at least one step`);
    } finally {
      await rm(checkout, { recursive: true });
    }
  }
});

test("the setup.yml reference and the environment skill state the runner's limits", async () => {
  const docs = new Map(
    (await markdown(CATALOGUE)).map(({ path, text }) => [path.slice(CATALOGUE.length + 1), text]),
  );
  const setup = docs.get("ryph-environment/references/setup-yml.md")!;
  assertStringIncludes(setup, `at most ${MAX_STEPS} steps`);
  assertStringIncludes(setup, `at most ${MAX_RUN_LEN.toLocaleString("en-US")} characters`);
  assertStringIncludes(setup, `at most ${MAX_NAME_LEN} characters`);
  assertStringIncludes(setup, `at most ${MAX_SETUP_BYTES / 1024 / 1024} MiB`);
  assertStringIncludes(
    docs.get("ryph-environment/SKILL.md")!,
    `At most ${MAX_ENVIRONMENT_BYTES / 1024} KiB per repository`,
  );
});

test("every ryph__ tool the catalogue names is one the runner serves", async () => {
  const served = new Set<string>(LOOPBACK_TOOLS.map((tool) => tool.name));
  const prefix = `${LOOPBACK_SERVER_SLUG}__`;
  const named = (await markdown(CATALOGUE)).flatMap(({ path, text }) =>
    [...text.matchAll(new RegExp(`\\b${prefix}([a-z0-9_]+)`, "g"))].map((m) => ({
      path,
      name: m[1],
    }))
  );
  assert(named.length > 0, "the catalogue names at least one tool");
  for (const { path, name } of named) {
    assert(served.has(name), `${path} names ${prefix}${name}, which the runner does not serve`);
  }
});
