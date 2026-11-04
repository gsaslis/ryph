// What a valid skill is, its digest, which skills a run is given, and how the trail words a skill
// a run could not be given. The rules are pure, so they are tested as tables; the
// store round-trips a bundle through the real schema.

import { test } from "bun:test";
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  type CatalogueSkill,
  describeDrops,
  describeStale,
  judgeSkill,
  listingBytes,
  MAX_DESCRIPTION_CHARS,
  MAX_LISTED_SKILLS,
  MAX_LISTING_BYTES,
  MAX_PATH_DEPTH,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  type OrgVersion,
  RESERVED_PREFIX,
  resolveRunSkills,
  skillDigest,
  type SkillSync,
  type SkillTreeEntry,
} from "../src/core/skills.ts";
import {
  DEFAULT_SKILL_POLICY,
  DEFAULT_SKILL_SETTINGS,
  type SkillPolicy,
} from "../src/core/types.ts";
import { SETUP_SKILL } from "../src/core/environment_setup.ts";
import { supportsSkills } from "../src/core/harness_tools.ts";
import { drizzleSkillStore } from "../src/adapters/store/drizzle_skills.ts";
import { makeTestDb } from "./db.ts";

const text = (s: string) => new TextEncoder().encode(s);

/** `skillDigest` of `SKILL.md` = "ab" and an executable `run.sh` = "x". */
const GOLDEN_DIGEST = "sha256:a9ebabd0882669a36546d1399a050b3bb92fe819beab940083fc3a9483615d45";

function file(path: string, content: string, executable = false): SkillTreeEntry {
  return { path, type: "file", executable, bytes: text(content) };
}

function skillMd(frontmatter: string, body = "# Body\n\nDo the thing.\n"): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

const VALID = skillMd(
  "name: release\ndescription: How this org cuts a release. Read before tagging.",
);

async function judge(
  entries: SkillTreeEntry[],
  opts: { dir?: string; allowReserved?: boolean } = {},
) {
  return await judgeSkill({
    dir: opts.dir ?? "release",
    entries,
    allowReserved: opts.allowReserved ?? false,
  });
}

test("skills: a well-formed skill is valid, with its files sorted and its description trimmed", async () => {
  const judged = await judge([
    file("scripts/cut.sh", "#!/bin/sh\necho cut\n", true),
    file("SKILL.md", skillMd("name: release\ndescription: '  Cut a release.  '")),
    file("references/steps.md", "1. tag\n"),
  ]);
  assert(judged.kind === "valid", JSON.stringify(judged.warnings));
  assertEquals(judged.warnings, []);
  assertEquals(judged.skill.name, "release");
  assertEquals(judged.skill.description, "Cut a release.");
  assertEquals(judged.skill.files.map((f) => f.path), [
    "SKILL.md",
    "references/steps.md",
    "scripts/cut.sh",
  ]);
  assertEquals(judged.skill.files.find((f) => f.path === "scripts/cut.sh")?.executable, true);
  assert(/^sha256:[0-9a-f]{64}$/.test(judged.skill.digest));
});

