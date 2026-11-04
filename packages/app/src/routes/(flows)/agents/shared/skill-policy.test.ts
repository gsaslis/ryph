import { describe, expect, it } from "vitest";
import { DEFAULT_SKILL_POLICY, type SkillPolicy, type SkillsOverview } from "$lib/api/types";
import {
  clearSkillChoice,
  composeSkillPolicy,
  hiddenSkillChoices,
  isDefaultSkillPolicy,
  skillPolicyPatch,
  skillPolicyToFields,
  skillsOffOnScreen,
  skillsSummary,
  switchName,
} from "./skill-policy";

const overview = (over: Partial<SkillsOverview> = {}): SkillsOverview => ({
  catalogue: [
    {
      name: "ryph-checks",
      description: "checks",
      digest: "sha256:1",
      bytes: 1,
      files: [],
      frontmatter: {},
      presentation: null,
      enabled: true,
    },
    {
      name: "ryph-environment",
      description: "environment",
      digest: "sha256:2",
      bytes: 1,
      files: [],
      frontmatter: {},
      presentation: null,
      enabled: false,
    },
  ],
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
      syncedAt: "2026-10-01T10:00:00.000Z",
      warnings: [],
      skills: [
        {
          name: "release",
          description: "r",
          digest: "sha256:3",
          frontmatter: {},
          presentation: null,
        },
        {
          name: "incidents",
          description: "i",
          digest: "sha256:4",
          frontmatter: {},
          presentation: null,
        },
      ],
    },
    checkedAt: null,
    checkedCommit: null,
    stale: false,
    lastFailure: null,
    archived: false,
  },
  workingRepoSkills: true,
  limits: { skills: 32, listingBytes: 16384 },
  updatedAt: null,
  updatedBy: null,
  ...over,
});

describe("the skill policy fields", () => {
  it("seeds the defaults for an agent without a policy, as a copy the form may edit", () => {
    const fields = skillPolicyToFields(null);
    expect(fields).toEqual(DEFAULT_SKILL_POLICY);
    fields.catalogue.disabled.push("ryph-checks");
    expect(DEFAULT_SKILL_POLICY.catalogue.disabled).toEqual([]);
  });

  it("saves the defaults as null, and anything else tidied", () => {
    expect(composeSkillPolicy(skillPolicyToFields(null))).toBeNull();
    // The org picks are kept while the repo is off, but they alone are not the defaults.
    expect(
      isDefaultSkillPolicy({ ...DEFAULT_SKILL_POLICY, org: { enabled: true, disabled: ["a"] } }),
    )
      .toBe(false);
    expect(
      composeSkillPolicy({
        catalogue: { disabled: ["ryph-z", "ryph-a", "ryph-z"] },
        org: { enabled: false, disabled: ["b", "a"] },
        workingRepos: { enabled: true },
      }),
    ).toEqual({
      catalogue: { disabled: ["ryph-a", "ryph-z"] },
      org: { enabled: false, disabled: ["a", "b"] },
      workingRepos: { enabled: true },
    });
  });

  it("switches one name on or off in a list of what is off", () => {
    expect(switchName([], "a", false)).toEqual(["a"]);
    expect(switchName(["a", "b"], "a", true)).toEqual(["b"]);
    expect(switchName(["a"], "a", false)).toEqual(["a"]);
  });
});

const labels = (fields: SkillPolicy, offered: SkillsOverview) =>
  hiddenSkillChoices(fields, offered).map((choice) => choice.label);

describe("what the step can show", () => {
  it("counts only the switches on screen as off", () => {
    const fields = skillPolicyToFields(null);
    expect(skillsOffOnScreen(fields, overview())).toBe(false);
    fields.org.disabled = ["release"];
    expect(skillsOffOnScreen(fields, overview())).toBe(true);
    // An org skill since removed, and a catalogue skill an admin turned off for everyone, have no
    // switch on screen; the policy keeps them so they stay off if they come back.
    fields.org.disabled = ["gone"];
    fields.catalogue.disabled = ["ryph-environment"];
    expect(skillsOffOnScreen(fields, overview())).toBe(false);
    expect(labels(fields, overview())).toEqual(["ryph-environment", "gone"]);
    expect(composeSkillPolicy(fields)?.org.disabled).toEqual(["gone"]);
  });

  it("does not promise to keep off a Ryph skill no longer shipped", () => {
    // The orchestrator's settleSkillPolicy keeps only shipped names in catalogue.disabled, so a
    // retired one is gone after the next save and would be on if a release brought it back.
    const fields = skillPolicyToFields(null);
    fields.catalogue.disabled = ["ryph-environment", "ryph-retired"];
    expect(labels(fields, overview())).toEqual(["ryph-environment"]);
  });

  it("names a source the deployment does not offer now, when the agent turned it off", () => {
    const fields = skillPolicyToFields(null);
    fields.org = { enabled: false, disabled: ["release"] };
    fields.workingRepos.enabled = false;
    const bare = overview({ org: null, workingRepoSkills: false });
    expect(skillsOffOnScreen(fields, bare)).toBe(false);
    expect(labels(fields, bare)).toEqual(["org skills", "release", "repo skills"]);
    // With the repo there and turned off, the toggle says so, and its picks are not named.
    expect(skillsOffOnScreen(fields, overview())).toBe(true);
    expect(labels(fields, overview())).toEqual([]);
  });

  it("names the org picks of a repo that has not synced, which have no switch yet", () => {
    const fields = skillPolicyToFields(null);
    fields.org.disabled = ["release"];
    const unsynced = overview();
    unsynced.org = { ...unsynced.org!, current: null };
    expect(skillsOffOnScreen(fields, unsynced)).toBe(false);
    expect(labels(fields, unsynced)).toEqual(["release"]);
  });
});

