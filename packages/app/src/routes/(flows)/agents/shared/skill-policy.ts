// The bridge between the agent form's Skills step and the API's SkillPolicy, shared by the create
// and edit flows. The policy only ever narrows what the deployment allows, and its lists name what
// is OFF, so the form edits a copy of the policy itself: there is nothing to translate, only the
// defaults to tell apart from a choice.

import { DEFAULT_SKILL_POLICY, type SkillPolicy, type SkillsOverview } from "$lib/api/types";

/** The form's copy of a policy: the stored one, or the defaults for an agent that has none. */
export function skillPolicyToFields(policy: SkillPolicy | null): SkillPolicy {
  return structuredClone(policy ?? DEFAULT_SKILL_POLICY);
}

/** Whether the form says nothing the defaults do not: every skill the deployment allows. */
export function isDefaultSkillPolicy(fields: SkillPolicy): boolean {
  return fields.catalogue.disabled.length === 0 && fields.org.enabled &&
    fields.org.disabled.length === 0 && fields.workingRepos.enabled;
}

/** The org skills repo the form shows switches for: none when it is gone or archived, since runs
 * get nothing from it then. */
function shownOrg(overview: SkillsOverview) {
  return overview.org !== null && !overview.org.archived ? overview.org : null;
}

/**
 * Whether a switch on screen is off: a skill the deployment offers turned off for this agent, or a
 * source turned off that the deployment offers. The policy itself can say more, about names nothing
 * on screen shows (`hiddenSkillChoices`), and those do not count here.
 */
export function skillsOffOnScreen(fields: SkillPolicy, overview: SkillsOverview): boolean {
  const offered = new Set(overview.catalogue.filter((s) => s.enabled).map((s) => s.name));
  if (fields.catalogue.disabled.some((n) => offered.has(n))) return true;
  const org = shownOrg(overview);
  if (org !== null) {
    if (!fields.org.enabled) return true;
    const listed = new Set(org.current?.skills.map((s) => s.name) ?? []);
    if (fields.org.disabled.some((n) => listed.has(n))) return true;
  }
  return overview.workingRepoSkills && !fields.workingRepos.enabled;
}

/** One thing the policy turns off that the form has no switch for, and where in the policy it
 * lives, so it can be cleared on its own. `label` is how the form names it. */
export interface HiddenSkillChoice {
  kind: "catalogue" | "org" | "org-source" | "repo-source";
  label: string;
}

/**
 * What the policy turns off that the form has no switch for: a Ryph skill an admin turned off for
 * everyone, an org skill renamed or removed since, or a whole source the deployment does not offer
 * now. These are kept in the saved policy on purpose, since the lists name what is off: a skill
 * that comes back stays off for this agent. The form names them so the agent's state can be
 * explained, and each can be cleared on its own (`clearSkillChoice`) without resetting the rest.
 *
 * A Ryph skill a release no longer ships is left out: the orchestrator drops it from the policy on
 * the next save, so it would not stay off if a later release brought it back.
 */
