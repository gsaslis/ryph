// The skills ryph ships about its own configuration files, as the core sees them.
//
// One adapter stands behind it — a directory inside this package, read and validated once at
// boot (adapters/skill_catalogue/directory.ts) — and the catalogue ships with the orchestrator
// rather than the harness image because the formats it documents are parsed here and in the
// forge: a deploy that changes what `.ryph/checks.yml` means changes the skill in the same
// commit. A port and not an import for the reason ports/service_catalogue.ts gives.

import type { CatalogueSkill, SkillBundle } from "../core/skills.ts";

export interface SkillCatalogue {
  /** Every skill, sorted by name. Already validated: an invalid one never gets this far. */
  list(): CatalogueSkill[];
  /** A skill's files by digest, or null when this catalogue holds no such version. */
  bundle(digest: string): SkillBundle | null;
}
