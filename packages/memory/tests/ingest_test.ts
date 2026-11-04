// Ingestion: a document becomes a source and a review batch; without a model, a pointer alone;
// a re-ingest supersedes; `doc` serves the document to a run in scope; the routes.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { makeMemoryService, MemoryRefusedError, type MemoryService } from "../src/core/service.ts";
import { parseClaims } from "../src/core/extract.ts";
import { FetchRefusedError } from "../src/ports/fetcher.ts";
import type { ModelClient } from "../src/ports/model.ts";
import { ADMIN, call, makeApi, PLAIN } from "./api.ts";
import { countingMinter, fakeClock, fakeHash, memory, source } from "./fixtures.ts";
import { memoryStore } from "./memory_store.ts";

const silent = { debug() {}, warn() {} };

const GUIDE = `# Onboarding

Welcome.

## Testing

App tests are vitest, wired in via package.json scripts.test.

## Deploy

Deploys go through deno task release:push. Never on Fridays.
`;

function extractor(perSection: Record<string, unknown[]>): ModelClient {
  return {
    complete(req) {
      const section = req.prompt.match(/^Section: (.+)$/m)?.[1] ?? "";
      const claims = perSection[section];
      if (claims === undefined) return Promise.resolve("no json here");
      return Promise.resolve(JSON.stringify({ claims }));
    },
  };
}

/** Ingests and waits for the extraction behind it — what most of these tests are about. */
const ingestAll = async (
  service: MemoryService,
  input: Parameters<MemoryService["ingest"]>[0],
  userId: string,
) => (await service.ingest(input, userId)).done;

function makeService(model: ModelClient | null, store = memoryStore()) {
  const clock = fakeClock();
  const service = makeMemoryService({
    store,
    now: clock.now,
    diag: silent,
    mintId: countingMinter(),
    model,
    hash: fakeHash,
    fetchers: {
      url: {
        fetch: (locator) =>
          locator.endsWith("/guide")
            ? Promise.resolve({ title: "Fetched guide", text: GUIDE })
            : Promise.reject(new FetchRefusedError("nope")),
      },
    },
  });
  return { store, clock, service };
}

test("parseClaims drops the empty and the overlong, defaults the kind and subject", () => {
  const claims = parseClaims(
    JSON.stringify({
      claims: [
        { text: "A", kind: "gotcha", subject: "org", excerpt: "A." },
        { text: "", kind: "fact" },
        { text: "x".repeat(501) },
        { text: "B", kind: "pointer" },
      ],
    }),
    "repo",
  );
  assertEquals(claims, [
    { text: "A", kind: "gotcha", subject: "org", excerpt: "A." },
    { text: "B", kind: "fact", subject: "repo", excerpt: "" },
  ]);
});

