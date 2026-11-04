import { describe, expect, it } from "vitest";
import {
  getForgeProviders,
  getForges,
  getRadicleIdentity,
  isWebLink,
  radicleUserMode,
} from "./forge";
import {
  linkIdentityByProof,
  listIdentities,
  mintIdentityChallenge,
  unlinkIdentity,
} from "./identities";
import {
  addCommandAllowlistEntry,
  connectRadicleRepo,
  connectRepo,
  getCommandAllowlist,
  getConnectedRepos,
  removeCommandAllowlistEntry,
} from "./repos";
import {
  forgeToolActionSchema,
  messageSenderSchema,
  patchWithContextSchema,
  radicleRepoInfoSchema,
  runForgeScopeSchema,
} from "./types";

// The forge-neutral wire, pinned at the client: a repo is addressed by `repoRef` on a named
// provider, a thread by a string its own forge spells, and an identity by the login its own
// forge names — a DID on Radicle. Everything here is a shape the app would otherwise discover
// at runtime.

const respond = (status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) =>
  ((url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.init = init;
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const DID = "did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";

const githubRepo = {
  id: "cr-1",
  provider: "github",
  installationId: "42",
  repoRef: "acme/app",
  url: "https://github.com/acme/app",
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T10:00:00.000Z",
};

const radicleRepo = {
  ...githubRepo,
  id: "cr-2",
  provider: "radicle",
  // No installation on a forge whose writes are signed rather than tokened, and no explorer
  // URL unless the deployment configured one.
  installationId: null,
  repoRef: RID,
  url: "",
};

const followCommands = {
  inWorkingCopy: "rad remote add z6Mkire… --sync",
  anywhere: `rad follow z6Mkire… --repo ${RID}`,
};

const radicleInfo = {
  rid: RID,
  nid: "z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM",
  did: DID,
  alias: "ryph",
  name: "heartwood",
  defaultBranch: "master",
  delegates: [DID],
  isDelegate: false,
  isAllowed: true,
  visibility: "public",
  followCommands,
};

describe("connected repos", () => {
  it("parses both providers, installation id and all", async () => {
    const repos = await getConnectedRepos(respond(200, { repos: [githubRepo, radicleRepo] }));
    expect(repos.map((r) => r.provider)).toEqual(["github", "radicle"]);
    expect(repos[0].installationId).toBe("42");
    expect(repos[1].installationId).toBeNull();
    expect(repos[1].repoRef).toBe(RID);
  });

  it("sends repoRef and the provider when connecting a GitHub repo", async () => {
    const seen: { init?: RequestInit } = {};
    await connectRepo(respond(201, githubRepo, seen), {
      installationId: "42",
      repoRef: "acme/app",
      submissionPolicy: "auto",
    });
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      provider: "github",
      installationId: "42",
      repoRef: "acme/app",
      submissionPolicy: "auto",
    });
  });

  it("connects a Radicle repo by its id, and reads back what the node knows", async () => {
    const seen: { init?: RequestInit } = {};
    const connected = await connectRadicleRepo(
      respond(201, { repo: radicleRepo, radicle: radicleInfo }, seen),
      { repoRef: RID },
    );
    // `installationId` is GitHub's and only GitHub's: the platform refuses a Radicle connect
    // that carries the key AT ALL, so the body must not have it — not even undefined.
    const body = JSON.parse(String(seen.init?.body));
    expect(body).toEqual({ provider: "radicle", repoRef: RID });
    expect("installationId" in body).toBe(false);
    expect(connected.repo.repoRef).toBe(RID);
    expect(connected.radicle.rid).toBe(RID);
    expect(connected.radicle.delegates).toEqual([DID]);
    expect(connected.radicle.isDelegate).toBe(false);
    expect(connected.radicle.isAllowed).toBe(true);
    expect(connected.radicle.followCommands.anywhere).toContain(RID);
  });

  it("says whether a private repo has ryph on its allow list, and tolerates an unnamed node", () => {
    const info = radicleRepoInfoSchema.parse({
      ...radicleInfo,
      alias: null,
      visibility: "private",
      isAllowed: false,
      // Fields the client does not model yet must not break the parse.
      threshold: 1,
      allow: [],
    });
    expect(info.isAllowed).toBe(false);
    expect(info.alias).toBeNull();
  });
});

describe("the command allowlist", () => {
  const entries = [{ subject: DID, addedBy: "u-1", createdAt: "2026-09-15T10:00:00.000Z" }];

  it("reads and adds entries, answering with the whole list each time", async () => {
    expect((await getCommandAllowlist(respond(200, { entries }), "cr-2"))[0].subject).toBe(DID);

    const seen: { url?: string; init?: RequestInit } = {};
    await addCommandAllowlistEntry(respond(201, { entries }, seen), "cr-2", DID);
    expect(seen.url).toBe("/api/v1/connected-repos/cr-2/command-allowlist");
    expect(JSON.parse(String(seen.init?.body))).toEqual({ subject: DID });
  });

  it("percent-encodes the DID's colons into the delete path", async () => {
    const seen: { url?: string } = {};
    await removeCommandAllowlistEntry(respond(200, { entries: [] }, seen), "cr-2", DID);
    expect(seen.url).toBe(
      `/api/v1/connected-repos/cr-2/command-allowlist/${encodeURIComponent(DID)}`,
    );
    // The app's proxy refuses an encoded separator, so the encoding must not produce one.
    expect(seen.url).not.toMatch(/%2f/i);
  });
});

