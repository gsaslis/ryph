// The ryph skills catalogue stays true by test, not by care: it loads through the real adapter, so
// an invalid skill fails CI and not a boot; every example of a ryph file it shows goes through the
// parser that reads that file; the facts it states about limits and names are checked against the
// constants that enforce them; and it leaves most of every run's listing budget to org and repo
// skills.
//
// `.ryph/setup.yml` examples are the runner's to check, with its own parser:
// packages/runner/tests/skill_catalogue_examples_test.ts.

import { test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  directorySkillCatalogue,
  SKILL_CATALOGUE_DIR,
} from "../src/adapters/skill_catalogue/directory.ts";
import { directoryServiceCatalogue } from "../src/adapters/service_catalogue/directory.ts";
import { listingBytes, MAX_LISTED_SKILLS, MAX_LISTING_BYTES } from "../src/core/skills.ts";
import {
  MAX_DECLARED_TIMEOUT_S,
  MAX_GLOB_CHARS,
  MAX_SERVICES_PER_CHECK,
  MAX_WILDCARDS,
  parseChecksYaml,
} from "../src/helpers/checks.ts";
import {
  MAX_ARG_LEN,
  MAX_COMMAND_ARGS,
  MAX_ENV_ENTRIES,
  MAX_ENV_VALUE_LEN,
  MAX_NAME_LEN,
  MAX_SERVICES,
  parseServicesYaml,
  SERVICE_NAME,
} from "../src/helpers/services.ts";
import {
  CHECK_NAME,
  DEFAULT_KEEP,
  MAX_CHECKS,
  MAX_KEEP,
  MAX_OWN_PODS,
  MAX_RUN_CHARS,
  MAX_SETUP_STEPS,
  MAX_WATCH,
} from "../src/core/check_types.ts";
import { DEFAULT_CHECK_POLICY } from "../src/core/check_policy.ts";
import { SIZE_CLASS_NAME } from "../src/core/run_sizes.ts";
import {
  DEFAULT_SERVICE_POLICY,
  RESERVED_SERVICE_NAMES,
  RUNNER_CONTROL_PORT,
} from "../src/core/services.ts";
import { UNIVERSAL_IMAGE } from "../src/core/environment_setup.ts";

/** Every Markdown file the catalogue ships, by path relative to the catalogue root. */
async function markdown(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (entry.name.endsWith(".md")) {
        out.set(path, await readFile(join(dir, entry.name), "utf8"));
      }
    }
  };
  await walk(SKILL_CATALOGUE_DIR, "");
  return out;
}

/** The ryph files the catalogue shows examples of; each has a parser test of its own. */
const EXAMPLE_FILES = [".ryph/checks.yml", ".ryph/services.yml", ".ryph/setup.yml"];

/** The fenced blocks whose first line names a ryph file (`# .ryph/checks.yml`), by that file. */
function examples(docs: Map<string, string>, file: string): Array<{ where: string; text: string }> {
  const found: Array<{ where: string; text: string }> = [];
  for (const [path, text] of docs) {
    for (const match of text.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)) {
      if (match[1].split("\n")[0].trim() === `# ${file}`) {
        found.push({ where: path, text: match[1] });
      }
    }
  }
  return found;
}

test("the catalogue loads through the real adapter: ryph-artifact-design, ryph-checks and ryph-environment", async () => {
  const catalogue = await directorySkillCatalogue();
  const skills = catalogue.list();
  assertEquals(skills.map((s) => s.name), [
    "ryph-artifact-design",
    "ryph-checks",
    "ryph-environment",
  ]);
  for (const skill of skills) {
    const bundle = catalogue.bundle(skill.digest);
    assert(bundle !== null, skill.name);
    assertEquals(bundle.files.map((f) => f.path), skill.files.map((f) => f.path));
    assert(bundle.files.every((f) => !f.executable), "no catalogue file is executable");
    assert(skill.files.some((f) => f.path === "SKILL.md"));
  }
  assertEquals(catalogue.bundle(`sha256:${"0".repeat(64)}`), null);
});