test("ingest with a model: a source, one proposal per claim with the section, and a pointer", async () => {
  const model = extractor({
    "Onboarding › Testing": [
      {
        text: "App tests are vitest, wired in via package.json scripts.test.",
        kind: "procedure",
        subject: "repo",
        excerpt: "App tests are vitest",
      },
    ],
    "Onboarding › Deploy": [
      { text: "Deploys go through deno task release:push.", kind: "procedure", subject: "repo" },
      { text: "Deploys never happen on Fridays.", kind: "preference", subject: "org" },
    ],
    // "Onboarding" (the intro) answers nonsense: counted as failed, nothing else.
  });
  const { store, service } = makeService(model);
  const out = await ingestAll(service, {
    kind: "paste",
    title: "Onboarding guide",
    text: GUIDE,
    subject: { kind: "repo", url: "github.com/acme/app" },
  }, "u-admin");
  assertEquals(out.source.kind, "paste");
  assertEquals(out.source.locator, null);
  assertEquals(out.source.supersedesSourceId, null);
  assertEquals(out.stats, {
    sections: 3,
    extracted: 3,
    failed: 1,
    retired: 0,
    skipped: 0,
    modelBacked: true,
  });
  assertEquals(out.proposals.length, 4);
  const testing = out.proposals[0];
  assertEquals(testing.origin, {
    kind: "source",
    sourceId: out.source.id,
    section: "Onboarding › Testing",
  });
  assertEquals(testing.kind, "procedure");
  assertEquals(testing.subject, { kind: "repo", url: "github.com/acme/app" });
  const friday = out.proposals[2];
  assertEquals(friday.subject, { kind: "org" }, "moved by the claim's subject");
  assertEquals(friday.kind, "preference");
  const pointer = out.proposals[3];
  assertEquals(pointer.kind, "pointer");
  assertStringIncludes(
    pointer.text,
    'The document "Onboarding guide" is on record; sections: Onboarding, Testing, Deploy.',
  );
  assertEquals(pointer.origin, { kind: "source", sourceId: out.source.id, section: null });

  // The batch is listable by source; the consolidator promotes with ingested trust, holding the
  // preference for a person like an agent's.
  assertEquals((await service.listProposals(["pending"], 100, out.source.id)).length, 4);
  const stats = await service.consolidate();
  assertEquals(stats.promoted, 3);
  assertEquals(stats.held, 1);
  const detail = await service.getSource(out.source.id);
  assertEquals(detail?.memories.length, 3);
  // The batch is shaped as the inbox lists it: an ingested claim never waits on a change.
  assert(detail!.proposals.length > 0);
  assert(detail!.proposals.every((p) => p.basis === "observed" && p.change === null));
  assert(detail!.memories.every((m) => m.trust === "ingested"));
  assertEquals(detail?.sections.map((s) => s.title), [
    "Onboarding",
    "Onboarding › Testing",
    "Onboarding › Deploy",
  ]);

  // The same document again is refused; a changed one supersedes.
  await assertRejects(
    () =>
      ingestAll(service, {
        kind: "paste",
        title: "Onboarding guide",
        text: GUIDE,
        subject: { kind: "org" },
      }, "u-admin"),
    MemoryRefusedError,
    "already on record",
  );
  const again = await ingestAll(service, {
    kind: "paste",
    title: "Onboarding guide",
    text: GUIDE.replace(
      "Deploys go through deno task release:push. Never on Fridays.",
      "Deploys go through deno task release:push.",
    ),
    subject: { kind: "repo", url: "github.com/acme/app" },
  }, "u-admin");
  assertEquals(again.source.supersedesSourceId, out.source.id);
  // The old source's Friday preference was held, never a memory; the two promoted claims are
  // re-proposed (dedupe confirms them), and the new pointer supersedes the old one.
  assertEquals(again.stats.retired, 0);
  const newPointer = again.proposals.find((p) => p.kind === "pointer")!;
  const oldPointer = detail!.memories.find((m) => m.kind === "pointer")!;
  assertEquals(newPointer.supersedes, oldPointer.id);
  await service.consolidate();
  assertEquals((await store.getMemory(oldPointer.id))?.status, "retired");
  assertEquals(
    (await store.getMemory(detail!.memories.find((m) => m.kind === "procedure")!.id))
      ?.confirmations,
    1,
  );
});

test("re-ingest retires what the new extraction no longer says", async () => {
  const model = extractor({
    "Part 1": [{ text: "Claim A.", kind: "fact", subject: "org" }, {
      text: "Claim B.",
      kind: "fact",
      subject: "org",
    }],
  });
  const { store, service } = makeService(model);
  const first = await ingestAll(service, {
    kind: "paste",
    title: "Notes",
    text: "one",
    subject: { kind: "org" },
  }, "u");
  await service.consolidate();
  assertEquals((await service.getSource(first.source.id))?.memories.length, 3);
  // The second version says only A.
  const modelB = extractor({ "Part 1": [{ text: "Claim A.", kind: "fact", subject: "org" }] });
  const second = makeMemoryService({
    store,
    now: fakeClock().now,
    diag: silent,
    mintId: countingMinter(),
    model: modelB,
    hash: fakeHash,
  });
  const again = await ingestAll(second, {
    kind: "paste",
    title: "Notes",
    text: "two",
    subject: { kind: "org" },
  }, "u");
  assertEquals(again.stats.retired, 1);
  const b = [...store.memories.values()].find((m) => m.text === "Claim B.")!;
  assertEquals(b.status, "retired");
  assertEquals(
    store.feedback.some((f) =>
      f.kind === "sweep" && f.reason === "source-superseded" && f.memoryId === b.id
    ),
    true,
  );
});

