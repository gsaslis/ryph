// Skills on the runner's side: a frozen bundle is held to its digest and to the name and
// description it was frozen as, SKILL.md is written with a frontmatter that has one reading, the
// working repos' own skills are the ones each committed, and the core writes the skills only
// once setup is over, into a directory no setup step could see.
//
// The digest and the frontmatter rules are restated from @ryph/orchestrator on purpose, so they
// are also tested against it: a golden digest both suites hold, and the real catalogue, judged by
// the control plane's own code, accepted here. Tests sit outside both architecture guards, so
// the import across packages is a test's, never the runner's.

import { test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import {
  DESCRIPTION_CONTROL,
  isSkillPath,
  listingBytes,
  MAX_ALLOWED_TOOLS_CHARS,
  MAX_COMPATIBILITY_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_LICENSE_CHARS,
  MAX_LISTED_SKILLS,
  MAX_LISTING_BYTES,
  MAX_METADATA_CHARS,
  MAX_METADATA_KEYS,
  MAX_PATH_DEPTH,
  MAX_REPORTED_SKILL_DROPS,
  MAX_SKILL_BYTES,
  MAX_SKILL_DROP_DETAIL,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  MAX_SKILL_NAME,
  MAX_SKILL_PATH,
  normalizedSkillMd,
  PATH_SEGMENT,
  type PreparedSkill,
  prepareFrozenSkill,
  removeSkills,
  reportableDrops,
  RESERVED_PREFIX,
  SKILL_NAME,
  skillDigest,
  skillDir,
  writeSkills,
} from "../src/helpers/skills.ts";
import type { RunSkill, SkillBundle, SkillDrop } from "../src/core/types.ts";
import type { Harness, HarnessInput } from "../src/ports/harness.ts";
import type { SkillBundles } from "../src/ports/skills.ts";
import { run } from "../src/core/run.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { bindActions, makeRunFixture, repoEntry } from "./util.ts";
import type { RunActions } from "../src/ports/run_actions.ts";
import { gitHooksDir } from "../src/helpers/git_exec.ts";
import { directorySkillCatalogue } from "../../orchestrator/src/adapters/skill_catalogue/directory.ts";
import { RunnerSkillsReportSchema } from "../../orchestrator/src/schema.ts";
import * as control from "../../orchestrator/src/core/skills.ts";
import { DEFAULT_SKILL_SETTINGS } from "../../orchestrator/src/core/types.ts";
import { readRunSkills, RunSpecSchema } from "../src/schema.ts";

const text = (s: string) => new TextEncoder().encode(s);

// The runner's own git hooks directory is made once per process under TMPDIR, and the run tests
// below point TMPDIR at directories they remove. Made here first, it outlives them.
gitHooksDir();

const SKILL_MD = "---\nname: ryph-checks\ndescription: >-\n  How checks work.\n  Read first.\n" +
  "license: MIT\nmetadata:\n  owner: platform\n---\n# ryph checks\n\nBody, kept as written: --- \n";

async function frozen(
  files: Array<{ path: string; executable: boolean; content: string }>,
  overrides: Partial<RunSkill> = {},
): Promise<{ skill: RunSkill; bundle: SkillBundle }> {
  const digest = await skillDigest(
    files.map((f) => ({ path: f.path, executable: f.executable, bytes: text(f.content) })),
  );
  return {
    skill: {
      name: "ryph-checks",
      description: "How checks work. Read first.",
      source: "catalogue",
      digest,
      ...overrides,
    },
    bundle: {
      files: files.map((f) => ({
        path: f.path,
        executable: f.executable,
        content: text(f.content).toBase64(),
      })),
    },
  };
}

/** `skillDigest` of `SKILL.md` = "ab" and an executable `run.sh` = "x": the literal
 * @ryph/orchestrator's skills_test holds too. */
const GOLDEN_DIGEST = "sha256:a9ebabd0882669a36546d1399a050b3bb92fe819beab940083fc3a9483615d45";

test("skills: the digest is the control plane's, byte for byte", async () => {
  const files = [
    { path: "SKILL.md", executable: false, bytes: text("ab") },
    { path: "run.sh", executable: true, bytes: text("x") },
  ];
  // The framing spelled out, as the control plane's test spells it.
  const framed = text("SKILL.md\0-\x002\0ab" + "run.sh\0x\x001\0x");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", framed));
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(`sha256:${hex}`, GOLDEN_DIGEST);
  assertEquals(await skillDigest(files), GOLDEN_DIGEST);
  assertEquals(await skillDigest([...files].reverse()), GOLDEN_DIGEST);
});

test("skills: every catalogue skill, as the control plane freezes and serves it, is accepted", async () => {
  const catalogue = await directorySkillCatalogue();
  const skills = catalogue.list();
  assert(skills.length > 0, "the catalogue ships skills");
  for (const skill of skills) {
    const bundle = catalogue.bundle(skill.digest);
    assert(bundle !== null, skill.name);
    const prepared = await prepareFrozenSkill(
      {
        name: skill.name,
        description: skill.description,
        source: "catalogue",
        digest: skill.digest,
      },
      { files: bundle.files },
    );
    assert(!("refused" in prepared), `${skill.name}: ${JSON.stringify(prepared)}`);
    assertEquals(prepared.description, skill.description);
    // What pi will read back from the normalized file is what the control plane counted.
    const [, yaml] = normalizedSkillMd(prepared).split(/^---$/m);
    const doc = parseYaml(yaml) as { name: string; description: string };
    assertEquals([doc.name, doc.description], [skill.name, skill.description]);
  }
});

const FILES = [
  { path: "SKILL.md", executable: false, content: SKILL_MD },
  { path: "scripts/check.sh", executable: true, content: "#!/bin/sh\necho ok\n" },
];

test("skills: a bundle that matches what was frozen is prepared, its body kept as written", async () => {
  const { skill, bundle } = await frozen(FILES);
  const prepared = await prepareFrozenSkill(skill, bundle);
  assert(!("refused" in prepared), JSON.stringify(prepared));
  assertEquals(prepared.name, "ryph-checks");
  assertEquals(prepared.source, "catalogue");
  assertEquals(prepared.frontmatter, { license: "MIT", metadata: { owner: "platform" } });
  assertEquals(prepared.body, "# ryph checks\n\nBody, kept as written: --- \n");
});

test("skills: a bundle that is not what was frozen is refused, saying why", async () => {
  const { skill, bundle } = await frozen(FILES);
  const refusals: Array<[string, RunSkill, SkillBundle, string]> = [
    [
      "a file changed",
      skill,
      {
        files: [{ ...bundle.files[0], content: text(SKILL_MD + "!").toBase64() }, bundle.files[1]],
      },
      "do not match the digest",
    ],
    [
      "a mode changed",
      skill,
      { files: [bundle.files[0], { ...bundle.files[1], executable: false }] },
      "do not match the digest",
    ],
    ["another name", { ...skill, name: "ryph-other" }, bundle, "frozen as"],
    ["another description", { ...skill, description: "Something else." }, bundle, "frozen as"],
    [
      "a path out of the skill",
      skill,
      { files: [...bundle.files, { path: "../x", executable: false, content: "" }] },
      "not allowed",
    ],
    [
      "not base64",
      skill,
      { files: [{ ...bundle.files[0], content: "%%%" }] },
      "not valid base64",
    ],
    ["a file twice", skill, { files: [...bundle.files, bundle.files[1]] }, "appears twice"],
    [
      "a file that is also a directory",
      skill,
      {
        files: [...bundle.files, {
          path: "scripts/check.sh/inner",
          executable: false,
          content: text("x").toBase64(),
        }],
      },
      "also the directory holding scripts/check.sh/inner",
    ],
    [
      "more files than a skill may hold",
      skill,
      {
        files: [
          ...bundle.files,
          ...Array.from({ length: MAX_SKILL_FILES - 1 }, (_, i) => ({
            path: `r/${i}.md`,
            executable: false,
            content: text("x").toBase64(),
          })),
        ],
      },
      "over the limit",
    ],
    [
      "more bytes than a skill may hold",
      skill,
      {
        files: [...bundle.files, {
          path: "big.bin",
          executable: false,
          content: new Uint8Array(MAX_SKILL_BYTES).toBase64(),
        }],
      },
      "over the limit",
    ],
  ];
  for (const [what, s, b, message] of refusals) {
    const prepared = await prepareFrozenSkill(s, b);
    assert("refused" in prepared, what);
    assertStringIncludes(prepared.refused, message, what);
  }
  const noSkillMd = await frozen([FILES[1]]);
  const prepared = await prepareFrozenSkill(noSkillMd.skill, noSkillMd.bundle);
  assert("refused" in prepared && prepared.refused === "no SKILL.md");
});

test("skills: the written frontmatter is JSON-quoted, has one reading, and keeps the body", () => {
  const skill = {
    name: "release",
    description: 'Cut a release: "tag", then push.\n\tSecond line, # not a comment',
    frontmatter: {
      license: "Apache-2.0",
      allowedTools: "Bash(git:*)",
      metadata: { "a key: with colon": "v&*!" },
    },
    body: "\n# Release\n\n---\nnot frontmatter\n",
  };
  const written = normalizedSkillMd(skill);
  assert(written.startsWith('---\nname: "release"\ndescription: '), written);
  const [, yaml, ...rest] = written.split(/^---$/m);
  assertEquals(parseYaml(yaml), {
    name: skill.name,
    description: skill.description,
    license: "Apache-2.0",
    "allowed-tools": "Bash(git:*)",
    metadata: { "a key: with colon": "v&*!" },
  });
  assertEquals(rest.join("---"), "\n" + skill.body);
});

test("skills: writing puts each skill in its own directory with its modes, and removing cleans up", async () => {
  const { skill, bundle } = await frozen(FILES);
  const prepared = await prepareFrozenSkill(skill, bundle) as PreparedSkill;
  const { root, written } = await writeSkills([prepared]);
  const dirs = written.map((w) => "dir" in w ? w.dir : w.error);
  try {
    assertEquals(dirs, [`${root}/catalogue/ryph-checks`]);
    const md = await readFile(`${dirs[0]}/SKILL.md`, "utf8");
    assert(md.startsWith('---\nname: "ryph-checks"\ndescription: "How checks work. Read first."'));
    assert(md.endsWith("Body, kept as written: --- \n"));
    if (process.platform !== "win32") {
      assertEquals((await stat(`${dirs[0]}/scripts/check.sh`)).mode! & 0o777, 0o755);
      assertEquals((await stat(`${dirs[0]}/SKILL.md`)).mode! & 0o777, 0o644);
    }
  } finally {
    await removeSkills(root);
  }
  assertEquals(await stat(root).then(() => true, () => false), false);
  assert(isSkillPath("references/a.md"));
  assert(!isSkillPath("a/../b") && !isSkillPath("/abs") && !isSkillPath("a b"));
  // The schema's cheap length bound is exactly the longest path the check accepts.
  const longest = Array.from({ length: MAX_PATH_DEPTH }, () => "a".repeat(128)).join("/");
  assertEquals(longest.length, MAX_SKILL_PATH);
  assert(isSkillPath(longest));
  assert(!isSkillPath(`${longest}/a`) && !isSkillPath(longest.replace("a", "aa")));
});

test("skills: a skill's directory names its origin and ends in its name", () => {
  assertEquals(
    skillDir("/r", { source: "catalogue", name: "ryph-checks" }),
    "/r/catalogue/ryph-checks",
  );
  assertEquals(skillDir("/r", { source: "org", name: "deploy" }), "/r/org/deploy");
  assertEquals(
    skillDir("/r", { source: "repo", path: "api", name: "deploy" }),
    "/r/repo/api/deploy",
  );
  // Whatever already held them, nothing joined here climbs out of the root.
  for (const path of ["..", ".", "a/b", ""]) {
    assertThrows(() => skillDir("/r", { source: "repo", path, name: "deploy" }));
  }
  assertThrows(() => skillDir("/r", { source: "org", name: "../deploy" }));
});

test("skills: a skill that cannot be written costs only itself", async () => {
  const { skill, bundle } = await frozen(FILES);
  const good = await prepareFrozenSkill(skill, bundle) as PreparedSkill;
  // What no prepare lets through, built by hand: `x` both a file and a directory.
  const broken: PreparedSkill = {
    ...good,
    name: "broken",
    files: [
      good.files[0],
      { path: "x", executable: false, bytes: text("file") },
      { path: "x/y", executable: false, bytes: text("nested") },
    ],
  };
  const { root, written } = await writeSkills([broken, good]);
  try {
    assert("error" in written[0], JSON.stringify(written[0]));
    assertEquals(written[1], { dir: `${root}/catalogue/ryph-checks` });
    assertEquals(await stat(`${root}/catalogue/broken`).then(() => true, () => false), false);
    assert(
      (await readFile(`${root}/catalogue/ryph-checks/SKILL.md`, "utf8")).includes("ryph-checks"),
    );
  } finally {
    await removeSkills(root);
  }
});

/** A harness that records what it was handed and reads every skill back at the moment it ran. */
function recordingHarness(actions: () => RunActions) {
  const seen: { skills: HarnessInput["skills"]; skillMd: string[] } = { skills: [], skillMd: [] };
  const harness: Harness = {
    async run(input) {
      seen.skills = input.skills;
      for (const skill of input.skills) {
        seen.skillMd.push(await readFile(`${skill.dir}/SKILL.md`, "utf8"));
      }
      actions().reportOutcome({ outcome: "no-changes" });
      return { summary: "done", interrupted: false };
    },
  };
  return { harness, seen };
}

test("run: frozen skills are written only after setup, outside the clones, then removed", async () => {
  const { skill, bundle } = await frozen(FILES);
  const unavailable = { ...skill, name: "ryph-gone", digest: `sha256:${"0".repeat(64)}` };
  // A fetch that throws, with the kind of message an HTTP body or a schema error makes.
  const flaky = { ...skill, name: "ryph-flaky", digest: `sha256:${"1".repeat(64)}` };
  // A bundle that is not what the run was frozen with.
  const tampered = { ...skill, name: "ryph-tampered", digest: `sha256:${"2".repeat(64)}` };
  const bundles: SkillBundles = {
    fetch: (digest) => {
      if (digest === flaky.digest) {
        return Promise.reject(new Error("line one\nline two\t" + "x".repeat(600)));
      }
      if (digest === tampered.digest) return Promise.resolve(bundle);
      return Promise.resolve(digest === skill.digest ? bundle : null);
    },
  };
  // TMPDIR is where the core makes the skills directory; a setup step lists it to show nothing
  // was there while it ran, and tries to plant a skill where the directory will appear.
  const tmp = await mkdtemp(join(tmpdir(), "runner-skills-tmp-"));
  const probe = `${tmp}-probe.txt`;
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  process.env.SKILLS_PROBE = probe;
  const gateway = fakeOrchestratorGateway();
  const f = await makeRunFixture(gateway, {
    repoFiles: {
      ".ryph/setup.yml": 'steps:\n  - run: ls "$TMPDIR" > "$SKILLS_PROBE"\n' +
        '  - run: mkdir -p "$TMPDIR/ryph-skills-planted/ryph-checks"\n',
    },
  });
  const { harness, seen } = recordingHarness(bindActions(f));
  try {
    const result = await run(f.item, {
      ...f.ctx,
      harness,
      skills: {
        spec: {
          skills: [skill, unavailable, flaky, tampered],
          workingRepos: false,
          budget: { skills: 30, listingBytes: 16_000 },
        },
        bundles,
      },
    });
    assertEquals(result.status, "success", JSON.stringify(result));
    assert(!(await readFile(probe, "utf8")).includes("ryph-skills-"), "nothing existed in setup");
    assertEquals(seen.skills.map((s) => [s.name, s.source]), [["ryph-checks", "catalogue"]]);
    const dir = seen.skills[0].dir;
    assert(dir.startsWith(tmp) && !dir.startsWith(f.checkoutRoot), dir);
    assert(!dir.includes("planted"), "the core made its own directory, not the planted one");
    assert(seen.skillMd[0].startsWith('---\nname: "ryph-checks"'));
    // Gone once the harness was done with it.
    assertEquals(await stat(dir).then(() => true, () => false), false);
    // Every skill that did not arrive was dropped, saying why, in one report.
    assertEquals(gateway.skillReports.length, 1);
    const [report] = gateway.skillReports;
    // It names the directory the skills were written under, which the run page trusts.
    assertEquals(report.root, dir.slice(0, dir.indexOf("/catalogue/")));
    assertEquals(
      report.dropped.map((d) => [d.name, d.reason]),
      [["ryph-gone", "unavailable"], ["ryph-flaky", "unavailable"], ["ryph-tampered", "invalid"]],
    );
    assertEquals(report.dropped[0].detail, "the platform holds no such version");
    // A thrown error reaches the trail as one bounded line: the control plane refuses a report
    // with a multi-line detail whole, and every drop in it would be lost.
    const detail = report.dropped[1].detail!;
    assert(detail.startsWith("line one line two x"), detail);
    assert(!/[\r\n]/.test(detail) && detail.length === MAX_SKILL_DROP_DETAIL, detail);
    assertStringIncludes(report.dropped[2].detail!, "do not match the digest");
    // And the control plane's own schema takes it, at the longest it takes and no longer.
    assert(RunnerSkillsReportSchema.safeParse(report).success, JSON.stringify(report));
    const at = (detail: string) => ({
      loaded: [],
      dropped: [{ ...report.dropped[1], detail }],
    });
    assert(!RunnerSkillsReportSchema.safeParse(at("x".repeat(MAX_SKILL_DROP_DETAIL + 1))).success);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    delete process.env.SKILLS_PROBE;
    await f.cleanup();
    await rm(tmp, { recursive: true });
    await rm(probe).catch(() => {});
  }
});

test("run: skills that cannot be written cost the run its skills, never the run", async () => {
  const { skill, bundle } = await frozen(FILES);
  // The core makes the skills directory under TMPDIR once setup is over; the last setup step
  // makes TMPDIR read-only, so that write fails while the clone before it did not.
  const tmp = await mkdtemp(join(tmpdir(), "runner-skills-ro-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  const gateway = fakeOrchestratorGateway();
  const f = await makeRunFixture(gateway, {
    repoFiles: { ".ryph/setup.yml": 'steps:\n  - run: chmod 555 "$TMPDIR"\n' },
  });
  const { harness, seen } = recordingHarness(bindActions(f));
  try {
    const result = await run(f.item, {
      ...f.ctx,
      harness,
      skills: {
        spec: {
          skills: [skill],
          workingRepos: false,
          budget: { skills: 31, listingBytes: 16_000 },
        },
        bundles: { fetch: () => Promise.resolve(bundle) },
      },
    });
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(seen.skills, []);
    assertEquals(gateway.skillReports, [{
      root: null,
      loaded: [],
      dropped: [{
        source: "catalogue",
        name: "ryph-checks",
        reason: "unavailable",
        detail: "it could not be written to disk",
      }],
    }]);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await chmod(tmp, 0o755);
    await f.cleanup();
    await rm(tmp, { recursive: true });
  }
});

test("run: a run with no frozen skills hands the harness none and reports nothing", async () => {
  const gateway = fakeOrchestratorGateway();
  const f = await makeRunFixture(gateway);
  const { harness, seen } = recordingHarness(bindActions(f));
  try {
    await run(f.item, { ...f.ctx, harness });
    assertEquals(seen.skills, []);
    assertEquals(gateway.skillReports, []);
  } finally {
    await f.cleanup();
  }
});

test("run: the repos' own skills are what each committed, after the frozen ones, and reported", async () => {
  const { skill, bundle } = await frozen(FILES);
  const org: RunSkill = {
    name: "deploy",
    description: "The org's deploy.",
    source: "org",
    digest: `sha256:${"3".repeat(64)}`,
  };
  const release = "---\nname: release\ndescription: How we release.\n---\n# Release\n";
  const gateway = fakeOrchestratorGateway();
  const f = await makeRunFixture(gateway, {
    repoFiles: {
      ".agents/skills/release/SKILL.md": release,
      // A setup step rewrites the committed skill and plants another, leaving a tree that looks
      // clean (skip-worktree, .gitignore): the run gets neither.
      ".gitignore": ".agents/skills/planted/\n",
      ".ryph/tamper.sh": "git update-index --skip-worktree .agents/skills/release/SKILL.md\n" +
        "printf -- '---\\nname: release\\ndescription: Rewritten.\\n---\\n' " +
        "> .agents/skills/release/SKILL.md\n" +
        "mkdir -p .agents/skills/planted\n" +
        "printf -- '---\\nname: planted\\ndescription: Planted.\\n---\\n' " +
        "> .agents/skills/planted/SKILL.md\n",
      ".ryph/setup.yml": "steps:\n  - run: bash .ryph/tamper.sh\n",
    },
    moreRepos: [{
      path: "api",
      files: { ".agents/skills/deploy/SKILL.md": release.replaceAll("release", "deploy") },
    }],
  });
  const { harness, seen } = recordingHarness(bindActions(f));
  try {
    const result = await run(f.item, {
      ...f.ctx,
      harness,
      skills: {
        spec: {
          skills: [skill, org],
          workingRepos: true,
          budget: { skills: 30, listingBytes: 16_000 },
        },
        bundles: {
          fetch: (digest) => Promise.resolve(digest === skill.digest ? bundle : null),
        },
      },
    });
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(
      seen.skills.map((s) => [s.name, s.source, s.source === "repo" ? s.path : null]),
      [["ryph-checks", "catalogue", null], ["release", "repo", "repo"]],
    );
    // The worktree was rewritten, and the run got what the repository committed anyway,
    // normalized like every other skill.
    assertStringIncludes(
      await readFile(`${f.checkoutDir}/.agents/skills/release/SKILL.md`, "utf8"),
      "Rewritten.",
    );
    assertEquals(
      seen.skillMd[1],
      '---\nname: "release"\ndescription: "How we release."\n---\n# Release\n',
    );
    assert(!seen.skills[1].dir.startsWith(f.checkoutRoot), "outside every clone");
    // Each is written under where it came from, so the location the agent is shown names a
    // repo's own skill as the repo's.
    const root = seen.skills[0].dir.slice(0, -"/catalogue/ryph-checks".length);
    assertEquals(seen.skills.map((s) => s.dir), [
      `${root}/catalogue/ryph-checks`,
      `${root}/repo/repo/release`,
    ]);
    assertEquals(gateway.skillReports.length, 1);
    const [report] = gateway.skillReports;
    assertEquals(report.loaded, [{ path: "repo", name: "release" }]);
    assertEquals(report.dropped.map((d) => [d.name, d.reason]), [
      ["deploy", "unavailable"],
      ["deploy", "collision"],
    ]);
    assert(RunnerSkillsReportSchema.safeParse(report).success, JSON.stringify(report));
  } finally {
    await f.cleanup();
  }
});

test("run: with the repos' own skills off, none are read, and the report says so", async () => {
  const gateway = fakeOrchestratorGateway();
  const f = await makeRunFixture(gateway, {
    repoFiles: {
      ".agents/skills/release/SKILL.md": "---\nname: release\ndescription: How.\n---\n",
    },
  });
  const { harness, seen } = recordingHarness(bindActions(f));
  try {
    await run(f.item, {
      ...f.ctx,
      harness,
      skills: {
        spec: { skills: [], workingRepos: false, budget: { skills: 32, listingBytes: 16_384 } },
        bundles: { fetch: () => Promise.resolve(null) },
      },
    });
    assertEquals(seen.skills, []);
    assertEquals(gateway.skillReports, [{ root: null, loaded: [], dropped: [] }]);
  } finally {
    await f.cleanup();
  }
});

// The wire's bounds are restated here, and a spec they refuse costs the run its skills: so each
// is held to the control plane's constant, and what the control plane freezes at its own caps is
// read whole by this side.
test("skills: past the report's limit, the drops kept say how many more there were", () => {
  const drop = (i: number): SkillDrop => ({
    source: "repo",
    path: `repo-${i % 5}`,
    name: `skill-${i}`,
    reason: "cap",
  });
  const few = Array.from({ length: MAX_REPORTED_SKILL_DROPS }, (_, i) => drop(i));
  assertEquals(reportableDrops(few), few);

  const many = Array.from({ length: MAX_REPORTED_SKILL_DROPS + 32 }, (_, i) => drop(i));
  const kept = reportableDrops(many);
  assertEquals(kept.length, MAX_REPORTED_SKILL_DROPS);
  assertEquals(kept.slice(0, -1), many.slice(0, MAX_REPORTED_SKILL_DROPS - 1));
  assertEquals(kept.at(-1)!.name, many[MAX_REPORTED_SKILL_DROPS - 1].name);
  assertEquals(kept.at(-1)!.detail, "32 more skills were dropped and are not listed");
  assert(RunnerSkillsReportSchema.safeParse({ root: null, loaded: [], dropped: kept }).success);

  // A long detail of its own is clipped after the count, never the count.
  many[MAX_REPORTED_SKILL_DROPS - 1] = { ...drop(0), detail: "x".repeat(MAX_SKILL_DROP_DETAIL) };
  const clipped = reportableDrops(many).at(-1)!.detail!;
  assert(clipped.startsWith("32 more skills") && clipped.length === MAX_SKILL_DROP_DETAIL);
  assert(
    RunnerSkillsReportSchema.safeParse({ root: null, loaded: [], dropped: reportableDrops(many) })
      .success,
  );
});

test("skills: the runner's bounds are the control plane's, and a spec frozen at the caps reads whole", () => {
  assertEquals(
    {
      SKILL_NAME: SKILL_NAME.source,
      DESCRIPTION_CONTROL: DESCRIPTION_CONTROL.source,
      PATH_SEGMENT: PATH_SEGMENT.source,
      MAX_SKILL_NAME,
      MAX_DESCRIPTION_CHARS,
      MAX_SKILL_MD_BYTES,
      MAX_SKILL_FILES,
      MAX_SKILL_BYTES,
      MAX_PATH_DEPTH,
      MAX_LISTED_SKILLS,
      MAX_LISTING_BYTES,
      RESERVED_PREFIX,
      MAX_SKILL_DROP_DETAIL,
      MAX_REPORTED_SKILL_DROPS,
      MAX_LICENSE_CHARS,
      MAX_COMPATIBILITY_CHARS,
      MAX_METADATA_KEYS,
      MAX_METADATA_CHARS,
      MAX_ALLOWED_TOOLS_CHARS,
    },
    {
      SKILL_NAME: control.SKILL_NAME.source,
      DESCRIPTION_CONTROL: control.DESCRIPTION_CONTROL.source,
      PATH_SEGMENT: control.PATH_SEGMENT.source,
      MAX_SKILL_NAME: control.MAX_SKILL_NAME,
      MAX_DESCRIPTION_CHARS: control.MAX_DESCRIPTION_CHARS,
      MAX_SKILL_MD_BYTES: control.MAX_SKILL_MD_BYTES,
      MAX_SKILL_FILES: control.MAX_SKILL_FILES,
      MAX_SKILL_BYTES: control.MAX_SKILL_BYTES,
      MAX_PATH_DEPTH: control.MAX_PATH_DEPTH,
      MAX_LISTED_SKILLS: control.MAX_LISTED_SKILLS,
      MAX_LISTING_BYTES: control.MAX_LISTING_BYTES,
      RESERVED_PREFIX: control.RESERVED_PREFIX,
      MAX_SKILL_DROP_DETAIL: control.MAX_SKILL_DROP_DETAIL,
      MAX_REPORTED_SKILL_DROPS: control.MAX_REPORTED_SKILL_DROPS,
      MAX_LICENSE_CHARS: control.MAX_LICENSE_CHARS,
      MAX_COMPATIBILITY_CHARS: control.MAX_COMPATIBILITY_CHARS,
      MAX_METADATA_KEYS: control.MAX_METADATA_KEYS,
      MAX_METADATA_CHARS: control.MAX_METADATA_CHARS,
      MAX_ALLOWED_TOOLS_CHARS: control.MAX_ALLOWED_TOOLS_CHARS,
    },
  );
  // A listing is costed the way the control plane costs it, or the budget it froze for the
  // working repos is spent by another measure.
  for (const skill of [{ name: "deploy", description: "Ship it, ünd quickly." }]) {
    assertEquals(listingBytes(skill), control.listingBytes(skill));
  }

  // One catalogue that fills the count cap and one that fills the byte cap, each led by a skill
  // at the longest name and description the control plane accepts.
  const catalogue = (descriptionChars: number): control.CatalogueSkill[] =>
    Array.from({ length: control.MAX_LISTED_SKILLS + 8 }, (_, i) => ({
      name: i === 0
        ? `ryph-${"a".repeat(control.MAX_SKILL_NAME - 5)}`
        : `ryph-s${String(i).padStart(2, "0")}`,
      description: i === 0 ? "d".repeat(control.MAX_DESCRIPTION_CHARS) : "d".repeat(
        descriptionChars,
      ),
      digest: `sha256:${i.toString(16).padStart(64, "0")}`,
      bytes: 3,
      files: [{ path: "SKILL.md", bytes: 3 }],
      frontmatter: {},
      presentation: null,
      icons: null,
    }));
  for (const descriptionChars of [100, control.MAX_DESCRIPTION_CHARS]) {
    const resolved = control.resolveRunSkills({
      supportsSkills: true,
      catalogue: catalogue(descriptionChars),
      settings: DEFAULT_SKILL_SETTINGS,
      org: null,
      policy: null,
      pinned: [],
    });
    assert(resolved.drops.some((d) => d.reason === "cap"), "the catalogue must reach a cap");
    const frozen = resolved.skills!;
    // As the spec route serves it: without the org provenance.
    const served = {
      skills: frozen.skills,
      workingRepos: frozen.workingRepos,
      budget: frozen.budget,
    };
    const spec = RunSpecSchema.parse({
      workItem: {
        id: "wi-1",
        agent: { name: "ada", email: "ada@runner.local" },
        spec: { title: "t", instructions: "i" },
        repos: [repoEntry({ url: "https://example.com/repo.git" })],
        workspace: null,
        harness: { kind: "pi" },
        lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
      },
      injectedContext: null,
      skills: served,
    });
    assertEquals(readRunSkills(spec.skills), { skills: served, refused: null });
  }
});
