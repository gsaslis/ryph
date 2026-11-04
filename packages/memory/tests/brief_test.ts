// Composing the brief: pinned first, then by score with a turn per subject, under a token
// budget, with the topic index for what did not fit — and null when there is nothing to say.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { composeBrief, estimateTokens, relativeAge, renderLine } from "../src/core/brief.ts";
import { memory, T0 } from "./fixtures.ts";

const now = new Date(T0);

test("stale observations are secondary, relevant-only, bounded, and retain evidence", () => {
  const canon = memory({ id: "current" });
  const stale = memory({
    id: "stale-pin",
    status: "needs-verification",
    trust: "pinned",
    evidence: { sha: "abc1234", paths: ["package.json"] },
  });
  const candidates = [
    { memory: stale, relevance: 1 },
    { memory: canon, relevance: 0.5 },
    { memory: memory({ id: "irrelevant", status: "needs-verification" }), relevance: 0 },
  ];
  const brief = composeBrief(candidates, 2000, now)!;
  assertEquals(brief.memoryIds, ["current", "stale-pin"]);
  assertStringIncludes(brief.text, "### Needs verification — not current canon");
  assertStringIncludes(brief.text, "memory__get");
  assertStringIncludes(brief.text, "memory__confirm");
  assertStringIncludes(brief.text, "memory__refute");
  assertEquals(brief.evidence.find((e) => e.memoryId === stale.id)?.sha, "abc1234");
  const secondary = brief.text.slice(brief.text.indexOf("### Needs verification"));
  assert(estimateTokens(secondary) <= 500);
  assertEquals(composeBrief(candidates, 100, now)!.memoryIds, ["current"]);
  assertEquals(composeBrief([{ memory: stale, relevance: 1 }], 100, now), null);
  const longPin = { ...stale, text: "large stale claim ".repeat(200) };
  assertEquals(composeBrief([{ memory: longPin, relevance: 1 }], 2000, now), null);
});

test("many stale claims cannot displace canon or exceed the remaining budget", () => {
  const stale = Array.from({ length: 100 }, (_, i) => ({
    memory: memory({ id: `stale-${i}`, status: "needs-verification", trust: "pinned" }),
    relevance: 1,
  }));
  const budget = 2000;
  const roomy = composeBrief(stale, budget, now)!;
  assert(roomy.memoryIds.length > 0 && roomy.memoryIds.length < stale.length);
  assert(
    estimateTokens(roomy.text.slice(roomy.text.indexOf("### Needs verification"))) <= budget / 4,
  );
  // Leave less than the quarter-budget allowance, but enough for a few stale lines.
  const canon = { memory: memory({ id: "canon", text: "x".repeat(6500) }), relevance: 1 };
  const alone = composeBrief([canon], budget, now)!;
  const combined = composeBrief([...stale, canon], budget, now)!;
  assertEquals(combined.memoryIds[0], "canon");
  assert(combined.text.startsWith(alone.text));
  assert(combined.memoryIds.length > 1);
  assert(combined.memoryIds.length < roomy.memoryIds.length);
  assert(estimateTokens(combined.text) <= budget);
  // A canon pin may overrun the budget; stale pins must never add to that overrun.
  const overrun = {
    memory: { ...canon.memory, trust: "pinned" as const, text: "x".repeat(9000) },
    relevance: 1,
  };
  assertEquals(
    composeBrief([...stale, overrun], budget, now),
    composeBrief([overrun], budget, now),
  );
});

test("nothing to say is null, not an empty section", () => {
  assertEquals(composeBrief([], 2000, now), null);
});

test("pinned memories come first, whatever their score, and the rest rank by score", () => {
  const brief = composeBrief(
    [
      {
        memory: memory({ id: "mem-old", confirmations: 0, createdAt: "2025-01-01T00:00:00.000Z" }),
        relevance: 0.5,
      },
      { memory: memory({ id: "mem-hot", confirmations: 5 }), relevance: 1 },
      {
        memory: memory({ id: "mem-pin", trust: "pinned", createdAt: "2024-01-01T00:00:00.000Z" }),
        relevance: 0,
      },
    ],
    2000,
    now,
  )!;
  assertEquals(brief.memoryIds, ["mem-pin", "mem-hot", "mem-old"]);
  assertStringIncludes(brief.text, "## What previous runs learned");
  assertStringIncludes(brief.text, "[mem-pin]");
  assert(!brief.text.includes("Also on record"), "everything fit, so no index");
});

