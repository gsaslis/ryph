// The catalogue this package SHIPS, loaded and checked for real — plus the rules the schema
// enforces on any entry a future PR adds.
//
// The capability sets below were measured, not reasoned: each image was launched under
// `--cap-drop ALL` plus the entry's list and watched for its ready line, and each list was then
// trimmed until something broke. That is what makes the differences between them meaningful.

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  directoryServiceCatalogue,
  ServiceCatalogueEntrySchema,
} from "../src/adapters/service_catalogue/directory.ts";

const base = {
  id: "thing",
  name: "Thing",
  description: "",
  docs: "https://example.test",
  versions: { "1": `thing:1@sha256:${"a".repeat(64)}` },
  defaultPort: 1234,
  capabilities: [],
  memory: "512m",
  env: [],
};

test("the shipped catalogue loads, and every image in it is digest-pinned", async () => {
  const catalogue = await directoryServiceCatalogue();
  const entries = await catalogue.list();
  assertEquals(entries.map((e) => e.id).sort(), [
    "meilisearch",
    "mongo",
    "mysql",
    "postgres",
    "redis",
  ]);
  for (const entry of entries) {
    for (const image of Object.values(entry.versions)) {
      assert(image.includes("@sha256:"), `${entry.id}: ${image} is not digest-pinned`);
    }
  }
});

test("the shipped capability sets are the measured ones, and differ per image", async () => {
  const byId = new Map((await (await directoryServiceCatalogue()).list()).map((e) => [e.id, e]));
  // postgres and mongo drop privileges with gosu: SETUID/SETGID, and CHOWN for the data dir.
  assertEquals(byId.get("postgres")!.capabilities, ["CHOWN", "SETGID", "SETUID"]);
  assertEquals(byId.get("mongo")!.capabilities, ["CHOWN", "SETGID", "SETUID"]);
  // redis uses setpriv, which shrinks the bounding set — that needs SETPCAP, and nothing else
  // here does. Without it the container exits with "apply bounding set: Operation not permitted".
  assertEquals(byId.get("redis")!.capabilities, ["CHOWN", "SETGID", "SETPCAP", "SETUID"]);
  // mysql's entrypoint reads /var/lib/mysql-files as root before dropping: DAC_OVERRIDE.
  assertEquals(byId.get("mysql")!.capabilities, ["CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"]);
  // And the one that needs nothing at all, which is the target every other entry misses.
  assertEquals(byId.get("meilisearch")!.capabilities, []);
});

test("an unpinned image cannot enter the catalogue", () => {
  const parsed = ServiceCatalogueEntrySchema.safeParse({
    ...base,
    versions: { "1": "thing:1" },
  });
  assert(!parsed.success);
  assertStringIncludes(JSON.stringify(parsed.error.issues), "digest-pinned");
});

test("NET_RAW cannot enter the catalogue, however well argued", () => {
  // A sidecar shares the run's network namespace, and every intra-cluster hop in this
  // deployment is plaintext HTTP carrying the run token, the git token and the model key.
  const parsed = ServiceCatalogueEntrySchema.safeParse({
    ...base,
    capabilities: ["NET_RAW"],
  });
  assert(!parsed.success);
});

test("the catalogue grants from an allowlist, not around a denylist", () => {
  // NET_ADMIN rewrites the pod's routes to the same effect as sniffing; ALL is everything.
  for (const cap of ["ALL", "NET_ADMIN", "SYS_PTRACE"]) {
    const parsed = ServiceCatalogueEntrySchema.safeParse({ ...base, capabilities: [cap] });
    assert(!parsed.success, `${cap} must not enter the catalogue`);
    assertStringIncludes(JSON.stringify(parsed.error.issues), cap === "ALL" ? "every" : "never");
  }
});

test("an entry cannot name a field the schema has not agreed to", () => {
  const parsed = ServiceCatalogueEntrySchema.safeParse({ ...base, privileged: true });
  assert(!parsed.success);
});

test("a broken entry fails the whole load, naming the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await writeFile(`${dir}/thing.json`, JSON.stringify({ ...base, memory: "huge" }));
    const err = await directoryServiceCatalogue(dir).then(() => null, (e: Error) => e);
    assert(err !== null, "a bad entry must not load");
    assertStringIncludes(err.message, "thing.json");
    // "We skipped the one that did not parse" is not a mode worth having for the list of
    // images the platform runs on someone else's machines.
    assertStringIncludes(err.message, "memory");
  } finally {
    await rm(dir, { recursive: true });
  }
});
