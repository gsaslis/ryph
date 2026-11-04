import { describe, expect, it } from "vitest";
import {
  connectOrgSkillsRepo,
  getCatalogueSkill,
  getOrgSkill,
  getSkillBundle,
  getSkills,
  getSkillsOrNull,
  getSkillSyncs,
  putSkillSettings,
  syncOrgSkillsRepo,
} from "./skills";

// The skills client against answers shaped as the orchestrator's skills_api.ts sends them.

type Asked = { url: string; init: RequestInit | undefined };

/** A fetch that records what it was asked and answers with `body`. */
function answering(status: number, body: unknown) {
  const asked: Asked[] = [];
  const f = ((url: string, init?: RequestInit) => {
    asked.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { f, asked };
}

const digest = `sha256:${"0f".repeat(32)}`;

const sync = {
  id: "ss_1",
  connectedRepoId: "cr_1",
  branch: "main",
  trigger: "connect",
  outcome: "synced",
  failure: null,
  rulesVersion: 1,
  commit: "a".repeat(40),
  treeId: "b".repeat(40),
  skillCount: 1,
  warnings: [{ path: "Bad Name/SKILL.md", message: "not a skill name" }],
  error: null,
  repeats: 1,
  requestedBy: "u_1",
  startedAt: "2026-10-01T10:00:00.000Z",
  finishedAt: "2026-10-01T10:00:02.000Z",
};

const icon = { mime: "image/svg+xml", data: btoa("<svg xmlns='http://www.w3.org/2000/svg'/>") };

const presentation = {
  displayName: "Checks",
  shortDescription: "Set up and run the checks a change must pass.",
  brandColor: null,
  defaultPrompt: null,
  implicitInvocation: true,
  author: null,
  version: null,
  iconSmall: icon,
  iconLarge: icon,
};

const overview = {
  catalogue: [{
    name: "ryph-checks",
    description: "The format and rules of .ryph/checks.yml.",
    digest,
    bytes: 9000,
    files: [{ path: "SKILL.md", bytes: 4000 }, { path: "references/checks-yml.md", bytes: 5000 }],
    frontmatter: {},
    presentation,
    enabled: true,
  }],
  org: {
    repo: {
      id: "cr_1",
      provider: "github",
      repoRef: "acme/skills",
      url: "https://github.com/acme/skills",
      defaultBranch: "main",
    },
    branch: null,
    effectiveBranch: "main",
    current: {
      syncId: "ss_1",
      commit: "a".repeat(40),
      syncedAt: "2026-10-01T10:00:02.000Z",
      warnings: sync.warnings,
      skills: [{
        name: "release",
        description: "How we release.",
        digest,
        frontmatter: { license: "MIT", allowedTools: "Bash(git:*)" },
        presentation: null,
      }],
    },
    checkedAt: "2026-10-01T10:00:02.000Z",
    checkedCommit: "a".repeat(40),
    stale: false,
    lastFailure: null,
    archived: false,
  },
  workingRepoSkills: true,
  limits: { skills: 32, listingBytes: 16384 },
  updatedAt: "2026-10-01T09:00:00.000Z",
  updatedBy: "u_1",
};

describe("the skills client", () => {
  it("parses the overview", async () => {
    const { f, asked } = answering(200, overview);
    const read = await getSkills(f);
    expect(asked[0].url).toBe("/api/v1/skills");
    expect(read.org?.current?.skills[0].frontmatter.allowedTools).toBe("Bash(git:*)");
    expect(read.catalogue[0].enabled).toBe(true);
  });

  it("reads each skill's presentation, null where the skill sets none", async () => {
    const read = await getSkills(answering(200, overview).f);
    expect(read.catalogue[0].presentation?.displayName).toBe("Checks");
    expect(read.catalogue[0].presentation?.iconSmall?.mime).toBe("image/svg+xml");
    expect(read.org?.current?.skills[0].presentation).toBeNull();
  });

  it("refuses an icon of a type the page would not render as an image", async () => {
    const bad = {
      ...overview,
      catalogue: [{
        ...overview.catalogue[0],
        presentation: { ...presentation, iconSmall: { mime: "text/html", data: "PGI+" } },
      }],
    };
    await expect(getSkills(answering(200, bad).f)).rejects.toThrow();
  });

  it("refuses icon data outside the base64 alphabet", async () => {
    const bad = {
      ...overview,
      catalogue: [{
        ...overview.catalogue[0],
        presentation: {
          ...presentation,
          iconSmall: { mime: "image/svg+xml", data: 'PGI+"); background: url(x' },
        },
      }],
    };
    await expect(getSkills(answering(200, bad).f)).rejects.toThrow();
  });

  it("reads the presentation on both detail routes", async () => {
    const catalogue = answering(200, { skill: overview.catalogue[0], files: [] });
    const one = await getCatalogueSkill(catalogue.f, "ryph-checks");
    expect(catalogue.asked[0].url).toBe("/api/v1/skills/catalogue/ryph-checks");
    expect(one.skill.presentation?.shortDescription).toBe(presentation.shortDescription);

    const org = answering(200, {
      skill: {
        ...overview.org.current.skills[0],
        presentation: { ...presentation, brandColor: "#3B82F6", defaultPrompt: "Cut a release." },
        warnings: [],
      },
      files: [],
      versions: [],
    });
    const two = await getOrgSkill(org.f, "release");
    expect(two.skill.presentation?.brandColor).toBe("#3B82F6");
    expect(two.skill.presentation?.defaultPrompt).toBe("Cut a release.");
  });

  it("folds an overview the editor cannot have into null, and throws the editor's own faults", async () => {
    expect(await getSkillsOrNull(answering(403, { error: "no" }).f)).toBeNull();
    expect(await getSkillsOrNull(answering(404, { error: "not found" }).f)).toBeNull();
    const unreachable = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    expect(await getSkillsOrNull(unreachable)).toBeNull();
    await expect(getSkillsOrNull(answering(400, { error: "bad" }).f)).rejects.toThrow("bad");
  });

  it("asks for a bundle with the digest's colon as it is, and never for a string that is not one", async () => {
    const { f, asked } = answering(200, {
      digest,
      bytes: 3,
      files: [{ path: "SKILL.md", executable: false, bytes: 3, text: "abc" }],
    });
    const bundle = await getSkillBundle(f, digest);
    // The route matches the digest raw; an encoded colon would never match it.
    expect(asked[0].url).toBe(`/api/v1/skills/bundles/${digest}`);
    expect(bundle?.files[0].text).toBe("abc");
    expect(await getSkillBundle(f, "../settings")).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it("pages the sync history by the cursor it was handed", async () => {
    const { f, asked } = answering(200, {
      syncs: [{ ...sync, repoRef: "acme/skills" }],
      nextCursor: "next-page",
    });
    const page = await getSkillSyncs(f, { cursor: "c1", limit: 20 });
    expect(asked[0].url).toBe("/api/v1/skills/syncs?cursor=c1&limit=20");
    expect(page.nextCursor).toBe("next-page");
    await getSkillSyncs(f);
    expect(asked[1].url).toBe("/api/v1/skills/syncs");
  });

  it("saves both switches with a PUT, and reads the overview back", async () => {
    const { f, asked } = answering(200, overview);
    await putSkillSettings(f, { disabledCatalogue: ["ryph-checks"], workingRepoSkills: false });
    expect(asked[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(asked[0].init?.body))).toEqual({
      disabledCatalogue: ["ryph-checks"],
      workingRepoSkills: false,
    });
  });

  it("connects and syncs, each answering the overview with what the read did", async () => {
    const answer = { ...overview, sync: { outcome: "synced", sync } };
    const connect = answering(200, answer);
    const connected = await connectOrgSkillsRepo(connect.f, {
      connectedRepoId: "cr_1",
      branch: null,
    });
    expect(connect.asked[0].url).toBe("/api/v1/skills/org-repo");
    expect(JSON.parse(String(connect.asked[0].init?.body))).toEqual({
      connectedRepoId: "cr_1",
      branch: null,
    });
    expect(connected.sync.outcome).toBe("synced");

    const now = answering(200, { ...overview, sync: { outcome: "up-to-date", sync: null } });
    const synced = await syncOrgSkillsRepo(now.f);
    expect(now.asked[0].init?.method).toBe("POST");
    expect(synced.sync).toEqual({ outcome: "up-to-date", sync: null });
  });
});
