// A working repo's own skills, read the way the runner reads them: from git objects at the
// clone's base commit, judged by the control plane's rules, and put after the frozen skills in
// precedence. The fixtures are real repos, so what is tested is what git answers: a gitignored
// skill planted in the worktree, an uncommitted edit, a replace ref, a symlinked SKILL.md, a
// binary asset.

import { test } from "bun:test";
import { command } from "@ryph/process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { catFileBatch, git, gitBounded } from "../src/helpers/git_exec.ts";
import {
  discoverRepoSkills,
  MAX_REPO_SKILL_BYTES,
  MAX_REPO_SKILL_DIRS,
  MAX_REPO_SKILLS_LISTING_BYTES,
  type RepoToRead,
} from "../src/helpers/repo_skills.ts";
import { MAX_SKILL_BYTES, normalizedSkillMd, skillDigest } from "../src/helpers/skills.ts";
import type { RunSkill } from "../src/core/types.ts";
import { RunnerSkillsReportSchema } from "../../orchestrator/src/schema.ts";
import * as control from "../../orchestrator/src/core/skills.ts";

const skillMd = (name: string, description = `How to ${name}.`, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n\nSteps.\n`;

const BUDGET = { skills: 30, listingBytes: 16_000 };

/** A repo with one commit holding `files` (a Uint8Array is written as bytes; `exec` paths get
 * mode 755), answering what `discoverRepoSkills` reads. */
async function makeRepo(
  path: string,
  files: Record<string, string | Uint8Array>,
  opts: { exec?: string[]; links?: Record<string, string> } = {},
): Promise<RepoToRead & { cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "runner-repo-skills-"));
  await git(dir, "init", "-b", "main");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(`${dir}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true })
      .catch(() => {});
    if (typeof content === "string") await writeFile(`${dir}/${file}`, content);
    else await writeFile(`${dir}/${file}`, content);
  }
  for (const file of opts.exec ?? []) await chmod(`${dir}/${file}`, 0o755);
  for (const [link, target] of Object.entries(opts.links ?? {})) {
    await mkdir(`${dir}/${link.slice(0, link.lastIndexOf("/"))}`, { recursive: true });
    await symlink(target, `${dir}/${link}`);
  }
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@test.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "seed",
  );
  const commit = await git(dir, "rev-parse", "HEAD");
  return { path, dir, commit, cleanup: () => rm(dir, { recursive: true }) };
}