test("the catalogue leaves most of a run's listing to org and repo skills", async () => {
  const skills = (await directorySkillCatalogue()).list();
  assert(skills.length * 2 <= MAX_LISTED_SKILLS, `${skills.length} skills`);
  const bytes = skills.reduce((sum, s) => sum + listingBytes(s), 0);
  assert(bytes * 2 <= MAX_LISTING_BYTES, `${bytes} listing bytes`);
});

// The parser tests pick examples up by their first line, so an example without it, or with a
// typo in it, would never be parsed and nothing would fail.
test("every YAML example in the catalogue names the ryph file it shows, so a parser reads it", async () => {
  let fences = 0;
  for (const [path, text] of await markdown()) {
    for (const match of text.matchAll(/^```(?:yaml|yml)\n([\s\S]*?)^```/gm)) {
      fences += 1;
      const first = match[1].split("\n")[0].trim();
      assert(
        EXAMPLE_FILES.some((file) => first === `# ${file}`),
        `${path}: a YAML example starts with "${first}", not one of ${EXAMPLE_FILES.join(", ")}`,
      );
    }
  }
  assert(fences > 0);
});

test("every .ryph/checks.yml example in the catalogue parses with the real parser", async () => {
  const found = examples(await markdown(), ".ryph/checks.yml");
  assert(found.length > 0, "the catalogue shows at least one checks.yml");
  for (const { where, text } of found) {
    const parsed = parseChecksYaml(text);
    assert(parsed.checks.length > 0, `${where}: an example declares at least one check`);
  }
});

test("every .ryph/services.yml example parses, and names a catalogue entry it may configure", async () => {
  const found = examples(await markdown(), ".ryph/services.yml");
  assert(found.length > 0, "the catalogue shows at least one services.yml");
  const entries = await (await directoryServiceCatalogue()).list();
  for (const { where, text } of found) {
    for (const service of parseServicesYaml(text)) {
      const at = `${where}: services.${service.name}`;
      assert(!RESERVED_SERVICE_NAMES.includes(service.name), `${at} uses a reserved name`);
      assert(service.port !== RUNNER_CONTROL_PORT, `${at} uses the runner's port`);
      const [id, version] = (service.uses ?? "").split("@");
      const entry = entries.find((e) => e.id === id);
      assert(entry !== undefined && version in entry.versions, `${at}: ${service.uses}`);
      for (const key of Object.keys(service.env)) {
        assert(entry.env.includes(key), `${at}: ${id} takes no setting ${key}`);
      }
    }
  }
});

test("the services reference names every catalogue entry and every refused name", async () => {
  const reference = (await markdown()).get("ryph-environment/references/services-yml.md")!;
  for (const entry of await (await directoryServiceCatalogue()).list()) {
    for (const version of Object.keys(entry.versions)) {
      assertStringIncludes(reference, `\`${entry.id}@${version}\``);
    }
    assertStringIncludes(reference, String(entry.defaultPort));
    for (const key of entry.env) assertStringIncludes(reference, `\`${key}\``);
  }
  for (const name of RESERVED_SERVICE_NAMES) assertStringIncludes(reference, `\`${name}\``);
  assertStringIncludes(reference, `Port ${RUNNER_CONTROL_PORT}`);
});

test("the services reference states the parser's limits and the policy's default", async () => {
  const reference = (await markdown()).get("ryph-environment/references/services-yml.md")!;
  assertStringIncludes(reference, `at most ${MAX_SERVICES} entries`);
  assertStringIncludes(reference, `\`${SERVICE_NAME.source}\``);
  assertStringIncludes(reference, `at most ${MAX_NAME_LEN} characters`);
  assertStringIncludes(reference, `at most ${MAX_COMMAND_ARGS}, each 1–${MAX_ARG_LEN} characters`);
  assertStringIncludes(reference, `At most ${MAX_ENV_ENTRIES} settings`);
  assertStringIncludes(reference, `at most ${MAX_ENV_VALUE_LEN} characters`);
  assertStringIncludes(reference, `(${DEFAULT_SERVICE_POLICY.max} by default)`);
});