describe("forge providers and identities", () => {
  it("reads the providers this deployment serves", async () => {
    expect(
      await getForgeProviders(
        respond(200, { providers: ["github", "radicle"], github: null, gitlab: null }),
      ),
    ).toEqual(["github", "radicle"]);
  });

  it("reads how this deployment is on GitHub", async () => {
    const forges = await getForges(
      respond(200, {
        providers: ["github"],
        github: { mode: "user", login: "ada" },
        gitlab: null,
      }),
    );
    expect(forges.github).toEqual({ mode: "user", login: "ada" });
  });

  it("reads whether Radicle is one person's own node", async () => {
    const forges = await getForges(
      respond(200, {
        providers: ["radicle"],
        github: null,
        gitlab: null,
        radicle: { mode: "user" },
      }),
    );
    expect(radicleUserMode(forges)).toBe(true);
    expect(radicleUserMode({ radicle: { mode: "deployment" } })).toBe(false);
    expect(radicleUserMode(null)).toBe(false);
  });

  it("reads whether a GitHub App signs people in, and refuses an answer that does not say", async () => {
    const app = { mode: "app", signIn: false };
    const forges = await getForges(
      respond(200, { providers: ["github"], github: app, gitlab: null }),
    );
    expect(forges.github).toEqual(app);
    await expect(
      getForges(respond(200, { providers: ["github"], github: { mode: "app" }, gitlab: null })),
    ).rejects.toThrow();
  });

  it("reads how this deployment is on GitLab", async () => {
    const gitlab = {
      mode: "bot",
      login: "ryph-bot",
      url: "https://gitlab.example.com",
      signIn: true,
    };
    const forges = await getForges(
      respond(200, { providers: ["gitlab", "local"], github: null, gitlab }),
    );
    expect(forges.providers).toEqual(["gitlab", "local"]);
    expect(forges.gitlab).toEqual(gitlab);
  });

  it("refuses a GitLab description that does not match the provider list", async () => {
    const gitlab = { mode: "user", login: "ada", url: "https://gitlab.com", signIn: false };
    await expect(getForges(respond(200, { providers: ["github"], github: null, gitlab })))
      .rejects.toThrow();
    await expect(getForges(respond(200, { providers: ["gitlab"], github: null, gitlab: null })))
      .rejects.toThrow();
  });

  it("reads identities by provider and login — a DID is a login on Radicle", async () => {
    const identities = await listIdentities(respond(200, {
      identities: [
        { provider: "github", login: "ada", linkedAt: "2026-09-15T10:00:00.000Z" },
        { provider: "radicle", login: DID, linkedAt: "2026-09-15T11:00:00.000Z" },
      ],
    }));
    expect(identities.map((i) => i.provider)).toEqual(["github", "radicle"]);
    expect(identities[1].login).toBe(DID);
  });

  it("unlinks one by provider", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await unlinkIdentity(respond(200, {}, seen), "radicle");
    expect(seen.url).toBe("/api/v1/auth/identities/radicle");
    expect(seen.init?.method).toBe("DELETE");
  });

  it("takes a challenge and proves it with a signature", async () => {
    // The challenge route answers 201 — it created a row — so the client must take it.
    const challenge = await mintIdentityChallenge(
      respond(201, {
        nonce: "n-1",
        expiresAt: "2026-09-15T10:10:00.000Z",
        command: "ssh-keygen -Y sign -f ~/.radicle/keys/radicle -n ryph",
      }),
      "radicle",
    );
    expect(challenge.nonce).toBe("n-1");

    const seen: { url?: string; init?: RequestInit } = {};
    const linked = await linkIdentityByProof(
      respond(
        200,
        { provider: "radicle", login: DID, linkedAt: "2026-09-15T10:05:00.000Z" },
        seen,
      ),
      "radicle",
      { subject: DID, signature: "-----BEGIN SSH SIGNATURE-----\nx\n-----END SSH SIGNATURE-----" },
    );
    expect(seen.url).toBe("/api/v1/auth/identities/radicle/link");
    // The nonce is deliberately absent: the platform tries every outstanding challenge and
    // spends the one that verifies, so a caller-named nonce would prove nothing.
    const body = JSON.parse(String(seen.init?.body));
    expect(body.subject).toBe(DID);
    expect("nonce" in body).toBe(false);
    expect(linked.provider).toBe("radicle");
  });

  it("reads ryph's own node, and calls a deployment without one absent rather than broken", async () => {
    const identity = await getRadicleIdentity(respond(200, {
      did: DID,
      nid: "z6Mkire",
      alias: "ryph",
      // Whether the node is actually up, and the one command a screen with room for a line uses.
      node: { running: true, sessions: 3 },
      followCommand: followCommands.inWorkingCopy,
      followCommands,
    }));
    expect(identity?.alias).toBe("ryph");
    expect(identity?.node).toEqual({ running: true, sessions: 3 });
    expect(identity?.followCommand).toBe(followCommands.inWorkingCopy);
    expect(await getRadicleIdentity(respond(404, { error: "radicle is not enabled" }))).toBeNull();
  });

  it("takes a node that has not named itself, and one that could not be asked", async () => {
    const identity = await getRadicleIdentity(respond(200, {
      did: DID,
      nid: "z6Mkire",
      alias: null,
      node: null,
      followCommands,
    }));
    expect(identity?.alias).toBeNull();
    expect(identity?.node).toBeNull();
  });
});