test("repo skills: what the repository committed, judged, with every refusal named", async () => {
  const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff, 0x0a, 0x20]);
  const repo = await makeRepo("api", {
    ".gitignore": ".agents/skills/planted/\n",
    ".agents/skills/README.md": "Our skills.\n",
    ".agents/skills/release/SKILL.md": skillMd(
      "release",
      "How we cut a release.",
      "license: MIT\n",
    ),
    ".agents/skills/release/scripts/cut.sh": "#!/bin/sh\necho cut\n",
    ".agents/skills/release/assets/logo.png": logo,
    ".agents/skills/release/references/target.md": "the real reference\n",
    ".agents/skills/deploy/SKILL.md": skillMd("deploy"),
    ".agents/skills/ryph-mine/SKILL.md": skillMd("ryph-mine"),
    ".agents/skills/broken/SKILL.md": "---\nname: broken\n---\nno description\n",
    ".agents/skills/hidden/SKILL.md": skillMd("hidden", "x", "disable-model-invocation: true\n"),
    ".agents/skills/misnamed/SKILL.md": skillMd("other"),
    ".agents/skills/Bad_Name/SKILL.md": skillMd("Bad_Name"),
    "elsewhere/SKILL.md": skillMd("linked"),
  }, {
    exec: [".agents/skills/release/scripts/cut.sh"],
    links: {
      // A SKILL.md that points elsewhere is no SKILL.md, and a link inside a skill is skipped
      // rather than followed.
      ".agents/skills/linked/SKILL.md": "../../../elsewhere/SKILL.md",
      ".agents/skills/release/references/link.md": "/etc/passwd",
      ".agents/skills/alias": "release",
    },
  });
  try {
    // After the commit: a gitignored skill planted in the worktree, and an uncommitted rewrite of
    // a committed one. Neither is what the repository committed.
    await mkdir(`${repo.dir}/.agents/skills/planted`);
    await writeFile(`${repo.dir}/.agents/skills/planted/SKILL.md`, skillMd("planted"));
    await writeFile(
      `${repo.dir}/.agents/skills/deploy/SKILL.md`,
      skillMd("deploy", "Rewritten after the commit."),
    );
    // And a replace ref standing in another blob for the committed reference file.
    const real = await git(
      repo.dir,
      "rev-parse",
      `HEAD:.agents/skills/release/references/target.md`,
    );
    const evilDir = await mkdtemp(join(tmpdir(), "ryph-"));
    const evil = join(evilDir, "evil");
    await writeFile(evil, "the replaced reference\n");
    const evilId = await git(repo.dir, "hash-object", "-w", evil);
    await git(repo.dir, "replace", real, evilId);
    await rm(evilDir, { recursive: true });

    const found = await discoverRepoSkills({
      repos: [repo],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(found.unread, []);
    assertEquals(found.prepared.map((s) => [s.name, s.source, s.path]), [
      ["deploy", "repo", "api"],
      ["release", "repo", "api"],
    ]);
    assertEquals(found.prepared[0].description, "How to deploy.", "the committed one");
    const release = found.prepared[1];
    assertEquals(release.frontmatter, { license: "MIT" });
    assertEquals(release.files.map((f) => [f.path, f.executable]), [
      ["SKILL.md", false],
      ["assets/logo.png", false],
      ["references/target.md", false],
      ["scripts/cut.sh", true],
    ]);
    assertEquals(release.files[1].bytes, logo, "binary content survives byte for byte");
    assertEquals(
      new TextDecoder().decode(release.files[2].bytes),
      "the real reference\n",
      "a replace ref does not stand in for a committed object",
    );
    assertStringIncludes(normalizedSkillMd(release), 'name: "release"');

    assertEquals(
      found.dropped.map((d) => [d.name, d.reason]).sort(),
      [
        ["alias", "invalid"],
        ["broken", "invalid"],
        ["hidden", "invalid"],
        ["linked", "invalid"],
        ["misnamed", "invalid"],
        ["ryph-mine", "reserved"],
      ],
    );
    const detail = (name: string) => found.dropped.find((d) => d.name === name)?.detail ?? "";
    assertStringIncludes(detail("linked"), "no SKILL.md");
    assertStringIncludes(detail("misnamed"), "the directory is");
    assertStringIncludes(detail("hidden"), "disable-model-invocation");
    // A directory whose name is no skill name cannot be named on the trail.
    assertEquals(found.unnamed.map((u) => u.path), ["Bad_Name"]);
    // And the control plane takes what this would report.
    const report = {
      root: null,
      loaded: found.prepared.map((s) => ({ path: "api", name: s.name })),
      dropped: found.dropped,
    };
    assert(RunnerSkillsReportSchema.safeParse(report).success, JSON.stringify(report));
  } finally {
    await repo.cleanup();
  }
});