test("skills: every rule that drops a skill drops it with a warning naming why", async () => {
  const cases: Array<
    [string, SkillTreeEntry[], string, { dir?: string; allowReserved?: boolean }?]
  > = [
    ["no SKILL.md", [file("README.md", "hi")], "no SKILL.md"],
    [
      "SKILL.md as a symlink",
      [{ path: "SKILL.md", type: "symlink", executable: false, bytes: new Uint8Array() }],
      "no SKILL.md",
    ],
    ["no frontmatter", [file("SKILL.md", "# just a body\n")], "no frontmatter"],
    ["unclosed frontmatter", [file("SKILL.md", "---\nname: release\n")], "no frontmatter"],
    ["not YAML", [file("SKILL.md", skillMd("name: [release"))], "not valid YAML"],
    ["not a mapping", [file("SKILL.md", skillMd("- release"))], "must be a mapping"],
    [
      "a bad name",
      [file("SKILL.md", skillMd("name: Release--x\ndescription: d"))],
      "`name` must be",
    ],
    [
      "a name that is not the directory",
      [file("SKILL.md", skillMd("name: deploy\ndescription: d"))],
      'the directory is "release"',
    ],
    [
      "a reserved name outside the catalogue",
      [file("SKILL.md", skillMd("name: ryph-checks\ndescription: d"))],
      "reserved",
      { dir: "ryph-checks" },
    ],
    ["no description", [file("SKILL.md", skillMd("name: release"))], "`description` is required"],
    [
      "a blank description",
      [file("SKILL.md", skillMd("name: release\ndescription: '   '"))],
      "`description` is required",
    ],
    [
      "a description over 1024 characters",
      [file("SKILL.md", skillMd(`name: release\ndescription: ${"x".repeat(1025)}`))],
      "over the 1024 limit",
    ],
    [
      "control characters in the description",
      [file("SKILL.md", skillMd('name: release\ndescription: "a\\u0007b"'))],
      "control characters",
    ],
    [
      // Valid UTF-8 on disk; YAML decodes the escape after that check, and jsonb refuses it.
      "an unpaired surrogate in the description",
      [file("SKILL.md", skillMd('name: release\ndescription: "hi \\uD800 there"'))],
      "unpaired UTF-16 surrogate",
    ],
    [
      "hidden from the model",
      [file("SKILL.md", skillMd("name: release\ndescription: d\ndisable-model-invocation: true"))],
      "not listed",
    ],
    [
      "a SKILL.md over 64 KiB",
      [file("SKILL.md", skillMd("name: release\ndescription: d", "x".repeat(70_000)))],
      "65536-byte limit",
    ],
    [
      "more than 64 files",
      [file("SKILL.md", VALID), ...Array.from({ length: 64 }, (_, i) => file(`r/${i}.md`, "x"))],
      "over the limit of 64 files",
    ],
    [
      "more than 512 KiB in all, in few files",
      [
        file("SKILL.md", VALID),
        ...Array.from({ length: 9 }, (_, i) => file(`r/${i}.md`, "x".repeat(60_000))),
      ],
      `and ${MAX_SKILL_BYTES} bytes per skill`,
    ],
    [
      "invalid UTF-8",
      [{ path: "SKILL.md", type: "file", executable: false, bytes: new Uint8Array([0xff, 0xfe]) }],
      "not valid UTF-8",
    ],
    // A tree git's fsck would refuse, which a repo that never ran it can still hold.
    [
      "a path twice",
      [file("SKILL.md", VALID), file("notes.md", "a"), file("notes.md", "b")],
      "appears twice",
    ],
    [
      "a file that is also a directory",
      [file("SKILL.md", VALID), file("x", "a"), file("x/y", "b")],
      "also the directory holding x/y",
    ],
  ];
  for (const [what, entries, message, opts] of cases) {
    const judged = await judge(entries, opts);
    assertEquals(judged.kind, "dropped", what);
    assert(
      judged.warnings.some((w) => w.message.includes(message)),
      `${what}: ${JSON.stringify(judged.warnings)}`,
    );
  }
});

// Every cap is inclusive: a skill exactly at each one is valid, so a `>=` written for a `>` fails.
test("skills: a skill at every limit at once is valid", async () => {
  const head = `name: release\ndescription: ${"d".repeat(MAX_DESCRIPTION_CHARS)}`;
  const bare = skillMd(head, "");
  const md = skillMd(head, "x".repeat(MAX_SKILL_MD_BYTES - text(bare).length));
  assertEquals(text(md).length, MAX_SKILL_MD_BYTES);
  // SKILL.md, the deepest path allowed, and enough one-byte files to make the file cap; the
  // deep file carries whatever is left of the byte cap.
  const ones = Array.from({ length: MAX_SKILL_FILES - 2 }, (_, i) => file(`r/${i}.md`, "x"));
  const deep = "a/b/c/d/e/f/g/h.md";
  assertEquals(deep.split("/").length, MAX_PATH_DEPTH);
  const rest = MAX_SKILL_BYTES - MAX_SKILL_MD_BYTES - ones.length;
  const judged = await judge([file("SKILL.md", md), file(deep, "y".repeat(rest)), ...ones]);
  assert(judged.kind === "valid", JSON.stringify(judged.warnings));
  assertEquals(judged.warnings, []);
  assertEquals(judged.skill.files.length, MAX_SKILL_FILES);
  assertEquals(judged.skill.bytes, MAX_SKILL_BYTES);
  assertEquals(judged.skill.description.length, MAX_DESCRIPTION_CHARS);
});

