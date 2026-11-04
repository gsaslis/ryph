// The invariants every committed migration set has to hold, checked for all of them at once.
//
// This lives in @ryph/db because it is this package's migrator that makes them invariants.
// `migrate()` reads the NEWEST `created_at` in the set's tracking table once, before it starts,
// then applies only entries whose journal `when` is strictly greater (src/open.ts). Two things
// follow, and neither is visible in a normal test run:
//
//   A migration whose `when` is older than one already applied is SILENTLY SKIPPED on any
//   database that has run the later one — and the migrate job still reports success. A fresh
//   database is unaffected, because there is no newest row yet to compare against, so a suite
//   that applies the set to an empty database (every package's own migrations_test.ts) passes
//   while deployments quietly diverge. Only ordering the journal by `when` catches it.
//
//   A missing `meta/<n>_snapshot.json` is the same shape of problem one layer up. drizzle-kit
//   diffs the schema against the LAST snapshot to generate the next migration, so a
//   hand-written migration that never got a snapshot leaves its own changes looking undone:
//   the next `db:generate` re-emits them, and that duplicate fails on every database that
//   already ran the original.
//
// Both were live in this repo — orchestrator 0009, chat 0001/0002 and memory 0010 were written
// by hand during a stack review, and orchestrator 0009 reached a deployment unapplied.

import { test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { assertEquals } from "@std/assert";

const PACKAGES = new URL("../../", import.meta.url);

interface Entry {
  idx: number;
  when: number;
  tag: string;
}

/** Every package that owns a migration set, by name. */
async function sets(): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const journal = new URL(`${entry.name}/drizzle/meta/_journal.json`, PACKAGES);
    if (await stat(journal).then(() => true).catch(() => false)) found.push(entry.name);
  }
  return found.sort();
}

const journalOf = async (pkg: string): Promise<Entry[]> =>
  JSON.parse(await readFile(new URL(`${pkg}/drizzle/meta/_journal.json`, PACKAGES), "utf8"))
    .entries;

/** The `0009` of `0009_one_open_response` — what names the entry's files. */
const prefixOf = (tag: string) => tag.split("_")[0];

const exists = (url: URL) => stat(url).then(() => true).catch(() => false);

test("every migration set is ordered so the migrator cannot skip an entry", async () => {
  for (const pkg of await sets()) {
    const entries = await journalOf(pkg);
    // Strictly increasing, and in the order the journal lists them — an entry that sorts by
    // `when` into a different place than its index is exactly the skip described above.
    const outOfOrder = entries.filter((e, i) => i > 0 && e.when <= entries[i - 1].when)
      .map((e) => `${pkg}/${e.tag} (when=${e.when})`);
    assertEquals(outOfOrder, []);
    // The index is the position, so a journal that disagrees would make `idx` meaningless.
    assertEquals(entries.map((e) => e.idx), entries.map((_, i) => i), `${pkg}: idx is not dense`);
  }
});

test("every journal entry has its sql and its snapshot, and the chain links up", async () => {
  for (const pkg of await sets()) {
    const dir = new URL(`${pkg}/drizzle/`, PACKAGES);
    const entries = await journalOf(pkg);

    const missingSql: string[] = [];
    const missingSnapshot: string[] = [];
    const brokenChain: string[] = [];
    let previousId: string | undefined;

    for (const [i, entry] of entries.entries()) {
      if (!await exists(new URL(`${entry.tag}.sql`, dir))) missingSql.push(`${pkg}/${entry.tag}`);

      const snapshot = new URL(`meta/${prefixOf(entry.tag)}_snapshot.json`, dir);
      if (!await exists(snapshot)) {
        missingSnapshot.push(`${pkg}/${prefixOf(entry.tag)}`);
        previousId = undefined;
        continue;
      }
      const { id, prevId } = JSON.parse(await readFile(snapshot, "utf8"));
      // Each snapshot names the one before it. A break means a snapshot was regenerated or
      // dropped in isolation, which is how a set starts describing a history it never had.
      if (i > 0 && previousId !== undefined && prevId !== previousId) {
        brokenChain.push(`${pkg}/${prefixOf(entry.tag)}`);
      }
      previousId = id;
    }

    assertEquals(missingSql, []);
    assertEquals(missingSnapshot, []);
    assertEquals(brokenChain, []);

    // And nothing the journal does not account for: a snapshot with no entry is the residue of
    // a renumbering, and the next `db:generate` would diff against it if it sorts last.
    const declared = new Set(entries.map((e) => prefixOf(e.tag)));
    const orphans: string[] = [];
    for (const file of await readdir(new URL("meta/", dir), { withFileTypes: true })) {
      const match = file.name.match(/^(\d+)_snapshot\.json$/);
      if (match && !declared.has(match[1])) orphans.push(`${pkg}/${file.name}`);
    }
    assertEquals(orphans.sort(), []);
  }
});
