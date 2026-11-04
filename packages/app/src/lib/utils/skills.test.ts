import { describe, expect, it } from "vitest";
import type { SkillSync } from "$lib/api/types";
import {
  commitUrl,
  parseSkillDrop,
  readingOrder,
  resolveSkillLink,
  runSkillsView,
  shortDigest,
  skillBody,
  skillDirUrl,
  skillFileKind,
  skillRead,
  syncAnswerMessage,
  syncFailureTitle,
} from "./skills";

const github = { provider: "github" as const, url: "https://github.com/acme/skills" };
const radicle = { provider: "radicle" as const, url: "" };

describe("versions and commits", () => {
  it("shortens a digest to its first eight hex digits", () => {
    expect(shortDigest(`sha256:${"ab12".repeat(16)}`)).toBe("ab12ab12");
  });

  it("links a GitHub commit and skill directory, and nothing where the forge has no page", () => {
    expect(commitUrl(github, "abc123")).toBe("https://github.com/acme/skills/commit/abc123");
    expect(commitUrl({ ...github, url: "https://github.com/acme/skills/" }, "abc")).toBe(
      "https://github.com/acme/skills/commit/abc",
    );
    expect(commitUrl(radicle, "abc123")).toBeNull();
    expect(skillDirUrl(github, "release/v2", "deploy")).toBe(
      "https://github.com/acme/skills/tree/release/v2/.agents/skills/deploy",
    );
    expect(skillDirUrl(github, "abc123", "deploy")).toBe(
      "https://github.com/acme/skills/tree/abc123/.agents/skills/deploy",
    );
    expect(skillDirUrl(radicle, "main", "deploy")).toBeNull();
    // A clone URL links into the repository, not under `repo.git/`.
    const cloned = { ...github, url: "https://github.com/acme/.agents.git" };
    expect(skillDirUrl(cloned, "main", "shadcn-svelte")).toBe(
      "https://github.com/acme/.agents/tree/main/.agents/skills/shadcn-svelte",
    );
    expect(commitUrl(cloned, "abc")).toBe("https://github.com/acme/.agents/commit/abc");
    // GitLab hangs its commit and tree pages off `/-`, under a nested group path.
    const gitlab = { provider: "gitlab" as const, url: "https://gitlab.com/acme/web/skills.git" };
    expect(commitUrl(gitlab, "abc")).toBe("https://gitlab.com/acme/web/skills/-/commit/abc");
    expect(skillDirUrl(gitlab, "main", "deploy")).toBe(
      "https://gitlab.com/acme/web/skills/-/tree/main/.agents/skills/deploy",
    );
  });
});

describe("a skill's files", () => {
  it("drops the frontmatter from SKILL.md, and keeps text without one whole", () => {
    expect(skillBody("---\nname: a\ndescription: b\n---\n\n# Title\nbody")).toBe("# Title\nbody");
    expect(skillBody("# Title\n---\nnot frontmatter")).toBe("# Title\n---\nnot frontmatter");
    expect(skillBody("---\nname: a\nnever closed")).toBe("---\nname: a\nnever closed");
  });

  it("puts SKILL.md first and the rest by path", () => {
    const order = readingOrder([
      { path: "scripts/run.sh" },
      { path: "SKILL.md" },
      { path: "references/a.md" },
    ]).map((f) => f.path);
    expect(order).toEqual(["SKILL.md", "references/a.md", "scripts/run.sh"]);
  });

  it("renders markdown, shows other text as code, and names the rest by size", () => {
    const file = { path: "references/a.md", executable: false, bytes: 3, text: "# a" };
    expect(skillFileKind(file)).toBe("markdown");
    expect(skillFileKind({ ...file, path: "scripts/run.sh" })).toBe("text");
    expect(skillFileKind({ ...file, path: "assets/logo.png", text: null })).toBe("binary");
  });

  it("follows a link to a file of the same skill, and leaves every other link alone", () => {
    const paths = ["SKILL.md", "references/checks-yml.md", "references/more/x.md"];
    expect(resolveSkillLink("references/checks-yml.md", "SKILL.md", paths)).toBe(
      "references/checks-yml.md",
    );
    expect(resolveSkillLink("./references/checks-yml.md#limits", "SKILL.md", paths)).toBe(
      "references/checks-yml.md",
    );
    expect(resolveSkillLink("../SKILL.md", "references/checks-yml.md", paths)).toBe("SKILL.md");
    expect(resolveSkillLink("more/x.md", "references/checks-yml.md", paths)).toBe(
      "references/more/x.md",
    );
    expect(resolveSkillLink("../../SKILL.md", "references/checks-yml.md", paths)).toBeNull();
    expect(resolveSkillLink("missing.md", "SKILL.md", paths)).toBeNull();
    expect(resolveSkillLink("https://example.com/SKILL.md", "SKILL.md", paths)).toBeNull();
    expect(resolveSkillLink("#heading", "SKILL.md", paths)).toBeNull();
    expect(resolveSkillLink("/SKILL.md", "SKILL.md", paths)).toBeNull();
  });
});