test("the checks reference states the parser's limits and names and the policy's defaults", async () => {
  const docs = await markdown();
  const reference = docs.get("ryph-checks/references/checks-yml.md")!;
  assertStringIncludes(reference, `at most ${MAX_CHECKS} checks`);
  assertStringIncludes(reference, `at most ${MAX_SETUP_STEPS} steps`);
  assertStringIncludes(reference, `${MAX_RUN_CHARS} characters`);
  assertStringIncludes(reference, `\`${CHECK_NAME.source}\``);
  assertStringIncludes(reference, `at most ${MAX_WATCH} path globs`);
  assertStringIncludes(reference, `at most ${MAX_KEEP} gitignore-style patterns`);
  assertStringIncludes(reference, `At most ${MAX_OWN_PODS} checks of a file may be \`pod: own\``);
  assertStringIncludes(reference, `\`${SIZE_CLASS_NAME.source}\``);
  assertStringIncludes(reference, `\`[${DEFAULT_KEEP.join(", ")}]\``);
  assertStringIncludes(docs.get("ryph-checks/SKILL.md")!, `\`[${DEFAULT_KEEP.join(", ")}]\``);
  assertStringIncludes(reference, `at most ${MAX_SERVICES_PER_CHECK} service names`);
  assertStringIncludes(reference, `At most ${MAX_DECLARED_TIMEOUT_S / 3600}h declared`);
  assertStringIncludes(
    reference,
    `at most ${MAX_GLOB_CHARS} characters, with at most ${MAX_WILDCARDS}`,
  );
  assertStringIncludes(reference, `\`${SERVICE_NAME.source}\``);
  const minutes = DEFAULT_CHECK_POLICY.defaultTimeoutSeconds / 60;
  const hours = DEFAULT_CHECK_POLICY.maxTimeoutSeconds / 3600;
  assertStringIncludes(reference, `${minutes} minutes`);
  assertStringIncludes(docs.get("ryph-checks/SKILL.md")!, `Default ${minutes} minutes`);
  // The docs spell the cap in words; this ties those words to the constant.
  assertEquals(hours, 1, "the docs say the cap defaults to one hour");
  assertStringIncludes(reference, "(one hour by default)");
  assertStringIncludes(docs.get("ryph-checks/SKILL.md")!, "(default 1 hour)");
  assertStringIncludes(
    docs.get("ryph-checks/SKILL.md")!,
    `(${DEFAULT_CHECK_POLICY.maxPerRun} by default)`,
  );
});

test("the environment skill recommends the base image the platform maps", async () => {
  const docs = await markdown();
  assertStringIncludes(docs.get("ryph-environment/SKILL.md")!, `FROM ${UNIVERSAL_IMAGE}`);
  assertStringIncludes(
    docs.get("ryph-environment/references/dockerfile.md")!,
    `FROM ${UNIVERSAL_IMAGE}`,
  );
});

test("an invalid catalogue fails the load loudly, naming every problem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await mkdir(join(dir, "ryph-ok"));
    await writeFile(
      join(dir, "ryph-ok", "SKILL.md"),
      "---\nname: ryph-ok\ndescription: fine\nlicense: 7\n---\nbody\n",
    );
    await mkdir(join(dir, "plain"));
    await writeFile(
      join(dir, "plain", "SKILL.md"),
      "---\nname: plain\ndescription: d\n---\n",
    );
    await writeFile(join(dir, "README.md"), "not a skill, and not a problem");
    const err = await assertRejects(() => directorySkillCatalogue(dir), Error);
    // A field the org repo would merely drop is a failure here: this is platform content.
    assertStringIncludes(err.message, "ryph-ok/SKILL.md: `license`");
    assertStringIncludes(err.message, 'plain: "plain" does not start with "ryph-"');
    assert(!err.message.includes("README"));
  } finally {
    await rm(dir, { recursive: true });
  }
});
