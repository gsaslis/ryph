/** What the checks list can be narrowed to, each kept in the address so a view can be linked. */
export const STATE_FILTERS = ["any", "failing", "passed", "active"] as const;
export const ASKER_FILTERS = ["anyone", "tool", "patch", "push", "forge", "local"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];
export type AskerFilter = (typeof ASKER_FILTERS)[number];
