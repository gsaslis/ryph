// The Radicle half of the control plane, end to end through the HTTP surface: connecting a
// repository (delegates only, private repositories refused with the command that fixes them),
// who may command an agent, and a change request's fate settling the patch that opened it.
// Proving a DID is @ryph/auth's flow — its routes are tested there, and the verifier that
// backs them in sshsig_test.ts.
//
// No node and no `rad` anywhere — the boundary is a fake `Forge`, exactly as every GitHub test
// here uses the noop one.

import { test } from "bun:test";
import { capsClaimOf, type Role } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import type {
  Forge,
  ForgePermission,
  PatchSubmission,
  RadicleConnect,
  RadicleRepoInfo,
} from "../src/ports/forge.ts";
import {
  DEFAULT_PATCH_SUBMIT_CONFIG,
  markSubmitted,
  markSubmitting,
  openPatch,
} from "../src/core/patch_lifecycle.ts";
import { sweepPatches } from "../src/core/reaper.ts";
import { reconcileMergeSettles } from "../src/core/merge_settle.ts";
import type { PatchPayload, Run, Task } from "../src/core/types.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const OURS = "did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";
const THEM = "did:key:z6MktaNvN1tMt1Nkm5gNomgQsjqR3nrPtAVSt58BJgmv5J3z";
const COB = "a".repeat(40);
const GATEWAY = { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 };

const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
} as const;

function identityDoc(over: Partial<RadicleRepoInfo> = {}): RadicleRepoInfo {
  return {
    rid: RID,
    name: "payments",
    description: "the payments service",
    defaultBranch: "main",
    delegates: [THEM],
    threshold: 1,
    visibility: "public",
    allow: [],
    self: { did: OURS, nid: "z6Mkire", alias: "ryph" },
    isDelegate: false,
    isAllowed: true,
    ...over,
  };
}

/**
 * `checkPermission` as the Radicle adapter answers it, so a test about the orchestrator's use
 * of the two tiers is about something. `admin` is delegacy. `write` is NOT a claim about the
 * subject at all on a public repository — contribution is permissionless and everyone writes
 * to their own namespace — and is the allow list on a private one. The NULL subject the
 * orchestrator passes for an unlinked caller is answered here exactly as the adapter answers
 * it: on visibility alone, which is what makes the public case pass and the private one fail.
 *
 * `doc` may be `"unknown"` — the node not answering — because the third verdict is a real one
 * and a fake that could only say allowed-or-denied would let a caller that mishandles it pass.
 *
 * The verdict for a repo on ANOTHER forge is a required argument, never a default: this fake
 * knows nothing about GitHub, and quietly answering "allowed" there would turn the permission
 * gate into a no-op in any mixed-forge test that reached for it — a test that reads like it
 * proves GitHub is still gated while proving nothing at all.
 */
function radiclePermissions(
  doc: RadicleRepoInfo | "unknown",
  otherForge: ForgePermission,
): Forge["checkPermission"] {
  return (repo, identity, atLeast) => {
    // Per forge, as the real boundary is: an identity linked on one says nothing on another.
    if (identity.provider !== repo.provider) return Promise.resolve("denied" as ForgePermission);
    if (repo.provider !== "radicle") return Promise.resolve(otherForge);
    if (doc === "unknown") return Promise.resolve("unknown" as ForgePermission);
    // A null subject is nobody, so it is in neither set — but the public `write` branch below
    // never looks, which is the whole point of the tier.
    const inSet = (dids: string[]) => identity.subject !== null && dids.includes(identity.subject);
    if (atLeast === "admin") return Promise.resolve(inSet(doc.delegates) ? "allowed" : "denied");
    if (doc.visibility === "public") return Promise.resolve("allowed");
    return Promise.resolve(
      inSet(doc.delegates) || inSet(doc.allow) ? "allowed" : "denied",
    );
  };
}

function buildApp(
  opts: {
    permission?: ForgePermission;
    radicleRepo?: RadicleRepoInfo | null;
    /** Overrides the whole boundary — for the tests about it being unreachable. */
    radicleConnect?: RadicleConnect;
    /** Replaces the noop's flat verdict, for the tests that are about the TIERS meaning
     * different things on Radicle. */
    checkPermission?: Forge["checkPermission"];
    /** The ryph platform role the caller holds. "admin" is what governs ryph-side
     * administration of a Radicle repo, which delegacy does not. */
    role?: Role;
    /** How the bridge acts: a deployment's own node by default, or one person's (user mode). */
    radicleMode?: "deployment" | "user";
    radicleBlocked?: boolean;
  } = {},
) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const noop = noopForge(silentDiagnostics(), {
    permission: opts.permission ?? "allowed",
    radicleRepo: opts.radicleRepo === undefined ? identityDoc() : opts.radicleRepo,
    radicle: { mode: opts.radicleMode ?? "deployment" },
    radicleBlocked: opts.radicleBlocked,
  });
  // The recorded arrays are the same objects after the spread, so `app.forge.seeded` still
  // sees what the wired boundary did.
  const forge = opts.checkPermission ? { ...noop, checkPermission: opts.checkPermission } : noop;
  const deps = {
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: (() =>
      Promise.resolve({
        ...USER,
        caps: capsClaimOf(opts.role ?? "member"),
      })) as unknown as Authenticate,
    forgeToken: "forge-service-token",
    forge: forge as Forge,
    githubConnect: forge,
    radicleConnect: opts.radicleConnect ?? forge,
    identityDirectory: identities.directory,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: GATEWAY,
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: {
        webServerId: "ms-platform-web",
        web: false,
        forge: null,
        pending: false,
      },
    },
  };
  return { handler: makeHandler(deps), deps, store, clock, launches, forge, identities };
}