export function hiddenSkillChoices(
  fields: SkillPolicy,
  overview: SkillsOverview,
): HiddenSkillChoice[] {
  const turnedOff = new Set(overview.catalogue.filter((s) => !s.enabled).map((s) => s.name));
  const hidden: HiddenSkillChoice[] = fields.catalogue.disabled
    .filter((n) => turnedOff.has(n))
    .map((label) => ({ kind: "catalogue", label }));
  const orgNames = (names: string[]) =>
    names.map((label): HiddenSkillChoice => ({ kind: "org", label }));
  const org = shownOrg(overview);
  if (org === null) {
    if (!fields.org.enabled) hidden.push({ kind: "org-source", label: "org skills" });
    hidden.push(...orgNames(fields.org.disabled));
  } else if (fields.org.enabled) {
    // With the repo turned off its switches are hidden, but the toggle already says it is off.
    const listed = new Set(org.current?.skills.map((s) => s.name) ?? []);
    hidden.push(...orgNames(fields.org.disabled.filter((n) => !listed.has(n))));
  }
  if (!overview.workingRepoSkills && !fields.workingRepos.enabled) {
    hidden.push({ kind: "repo-source", label: "repo skills" });
  }
  const seen = new Set<string>();
  return hidden.filter((choice) => {
    const key = `${choice.kind}:${choice.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The fields with one hidden choice dropped, and every other choice kept as it was. */
export function clearSkillChoice(fields: SkillPolicy, choice: HiddenSkillChoice): SkillPolicy {
  // Built anew rather than cloned: the form's fields are reactive state, which does not clone.
  const catalogue = choice.kind === "catalogue"
    ? switchName(fields.catalogue.disabled, choice.label, true)
    : [...fields.catalogue.disabled];
  const orgDisabled = choice.kind === "org"
    ? switchName(fields.org.disabled, choice.label, true)
    : [...fields.org.disabled];
  return {
    catalogue: { disabled: catalogue },
    org: { enabled: fields.org.enabled || choice.kind === "org-source", disabled: orgDisabled },
    workingRepos: { enabled: fields.workingRepos.enabled || choice.kind === "repo-source" },
  };
}

/** The policy to save: null for the defaults, as the orchestrator stores them, and otherwise the
 * fields with each list sorted and once per name, so an unchanged form saves an unchanged policy. */
export function composeSkillPolicy(fields: SkillPolicy): SkillPolicy | null {
  if (isDefaultSkillPolicy(fields)) return null;
  const tidy = (names: string[]) => [...new Set(names)].sort();
  return {
    catalogue: { disabled: tidy(fields.catalogue.disabled) },
    org: { enabled: fields.org.enabled, disabled: tidy(fields.org.disabled) },
    workingRepos: { enabled: fields.workingRepos.enabled },
  };
}

/**
 * The skills half of an agent edit. Owned outright when the step could show what the deployment
 * offers, and left out when it could not, so a form that could not read the skills never clears a
 * policy it could not show. On a harness that reads no skills the step is gone, and a stored
 * policy is cleared: the control plane refuses to keep one there, since it would do nothing, and
 * the form has no step left to clear it from.
 */
export function skillPolicyPatch(edit: {
  /** The selected harness reads skills, so the Skills step is on the form. */
  shown: boolean;
  /** The deployment's skills could be read, so the step showed them. */
  offered: boolean;
  /** The agent's policy as saved. */
  stored: SkillPolicy | null;
  fields: SkillPolicy;
}): { skillPolicy?: SkillPolicy | null } {
  if (!edit.shown) return edit.stored === null ? {} : { skillPolicy: null };
  if (!edit.offered) return {};
  return { skillPolicy: composeSkillPolicy(edit.fields) };
}

/** A list of names with one turned on (taken out) or off (put in). */
export function switchName(disabled: readonly string[], name: string, on: boolean): string[] {
  const rest = disabled.filter((n) => n !== name);
  return on ? rest : [...rest, name];
}

/**
 * What the agent's runs get from each source, in a few words, for the review. A source the
 * deployment does not offer is said as such rather than as the agent's choice, in the terms the
 * Skills step uses for it: a repo disconnected, not synced yet, or with no skills yet.
 */
export function skillsSummary(
  fields: SkillPolicy,
  overview: SkillsOverview,
): { catalogue: string; org: string; workingRepos: string } {
  const offered = overview.catalogue.filter((s) => s.enabled);
  const catalogueOn = offered.filter((s) => !fields.catalogue.disabled.includes(s.name)).length;
  return {
    catalogue: offered.length === 0
      ? "None offered"
      : catalogueOn === offered.length
      ? "All"
      : `${catalogueOn} of ${offered.length}`,
    org: orgSummary(fields, overview),
    workingRepos: !overview.workingRepoSkills
      ? "Off for everyone"
      : fields.workingRepos.enabled
      ? "On"
      : "Off",
  };
}

function orgSummary(fields: SkillPolicy, overview: SkillsOverview): string {
  const org = overview.org;
  if (org === null) return "No repository connected";
  if (org.archived) return "Repository disconnected";
  if (!fields.org.enabled) return "Off";
  if (org.current === null) return "Not synced yet";
  const skills = org.current.skills;
  if (skills.length === 0) return "None yet";
  const on = skills.filter((s) => !fields.org.disabled.includes(s.name)).length;
  return on === skills.length ? "All" : `${on} of ${skills.length}`;
}