test("repo skills: preferred root shadows even invalid copies, without merging files or reading losers", async () => {
  const repo = await makeRepo("app", {
    ".agents/skills/deploy/SKILL.md": skillMd("deploy", "Preferred."),
    ".claude/skills/deploy/SKILL.md": skillMd("deploy", "Shadowed."),
    ".claude/skills/deploy/extra.txt": "not merged",
    ".agents/skills/broken/SKILL.md": "invalid",
    ".claude/skills/broken/SKILL.md": skillMd("broken"),
    ".claude/skills/alias/SKILL.md": skillMd("alias"),
    ".claude/skills/alone/SKILL.md": skillMd("alone"),
  }, { links: { ".agents/skills/alias": "deploy" } });
  try {
    const readIds: string[] = [];
    const found = await discoverRepoSkills({
      repos: [repo],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: (dir, ids, bytes) => {
        readIds.push(...ids);
        return catFileBatch(dir, ids, bytes);
      },
    });
    assertEquals(found.prepared.map((s) => [s.name, s.description]), [
      ["alone", "How to alone."],
      ["deploy", "Preferred."],
    ]);
    assertEquals(found.prepared[1].files.map((f) => f.path), ["SKILL.md"]);
    const collisions = found.dropped.filter((d) => d.reason === "collision");
    assertEquals(collisions.map((d) => [d.name, d.winner]), [
      ["alias", "repo"],
      ["broken", "repo"],
      ["deploy", "repo"],
    ]);
    for (const d of collisions) {
      assertStringIncludes(
        d.detail!,
        `.claude/skills/${d.name} is shadowed by .agents/skills/${d.name}`,
      );
      const id = await git(
        repo.dir,
        "rev-parse",
        `${repo.commit}:.claude/skills/${d.name}/SKILL.md`,
      );
      assert(!readIds.includes(id), "shadowed content is not read");
    }
    assert(
      RunnerSkillsReportSchema.safeParse({ root: null, loaded: [], dropped: found.dropped })
        .success,
    );
  } finally {
    await repo.cleanup();
  }
});