type Handler = (req: Request) => Promise<Response>;
const call = (
  handler: Handler,
  method: string,
  path: string,
  body?: unknown,
  token = "t",
) =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const post = (h: Handler, path: string, body: unknown = {}, token = "t") =>
  call(h, "POST", path, body, token);
const get = (h: Handler, path: string) => call(h, "GET", path, undefined);

/** Links `did` for the caller without going through the signature flow — the state, not the
 * ceremony, which is @ryph/auth's and is tested there. */
function link(app: ReturnType<typeof buildApp>, did: string) {
  app.identities.link(USER.userId, did, "radicle");
  return Promise.resolve();
}

const connect = (app: ReturnType<typeof buildApp>, over: Record<string, unknown> = {}) =>
  post(app.handler, "/v1/connected-repos", { provider: "radicle", repoRef: RID, ...over });

// ---- the connect flow --------------------------------------------------------------------

test("a delegate connects a Radicle repo: no installation, seeded, coordinates from the document", async () => {
  const app = buildApp();
  await link(app, THEM); // a delegate of the fixture document

  const res = await connect(app);
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.repo.provider, "radicle");
  assertEquals(body.repo.repoRef, RID);
  // No tenant at all: every write is signed by this deployment's own key.
  assertEquals(body.repo.installationId, null);
  // THE RID, as the row's address. `url` is what the platform hands the forge to read the
  // repository with — the services-file read among them, whose schema rejects "" — and the
  // fetchable git address is still derived from `repoRef` by the forge. Whether a `rad:z…`
  // renders as a hyperlink is the app's question, answered once in `isWebLink`.
  assertEquals(body.repo.url, RID);
  assertEquals(body.repo.defaultBranch, "main");
  // Seeded with scope `all` — without it a stranger's /ryph comment never arrives.
  assertEquals(app.forge.seeded, [RID]);

  // The answer carries what the connect page has to show: who ryph is, who may write, and the
  // line a maintainer pastes to SEE ryph's work at all.
  assertEquals(body.radicle.did, OURS);
  assertEquals(body.radicle.nid, "z6Mkire");
  assertEquals(body.radicle.delegates, [THEM]);
  assertEquals(body.radicle.isDelegate, false);
  assertEquals(body.radicle.visibility, "public");
  assertEquals(body.radicle.followCommands.inWorkingCopy, `rad remote add ${OURS} --sync`);
  assertEquals(body.radicle.followCommands.anywhere, `rad follow ${OURS} --alias ryph`);
});

test("in user mode connecting needs repos:manage-all, asked before the node is", async () => {
  // A delegate with no ryph role: enough beside a deployment's bridge, not beside one that signs
  // as the binary's owner. Refused without a seed — the node never hears the RID.
  const member = buildApp({ radicleMode: "user" });
  await link(member, THEM);
  const refused = await connect(member);
  assertEquals(refused.status, 403);
  assertStringIncludes((await refused.json()).error, "repos:manage-all");
  assertEquals(member.forge.seeded, []);

  const admin = buildApp({ radicleMode: "user", role: "owner" });
  assertEquals((await connect(admin)).status, 201);
  assertEquals(admin.forge.seeded, [RID]);

  // A forge that will not say how its bridge acts is no answer: refused, still unseeded.
  const silent = buildApp({ radicleMode: "user", role: "owner" });
  silent.deps.forge = {
    ...silent.deps.forge,
    providers: () => Promise.reject(new Error("forge down")),
  };
  assertEquals(
    (await post(makeHandler(silent.deps), "/v1/connected-repos", {
      provider: "radicle",
      repoRef: RID,
    })).status,
    502,
  );
  assertEquals(silent.forge.seeded, []);
});

test("a repository the owner's node blocks is a 409 that says how to lift it, and nothing is undone", async () => {
  const app = buildApp({ radicleMode: "user", role: "owner", radicleBlocked: true });
  const res = await connect(app);
  assertEquals(res.status, 409);
  const body = await res.json();
  assertStringIncludes(body.error, "blocks");
  assertEquals(body.command, `rad unblock ${RID}`);
  assertEquals(app.forge.unseeded, []);
  assertEquals((await app.store.listConnectedRepos()).length, 0);
});

test("a body with no installation is what a Radicle connect sends, and a GitHub one still needs its own", async () => {
  const app = buildApp();
  await link(app, THEM);
  assertEquals((await connect(app)).status, 201);

  // The mirror image: an installation id on a Radicle body names a tenant Radicle does not
  // have, and is refused rather than quietly stored.
  const app2 = buildApp();
  await link(app2, THEM);
  const strayTenant = await connect(app2, { repoRef: RID, installationId: "42" });
  assertEquals(strayTenant.status, 400);

  const noTenant = await post(app2.handler, "/v1/connected-repos", {
    provider: "github",
    repoRef: "acme/app",
  });
  assertEquals(noTenant.status, 400);
});