test("ingest without a model: the source and a pointer proposal, and it says so", async () => {
  const { service } = makeService(null);
  const out = await ingestAll(service, {
    kind: "url",
    locator: "https://docs.example/guide",
    subject: { kind: "org" },
  }, "u");
  assertEquals(out.source.title, "Fetched guide");
  assertEquals(out.source.locator, "https://docs.example/guide");
  assertEquals(out.stats.modelBacked, false);
  assertEquals(out.proposals.map((p) => p.kind), ["pointer"]);
  await assertRejects(
    () =>
      ingestAll(service, {
        kind: "url",
        locator: "https://docs.example/private",
        subject: { kind: "org" },
      }, "u"),
    MemoryRefusedError,
    "nope",
  );
  await assertRejects(
    () =>
      ingestAll(service, { kind: "repo-file", locator: "x@y:z", subject: { kind: "org" } }, "u"),
    MemoryRefusedError,
    "cannot be fetched here",
  );
  await assertRejects(
    () =>
      ingestAll(service, {
        kind: "paste",
        title: "T",
        text: "token AKIAIOSFODNN7EXAMPLE",
        subject: { kind: "org" },
      }, "u"),
    MemoryRefusedError,
    "credential",
  );
});

test("doc serves the document behind a pointer to a run in scope, whole or by section", async () => {
  const { store, service } = makeService(null);
  const out = await ingestAll(service, {
    kind: "paste",
    title: "Onboarding guide",
    text: GUIDE,
    subject: { kind: "repo", url: "github.com/acme/app" },
  }, "u");
  await service.consolidate();
  const pointer = (await service.getSource(out.source.id))!.memories[0];
  const scope = { agentId: "a-1", repos: ["github.com/acme/app"] };
  const whole = await service.docInScope(scope, pointer.id);
  assertStringIncludes(whole!, "# Onboarding guide\n\n# Onboarding");
  const section = await service.docInScope(scope, out.source.id, "Deploy");
  assertEquals(
    section,
    "# Onboarding guide › Onboarding › Deploy\n\nDeploys go through deno task release:push. Never on Fridays.",
  );
  assertEquals(await service.docInScope(scope, out.source.id, "Nope"), null);
  // Another repo's run sees neither the pointer nor the source.
  const other = { agentId: "a-1", repos: ["github.com/acme/other"] };
  assertEquals(await service.docInScope(other, pointer.id), null);
  assertEquals(await service.docInScope(other, out.source.id), null);
  // A memory that is not a pointer has no document.
  await store.insertMemory(memory({ id: "mem-plain" }));
  assertEquals(await service.docInScope(scope, "mem-plain"), null);
});

test("withdrawing a source rejects its batch, retires its memories, keeps the pinned, frees the text", async () => {
  const { store, service } = makeService(
    extractor({
      "Onboarding": [],
      "Onboarding › Testing": [
        { text: "App tests are vitest.", kind: "fact", subject: "org", excerpt: "vitest" },
        { text: "Tests live in package.json.", kind: "fact", subject: "org", excerpt: "scripts" },
      ],
      "Onboarding › Deploy": [
        { text: "Never deploy on Fridays.", kind: "procedure", subject: "org", excerpt: "Fridays" },
      ],
    }),
  );
  const out = await ingestAll(service, {
    kind: "paste",
    title: "Wrong title",
    text: GUIDE,
    subject: { kind: "org" },
  }, "u-1");
  const [vitest, scripts, fridays, pointer] = out.proposals;
  assertEquals(pointer.kind, "pointer");
  const promoted = await service.acceptProposal(vitest.id, "u-1");
  assert(promoted !== null);
  const pinned = await service.acceptProposal(fridays.id, "u-1");
  assert(pinned !== null);
  await service.setPinned(pinned.id, true, "u-1");
  const doc = await service.acceptProposal(pointer.id, "u-1");
  assert(doc !== null);

  assertEquals(await service.withdrawSource("src-nope", "u-2"), null);
  assertEquals(await service.withdrawSource(out.source.id, "u-2"), {
    sourceId: out.source.id,
    rejected: 1,
    retired: 2,
    kept: 1,
  });
  assertEquals((await store.getProposal(scripts.id))?.resolution, { reason: "source withdrawn" });
  assertEquals((await store.getMemory(promoted.id))?.status, "retired");
  assertEquals((await store.getMemory(doc.id))?.status, "retired");
  assertEquals((await store.getMemory(pinned.id))?.status, "canon");
  assertEquals(await service.listSources(), []);
  assertEquals(await service.getSource(out.source.id), null);
  const scope = { agentId: "a-1", repos: [] };
  assertEquals(await service.docInScope(scope, out.source.id), null);

  // The hash guard forgot it: the same text comes back under the right title, on its own.
  const again = await ingestAll(service, {
    kind: "paste",
    title: "Onboarding guide",
    text: GUIDE,
    subject: { kind: "org" },
  }, "u-1");
  assertEquals(again.source.supersedesSourceId, null);
  assertEquals(again.stats.retired, 0);
  assertEquals((await service.listSources()).map((s) => s.title), ["Onboarding guide"]);
});

