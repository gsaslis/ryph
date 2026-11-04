// `TrackedRepoStore` in memory — for tests. Not a production choice even for a small set: a
// user-mode bridge that forgot its set on restart would watch nothing (see the port).

import type { TrackedRepo, TrackedRepoStore } from "../../ports/tracked_repos.ts";

export function memoryTrackedRepos(seed: TrackedRepo[] = []): TrackedRepoStore {
  const rows = new Map(seed.map((r) => [r.rid, { ...r }]));
  const sorted = (keep: (r: TrackedRepo) => boolean) =>
    [...rows.values()].filter(keep).sort((a, b) => a.rid.localeCompare(b.rid)).map((r) => ({
      ...r,
    }));
  return {
    list: () => Promise.resolve(sorted((r) => !r.unseedPending)),
    get: (rid) => {
      const row = rows.get(rid);
      return Promise.resolve(row === undefined ? null : { ...row });
    },
    track: (rid, createdPolicy) => {
      const row = rows.get(rid);
      if (row === undefined) {
        rows.set(rid, {
          rid,
          createdPolicy,
          unseedPending: false,
          trackedAt: new Date().toISOString(),
        });
      } else {
        row.createdPolicy ||= createdPolicy;
        row.unseedPending = false;
        row.trackedAt = new Date().toISOString();
      }
      return Promise.resolve();
    },
    markUnseedPending: (rid) => {
      const row = rows.get(rid);
      if (row !== undefined) row.unseedPending = true;
      return Promise.resolve();
    },
    pendingUnseeds: () => Promise.resolve(sorted((r) => r.unseedPending)),
    untrack: (rid) => {
      const row = rows.get(rid) ?? null;
      rows.delete(rid);
      return Promise.resolve(row);
    },
  };
}