test("a plain user who is not a delegate cannot connect, and neither can one with no linked identity", async () => {
  const app = buildApp({ permission: "denied" });
  await link(app, OURS);
  const refused = await connect(app);
  assertEquals(refused.status, 403);
  const body = await refused.json();
  // The CODE the connect page switches on, unchanged — the detail now says the whole rule,
  // which has two ways through it.
  assertEquals(body.error, "not_delegate");
  assertStringIncludes(body.detail, "is not a delegate");
  assertStringIncludes(body.detail, "not a ryph admin");
  // The seed is undone: nothing connected, nothing held.
  assertEquals(app.forge.unseeded, [RID]);

  const unlinked = buildApp();
  const res = await connect(unlinked);
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error, "not_delegate");
  assertEquals(unlinked.forge.seeded, [], "nothing was seeded for a caller with no DID");
});

test("a refused connect leaves the seed alone when another connect of the repo landed meanwhile", async () => {
  // A delegate's connect and a non-delegate's race: both pass the "already connected?" check,
  // the delegate's row lands, and the refused one must not unseed what that row now relies on.
  const app = buildApp({ permission: "denied" });
  await link(app, OURS);
  const store = app.deps.store;
  let asked = 0;
  const original = store.listConnectedRepos.bind(store);
  store.listConnectedRepos = async () => {
    // The first look (the duplicate check) sees nothing; by the second the other has landed.
    if (asked++ === 0) return [];
    return [{
      id: "cr-other",
      provider: "radicle",
      installationId: null,
      repoRef: RID,
      url: RID,
      defaultBranch: "main",
      submissionPolicy: "require-approval",
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    }, ...(await original())];
  };
  const refused = await connect({ ...app, handler: makeHandler(app.deps) });
  assertEquals(refused.status, 403);
  assertEquals(app.forge.seeded, [RID]);
  assertEquals(app.forge.unseeded, []);
});

// Connecting is a RYPH decision, not a Radicle capability: what it settles is this
// deployment's own behaviour toward the repo — its submission policy, its command allowlist,
// its workspace membership — and Radicle has no opinion about any of that. Seeding and
// reading somebody else's public repository is permissionless and spends nothing but this
// deployment's resources, so the platform's admin role is a second way through, beside
// delegacy.
test("a ryph admin connects a repo they do not delegate, with no Radicle identity at all", async () => {
  const app = buildApp({ role: "owner", permission: "denied" });

  // No DID was ever linked for them — the check they clear is not about their Radicle
  // identity, so "link your Radicle identity first" would be an answer to nothing.
  const res = await connect(app);
  assertEquals(res.status, 201);
  assertEquals((await res.json()).repo.repoRef, RID);
  assertEquals(app.forge.seeded, [RID]);
  // Nothing was refused, so nothing is unseeded: the node goes on holding what it connected.
  assertEquals(app.forge.unseeded, []);
});

test("a delegate with no ryph role still connects — a team runs its own repos", async () => {
  const doc = identityDoc();
  const app = buildApp({
    role: "member",
    radicleRepo: doc,
    checkPermission: radiclePermissions(doc, "denied"),
  });
  await link(app, THEM); // a delegate of the fixture document, and nothing more

  assertEquals((await connect(app)).status, 201);
  assertEquals(app.forge.unseeded, []);

  // And the same forge, the same repo, a stranger who is neither: still refused.
  const stranger = buildApp({
    role: "member",
    radicleRepo: doc,
    checkPermission: radiclePermissions(doc, "denied"),
  });
  await link(stranger, OURS);
  const refused = await connect(stranger);
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).error, "not_delegate");
  assertEquals(stranger.forge.unseeded, [RID]);
});

// `write` on Radicle is not a claim about anybody: contribution is permissionless and every
// contributor writes to their own namespace, so the adapter answers a public repo on
// visibility alone and ignores the subject. Demanding a linked DID before asking a question
// whose answer does not turn on one would be friction that refuses the very case the rule is
// for. A private repo, where the allow list IS the answer, still refuses the unlinked caller.
test("an unlinked user launches a task on a PUBLIC Radicle repo, and cannot on a private one", async () => {
  const startTask = async (doc: RadicleRepoInfo) => {
    const app = buildApp({
      role: "owner",
      radicleRepo: doc,
      checkPermission: radiclePermissions(doc, "denied"),
    });
    // Connected by a ryph admin, who needs no DID for it.
    const repo = (await (await connect(app)).json()).repo;
    const agent = await (await post(app.handler, "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "echo",
    })).json();
    // From here on, a plain user with nothing linked — the whole point of the case.
    const plain = makeHandler({
      ...app.deps,
      authenticate: (() =>
        Promise.resolve({
          ...USER,
          userId: "u-2",
          caps: capsClaimOf("member"),
        })) as unknown as Authenticate,
    });
    return await post(plain, "/v1/tasks", {
      agentId: agent.id,
      connectedRepoId: repo.id,
      spec: { title: "Fix the flaky test", instructions: "Find and fix it." },
    });
  };

  const open = await startTask(identityDoc());
  assertEquals(open.status, 201, await open.text());

  const closed = await startTask(
    identityDoc({ visibility: "private", allow: [THEM], isAllowed: true }),
  );
  assertEquals(closed.status, 403);
  // Not "link your account first" fired before anybody was asked — the forge was asked, and
  // the allow list is what said no.
  assertStringIncludes((await closed.json()).error, "not open to everyone");
});