test("skills: a file that breaks a rule is skipped, and the skill keeps the rest", async () => {
  const judged = await judge([
    file("SKILL.md", VALID),
    { path: "link", type: "symlink", executable: false, bytes: new Uint8Array() },
    { path: "vendor", type: "submodule", executable: false, bytes: new Uint8Array() },
    file("bad name.md", "x"),
    file("a/b/c/d/e/f/g/h/i.md", "too deep"),
    file("references/ok.md", "fine"),
  ]);
  assert(judged.kind === "valid");
  assertEquals(judged.skill.files.map((f) => f.path), ["SKILL.md", "references/ok.md"]);
  assertEquals(
    judged.warnings.map((w) => w.path),
    ["release/link", "release/vendor", "release/bad name.md", "release/a/b/c/d/e/f/g/h/i.md"],
  );
});

test("skills: an optional field that does not fit is left out with a warning, not the skill", async () => {
  const judged = await judge([
    file(
      "SKILL.md",
      skillMd(
        [
          "name: release",
          "description: d",
          "license: MIT",
          "compatibility: ''",
          "allowed-tools: Bash(git:*) Read",
          "metadata:",
          "  owner: platform",
          "  version: 2",
        ].join("\n"),
      ),
    ),
  ]);
  assert(judged.kind === "valid");
  assertEquals(judged.skill.frontmatter, { license: "MIT", allowedTools: "Bash(git:*) Read" });
  assertEquals(judged.warnings.length, 2, JSON.stringify(judged.warnings));
  assert(judged.warnings.some((w) => w.message.includes("`compatibility`")));
  assert(judged.warnings.some((w) => w.message.includes("`metadata`")));
});

test("skills: an optional field jsonb could not store is left out, not the skill", async () => {
  const judged = await judge([
    file(
      "SKILL.md",
      skillMd(
        [
          "name: release",
          "description: d",
          'license: "MIT\\0"',
          'compatibility: "pi \\uDC00"',
          "allowed-tools: Read",
          "metadata:",
          '  owner: "plat\\0form"',
        ].join("\n"),
      ),
    ),
  ]);
  assert(judged.kind === "valid", JSON.stringify(judged.warnings));
  assertEquals(judged.skill.frontmatter, { allowedTools: "Read" });
  assertEquals(
    judged.warnings.map((w) => w.message.split(" ")[0]),
    ["`license`", "`compatibility`", "`metadata`"],
  );
  // And a key, not only a value.
  const byKey = await judge([
    file("SKILL.md", skillMd('name: release\ndescription: d\nmetadata:\n  "a\\uD800": b')),
  ]);
  assert(byKey.kind === "valid");
  assertEquals(byKey.skill.frontmatter, {});
});

test("skills: the catalogue may use the reserved prefix", async () => {
  const judged = await judge(
    [file("SKILL.md", skillMd("name: ryph-checks\ndescription: d"))],
    { dir: "ryph-checks", allowReserved: true },
  );
  assertEquals(judged.kind, "valid");
});

