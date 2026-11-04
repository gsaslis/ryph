/** What the builds list can be narrowed to, kept in the address so a view can be linked. */
export const STATE_FILTERS = ["any", "active", "ready", "failed"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];