test("a private repo ryph may not fetch is a 409 carrying the command that fixes it", async () => {
  const app = buildApp({
    radicleRepo: identityDoc({ visibility: "private", allow: [THEM], isAllowed: false }),
  });
  await link(app, THEM);
  const res = await connect(app);
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, "not_allowed");
  assertEquals(body.did, OURS);
  // Verified against `rad id update --help` (rad 1.10): `--allow <DID>`.
  assertEquals(body.command, `rad id update --allow ${OURS}`);
  assertEquals(app.forge.unseeded, [RID], "a repo we cannot read is not left seeded");
});

// The design gap the first live network test found. A private repository refuses the whole
// fetch at the responding node — heartwood's own golden for it prints "an I/O error occurred
// during the fetch handshake (connection reset)" — and is kept out of every inventory
// announcement, so a node that is not on its allow list sees exactly what it sees for a
// repository nobody has. Answering "not found" there told a maintainer to check their id when
// the real answer was a command only they could run.
test("a RID the network handed nothing back for is a 409 carrying the command anyway", async () => {
  const missing = buildApp({ radicleRepo: null });
  await link(missing, THEM);
  const gone = await connect(missing);
  assertEquals(gone.status, 409);
  const body = await gone.json();
  assertEquals(body.error, "not_allowed");
  assertEquals(body.did, OURS);
  assertEquals(body.command, `rad id update --allow ${OURS}`);
  // Both readings, because from here they are one answer.
  assertStringIncludes(body.detail, "private");
  assertStringIncludes(body.detail, "no peer is offering that id");
  assertEquals(missing.forge.unseeded, [RID], "a repo we could not read is not left seeded");

  // A claimant that was actually ASKED and said no: that, and only that, is "somebody who has
  // it refused us", which is what a private repository does.
  const unavailable = (over: { seeds: number; triedSeeds: number }) => ({
    radicleIdentity: () => Promise.reject(new Error("not asked")),
    describeRadicleRepo: () => Promise.resolve(null),
    seedRadicleRepo: (repoRef: string) =>
      Promise.resolve({
        kind: "unavailable" as const,
        rid: repoRef,
        did: OURS,
        command: `rad id update --allow ${OURS}`,
        reason: "no peer served it",
        ...over,
      }),
    unseedRadicleRepo: () => Promise.resolve(),
  });

  const offering = buildApp({ radicleConnect: unavailable({ seeds: 2, triedSeeds: 2 }) });
  await link(offering, THEM);
  const refused = await connect(offering);
  assertEquals(refused.status, 409);
  const sharp = await refused.json();
  assertStringIncludes(sharp.detail, "Every peer that claims to hold it refused the fetch");
  assertEquals(sharp.command, `rad id update --allow ${OURS}`);

  // THE LIVE BUG. The routing table claimed two seeds and ryph's node was connected to
  // NEITHER, so nothing that has the repository refused anything — it was never asked. Reading
  // the routing count as evidence told the owner of a public repository that it was private.
  const unasked = buildApp({ radicleConnect: unavailable({ seeds: 2, triedSeeds: 0 }) });
  await link(unasked, THEM);
  const notAsked = await (await connect(unasked)).json();
  assertStringIncludes(notAsked.detail, "not connected to any of them");
  assertEquals(
    notAsked.detail.includes("refused the fetch"),
    false,
    "nothing that holds it refused anything: it was never asked",
  );
});

test("an unreachable node is a 502", async () => {
  const base = buildApp();
  const dead: RadicleConnect = {
    radicleIdentity: () => Promise.reject(new Error("no bridge")),
    describeRadicleRepo: () => Promise.reject(new Error("no bridge")),
    seedRadicleRepo: () => Promise.reject(new Error("no bridge")),
    unseedRadicleRepo: () => Promise.resolve(),
  };
  const app = buildApp({ radicleConnect: dead });
  await link(app, THEM);
  const res = await connect(app);
  assertEquals(res.status, 502);
  assertEquals((await res.json()).error, "radicle_unreachable");
  assertEquals(base.forge.seeded, []);
});

test("a repo's document is re-read live, and disconnecting stops seeding it", async () => {
  const app = buildApp();
  await link(app, THEM);
  const repo = (await (await connect(app)).json()).repo;

  const fresh = await get(app.handler, `/v1/connected-repos/${repo.id}/radicle`);
  assertEquals(fresh.status, 200);
  assertEquals((await fresh.json()).delegates, [THEM]);

  assertEquals((await post(app.handler, `/v1/connected-repos/${repo.id}/archive`)).status, 200);
  // Seeding is what makes the node fetch a stranger's namespace every gossip round; a repo
  // nobody connected must not keep costing that.
  assertEquals(app.forge.unseeded, [RID]);
});