test("skills: the digest is the specification's, over source bytes, path order and modes", async () => {
  const files = [
    { path: "SKILL.md", executable: false, bytes: text("ab") },
    { path: "run.sh", executable: true, bytes: text("x") },
  ];
  // Spelled out byte for byte, so a change to the framing cannot pass by changing both sides.
  const framed = text("SKILL.md\0-\x002\0ab" + "run.sh\0x\x001\0x");
  const expected = `sha256:${
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", framed)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("")
  }`;
  assertEquals(await skillDigest(files), expected);
  // The literal, held in @ryph/runner's skills_test too: the runner restates the framing, and a
  // change on either side alone fails one of the two suites.
  assertEquals(expected, GOLDEN_DIGEST);
  assertEquals(await skillDigest([...files].reverse()), expected, "order of input is irrelevant");
  assertNotEquals(
    await skillDigest([files[0], { ...files[1], executable: false }]),
    expected,
    "the mode is part of it",
  );
});

const catalogueSkill = (name: string, description = `What ${name} is for.`): CatalogueSkill => ({
  name,
  description,
  digest: `sha256:${name.length.toString(16).padStart(64, "0")}`,
  bytes: 10,
  files: [{ path: "SKILL.md", bytes: 10 }],
  frontmatter: {},
  presentation: null,
  icons: null,
});

const CATALOGUE = [catalogueSkill("ryph-environment"), catalogueSkill("ryph-checks")];

test("resolution: a harness without skills support is frozen with none", () => {
  assertEquals(supportsSkills("echo"), false);
  assertEquals(supportsSkills("pi"), true);
  assertEquals(supportsSkills("constructor"), false);
  const resolved = resolveRunSkills({
    supportsSkills: false,
    catalogue: CATALOGUE,
    settings: DEFAULT_SKILL_SETTINGS,
    org: null,
    policy: null,
    pinned: [],
  });
  assertEquals(resolved, { skills: null, drops: [] });
});

test("resolution: by default every catalogue skill is on, in name order, with the rest of the budget", () => {
  const resolved = resolveRunSkills({
    supportsSkills: true,
    catalogue: CATALOGUE,
    settings: DEFAULT_SKILL_SETTINGS,
    org: null,
    policy: null,
    pinned: [],
  });
  assertEquals(resolved.drops, []);
  assertEquals(resolved.skills?.skills.map((s) => [s.name, s.source]), [
    ["ryph-checks", "catalogue"],
    ["ryph-environment", "catalogue"],
  ]);
  assertEquals(resolved.skills?.org, null);
  assertEquals(resolved.skills?.workingRepos, true);
  assertEquals(resolved.skills?.budget, {
    skills: MAX_LISTED_SKILLS - 2,
    listingBytes: MAX_LISTING_BYTES - CATALOGUE.reduce((sum, s) => sum + listingBytes(s), 0),
  });
});

test("resolution: an admin's off beats the setup pin; the agent's off does not", () => {
  const resolve = (opts: { adminOff?: string[]; agentOff?: string[]; pinned?: string[] }) =>
    resolveRunSkills({
      supportsSkills: true,
      catalogue: CATALOGUE,
      settings: { ...DEFAULT_SKILL_SETTINGS, disabledCatalogue: opts.adminOff ?? [] },
      org: null,
      policy: {
        ...DEFAULT_SKILL_POLICY,
        catalogue: { disabled: opts.agentOff ?? [] },
      },
      pinned: opts.pinned ?? [],
    }).skills?.skills.map((s) => s.name);

  assertEquals(resolve({ agentOff: ["ryph-environment"] }), ["ryph-checks"]);
  assertEquals(
    resolve({ agentOff: ["ryph-environment"], pinned: [SETUP_SKILL] }),
    ["ryph-checks", "ryph-environment"],
  );
  assertEquals(resolve({ adminOff: ["ryph-environment"], pinned: [SETUP_SKILL] }), [
    "ryph-checks",
  ]);
  // Neither is a drop: turning a skill off is a decision, not something the trail reports.
  assertEquals(
    resolveRunSkills({
      supportsSkills: true,
      catalogue: CATALOGUE,
      settings: { ...DEFAULT_SKILL_SETTINGS, disabledCatalogue: ["ryph-checks"] },
      org: null,
      policy: null,
      pinned: [],
    }).drops,
    [],
  );
});