test("the budget cuts the tail into a topic index, and pinned rides regardless", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    memory({
      id: `mem-${i}`,
      text: `Claim number ${i} about the build, long enough to cost some tokens each time`,
      kind: i % 2 === 0 ? "fact" : "gotcha",
      confirmations: 40 - i,
      subject: i < 30 ? { kind: "repo", url: "github.com/acme/app" } : { kind: "org" },
    }));
  const pinned = memory({
    id: "mem-pin",
    trust: "pinned",
    text: "Pinned claim",
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  const brief = composeBrief(
    [...many, pinned].map((m) => ({ memory: m, relevance: 1 })),
    300,
    now,
  )!;
  assert(brief.memoryIds.includes("mem-pin"));
  assert(brief.memoryIds.length < 41, "not everything fit");
  assert(estimateTokens(brief.text) < 300 + 120, "the index is the only overrun");
  assertStringIncludes(brief.text, "### Also on record");
  assertStringIncludes(brief.text, "repo github.com/acme/app:");
  assertStringIncludes(brief.text, "org:");
  assertStringIncludes(brief.text, "memories —");
  // The index counts exactly what was left out.
  const left = 41 - brief.memoryIds.length;
  const counted = [...brief.text.matchAll(/: (\d+) memor/g)].reduce((n, m) => n + Number(m[1]), 0);
  assertEquals(counted, left);
});

test("subjects take turns, so one repo's crowd cannot push a sibling or the org out", () => {
  // api has forty strong memories, web three weak ones, the org two weaker still. Ranked by
  // score alone the budget would fill with api; a turn per subject seats every subject.
  const api = Array.from({ length: 40 }, (_, i) =>
    memory({
      id: `api-${i}`,
      text: `The api service does something specific number ${i}, worth a line of its own`,
      confirmations: 50 - i,
      subject: { kind: "repo", url: "github.com/acme/api" },
    }));
  const web = Array.from({ length: 3 }, (_, i) =>
    memory({
      id: `web-${i}`,
      text: `The web app does something specific number ${i}, worth a line of its own`,
      confirmations: 1,
      subject: { kind: "repo", url: "github.com/acme/web" },
    }));
  const org = Array.from({ length: 2 }, (_, i) =>
    memory({
      id: `org-${i}`,
      text: `The org does something specific number ${i}, worth a line of its own`,
      subject: { kind: "org" },
    }));
  const brief = composeBrief(
    [...api, ...web, ...org].map((m) => ({ memory: m, relevance: 1 })),
    400,
    now,
  )!;
  assert(brief.memoryIds.length < 45, "not everything fit");
  const seated = (prefix: string) => brief.memoryIds.filter((id) => id.startsWith(prefix)).length;
  assertEquals(seated("web-"), 3, "every web memory is in");
  assertEquals(seated("org-"), 2, "every org memory is in");
  assert(seated("api-") >= 5, "api still gets its share");
  assert(seated("api-") < 40, "api is what the budget cut");
  // Rendered in score order regardless of the turn that admitted each one.
  const ids = brief.memoryIds;
  assertEquals(ids.slice(0, 2), ["api-0", "api-1"]);
  assert(ids.indexOf("web-0") > ids.indexOf("api-4"));
  assertStringIncludes(brief.text, "repo github.com/acme/api:");
  assert(!brief.text.includes("repo github.com/acme/web:"), "nothing of web was left out");
});

test("the pinned label is retained for canon but omitted for stale claims", () => {
  const pinned = memory({ trust: "pinned" });
  assertStringIncludes(renderLine(pinned, now), " · pinned · ");
  const stale = renderLine({ ...pinned, status: "needs-verification" }, now);
  assert(!stale.includes("pinned"), "stale claims must not advertise a pin override");
  assertStringIncludes(stale, `[${pinned.id}] ${pinned.text}`);
});

test("a line cites the id, the claim and its trail", () => {
  const line = renderLine(
    memory({ confirmations: 12, lastConfirmedAt: "2026-08-29T00:00:00.000Z" }),
    now,
  );
  assertEquals(
    line,
    "- [mem-1] App tests are vitest, wired in via package.json scripts.test (procedure · confirmed 12× · 3d ago)",
  );
  assertEquals(relativeAge("2026-06-01T00:00:00.000Z", now), "3mo ago");
  assertEquals(relativeAge("2024-06-01T00:00:00.000Z", now), "2y ago");
  assertEquals(relativeAge(T0, now), "today");
});