test("the providers a repo can be connected through are the boundary's answer, and Radicle reads are 404 without one", async () => {
  const app = buildApp();
  assertEquals((await (await get(app.handler, "/v1/forge-providers")).json()).providers, [
    "github",
    "radicle",
  ]);
  assertEquals((await (await get(app.handler, "/v1/forge-providers")).json()).radicle, {
    mode: "deployment",
  });
  // A user-mode bridge acts as one person, and the connect screens word themselves for it.
  const personal = buildApp({ radicleMode: "user" });
  assertEquals((await (await get(personal.handler, "/v1/forge-providers")).json()).radicle, {
    mode: "user",
  });
  const identity = await (await get(app.handler, "/v1/radicle/identity")).json();
  assertEquals(identity.did, OURS);
  assertEquals(identity.followCommand, `rad remote add ${OURS} --sync`);

  const dark = buildApp();
  const handler = makeHandler({ ...dark.deps, radicleConnect: null });
  assertEquals((await get(handler, "/v1/radicle/identity")).status, 404);
});

// ---- who may command an agent -------------------------------------------------------------

let deliveryCounter = 0;
const command = (over: Record<string, unknown> = {}) => ({
  deliveryId: `rad-delivery-${++deliveryCounter}`,
  kind: "issue_comment.created",
  repo: { provider: "radicle", repoRef: RID, url: RID },
  actorLogin: THEM,
  thread: { kind: "issue", ref: COB },
  body: "/ryph ada fix the flaky test",
  sourceCommentId: `issue:${COB}:${"b".repeat(40)}`,
  receivedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/** A connected Radicle repo and an agent — the world a /ryph command expects. */
async function prepare(app: ReturnType<typeof buildApp>) {
  await link(app, THEM);
  const repo = (await (await connect(app)).json()).repo;
  const agent = await (await post(app.handler, "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
  })).json();
  return { repo, agent };
}

test("a delegate's /ryph starts a run — matched on the RID, exactly", async () => {
  const app = buildApp();
  await prepare(app);
  const res = await post(app.handler, "/v1/forge/events", command(), "forge-service-token");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).outcome, "started");
  assertEquals(app.launches.length, 1);

  // A RID is base58, where case is meaning: a repo whose address differs only in case is a
  // DIFFERENT repository, and must not match.
  const other = await post(
    app.handler,
    "/v1/forge/events",
    command({ repo: { provider: "radicle", repoRef: RID.toLowerCase(), url: RID } }),
    "forge-service-token",
  );
  assertEquals((await other.json()).outcome, "repo-not-connected");
});

test("a run on a Radicle repo reads its services file by the RID, which is its address", async () => {
  // THE REGRESSION. Connecting stored `url = ""` so the app would not render `href="rad:z…"`,
  // and `url` is what the services-file read hands the forge — whose schema requires it
  // non-empty. The 400 came back as "services unavailable", and every `/ryph` on every Radicle
  // repo was refused with a 503 the user saw as nothing at all.
  const app = buildApp();
  const asked: Array<{ repo: unknown; url: string; ref: string }> = [];
  const reading = makeHandler({
    ...app.deps,
    // Services ON: with the feature off the declaration is never fetched and the bug is
    // invisible, which is exactly how it reached a deployment.
    config: { ...app.deps.config, services: { ...DEFAULT_SERVICE_POLICY, enabled: true } },
    forge: {
      ...app.deps.forge,
      readServicesFile(repo: unknown, url: string, ref: string) {
        asked.push({ repo, url, ref });
        return Promise.resolve({ kind: "absent" as const });
      },
    } as unknown as Forge,
  });
  await prepare(app);

  const res = await post(reading, "/v1/forge/events", command(), "forge-service-token");
  assertEquals((await res.json()).outcome, "started");
  assertEquals(asked.length, 1);
  assertEquals(asked[0].url, RID);
  assertEquals(asked[0].ref, "main");
});

test("a refusal is SAID in the Radicle thread, exactly as it is on GitHub", async () => {
  // A refused `/ryph` that says nothing is indistinguishable from a bridge that is down, and
  // the commenter has no way to find out which. The reply is posted through the same boundary
  // for both forges — this pins that the Radicle path is not the exception.
  const app = buildApp();
  const refusing = makeHandler({
    ...app.deps,
    config: { ...app.deps.config, services: { ...DEFAULT_SERVICE_POLICY, enabled: true } },
    forge: {
      ...app.deps.forge,
      readServicesFile() {
        // "We could not ask" — never "the repo declares none", which would start a run whose
        // services are silently absent.
        return Promise.resolve({ kind: "unavailable" as const, detail: "the forge answered 400" });
      },
    } as unknown as Forge,
  });
  await prepare(app);

  const res = await post(refusing, "/v1/forge/events", command(), "forge-service-token");
  assertEquals((await res.json()).outcome, "refused");
  assertEquals(app.launches.length, 0);
  const said = app.forge.comments.at(-1);
  assertEquals(said?.repoRef, RID);
  assertEquals(said?.thread, COB);
  assertStringIncludes(said?.body ?? "", "ryph refused the task");
  assertStringIncludes(said?.body ?? "", "services.yml");
});