test("resolution: working-repo skills need both the deployment and the agent", () => {
  const workingRepos = (deployment: boolean, agent: boolean) =>
    resolveRunSkills({
      supportsSkills: true,
      catalogue: [],
      settings: { ...DEFAULT_SKILL_SETTINGS, workingRepoSkills: deployment },
      org: null,
      policy: { ...DEFAULT_SKILL_POLICY, workingRepos: { enabled: agent } },
      pinned: [],
    }).skills?.workingRepos;
  assertEquals(workingRepos(true, true), true);
  assertEquals(workingRepos(false, true), false);
  assertEquals(workingRepos(true, false), false);
});

test("resolution: the caps admit pinned skills first and drop the rest, by name and reason", () => {
  const many = Array.from(
    { length: MAX_LISTED_SKILLS + 3 },
    (_, i) => catalogueSkill(`ryph-s${String(i).padStart(2, "0")}`),
  );
  const resolved = resolveRunSkills({
    supportsSkills: true,
    catalogue: many,
    settings: DEFAULT_SKILL_SETTINGS,
    org: null,
    policy: null,
    pinned: ["ryph-s34"],
  });
  const names = resolved.skills!.skills.map((s) => s.name);
  assertEquals(names.length, MAX_LISTED_SKILLS);
  assert(names.includes("ryph-s34"), "the pinned skill is admitted first");
  assertEquals(resolved.drops.map((d) => [d.name, d.reason]), [
    ["ryph-s31", "cap"],
    ["ryph-s32", "cap"],
    ["ryph-s33", "cap"],
  ]);
  assertEquals(resolved.skills!.budget.skills, 0);

  const wordy = [catalogueSkill("ryph-a", "x".repeat(1000))];
  for (let i = 0; i < 20; i++) wordy.push(catalogueSkill(`ryph-b${i}`, "y".repeat(1000)));
  const byBytes = resolveRunSkills({
    supportsSkills: true,
    catalogue: wordy,
    settings: DEFAULT_SKILL_SETTINGS,
    org: null,
    policy: null,
    pinned: [],
  });
  const used = byBytes.skills!.skills.reduce((sum, s) => sum + listingBytes(s), 0);
  assert(used <= MAX_LISTING_BYTES);
  assert(byBytes.drops.length > 0 && byBytes.drops.every((d) => d.reason === "cap"));
  assertEquals(byBytes.skills!.budget.listingBytes, MAX_LISTING_BYTES - used);
  assertStringIncludes(describeDrops(byBytes.drops), "(catalogue): over the 32-skill");

  // The byte cap is inclusive and the fill greedy: fifteen 1024-byte listings, one that no
  // longer fits, then one that fills the cap exactly and is still admitted after the refusal.
  const filler = (name: string) => catalogueSkill(name, "z".repeat(1024 - name.length));
  const exact = [
    ...Array.from({ length: 15 }, (_, i) => filler(`ryph-a${String(i).padStart(2, "0")}`)),
    catalogueSkill("ryph-m", "w".repeat(1100)),
    filler("ryph-z00"),
  ];
  const atCap = resolveRunSkills({
    supportsSkills: true,
    catalogue: exact,
    settings: DEFAULT_SKILL_SETTINGS,
    org: null,
    policy: null,
    pinned: [],
  });
  assertEquals(atCap.drops.map((d) => [d.name, d.reason]), [["ryph-m", "cap"]]);
  assertEquals(atCap.skills!.skills.length, 16);
  assertEquals(atCap.skills!.skills.at(-1)?.name, "ryph-z00");
  assertEquals(atCap.skills!.budget, { skills: MAX_LISTED_SKILLS - 16, listingBytes: 0 });
});

test("resolution: a name already taken is dropped as a collision, naming the winner", () => {
  const resolved = resolveRunSkills({
    supportsSkills: true,
    catalogue: [catalogueSkill("ryph-checks"), catalogueSkill("ryph-checks", "a second copy")],
    settings: DEFAULT_SKILL_SETTINGS,
    org: null,
    policy: null,
    pinned: [],
  });
  assertEquals(resolved.skills!.skills.length, 1);
  assertEquals(resolved.drops, [
    { name: "ryph-checks", source: "catalogue", reason: "collision", winner: "catalogue" },
  ]);
  assertEquals(
    describeDrops(resolved.drops),
    "ryph-checks (catalogue): the name is already taken by a skill from ryph's catalogue",
  );
});