test("moving a source puts its batch, its memories and its default under another subject", async () => {
  const { store, service } = makeService(
    extractor({
      "Onboarding": [],
      "Onboarding › Testing": [
        { text: "App tests are vitest.", kind: "fact", subject: "org", excerpt: "vitest" },
      ],
      "Onboarding › Deploy": [
        { text: "Never deploy on Fridays.", kind: "procedure", subject: "org", excerpt: "F" },
      ],
    }),
  );
  const out = await ingestAll(
    service,
    { kind: "paste", title: "Guide", text: GUIDE, subject: { kind: "org" } },
    "u-1",
  );
  const [vitest, fridays, pointer] = out.proposals;
  const promoted = await service.acceptProposal(vitest.id, "u-1");
  assert(promoted !== null);
  await service.setPinned(promoted.id, true, "u-1");
  const repo = { kind: "repo" as const, url: "github.com/acme/app" };
  assertEquals(await service.moveSource("src-nope", repo, "u-2"), null);
  assertEquals(await service.moveSource(out.source.id, repo, "u-2"), {
    sourceId: out.source.id,
    subject: repo,
    proposals: 2,
    memories: 1,
  });
  assertEquals((await store.getProposal(fridays.id))?.subject, repo);
  assertEquals((await store.getProposal(pointer.id))?.subject, repo);
  assertEquals((await store.getMemory(promoted.id))?.subject, repo);
  assertEquals((await store.getMemory(promoted.id))?.trust, "pinned");
  assertEquals((await store.getSource(out.source.id))?.defaultSubject, repo);
  const feedback = await store.listFeedbackForMemory(promoted.id);
  assert(feedback.some((f) => f.kind === "human" && f.action === "edit" && f.userId === "u-2"));
});

test("withdrawing a source unlinks the source that superseded it", async () => {
  const { store, service } = makeService(null);
  const first = await ingestAll(service, {
    kind: "paste",
    title: "Guide",
    text: GUIDE,
    subject: { kind: "org" },
  }, "u-1");
  const second = await ingestAll(service, {
    kind: "paste",
    title: "Guide",
    text: GUIDE + "\nMore.\n",
    subject: { kind: "org" },
  }, "u-1");
  assertEquals(second.source.supersedesSourceId, first.source.id);
  assert(await service.withdrawSource(first.source.id, "u-2"));
  assertEquals((await store.getSource(second.source.id))?.supersedesSourceId, null);
});