test("a non-delegate is silent unless an admin allowlisted them — the command gate is delegacy", async () => {
  const app = buildApp();
  const { repo } = await prepare(app);
  // The repo is connected; from here the boundary answers as the Radicle adapter really does,
  // against a PUBLIC document the commenter is no delegate of — so "write" says yes (nobody's
  // permission is needed to contribute) and "admin" says no. Which is what pins the tier this
  // gate asks for: were it "write", the run below would start and anyone on the network could
  // spend this deployment's budget by typing a comment.
  const strict = makeHandler({
    ...app.deps,
    forge: {
      ...app.forge,
      checkPermission: radiclePermissions(identityDoc({ delegates: [] }), "denied"),
    } as Forge,
  });

  // A stranger: silence, so a drive-by learns nothing.
  const denied = await post(strict, "/v1/forge/events", command(), "forge-service-token");
  assertEquals((await denied.json()).outcome, "denied");
  assertEquals(app.launches.length, 0);

  // The allowlist a delegate keeps, because Radicle has no grantable "write collaborator" tier
  // to borrow. Adding an entry needs admin on the repo, which is asked of the cooperative forge.
  assertEquals(
    (await post(app.handler, `/v1/connected-repos/${repo.id}/command-allowlist`, {
      subject: OURS,
    })).status,
    201,
  );
  const allowed = await post(
    strict,
    "/v1/forge/events",
    command({ actorLogin: OURS }),
    "forge-service-token",
  );
  // Past the permission gate and refused for a different, honest reason: no ryph user stands
  // behind that DID yet. Which is precisely what proves the gate let it through.
  assertEquals((await allowed.json()).outcome, "no-linked-user");

  await link(app, OURS);
  const launched = await post(
    strict,
    "/v1/forge/events",
    command({ actorLogin: OURS }),
    "forge-service-token",
  );
  assertEquals((await launched.json()).outcome, "started");
  assertEquals(app.launches.length, 1);

  // The allowlist widens WHO MAY COMMAND and nothing else: an allowlisted stranger is still
  // not a delegate, and every door that asks for admin on its own — archiving the connected
  // repo, here — goes on refusing them.
  const fromTheApp = makeHandler({
    ...app.deps,
    forge: noopForge(silentDiagnostics(), { permission: "denied", radicleRepo: identityDoc() }),
  });
  const refused = await post(fromTheApp, `/v1/connected-repos/${repo.id}/archive`);
  assertEquals(refused.status, 403);
});

test("an unanswerable permission check is a 503 that is redelivered, never a denial", async () => {
  const app = buildApp();
  await prepare(app);
  const flaky = makeHandler({
    ...app.deps,
    forge: noopForge(silentDiagnostics(), { permission: "unknown", radicleRepo: identityDoc() }),
  });
  const res = await post(flaky, "/v1/forge/events", command(), "forge-service-token");
  assertEquals(res.status, 503);
  assertEquals(app.launches.length, 0);
});

// ---- settlement ---------------------------------------------------------------------------

test("a merged change request settles the patch that opened it, by its object id", async () => {
  const app = buildApp();
  const { repo, agent } = await prepare(app);
  const at = "2026-01-01T00:00:00.000Z";

  const task = {
    id: "t-1",
    agentId: agent.id,
    spec: { title: "work", instructions: "do it" },
    repos: [{
      connectedRepoId: repo.id,
      name: repo.repoRef,
      url: repo.url,
      ref: "main",
      path: "app",
      branchName: "ryph/ada/r-1",
      description: null,
    }],
    workspaceId: null,
    origin: "user",
    requestedByUserId: USER.userId,
    targetChangeRequest: null,
    landings: {},
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
    createdAt: at,
  } as unknown as Task;
  const run = { id: "r-1", taskId: task.id, state: "succeeded" } as unknown as Run;
  await app.store.createTask(task, run);

  const opened = openPatch(
    {
      id: "p-1",
      connectedRepoId: repo.id,
      runId: run.id,
      taskId: task.id,
      setId: "s-1",
      path: "app",
      line: "work",
      branchName: "ryph/ada/r-1",
      headSha: "c".repeat(40),
      bundleKey: "b/1",
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
      carries: [],
      heldReason: null,
    },
    "auto",
    true,
    at,
  );
  const submitting = markSubmitting(opened.patch, at);
  assert(submitting.kind === "applied");
  // The forge ref is a 40-hex collaborative-object id here, not a number — and `forgeUrl` is
  // null, which is what a deployment with no explorer configured really has.
  const submitted = markSubmitted(
    submitting.patch,
    { ref: COB, url: null, branch: `patches/${COB}`, diffRef: "main" },
    at,
  );
  assert(submitted.kind === "applied");
  await app.store.savePatch(submitted.patch);

  const res = await post(
    app.handler,
    "/v1/forge/events",
    command({
      kind: "change_request.merged",
      thread: { kind: "change_request", ref: COB },
      body: null,
      sourceCommentId: null,
      // The merged revision's head; the noop forge finds every pushed head inside it.
      merged: { heads: ["c".repeat(40)] },
    }),
    "forge-service-token",
  );
  assertEquals((await res.json()).outcome, "patch-settled");
  // The delivery records the merge; the submit sweep's settle reconcile judges it.
  await reconcileMergeSettles({ ...app.deps, forge: app.forge as unknown as Forge });
  const settled = await app.store.getPatch("p-1");
  assertEquals(settled?.landed?.kind, "merged");
  assertEquals(settled?.forgeUrl, null);
});