function orgVersion(names: string[], opts: { stale?: boolean } = {}): OrgVersion {
  const sync: SkillSync = {
    id: "ss_1",
    connectedRepoId: "cr_skills",
    branch: "main",
    trigger: "push",
    outcome: "synced",
    failure: null,
    rulesVersion: 1,
    commit: "c0ffee".padEnd(40, "0"),
    treeId: "t".repeat(40),
    skillCount: names.length,
    warnings: [],
    error: null,
    repeats: 1,
    requestedBy: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T00:00:01.000Z",
  };
  const failed: SkillSync = {
    ...sync,
    id: "ss_2",
    outcome: "failed",
    failure: "missing-ref",
    commit: null,
    treeId: null,
    skillCount: 0,
    error: "branch main no longer exists",
    finishedAt: "2026-10-02T00:00:00.000Z",
  };
  return {
    connectedRepoId: "cr_skills",
    repoRef: "acme/skills",
    sync,
    skills: names.map((name) => ({
      name,
      description: `What ${name} is for.`,
      digest: `sha256:${"e".repeat(63)}${name.length.toString(16).slice(-1)}`,
      frontmatter: {},
      presentation: null,
    })),
    lastFailure: opts.stale ? failed : null,
  };
}

test("resolution: org skills follow the catalogue, in name order, naming the version they came from", () => {
  const resolved = resolveRunSkills({
    supportsSkills: true,
    catalogue: CATALOGUE,
    settings: DEFAULT_SKILL_SETTINGS,
    org: orgVersion(["release", "deploy"]),
    policy: null,
    pinned: [],
  });
  assertEquals(resolved.drops, []);
  assertEquals(resolved.skills!.skills.map((s) => [s.name, s.source]), [
    ["ryph-checks", "catalogue"],
    ["ryph-environment", "catalogue"],
    ["deploy", "org"],
    ["release", "org"],
  ]);
  assertEquals(resolved.skills!.org, {
    connectedRepoId: "cr_skills",
    repoRef: "acme/skills",
    commit: "c0ffee".padEnd(40, "0"),
    syncId: "ss_1",
    syncedAt: "2026-10-01T00:00:01.000Z",
    stale: false,
  });
  assertEquals(resolved.skills!.budget.skills, MAX_LISTED_SKILLS - 4);
});

test("resolution: the agent narrows the org repo per skill or whole, and only org skills it keeps name the version", () => {
  const resolve = (org: SkillPolicy["org"]) =>
    resolveRunSkills({
      supportsSkills: true,
      catalogue: CATALOGUE,
      settings: DEFAULT_SKILL_SETTINGS,
      org: orgVersion(["release", "deploy"], { stale: true }),
      policy: { ...DEFAULT_SKILL_POLICY, org },
      pinned: [],
    });
  const one = resolve({ enabled: true, disabled: ["deploy"] });
  assertEquals(one.skills!.skills.filter((s) => s.source === "org").map((s) => s.name), [
    "release",
  ]);
  assertEquals(one.skills!.org?.stale, true);
  assertEquals(one.drops, [], "turning a skill off is not a drop");
  // The repo off for this agent, its picks kept: no org skill, and no version named.
  const off = resolve({ enabled: false, disabled: ["deploy"] });
  assertEquals(off.skills!.skills.map((s) => s.source), ["catalogue", "catalogue"]);
  assertEquals(off.skills!.org, null);
  // Every org skill turned off one by one is the same: the run holds nothing from that version.
  assertEquals(resolve({ enabled: true, disabled: ["deploy", "release"] }).skills!.org, null);
});