describe("sync answers", () => {
  const sync: SkillSync = {
    id: "ss_1",
    connectedRepoId: "cr_1",
    repoRef: "acme/skills",
    branch: "main",
    trigger: "manual",
    outcome: "synced",
    failure: null,
    rulesVersion: 1,
    commit: "a".repeat(40),
    treeId: "b".repeat(40),
    skillCount: 3,
    warnings: [],
    error: null,
    repeats: 1,
    requestedBy: "u_1",
    startedAt: "2026-10-01T10:00:00.000Z",
    finishedAt: "2026-10-01T10:00:02.000Z",
  };

  it("says each outcome in a person's words", () => {
    expect(syncAnswerMessage({ outcome: "synced", sync })).toEqual({
      tone: "success",
      message: "Synced 3 skills",
    });
    expect(syncAnswerMessage({ outcome: "up-to-date", sync: null }).tone).toBe("info");
    expect(syncAnswerMessage({ outcome: "superseded", sync: null }).tone).toBe("info");
    expect(
      syncAnswerMessage({
        outcome: "failed",
        sync: {
          ...sync,
          outcome: "failed",
          failure: "missing-ref",
          error: "branch main no longer exists",
        },
      }),
    ).toEqual({
      tone: "error",
      message: "Branch no longer exists: branch main no longer exists",
    });
    expect(syncAnswerMessage({ outcome: "not-connected", sync: null }).tone).toBe("error");
  });

  it("names a failure with no kind as a plain failure", () => {
    expect(syncFailureTitle(null)).toBe("Sync failed");
    expect(syncFailureTitle("unavailable")).toBe("Couldn't reach the repository");
  });
});

describe("a run's skills", () => {
  const at = "2026-10-01T10:00:00.000Z";
  const skills = {
    skills: [
      { name: "ryph-checks", description: "c", source: "catalogue" as const, digest: "sha256:1" },
      { name: "release", description: "r", source: "org" as const, digest: "sha256:2" },
    ],
    org: {
      connectedRepoId: "cr_1",
      repoRef: "acme/skills",
      commit: "a".repeat(40),
      syncId: "ss_1",
      syncedAt: at,
      stale: true,
    },
    workingRepos: true,
  };

  it("groups the frozen skills by source, and reads the repo skills and the drops off the trail", () => {
    const view = runSkillsView(skills, [
      { runId: "r", at, kind: "skills.dropped", detail: "ryph-x (org): the name is reserved" },
      { runId: "r", at, kind: "skills.root", detail: "/tmp/ryph-skills-3f9a" },
      { runId: "r", at, kind: "skills.repo", detail: "deploy (`api/`)\nlint (`web/`)" },
      {
        runId: "r",
        at,
        kind: "skills.dropped",
        detail: "notes (`api/`): the listing is full",
      },
    ]);
    expect(view.catalogue).toEqual(["ryph-checks"]);
    expect(view.org).toEqual({
      repoRef: "acme/skills",
      commit: "a".repeat(40),
      stale: true,
      names: ["release"],
    });
    expect(view.repo).toEqual([{ name: "deploy", path: "api" }, { name: "lint", path: "web" }]);
    expect(view.root).toBe("/tmp/ryph-skills-3f9a");
    expect(view.dropped).toEqual([
      { name: "ryph-x", where: "org", reason: "the name is reserved" },
      { name: "notes", where: "in api/", reason: "the listing is full" },
    ]);
  });

  it("keeps a repo line it cannot read as it was written", () => {
    const view = runSkillsView({ ...skills, org: null }, [
      { runId: "r", at, kind: "skills.repo", detail: "odd line" },
    ]);
    expect(view.org).toBeNull();
    expect(view.repo).toEqual([{ name: "odd line", path: "" }]);
    expect(view.root).toBeNull();
  });
});