describe("clearing one hidden choice", () => {
  it("drops that choice and keeps every other one", () => {
    const fields = skillPolicyToFields(null);
    fields.catalogue.disabled = ["ryph-checks", "ryph-environment"];
    fields.org = { enabled: false, disabled: ["release", "runbook"] };
    fields.workingRepos.enabled = false;
    const bare = overview({ org: null, workingRepoSkills: false });
    const hidden = hiddenSkillChoices(fields, bare);
    const find = (label: string) => hidden.find((choice) => choice.label === label)!;

    const catalogue = clearSkillChoice(fields, find("ryph-environment"));
    expect(catalogue.catalogue.disabled).toEqual(["ryph-checks"]);
    expect(catalogue.org).toEqual(fields.org);
    expect(catalogue.workingRepos).toEqual(fields.workingRepos);

    const org = clearSkillChoice(fields, find("release"));
    expect(org.org).toEqual({ enabled: false, disabled: ["runbook"] });
    expect(org.catalogue).toEqual(fields.catalogue);

    expect(clearSkillChoice(fields, find("org skills")).org).toEqual({
      enabled: true,
      disabled: ["release", "runbook"],
    });
    const repos = clearSkillChoice(fields, find("repo skills"));
    expect(repos.workingRepos.enabled).toBe(true);
    expect(labels(repos, bare)).toEqual(["ryph-environment", "org skills", "release", "runbook"]);
    // The fields it was given are left as they were.
    expect(fields.workingRepos.enabled).toBe(false);
  });
});

describe("the review's summary", () => {
  it("counts what is on against what the deployment offers", () => {
    const fields = skillPolicyToFields(null);
    expect(skillsSummary(fields, overview())).toEqual({
      catalogue: "All",
      org: "All",
      workingRepos: "On",
    });
    fields.catalogue.disabled = ["ryph-checks"];
    fields.org.disabled = ["release"];
    fields.workingRepos.enabled = false;
    expect(skillsSummary(fields, overview())).toEqual({
      catalogue: "0 of 1",
      org: "1 of 2",
      workingRepos: "Off",
    });
    fields.org.enabled = false;
    expect(skillsSummary(fields, overview()).org).toBe("Off");
  });

  it("says what the deployment does not offer as such, not as the agent's choice", () => {
    const fields = skillPolicyToFields(null);
    const bare = overview({ catalogue: [], org: null, workingRepoSkills: false });
    expect(skillsSummary(fields, bare)).toEqual({
      catalogue: "None offered",
      org: "No repository connected",
      workingRepos: "Off for everyone",
    });
  });

  it("says what the org repo gives in the Skills step's terms, not as every skill", () => {
    const fields = skillPolicyToFields(null);
    const unsynced = overview();
    unsynced.org = { ...unsynced.org!, current: null };
    expect(skillsSummary(fields, unsynced).org).toBe("Not synced yet");
    const empty = overview();
    empty.org = { ...empty.org!, current: { ...empty.org!.current!, skills: [] } };
    expect(skillsSummary(fields, empty).org).toBe("None yet");
    const archived = overview();
    archived.org = { ...archived.org!, archived: true };
    expect(skillsSummary(fields, archived).org).toBe("Repository disconnected");
    // The agent's own choice still reads as such on a repo that has nothing yet.
    fields.org.enabled = false;
    expect(skillsSummary(fields, unsynced).org).toBe("Off");
  });
});

describe("the edit's skills half", () => {
  const narrowed = {
    ...DEFAULT_SKILL_POLICY,
    catalogue: { disabled: ["ryph-checks"] },
  };

  it("saves the step when it showed what the deployment offers", () => {
    const fields = skillPolicyToFields(narrowed);
    expect(skillPolicyPatch({ shown: true, offered: true, stored: null, fields })).toEqual({
      skillPolicy: narrowed,
    });
    expect(
      skillPolicyPatch({
        shown: true,
        offered: true,
        stored: narrowed,
        fields: skillPolicyToFields(null),
      }),
    ).toEqual({ skillPolicy: null });
  });

  it("leaves the policy alone when the skills could not be read", () => {
    const fields = skillPolicyToFields(null);
    expect(skillPolicyPatch({ shown: true, offered: false, stored: narrowed, fields })).toEqual({});
  });

  it("clears a stored policy on a harness that reads no skills, which would refuse to keep it", () => {
    const fields = skillPolicyToFields(narrowed);
    expect(skillPolicyPatch({ shown: false, offered: true, stored: narrowed, fields })).toEqual({
      skillPolicy: null,
    });
    expect(skillPolicyPatch({ shown: false, offered: true, stored: null, fields })).toEqual({});
  });
});