test("resolution: precedence is decided here, not by the prefix: a reserved org name is dropped, a taken one collides", () => {
  const resolved = resolveRunSkills({
    supportsSkills: true,
    catalogue: [catalogueSkill("ryph-checks"), catalogueSkill("release")],
    settings: DEFAULT_SKILL_SETTINGS,
    org: orgVersion(["release", "ryph-checks", "deploy"]),
    policy: null,
    pinned: [],
  });
  assertEquals(resolved.skills!.skills.map((s) => [s.name, s.source]), [
    ["release", "catalogue"],
    ["ryph-checks", "catalogue"],
    ["deploy", "org"],
  ]);
  assertEquals(resolved.drops, [
    { name: "ryph-checks", source: "org", reason: "reserved" },
    { name: "release", source: "org", reason: "collision", winner: "catalogue" },
  ]);
});

test("resolution: the caps fill with the catalogue first, then the org repo, and an admin's off frees room", () => {
  const org = Array.from({ length: MAX_LISTED_SKILLS }, (_, i) => `o${String(i).padStart(2, "0")}`);
  const resolve = (disabledCatalogue: string[]) =>
    resolveRunSkills({
      supportsSkills: true,
      catalogue: CATALOGUE,
      settings: { ...DEFAULT_SKILL_SETTINGS, disabledCatalogue },
      org: orgVersion(org),
      policy: null,
      pinned: [],
    });
  const full = resolve([]);
  assertEquals(full.skills!.skills.length, MAX_LISTED_SKILLS);
  assertEquals(full.skills!.skills.slice(0, 2).map((s) => s.source), ["catalogue", "catalogue"]);
  assertEquals(full.drops.map((d) => [d.name, d.source, d.reason]), [
    ["o30", "org", "cap"],
    ["o31", "org", "cap"],
  ]);
  assertEquals(full.skills!.budget.skills, 0);
  const roomier = resolve(["ryph-checks"]);
  assertEquals(roomier.drops.map((d) => d.name), ["o31"]);
});

test("resolution: a stale version reads as such on the trail", () => {
  const org = orgVersion(["release"], { stale: true });
  assertEquals(
    describeStale(org, org.lastFailure!),
    "the org skills came from acme/skills at c0ffee000000, synced 2026-10-01T00:00:01.000Z; " +
      "the latest read failed (branch main no longer exists), so they may be behind the repo " +
      "as it stands",
  );
});

test("drops read one way whoever wrote them: every reason, a repo's path, and a detail", () => {
  assertEquals(
    describeDrops([
      { name: "deploy", source: "repo", path: "api", reason: "collision", winner: "org" },
      { name: "lint", source: "repo", path: "web", reason: "cap" },
      { name: "ryph-mine", source: "repo", path: "api", reason: "reserved" },
      { name: "release", source: "org", reason: "invalid", detail: "no SKILL.md" },
      { name: "ryph-checks", source: "catalogue", reason: "unavailable", detail: "HTTP 503" },
    ]),
    [
      "deploy (`api/`): the name is already taken by a skill from the org skills repo",
      `lint (\`web/\`): over the ${MAX_LISTED_SKILLS}-skill or ${MAX_LISTING_BYTES}-byte listing cap`,
      `ryph-mine (\`api/\`): names starting with "${RESERVED_PREFIX}" are reserved for ryph`,
      "release (org): it did not validate; no SKILL.md",
      "ryph-checks (catalogue): its files could not be loaded; HTTP 503",
    ].join("\n"),
  );
});

test("the skill store keeps one row per digest, and answers it back whole", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleSkillStore(handle, () => new Date("2026-10-01T00:00:00.000Z"));
    const bundle = {
      digest: `sha256:${"a".repeat(64)}`,
      bytes: 3,
      files: [{ path: "SKILL.md", executable: false, content: text("abc").toBase64() }],
    };
    await store.upsertBundles([bundle]);
    // A second boot writes the same digest again: nothing changes, nothing throws.
    await store.upsertBundles([bundle, bundle]);
    await store.upsertBundles([]);
    assertEquals(await store.bundle(bundle.digest), bundle);
    assertEquals(await store.bundle(`sha256:${"b".repeat(64)}`), null);
  } finally {
    await handle.close();
  }
});
