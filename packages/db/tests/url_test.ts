import { test } from "bun:test";
import { assert, assertEquals, assertObjectMatch, assertThrows } from "@std/assert";
import { DbUrlError, describeDbTarget, isEphemeral, parseDbUrl, poolOptions } from "../src/url.ts";

test("a pglite path parses to an on-disk target", () => {
  assertObjectMatch(parseDbUrl("pglite:./data/ryph"), {
    kind: "pglite",
    dataDir: "./data/ryph",
  });
  assertObjectMatch(parseDbUrl("pglite:/var/lib/ryph"), {
    kind: "pglite",
    dataDir: "/var/lib/ryph",
  });
});

test("pglite:memory:// parses to an ephemeral target", () => {
  assertObjectMatch(parseDbUrl("pglite:memory://"), { kind: "pglite", dataDir: null });
  assertEquals(isEphemeral(parseDbUrl("pglite:memory://")), true);
  assertEquals(isEphemeral(parseDbUrl("pglite:./data/ryph")), false);
});

test("both postgres spellings parse, and keep the URL verbatim", () => {
  const url = "postgres://u:p@host:5432/ryph_control?sslmode=require";
  assertObjectMatch(parseDbUrl(url), { kind: "postgres", url });
  assertObjectMatch(parseDbUrl("postgresql://host/db"), {
    kind: "postgres",
    url: "postgresql://host/db",
  });
});

test("surrounding whitespace is tolerated — env files collect it", () => {
  assertObjectMatch(parseDbUrl("  pglite:./data/ryph\n"), {
    kind: "pglite",
    dataDir: "./data/ryph",
  });
});

test("each retired spelling is refused BY NAME, not as a generic parse error", () => {
  // The whole point: an old .env should say what to do, not fail opaquely.
  const memory = assertThrows(() => parseDbUrl("memory"), DbUrlError);
  assertEquals(memory.message.includes("pglite:memory://"), true);

  for (const sqlite of [":memory:", "file:ryph.db", "file:./ryph-history.db"]) {
    const err = assertThrows(() => parseDbUrl(sqlite), DbUrlError);
    assertEquals(
      err.message.includes("SQLite"),
      true,
      `${sqlite} should be named as a SQLite URL, got: ${err.message}`,
    );
  }
});

test("a bare path is refused rather than guessed at", () => {
  // "ryph.db" was the old RYPH_DB default. Treating it as a pglite path would quietly
  // create a directory named ryph.db next to the old SQLite file.
  assertThrows(() => parseDbUrl("ryph.db"), DbUrlError);
  assertThrows(() => parseDbUrl("./data/ryph"), DbUrlError);
  assertThrows(() => parseDbUrl(""), DbUrlError);
  assertThrows(() => parseDbUrl("   "), DbUrlError);
  assertThrows(() => parseDbUrl("pglite:"), DbUrlError);
});

test("describeDbTarget redacts a postgres password", () => {
  const described = describeDbTarget(parseDbUrl("postgres://user:sekrit@db.internal/ryph"));
  assertEquals(described.includes("sekrit"), false, described);
  assertEquals(described.includes("user"), true, described);
  assertEquals(described.includes("db.internal"), true, described);
});

test("describeDbTarget redacts a password given as a query parameter", () => {
  const described = describeDbTarget(
    parseDbUrl("postgres://user@db.internal/ryph?sslmode=require&password=sekrit"),
  );
  assert(!described.includes("sekrit"), described);
  assert(described.includes("sslmode=require"), described);
});

test("describeDbTarget names a pglite target without pretending it is a URL", () => {
  assertEquals(describeDbTarget(parseDbUrl("pglite:memory://")), "pglite (in memory)");
  assertEquals(describeDbTarget(parseDbUrl("pglite:./data/ryph")), "pglite ./data/ryph");
});

test("poolOptions reads the pool's shape from the URL as numbers", () => {
  assertEquals(
    poolOptions("postgres://u:p@db.internal:5432/ryph?sslmode=require&max=4&idle_timeout=30"),
    { max: 4, idle_timeout: 30 },
  );
  // Nothing said, nothing set: the driver keeps its defaults rather than seeing `undefined`,
  // which it would size a pool by (`Array(undefined)` is one element long too).
  assertEquals(poolOptions("postgres://u:p@db.internal/ryph?sslmode=require"), {});
  assertEquals(poolOptions("postgres://u:p@db.internal/ryph?max=1"), { max: 1 });
  assertEquals(poolOptions("postgres://u:p@db.internal/ryph?idle_timeout=0"), {
    idle_timeout: 0,
  });
});

test("poolOptions refuses a pool size it cannot honour", () => {
  assertThrows(() => poolOptions("postgres://u:p@db.internal/ryph?max=four"), DbUrlError);
  assertThrows(() => poolOptions("postgres://u:p@db.internal/ryph?max=0"), DbUrlError);
  assertThrows(() => poolOptions("postgres://u:p@db.internal/ryph?max=2.5"), DbUrlError);
  assertThrows(() => poolOptions("postgres://u:p@db.internal/ryph?idle_timeout=-1"), DbUrlError);
});