describe("the run's frozen forge shapes", () => {
  it("carries a provider and an address per repo, and a nullable tenant", () => {
    const scope = runForgeScopeSchema.parse({
      repos: [
        { connectedRepoId: "cr-1", provider: "github", repoRef: "acme/app", tenantId: "42" },
        { connectedRepoId: "cr-2", provider: "radicle", repoRef: RID, tenantId: null },
      ],
      sourceRepos: [],
      origin: { connectedRepoId: "cr-2", kind: "change_request", ref: "abc1234def" },
      capabilities: {
        read: true,
        createIssues: null,
        comment: { where: "origin", max: 5 },
        review: null,
        closeIssues: null,
        labels: [],
      },
      provenance: { agentName: "Ada", runUrl: null, requestedBy: null },
    });
    expect(scope.repos[1].tenantId).toBeNull();
    expect(scope.origin?.kind).toBe("change_request");
    expect(scope.origin?.ref).toBe("abc1234def");
  });

  it("records a forge write against a thread string, not a number", () => {
    const action = forgeToolActionSchema.parse({
      id: "fa-1",
      runId: "r-1",
      tool: "add_comment",
      connectedRepoId: "cr-2",
      // Told, not read off the address: the ledger row names its own forge.
      provider: "radicle",
      repoRef: RID,
      threadRef: "abc1234def5678900000000000000000000000ff",
      state: "done",
      // A Radicle deployment without an explorer has no URL to point at.
      url: null,
      createdThreadRef: null,
      detail: null,
      createdAt: "2026-09-15T10:00:00.000Z",
      completedAt: "2026-09-15T10:00:01.000Z",
    });
    expect(action.threadRef).toBe("abc1234def5678900000000000000000000000ff");
    expect(action.provider).toBe("radicle");
    expect(action.url).toBeNull();
  });

  it("carries the patch's forge beside its address, and loses both with the repo", () => {
    const base = {
      id: "p-1",
      setId: "ps-1",
      taskId: "t-1",
      runId: "r-1",
      connectedRepoId: "cr-2",
      path: "app",
      line: "work",
      branchName: "ryph/change",
      headSha: "a".repeat(40),
      bundleKey: "b-1",
      attempts: 1,
      nextAttemptAt: null,
      lastError: null,
      approvedBy: null,
      approvedAt: null,
      landed: null,
      supersededByPatchId: null,
      generation: 1,
      state: "submitted",
      title: "A change",
      forgeRef: "abc1234def5678900000000000000000000000ff",
      forgeUrl: null,
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:00:00.000Z",
      taskTitle: "Do the thing",
      agentName: "Ada",
      summary: null,
      commits: [{ sha: "a".repeat(40), subject: "A change" }],
    };
    const told = patchWithContextSchema.parse({ ...base, provider: "radicle", repoRef: RID });
    expect(told.provider).toBe("radicle");

    // A patch whose repo is gone has neither — nothing is inferred from what is left.
    const orphan = patchWithContextSchema.parse({ ...base, provider: null, repoRef: null });
    expect(orphan.provider).toBeNull();
  });

  it("names a forge sender by repo address and thread", () => {
    const sender = messageSenderSchema.parse({
      kind: "forge",
      login: "ada",
      repoRef: RID,
      thread: "abc1234def5678900000000000000000000000ff",
    });
    expect(sender).toEqual({
      kind: "forge",
      login: "ada",
      repoRef: RID,
      thread: "abc1234def5678900000000000000000000000ff",
    });
  });
});

describe("isWebLink", () => {
  it("is true only for something a browser can open", () => {
    expect(isWebLink("https://github.com/acme/app")).toBe(true);
    expect(isWebLink("http://explorer.test/rad:z3gq/patches/aa")).toBe(true);
    // A connected Radicle repo has no web address at all where no explorer is configured,
    // and a RID is not one: `href="rad:z…"` is a link to nothing.
    expect(isWebLink("")).toBe(false);
    expect(isWebLink("rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5")).toBe(false);
    expect(isWebLink(null)).toBe(false);
    expect(isWebLink(undefined)).toBe(false);
  });
});