test("repo skills: Claude skills use base objects, never worktree, replace refs, or links", async () => {
  const repo = await makeRepo("app", {
    ".gitignore": ".claude/skills/planted/\n",
    ".claude/skills/deploy/SKILL.md": skillMd("deploy", "Base commit."),
    ".claude/skills/deploy/ref.txt": "original\n",
    ".claude/skills/ryph-private/SKILL.md": skillMd("ryph-private"),
    "outside/SKILL.md": skillMd("linked"),
  }, {
    links: {
      ".claude/skills/linked/SKILL.md": "../../../outside/SKILL.md",
      ".claude/skills/deploy/escape": "/etc/passwd",
      ".claude/skills/alias": "deploy",
    },
  });
  try {
    const original = await git(
      repo.dir,
      "rev-parse",
      `${repo.commit}:.claude/skills/deploy/ref.txt`,
    );
    await writeFile(`${repo.dir}/.claude/skills/deploy/ref.txt`, "replacement\n");
    const replacement = await git(repo.dir, "hash-object", "-w", ".claude/skills/deploy/ref.txt");
    await git(repo.dir, "replace", original, replacement);
    await writeFile(`${repo.dir}/.claude/skills/deploy/SKILL.md`, skillMd("deploy", "New HEAD."));
    await git(repo.dir, "add", "-A");
    await git(
      repo.dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@test.local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "later",
    );
    await writeFile(`${repo.dir}/.claude/skills/deploy/SKILL.md`, skillMd("deploy", "Worktree."));
    await mkdir(`${repo.dir}/.claude/skills/planted`);
    await writeFile(`${repo.dir}/.claude/skills/planted/SKILL.md`, skillMd("planted"));
    const found = await discoverRepoSkills({
      repos: [repo],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(found.prepared.map((s) => [s.name, s.description]), [["deploy", "Base commit."]]);
    assertEquals(found.prepared[0].files.map((f) => f.path), ["SKILL.md", "ref.txt"]);
    assertEquals(new TextDecoder().decode(found.prepared[0].files[1].bytes), "original\n");
    assertEquals(found.dropped.map((d) => [d.name, d.reason]), [
      ["alias", "invalid"],
      ["linked", "invalid"],
      ["ryph-private", "reserved"],
    ]);
  } finally {
    await repo.cleanup();
  }
});

test("repo skills: a repo without the directory, or with it as a file, has none", async () => {
  const none = await makeRepo("a", { "README.md": "hi\n" });
  const file = await makeRepo("b", { ".agents/skills": "not a directory\n" });
  try {
    const found = await discoverRepoSkills({
      repos: [none, file],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(found, { prepared: [], dropped: [], unnamed: [], unread: [], warnings: [] });
  } finally {
    await none.cleanup();
    await file.cleanup();
  }
});

test("repo skills: a submodule committed as the directory is named, never read as an error", async () => {
  const repo = await makeRepo("app", { "README.md": "hi\n" });
  try {
    // The clone records only the submodule's commit id, which its object store lacks.
    await git(
      repo.dir,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"c".repeat(40)},.agents/skills`,
    );
    await git(
      repo.dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@test.local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "vendor the skills",
    );
    const found = await discoverRepoSkills({
      repos: [{ ...repo, commit: await git(repo.dir, "rev-parse", "HEAD") }],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(found, {
      prepared: [],
      dropped: [],
      unnamed: [{ repo: "app", path: ".agents/skills", why: "a submodule is never read" }],
      unread: [],
      warnings: [],
    });
  } finally {
    await repo.cleanup();
  }
});

test("repo skills: a submodule at either root does not block the other root", async () => {
  for (const [blocked, available] of [[".agents", ".claude"], [".claude", ".agents"]]) {
    const repo = await makeRepo("app", {
      [`${available}/skills/deploy/SKILL.md`]: skillMd("deploy"),
    });
    try {
      await git(
        repo.dir,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${"c".repeat(40)},${blocked}/skills`,
      );
      await git(
        repo.dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@test.local",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "submodule",
      );
      const found = await discoverRepoSkills({
        repos: [{ ...repo, commit: await git(repo.dir, "rev-parse", "HEAD") }],
        frozen: [],
        budget: BUDGET,
        git: gitBounded,
        catFile: catFileBatch,
      });
      assertEquals(found.prepared.map((s) => s.name), ["deploy"]);
      assertEquals(found.unread, []);
      assertEquals(found.unnamed, [{
        repo: "app",
        path: `${blocked}/skills`,
        why: "a submodule is never read",
      }]);
    } finally {
      await repo.cleanup();
    }
  }
});

test("repo skills: an optional field that does not fit is left out of a loaded skill, and said", async () => {
  const extra = `license: ${"l".repeat(600)}\nmetadata:\n  team: [a, b]\ncompatibility: "pi\\0"\n`;
  const repo = await makeRepo("app", {
    ".agents/skills/lint/SKILL.md": skillMd("lint", "How to lint.", extra),
    // Dropped for its name, so its own misfit field is said by the drop and not again.
    ".agents/skills/fmt/SKILL.md": skillMd("other", "How to fmt.", extra),
  });
  try {
    const found = await discoverRepoSkills({
      repos: [repo],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(found.prepared.map((s) => [s.name, s.frontmatter]), [["lint", {}]]);
    assertEquals(found.dropped.map((d) => d.name), ["fmt"]);
    assertEquals(found.warnings.map((w) => [w.repo, w.name]), [
      ["app", "lint"],
      ["app", "lint"],
      ["app", "lint"],
    ]);
    const said = found.warnings.map((w) => w.warning).join("\n");
    assertStringIncludes(said, "`license` must be a string");
    assertStringIncludes(said, "`compatibility` holds a NUL");
    assertStringIncludes(said, "`metadata` must map");
  } finally {
    await repo.cleanup();
  }
});

test("repo skills: frozen names win, then repos in order; the org repo's own copy is said once", async () => {
  const orgFiles = { "SKILL.md": skillMd("handbook"), "notes.md": "n\n" };
  const orgDigest = await skillDigest(
    Object.entries(orgFiles).map(([path, content]) => ({
      path,
      executable: false,
      bytes: new TextEncoder().encode(content),
    })),
  );
  const frozen: RunSkill[] = [
    { name: "handbook", description: "How to handbook.", source: "org", digest: orgDigest },
    { name: "oncall", description: "On call.", source: "org", digest: `sha256:${"1".repeat(64)}` },
    {
      name: "runbook",
      description: "How to runbook.",
      source: "org",
      digest: `sha256:${"2".repeat(64)}`,
    },
  ];
  // The org skills repo, checked out by this run: the same files as the synced copy.
  const skillsRepo = await makeRepo("skills", {
    ".agents/skills/handbook/SKILL.md": orgFiles["SKILL.md"],
    ".agents/skills/handbook/notes.md": orgFiles["notes.md"],
    ".agents/skills/runbook/SKILL.md": skillMd("runbook"),
    ".claude/skills/deploy/SKILL.md": skillMd("deploy", "The skills repo's deploy."),
  });
  const api = await makeRepo("api", {
    ".claude/skills/oncall/SKILL.md": skillMd("oncall", "A different on call."),
    ".agents/skills/deploy/SKILL.md": skillMd("deploy", "The api's deploy."),
    ".agents/skills/lint/SKILL.md": skillMd("lint"),
  });
  try {
    const found = await discoverRepoSkills({
      repos: [skillsRepo, api],
      frozen,
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(found.prepared.map((s) => [s.name, s.path, s.description]), [
      ["deploy", "skills", "The skills repo's deploy."],
      ["lint", "api", "How to lint."],
    ]);
    assertEquals(
      found.dropped.map((d) => [d.name, d.source === "repo" ? d.path : "", d.reason, d.detail]),
      [
        // runbook differs from the synced copy (an unsynced edit): a collision like any other.
        ["runbook", "skills", "collision", undefined],
        [
          "handbook",
          "skills",
          "collision",
          "the same files as the org skills repo's synced version",
        ],
        ["deploy", "api", "collision", undefined],
        ["oncall", "api", "collision", undefined],
      ],
    );
    assertEquals(
      found.dropped.map((d) => d.reason === "collision" ? d.winner : null),
      ["org", "org", "repo", "org"],
    );
    assertEquals(
      control.describeDrops(found.dropped).split("\n")[2],
      "deploy (`api/`): the name is already taken by a skill from a working repo",
    );
  } finally {
    await skillsRepo.cleanup();
    await api.cleanup();
  }
});

test("repo skills: the budget the run was frozen with admits them in order, the rest are dropped", async () => {
  const a = await makeRepo("a", {
    ".agents/skills/one/SKILL.md": skillMd("one"),
    ".claude/skills/two/SKILL.md": skillMd("two"),
  });
  const b = await makeRepo("b", { ".agents/skills/three/SKILL.md": skillMd("three") });
  try {
    const byCount = await discoverRepoSkills({
      repos: [a, b],
      frozen: [],
      budget: { skills: 2, listingBytes: 16_000 },
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(byCount.prepared.map((s) => s.name), ["one", "two"]);
    assertEquals(byCount.dropped.map((d) => [d.name, d.reason]), [["three", "cap"]]);

    // "one" + "How to one." is 14 bytes: room for exactly one, inclusive.
    const byBytes = await discoverRepoSkills({
      repos: [a, b],
      frozen: [],
      budget: { skills: 30, listingBytes: 14 },
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(byBytes.prepared.map((s) => s.name), ["one"]);
    assertEquals(byBytes.dropped.map((d) => [d.name, d.reason]), [
      ["two", "cap"],
      ["three", "cap"],
    ]);

    const none = await discoverRepoSkills({
      repos: [a],
      frozen: [],
      budget: { skills: 0, listingBytes: 0 },
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(none.prepared, []);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test("repo skills: links at the root count against the directory cap, named or not", async () => {
  const links: Record<string, string> = {};
  for (let i = 0; i < 200; i++) {
    links[`.agents/skills/Link_${String(i).padStart(3, "0")}`] = "elsewhere";
    links[`.agents/skills/link-${String(i).padStart(3, "0")}`] = "elsewhere";
  }
  const repo = await makeRepo("api", { ".agents/skills/zz/SKILL.md": skillMd("zz") }, { links });
  try {
    const found = await discoverRepoSkills({
      repos: [repo],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    // 400 links are named no further than the cap, and the cut is said once: what the run holds
    // and logs stays bounded however many a repo commits.
    assertEquals(found.unnamed.length + found.dropped.length, MAX_REPO_SKILL_DIRS + 1);
    // `Link_` sorts before `link-`: the cut lands on a link no skill name can carry, said first,
    // and the first by name are the rest of them.
    const whys = found.unnamed.map((u) => u.why);
    assertEquals(
      whys.filter((w) => w.includes("a link or a submodule is never read")).length,
      MAX_REPO_SKILL_DIRS,
    );
    assertStringIncludes(whys[0], "holds 401 skill directories and links");
    // The skill sorted past the cap is left out with the rest.
    assertEquals([found.prepared, found.dropped], [[], []]);
  } finally {
    await repo.cleanup();
  }
});

test("repo skills: the bounds hold before a byte is read", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i <= MAX_REPO_SKILL_DIRS; i++) {
    const name = `s${String(i).padStart(2, "0")}`;
    const root = i % 2 === 0 ? ".agents/skills" : ".claude/skills";
    files[`${root}/${name}/SKILL.md`] = skillMd(name);
  }
  // One skill over the per-skill byte limit.
  files[".agents/skills/s00/big.bin"] = "x".repeat(MAX_SKILL_BYTES);
  const many = await makeRepo("many", files);
  // Enough skills at just under the per-skill limit to pass what every repo may hold together.
  const per = MAX_SKILL_BYTES - 1024;
  const heavy: Record<string, string> = {};
  const needed = Math.ceil(MAX_REPO_SKILL_BYTES / per) + 1;
  for (let i = 0; i < needed; i++) {
    const name = `h${String(i).padStart(2, "0")}`;
    const root = i % 2 === 0 ? ".agents/skills" : ".claude/skills";
    heavy[`${root}/${name}/SKILL.md`] = skillMd(name);
    heavy[`${root}/${name}/blob.txt`] = "y".repeat(per - 200);
  }
  const big = await makeRepo("big", heavy);
  try {
    const found = await discoverRepoSkills({
      repos: [many, big],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    const drop = (name: string) => found.dropped.find((d) => d.name === name);
    // The directory past the limit is named once, and nothing after it is read.
    assertEquals(drop(`s${MAX_REPO_SKILL_DIRS}`)?.reason, "cap");
    assertStringIncludes(
      drop(`s${MAX_REPO_SKILL_DIRS}`)!.detail!,
      `holds ${MAX_REPO_SKILL_DIRS + 1} skill directories and links`,
    );
    assertEquals(drop("s00")?.reason, "invalid");
    assertStringIncludes(drop("s00")!.detail!, "bytes per skill");
    // Every working repo's skills together are bounded, whichever repo reaches it.
    const over = found.dropped.filter((d) => d.reason === "unavailable");
    assert(over.length > 0 && over.every((d) => d.source === "repo" && d.path === "big"));
    assertStringIncludes(over[0].detail!, `${MAX_REPO_SKILL_BYTES} bytes`);
  } finally {
    await many.cleanup();
    await big.cleanup();
  }
});

test("repo skills: a repo whose objects cannot be read costs only its own skills", async () => {
  // Enough to take most of what every repo may hold together, were it read.
  const per = MAX_SKILL_BYTES - 1024;
  const heavy: Record<string, string> = {};
  for (let i = 0; i < Math.floor(MAX_REPO_SKILL_BYTES / per); i++) {
    const name = `h${String(i).padStart(2, "0")}`;
    heavy[`.agents/skills/${name}/SKILL.md`] = skillMd(name);
    heavy[`.agents/skills/${name}/blob.txt`] = "y".repeat(per - 200);
  }
  const broken = await makeRepo("broken", heavy);
  const after = await makeRepo("after", {
    ".agents/skills/deploy/SKILL.md": skillMd("deploy"),
    ".agents/skills/deploy/blob.txt": "z".repeat(per - 200),
  });
  try {
    const found = await discoverRepoSkills({
      repos: [broken, after],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: (dir, ids, bytes) =>
        dir === broken.dir
          ? Promise.reject(new Error("cat-file died"))
          : catFileBatch(dir, ids, bytes),
    });
    assertEquals(found.prepared.map((s) => [s.name, s.path]), [["deploy", "after"]]);
    const dropped = found.dropped.filter((d) => d.reason === "unavailable");
    assert(dropped.length > 0 && dropped.every((d) => d.source === "repo" && d.path === "broken"));
    assertStringIncludes(dropped[0].detail!, "cat-file died");
  } finally {
    await broken.cleanup();
    await after.cleanup();
  }
});

/**
 * A repo whose one commit is a tree built by hand with `git mktree`, which, unlike `git add`,
 * writes trees git's fsck would refuse. `skills` answers the `.agents/skills` tree's id.
 */
async function craftRepo(
  path: string,
  skills: (
    mktree: (lines: string[]) => Promise<string>,
    blob: (text: string) => Promise<string>,
  ) => Promise<string>,
  roots = [".agents"],
): Promise<RepoToRead & { cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "runner-repo-skills-"));
  await git(dir, "init", "-b", "main");
  const pipe = async (args: string[], input: string) => {
    const child = await command("git", {
      args,
      cwd: dir,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const out = await child.output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout).trim();
  };
  const blob = (text: string) => pipe(["hash-object", "-w", "--stdin"], text);
  const mktree = (lines: string[]) => pipe(["mktree"], lines.map((l) => `${l}\n`).join(""));
  const agents = await mktree([`040000 tree ${await skills(mktree, blob)}\tskills`]);
  const root = await mktree(roots.map((name) => `040000 tree ${agents}\t${name}`));
  const commit = await pipe([
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@test.local",
    "commit-tree",
    root,
    "-m",
    "crafted",
  ], "");
  return { path, dir, commit, cleanup: () => rm(dir, { recursive: true }) };
}

test("repo skills: a skill whose paths clash is dropped alone", async () => {
  const repo = await craftRepo("crafted", async (mktree, blob) => {
    // `clash/x` is a file, and also a directory holding `clash/x/y`.
    const inner = await mktree([`100644 blob ${await blob("nested\n")}\ty`]);
    const clash = await mktree([
      `100644 blob ${await blob(skillMd("clash"))}\tSKILL.md`,
      `100644 blob ${await blob("file\n")}\tx`,
      `040000 tree ${inner}\tx`,
    ]);
    const good = await mktree([`100644 blob ${await blob(skillMd("deploy"))}\tSKILL.md`]);
    return await mktree([`040000 tree ${clash}\tclash`, `040000 tree ${good}\tdeploy`]);
  });
  try {
    const found = await discoverRepoSkills({
      repos: [repo],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals(found.prepared.map((s) => s.name), ["deploy"]);
    assertEquals(found.dropped.map((d) => [d.name, d.reason]), [["clash", "invalid"]]);
    assertStringIncludes(found.dropped[0].detail!, "also the directory holding x/y");
  } finally {
    await repo.cleanup();
  }
});

test("repo skills: a listing over its bound is not read at all", async () => {
  const repo = await craftRepo("huge", async (mktree, blob) => {
    const id = await blob("x\n");
    const name = (i: number) => String(i).padStart(120, "f");
    // Each root's listing fits alone; their combined listing must still be refused.
    const lines = Math.ceil(MAX_REPO_SKILLS_LISTING_BYTES / 300);
    const many = await mktree(
      [`100644 blob ${await blob(skillMd("huge"))}\tSKILL.md`].concat(
        Array.from({ length: lines }, (_, i) => `100644 blob ${id}\t${name(i)}`),
      ),
    );
    return await mktree([`040000 tree ${many}\thuge`]);
  }, [".agents", ".claude"]);
  try {
    const found = await discoverRepoSkills({
      repos: [repo],
      frozen: [],
      budget: BUDGET,
      git: gitBounded,
      catFile: catFileBatch,
    });
    assertEquals([found.prepared, found.dropped], [[], []]);
    assertEquals(found.unread.map((u) => u.repo), ["huge"]);
    assertStringIncludes(found.unread[0].error, `over ${MAX_REPO_SKILLS_LISTING_BYTES} bytes`);
  } finally {
    await repo.cleanup();
  }
});