test("a merged Radicle patch a run was working lands it on the default branch, and the next goes out fresh", async () => {
  // Landing on Radicle: a run on a patch checks it out as `patches/<id>` and merges into the
  // default branch. Once the patch merges, the repo moves onto that branch — the task's entry
  // qualified, the run's spec bare — and the next generation opens a patch of its own.
  const app = buildApp();
  const { repo, agent } = await prepare(app);
  const at = "2026-01-01T00:00:00.000Z";
  const entry = {
    connectedRepoId: repo.id,
    name: repo.repoRef,
    url: repo.url,
    path: "app",
    branchName: "ryph/ada/r-rad",
    description: null,
  };
  const task = {
    id: "t-rad",
    agentId: agent.id,
    spec: { title: "work", instructions: "do it" },
    repos: [{ ...entry, ref: `refs/heads/patches/${COB}`, targetRef: "refs/heads/main" }],
    workspaceId: null,
    origin: "user",
    requestedByUserId: USER.userId,
    targetChangeRequest: { connectedRepoId: repo.id, thread: COB },
    landings: {},
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
    createdAt: at,
  } as unknown as Task;
  const run = {
    id: "r-rad",
    taskId: task.id,
    agentId: agent.id,
    state: "running",
    workItem: {
      agent: { name: "Ada" },
      spec: { title: "work", instructions: "do it" },
      lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
      repos: [{ ...entry, ref: `patches/${COB}`, targetRef: "main" }],
    },
    result: null,
    createdAt: at,
  } as unknown as Run;
  await app.store.createTask(task, run);
  const born = (id: string, headSha: string, generation: number, createdAt: string) =>
    openPatch(
      {
        id,
        connectedRepoId: repo.id,
        runId: run.id,
        taskId: task.id,
        setId: `s-${id}`,
        path: "app",
        line: "work",
        branchName: generation === 1 ? "ryph/ada/r-rad" : `ryph/ada/r-rad-${generation}`,
        headSha,
        bundleKey: `b/${id}`,
        baseSha: null,
        generation,
        title: null,
        description: null,
        commits: [],
        carries: [],
        heldReason: null,
      },
      "auto",
      true,
      createdAt,
    ).patch;
  const submitter = {
    store: app.store,
    forge: app.forge as unknown as Forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: app.clock.now,
  };
  await app.store.savePatch(born("p-rad-1", "c".repeat(40), 1, at));
  await sweepPatches(submitter, DEFAULT_PATCH_SUBMIT_CONFIG);
  const submissions = () =>
    (app.forge as unknown as { submissions: PatchSubmission[] }).submissions;
  // Onto the task's own patch, as a revision, staged on its base.
  assertEquals(
    [submissions().at(-1)!.changeRequest, submissions().at(-1)!.baseBranch],
    [COB, `patches/${COB}`],
  );
  const first = (await app.store.getPatch("p-rad-1"))!;
  assertEquals([first.forgeRef, first.forgeBranch], [COB, `patches/${COB}`]);

  const res = await post(
    app.handler,
    "/v1/forge/events",
    command({
      kind: "change_request.merged",
      thread: { kind: "change_request", ref: COB },
      body: null,
      sourceCommentId: null,
      // The merged revision's head; the noop forge finds every pushed head inside it.
      merged: { heads: ["c".repeat(40)] },
    }),
    "forge-service-token",
  );
  assertEquals((await res.json()).outcome, "patch-settled");
  await sweepPatches(submitter, DEFAULT_PATCH_SUBMIT_CONFIG);
  const landed = (await app.store.getTask(task.id))!;
  assertEquals(landed.targetChangeRequest, null);
  assertEquals(landed.repos.map((r) => [r.ref, r.targetRef]), [["refs/heads/main", undefined]]);
  assertEquals(
    (await app.store.getRun(run.id))!.workItem.repos.map((r) => [r.ref, r.targetRef]),
    [["main", undefined]],
  );
  const cue = (await app.store.listRunMessages(run.id))
    .map((m) => m.payload as PatchPayload | null)
    .find((p) => p?.state === "merged");
  assertEquals(cue?.onto, "main");
  // The patch it pushed is still the thread the run holds.
  assertEquals((await app.store.findLiveRunOnChangeRequest(repo.id, COB))?.id, run.id);

  // The next generation: a patch of its own against the default branch, never a revision of the
  // merged one.
  await app.store.savePatch(born("p-rad-2", "d".repeat(40), 2, "2026-01-01T00:01:00.000Z"));
  await sweepPatches(submitter, DEFAULT_PATCH_SUBMIT_CONFIG);
  const sent = submissions().at(-1)!;
  assertEquals([sent.headSha, sent.changeRequest, sent.baseBranch], [
    "d".repeat(40),
    undefined,
    "main",
  ]);
  const second = (await app.store.getPatch("p-rad-2"))!;
  assert(second.forgeRef !== null && second.forgeRef !== COB);
  assertEquals(second.forgeBranch, `patches/${second.forgeRef}`);
});