test("routes: ingest is admins-only, sources list without their text, detail has everything", async () => {
  const { handle } = makeApi();
  const body = { kind: "paste", title: "Guide", text: GUIDE, subject: { kind: "org" } };
  assertEquals((await call(handle, "POST", "/v1/memory/sources", body, PLAIN)).status, 403);
  const created = await call(handle, "POST", "/v1/memory/sources", body, ADMIN);
  assertEquals(created.status, 202);
  const out = await created.json();
  assertEquals(out.proposals, undefined);
  assertEquals(out.source.status, "ingesting");
  const ready = await untilReady(handle, out.source.id);
  assertEquals(ready.status, "ready");
  assertEquals(ready.extraction, {
    sections: 3,
    extracted: 0,
    failed: 0,
    retired: 0,
    skipped: 0,
    modelBacked: false,
  });

  const bad = await call(handle, "POST", "/v1/memory/sources", { kind: "url", text: "x" }, ADMIN);
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  const dup = await call(handle, "POST", "/v1/memory/sources", body, ADMIN);
  assertEquals(dup.status, 400);
  assertStringIncludes((await dup.json()).error, "already on record");

  const listed = await (await call(handle, "GET", "/v1/memory/sources", undefined, PLAIN)).json();
  assertEquals(listed.sources.length, 1);
  assertEquals(listed.sources[0].text, undefined);
  assertEquals(listed.sources[0].chars, GUIDE.trim().length);
  const detail =
    await (await call(handle, "GET", `/v1/memory/sources/${out.source.id}`, undefined, PLAIN))
      .json();
  assertEquals(detail.source.text, GUIDE.trim());
  assertEquals(detail.sections.length, 3);
  assertEquals(detail.proposals.length, 1);
  assertEquals(
    (await call(handle, "GET", "/v1/memory/sources/src-nope", undefined, PLAIN)).status,
    404,
  );
  const batch = await (await call(
    handle,
    "GET",
    `/v1/memory-proposals?source=${out.source.id}`,
    undefined,
    PLAIN,
  )).json();
  assertEquals(batch.proposals.length, 1);

  const move = `/v1/memory/sources/${out.source.id}/move`;
  const to = { subject: { kind: "repo", url: "https://github.com/Acme/App.git" } };
  assertEquals((await call(handle, "POST", move, to, PLAIN)).status, 403);
  assertEquals((await call(handle, "POST", move, { subject: { kind: "x" } }, ADMIN)).status, 400);
  assertEquals(
    (await call(handle, "POST", "/v1/memory/sources/src-nope/move", to, ADMIN)).status,
    404,
  );
  const moved = await call(handle, "POST", move, to, ADMIN);
  assertEquals(moved.status, 200);
  assertEquals(await moved.json(), {
    sourceId: out.source.id,
    subject: { kind: "repo", url: "github.com/acme/app" },
    proposals: 1,
    memories: 0,
  });

  const withdraw = `/v1/memory/sources/${out.source.id}/withdraw`;
  assertEquals((await call(handle, "POST", withdraw, undefined, PLAIN)).status, 403);
  assertEquals(
    (await call(handle, "POST", "/v1/memory/sources/src-nope/withdraw", undefined, ADMIN)).status,
    404,
  );
  const withdrawn = await call(handle, "POST", withdraw, undefined, ADMIN);
  assertEquals(withdrawn.status, 200);
  assertEquals(await withdrawn.json(), {
    sourceId: out.source.id,
    rejected: 1,
    retired: 0,
    kept: 0,
  });
  assertEquals(
    (await call(handle, "GET", `/v1/memory/sources/${out.source.id}`, undefined, PLAIN)).status,
    404,
  );
  const again = await call(handle, "POST", "/v1/memory/sources", body, ADMIN);
  assertEquals(again.status, 202);
  await untilReady(handle, (await again.json()).source.id);
});

/** The source as the detail route shows it once the extraction behind an ingest has landed. */
async function untilReady(handle: Parameters<typeof call>[0], id: string) {
  for (let i = 0; i < 200; i += 1) {
    const detail = await (await call(handle, "GET", `/v1/memory/sources/${id}`, undefined, PLAIN))
      .json();
    if (detail.source.status !== "ingesting") return detail.source;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`source ${id} never left ingesting`);
}

test("ingest answers at once, ingesting; the batch and the stats land behind the answer", async () => {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const model: ModelClient = {
    complete: async (req) => {
      await gate;
      const section = req.prompt.match(/^Section: (.+)$/m)?.[1] ?? "";
      return section === "Onboarding › Deploy"
        ? JSON.stringify({
          claims: [{ text: "Never on Fridays.", kind: "procedure", subject: "org", excerpt: "F" }],
        })
        : JSON.stringify({ claims: [] });
    },
  };
  const { store, service } = makeService(model);
  const started = await service.ingest(
    { kind: "paste", title: "Guide", text: GUIDE, subject: { kind: "org" } },
    "u-1",
  );
  assertEquals(started.source.status, "ingesting");
  assertEquals((await service.listSources())[0].status, "ingesting");
  assertEquals((await store.listProposals({ tenantId: "default", limit: 10 })).length, 0);
  release();
  const out = await started.done;
  assertEquals(out.source.status, "ready");
  assertEquals(out.source.extraction, {
    sections: 3,
    extracted: 1,
    failed: 0,
    retired: 0,
    skipped: 0,
    modelBacked: true,
  });
  assertEquals(out.proposals.map((p) => p.kind), ["procedure", "pointer"]);
  assertEquals((await service.getSource(started.source.id))?.source.status, "ready");
});