describe("a skill left out", () => {
  // Each line as the control plane's describeDrops words it.
  it("says why in the app's words, with the source and repo path plain", () => {
    expect(
      parseSkillDrop("deploy (`api/`): the name is already taken by a skill from ryph's catalogue"),
    ).toEqual({ name: "deploy", where: "in api/", reason: "Name already used by a Ryph skill" });
    expect(
      parseSkillDrop(
        "release (org): the name is already taken by a skill from the org skills repo",
      ),
    )
      .toEqual({ name: "release", where: "org", reason: "Name already used by an org skill" });
    expect(
      parseSkillDrop("lint (`web/`): the name is already taken by a skill from a working repo"),
    )
      .toEqual({ name: "lint", where: "in web/", reason: "Name already used by a repo skill" });
    expect(parseSkillDrop("big (`./`): over the 32-skill or 16384-byte listing cap")).toEqual({
      name: "big",
      where: "in ./",
      reason: "Too many skills for one run",
    });
    expect(parseSkillDrop('ryph-x (org): names starting with "ryph-" are reserved for ryph'))
      .toEqual({ name: "ryph-x", where: "org", reason: "Only Ryph skills may start with ryph-" });
    expect(parseSkillDrop("ryph-checks (catalogue): it did not validate")).toEqual({
      name: "ryph-checks",
      where: "Ryph",
      reason: "Not a valid skill",
    });
  });

  it("keeps what the producer added after the reason", () => {
    expect(
      parseSkillDrop("notes (org): its files could not be loaded; it could not be written to disk"),
    ).toEqual({
      name: "notes",
      where: "org",
      reason: "Its files could not be loaded: it could not be written to disk",
    });
  });

  it("keeps a line in another shape whole", () => {
    expect(parseSkillDrop("and 3 more")).toEqual({ name: "", where: null, reason: "and 3 more" });
  });
});

describe("skillRead", () => {
  const root = "/tmp/ryph-skills-3f9a";
  const view = {
    catalogue: ["ryph-checks"],
    org: { repoRef: "acme/skills", commit: "a".repeat(40), stale: false, names: ["deploy"] },
    repo: [{ name: "release", path: "api" }],
    workingRepos: true,
    root,
    dropped: [],
  };

  it("reads a skill's SKILL.md as the skill, from every source", () => {
    expect(skillRead(`${root}/catalogue/ryph-checks/SKILL.md`, view))
      .toEqual({ name: "ryph-checks", source: "catalogue", file: "SKILL.md" });
    expect(skillRead(`${root}/org/deploy/SKILL.md`, view))
      .toEqual({ name: "deploy", source: "org", file: "SKILL.md" });
    expect(skillRead(`${root}/repo/api/release/SKILL.md`, view))
      .toEqual({ name: "release", source: "repo", file: "SKILL.md" });
  });

  it("names the file for anything else under a skill", () => {
    expect(skillRead(`${root}/catalogue/ryph-checks/references/checks-yml.md`, view))
      .toEqual({ name: "ryph-checks", source: "catalogue", file: "references/checks-yml.md" });
  });

  it("leaves a path that only looks the part a plain read", () => {
    // A name the run does not hold, a source it is not held under, a repo skill from another
    // checkout, the skill's directory itself, and no runner root at all.
    expect(skillRead(`${root}/catalogue/ryph-other/SKILL.md`, view)).toBeNull();
    expect(skillRead(`${root}/org/ryph-checks/SKILL.md`, view)).toBeNull();
    expect(skillRead(`${root}/repo/web/release/SKILL.md`, view)).toBeNull();
    expect(skillRead(`${root}/catalogue/ryph-checks`, view)).toBeNull();
    expect(skillRead("/work/catalogue/ryph-checks/SKILL.md", view)).toBeNull();
    expect(skillRead(`${root}/catalogue/ryph-checks/SKILL.md`, null)).toBeNull();
    expect(skillRead(`${root}/catalogue/ryph-checks/../../../etc/passwd`, view)).toBeNull();
  });

  it("counts a read only under the directory the runner reported", () => {
    // A checkout can commit the same layout under a directory named like the runner's.
    expect(skillRead(`/work/api/x/ryph-skills-fake/catalogue/ryph-checks/SKILL.md`, view))
      .toBeNull();
    expect(skillRead(`${root}-other/catalogue/ryph-checks/SKILL.md`, view)).toBeNull();
    expect(skillRead(`/work${root}/catalogue/ryph-checks/SKILL.md`, view)).toBeNull();
    // Before the runner says where, nothing counts.
    expect(skillRead(`${root}/catalogue/ryph-checks/SKILL.md`, { ...view, root: null }))
      .toBeNull();
  });
});