test("the whole submit path carries a null url: a Radicle deployment with no explorer", async () => {
  // Driven through the PORT, not by calling `markSubmitted` with a hand-written null: a
  // stand-in that always invented `https://forge.invalid/…` meant nothing between the reaper
  // and the run's inbox had ever seen the null a Radicle deployment really produces.
  const app = buildApp();
  const { repo, agent } = await prepare(app);
  const at = "2026-01-01T00:00:00.000Z";
  const task = {
    id: "t-null",
    agentId: agent.id,
    spec: { title: "work", instructions: "do it" },
    repos: [{
      connectedRepoId: repo.id,
      name: repo.repoRef,
      url: repo.url,
      ref: "main",
      path: "app",
      branchName: "ryph/ada/r-2",
      description: null,
    }],
    workspaceId: null,
    origin: "user",
    requestedByUserId: USER.userId,
    targetChangeRequest: null,
    landings: {},
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
    createdAt: at,
  } as unknown as Task;
  const run = {
    id: "r-2",
    taskId: task.id,
    agentId: agent.id,
    state: "running",
    workItem: { agent: { name: "Ada" }, lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 } },
    result: null,
  } as unknown as Run;
  await app.store.createTask(task, run);

  const opened = openPatch(
    {
      id: "p-null",
      connectedRepoId: repo.id,
      runId: run.id,
      taskId: task.id,
      setId: "s-null",
      path: "app",
      line: "work",
      branchName: "ryph/ada/r-2",
      headSha: "d".repeat(40),
      bundleKey: "b/2",
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
      carries: [],
      heldReason: null,
    },
    "auto",
    // Auto-submitted on a succeeded run, so the sweep below is the only thing left between it
    // and the forge.
    true,
    at,
  );
  await app.store.savePatch(opened.patch);

  const reported: Array<string | null> = [];
  await sweepPatches({
    store: app.store,
    forge: app.forge as unknown as Forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    memoryAccess: {
      reportChange: () => Promise.resolve(),
      reportPatch: (_runId, patch) => {
        reported.push(patch.forgeUrl);
        return Promise.resolve();
      },
    },
    now: app.clock.now,
  }, DEFAULT_PATCH_SUBMIT_CONFIG);

  const submitted = await app.store.getPatch("p-null");
  assertEquals(submitted?.state, "submitted");
  assertEquals(submitted?.forgeUrl, null, "no explorer means no web address, not a fake one");
  assertEquals(submitted?.forgeRef !== null, true, "the id is the address, and is never null");
  // And it survives the two relays off the sweep: memory's record, and the live run's inbox.
  assertEquals(reported, [null]);
  const note = (await app.store.listRunMessages(run.id)).at(-1);
  assertEquals((note?.payload as PatchPayload | null | undefined)?.forgeUrl ?? null, null);
  assertEquals((note?.text ?? "").includes("forge.invalid"), false);

  // A follow-up of the same branch goes onto that patch as a new revision, staged on the task's
  // base: the forge's git door serves the open patch's head only as `patches/<id>`, never as the
  // branch the run pushed, so the run's branch would be a base that does not exist there.
  const followUp = openPatch(
    {
      id: "p-next",
      connectedRepoId: repo.id,
      runId: run.id,
      taskId: task.id,
      setId: "s-next",
      path: "app",
      line: "work",
      branchName: "ryph/ada/r-2",
      headSha: "f".repeat(40),
      bundleKey: "b/4",
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
      carries: [],
      heldReason: null,
    },
    "auto",
    true,
    "2026-01-01T00:00:01.000Z",
  );
  await app.store.savePatch(followUp.patch);
  await sweepPatches({
    store: app.store,
    forge: app.forge as unknown as Forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: app.clock.now,
  }, DEFAULT_PATCH_SUBMIT_CONFIG);
  const sent = (app.forge as unknown as { submissions: PatchSubmission[] }).submissions.at(-1)!;
  assertEquals([sent.headSha, sent.baseBranch, sent.changeRequest], [
    "f".repeat(40),
    "main",
    submitted!.forgeRef,
  ]);

  // The same deployment WITH an explorer configured renders one — the template is the only
  // difference, which is what makes the null above a real answer rather than a gap.
  const withExplorer = noopForge(silentDiagnostics(), {
    radicleExplorerUrl: "https://explorer.test/{rid}/{kind}/{id}",
  });
  const rendered = await withExplorer.submitPatch({
    approvedHookPaths: [],
    bundleKey: "b/3",
    branchName: "ryph/ada/r-3",
    headSha: "e".repeat(40),
    repo: { provider: "radicle", repoRef: RID, tenantId: null },
    repoUrl: RID,
    baseBranch: "main",
    title: "t",
    body: "b",
    runId: "r-3",
  });
  assert(rendered.kind === "submitted");
  assertEquals(rendered.url, `https://explorer.test/${RID}/patches/${rendered.ref}`);
});

test("the stand-in forge denies a GitHub identity on a Radicle repo, as the boundary does", async () => {
  // The cross-provider rule the HTTP adapter enforces before it asks anybody. A stand-in that
  // answered "allowed" here would be a laxer boundary in dev than in production — and this is
  // the one rule that keeps a login linked on one forge from becoming access on another.
  const forge = noopForge(silentDiagnostics(), { permission: "allowed" });
  const radicleRepo = { provider: "radicle" as const, repoRef: RID, tenantId: null };
  assertEquals(
    await forge.checkPermission(radicleRepo, { provider: "github", subject: "ada" }, "write"),
    "denied",
  );
  assertEquals(
    await forge.checkPermission(radicleRepo, { provider: "radicle", subject: THEM }, "write"),
    "allowed",
  );
  assertEquals(
    await forge.checkPermission(
      { provider: "github", repoRef: "acme/app", tenantId: "1" },
      { provider: "radicle", subject: THEM },
      "write",
    ),
    "denied",
  );
});