test("withdrawing a source while it is ingesting stops the extraction under it", async () => {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const model: ModelClient = {
    complete: async () => {
      await gate;
      return JSON.stringify({
        claims: [{ text: "A claim.", kind: "fact", subject: "org", excerpt: "x" }],
      });
    },
  };
  const { store, service } = makeService(model);
  const started = await service.ingest(
    { kind: "paste", title: "Guide", text: GUIDE, subject: { kind: "org" } },
    "u-1",
  );
  assertEquals(await service.withdrawSource(started.source.id, "u-2"), {
    sourceId: started.source.id,
    rejected: 0,
    retired: 0,
    kept: 0,
  });
  release();
  const out = await started.done;
  assertEquals(out.source.status, "failed");
  assertEquals(out.source.failure, "withdrawn while ingesting");
  assertEquals(await store.listProposals({ tenantId: "default", limit: 10 }), []);
  assertEquals(await service.listSources(), []);
});

test("an extraction that cannot finish leaves the source failed with the reason", async () => {
  const store = memoryStore();
  const broken = { ...store, insertProposal: () => Promise.reject(new Error("db down")) };
  const { service } = makeService(null, broken);
  const out = await ingestAll(
    service,
    { kind: "paste", title: "Guide", text: GUIDE, subject: { kind: "org" } },
    "u-1",
  );
  assertEquals(out.source.status, "failed");
  assertEquals(out.source.failure, "db down");
  assertEquals(out.proposals, []);
  assertEquals((await store.getSource(out.source.id))?.status, "failed");
});

test("recovery at boot marks an extraction a restart cut short as failed", async () => {
  const { store, service } = makeService(null);
  await store.insertSource(source({ id: "src-cut", status: "ingesting" }));
  await store.insertSource(source({ id: "src-ok", status: "ready", contentHash: "h2" }));
  assertEquals(await service.recoverIngests(), 1);
  assertEquals((await store.getSource("src-cut"))?.status, "failed");
  assertEquals(
    (await store.getSource("src-cut"))?.failure,
    "the extraction was interrupted by a restart",
  );
  assertEquals((await store.getSource("src-ok"))?.status, "ready");
  assertEquals(await service.recoverIngests(), 0);
});

test("a document whose extraction failed can be ingested again: the failed record is withdrawn", async () => {
  const { store, service } = makeService(null);
  const text = GUIDE.trim();
  await store.insertSource(
    source({
      id: "src-failed",
      status: "failed",
      failure: "the extraction was interrupted by a restart",
      title: "Guide",
      contentHash: await fakeHash(text),
      text,
    }),
  );
  await store.insertProposal({
    id: "prop-stale",
    tenantId: "default",
    text: "Half of a batch",
    kind: "fact",
    subject: { kind: "org" },
    audience: { kind: "all" },
    evidence: null,
    origin: { kind: "source", sourceId: "src-failed", section: null },
    supersedes: null,
    basis: "observed",
    changeId: null,
    status: "pending",
    resolution: null,
    flags: [],
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  const out = await ingestAll(service, {
    kind: "paste",
    title: "Guide",
    text,
    subject: { kind: "org" },
  }, "u-1");
  assertEquals(out.source.status, "ready");
  assertEquals(await store.getSource("src-failed"), null);
  assertEquals((await store.getProposal("prop-stale"))?.status, "rejected");
  // A record that is READY is still the document, and the same text is refused.
  await assertRejects(
    () =>
      service.ingest({ kind: "paste", title: "Guide 2", text, subject: { kind: "org" } }, "u-1"),
    MemoryRefusedError,
    "already on record",
  );
});

test("the extractor reads a bounded number of sections and says how many it skipped", async () => {
  const { MAX_EXTRACT_SECTIONS } = await import("../src/core/service.ts");
  const sections = Array.from(
    { length: MAX_EXTRACT_SECTIONS + 5 },
    (_, i) => `## S${i}\n\nBody ${i}.`,
  );
  const { service } = makeService(extractor({}));
  const out = await ingestAll(
    service,
    { kind: "paste", title: "Long", text: sections.join("\n\n"), subject: { kind: "org" } },
    "u-1",
  );
  assertEquals(out.stats.sections, MAX_EXTRACT_SECTIONS + 5);
  assertEquals(out.stats.skipped, 5);
  assertEquals(out.stats.failed, MAX_EXTRACT_SECTIONS);
});
