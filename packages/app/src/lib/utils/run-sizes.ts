import type { RunSize } from "$lib/api/types";

/**
 * One class's quantities in words, for the option list and the hint under it:
 * "4 CPU · 8Gi memory · 10Gi disk · 50Gi work volume". A field the class leaves unset is
 * not mentioned — it is the backend's own default, not zero.
 */
export function sizeSummary(size: Omit<RunSize, "default">): string {
  return [
    size.cpu === null && size.memory === null ? "No CPU or memory caps" : null,
    size.cpu === null ? null : `${size.cpu} CPU`,
    size.memory === null ? null : `${size.memory} memory`,
    size.ephemeralStorage === null ? null : `${size.ephemeralStorage} disk`,
    size.workVolume === null ? null : `${size.workVolume} work volume`,
  ].filter((part) => part !== null).join(" · ");
}

/** A compact label for the frozen class on a run, not today's deployment configuration. */
export function runSizeLabel(size: Omit<RunSize, "default">): string {
  return size.cpu === null && size.memory === null ? `${size.name} · uncapped` : size.name;
}

/** The select's value for "no class chosen": a name the grammar cannot produce. */
export const DEFAULT_SIZE_VALUE = "__default__";

/**
 * What the select shows for a subject's stored class: the deployment default spelled out, the
 * class by name, or — when the configuration no longer defines the stored name — that name, so an
 * admin sees why their runs are on the default.
 */
export function sizeClassLabel(sizeClass: string | null, sizes: RunSize[]): string {
  if (sizeClass === null) {
    const fallback = sizes.find((s) => s.default);
    return fallback ? `Default (${fallback.name})` : "Default";
  }
  return sizes.some((s) => s.name === sizeClass)
    ? sizeClass
    : `${sizeClass} (no longer configured — runs get the default)`;
}
