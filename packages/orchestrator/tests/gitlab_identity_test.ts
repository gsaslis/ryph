import { test } from "bun:test";

// GitLab's sign-in, identity and connect wire on the control plane's side: the sign-in offer and
// code exchange (the redirect URI and PKCE verifier carried to the forge), the group gate, the
// cached mode, the user-mode directory, and the forge wire of the three connect reads.

import { NO_CODE_LEG } from "@ryph/auth";
import { assertEquals, assertRejects } from "@std/assert";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { httpForge } from "../src/adapters/forge/http.ts";
import { githubModeSource } from "../src/adapters/forge/github_mode.ts";
import { gitlabModeSource } from "../src/adapters/forge/gitlab_mode.ts";
import { forgeUserModeDirectory } from "../src/adapters/identity_directory/forge_user_mode.ts";
import { authStoreIdentityDirectory } from "../src/adapters/identity_directory/auth_store.ts";
import { memoryAuthStore } from "../../auth/tests/memory_store.ts";
import { forgeIdentityProvider } from "../src/adapters/identity_provider/forge.ts";
import type {
  ForgeConnect,
  ForgeIdentity,
  ForgeProviders,
  GitlabProjectListing,
  OAuthLeg,
  SignInForge,
} from "../src/ports/forge.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { fakeIdentityDirectory, silentDiagnostics } from "./doubles.ts";

const BOT: ForgeProviders = {
  providers: ["github", "gitlab"],
  github: { mode: "app", signIn: true },
  gitlab: {
    mode: "bot",
    login: "ryph-bot",
    accountId: "1@https://gitlab.example",
    url: "https://gitlab.example",
    signIn: true,
  },
  radicle: null,
};
const PERSON: ForgeProviders = {
  ...BOT,
  gitlab: {
    mode: "user",
    login: "ada",
    accountId: "1@https://gitlab.example",
    url: "https://gitlab.example",
    signIn: false,
  },
};

function scriptedForge(initial: ForgeProviders | Error) {
  let answer: ForgeProviders | Error = initial;
  let calls = 0;
  return {
    forge: {
      providers: () => {
        calls++;
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
    set: (next: ForgeProviders | Error) => (answer = next),
    calls: () => calls,
  };
}

/** A sign-in surface that records what it was asked. */
function recordingConnect(membership: Awaited<ReturnType<ForgeConnect["checkForgeMembership"]>>) {
  const exchanges: Array<{ provider: SignInForge; code: string; leg: OAuthLeg | null }> = [];
  const memberships: Array<{ provider: SignInForge; who: string; installationId: unknown }> = [];
  const connect: ForgeConnect = {
    exchangeForgeOAuthCode(provider, code, leg): Promise<ForgeIdentity> {
      exchanges.push({ provider, code, leg });
      return Promise.resolve({
        accountId: "4242@https://gitlab.example",
        login: "grace.h",
        name: "Grace",
        verifiedEmails: ["grace@example.com"],
        accessToken: "discarded",
      });
    },
    checkForgeMembership(provider, who, installationId) {
      memberships.push({ provider, who, installationId });
      return Promise.resolve(membership);
    },
  };
  return { connect, exchanges, memberships };
}

async function provider(answer: ForgeProviders, membership: "member" | "no-organization") {
  const { forge } = scriptedForge(answer);
  const githubMode = githubModeSource({ forge, diag: silentDiagnostics() });
  const gitlabMode = gitlabModeSource({ forge, diag: silentDiagnostics() });
  await githubMode.get();
  await gitlabMode.get();
  const recorded = recordingConnect(membership);
  return {
    ...recorded,
    provider: forgeIdentityProvider({
      githubConnect: noopForge(silentDiagnostics()),
      store: memoryTaskStore(),
      githubMode,
      forgeConnect: recorded.connect,
      gitlabMode,
    }),
  };
}

// ---- sign-in -------------------------------------------------------------------------------

test("bot mode: GitLab is offered, and its code is redeemed with the leg it was issued under", async () => {
  const { provider: p, exchanges } = await provider(BOT, "member");
  assertEquals(p.providers(), ["github", "gitlab"]);
  const leg = { redirectUri: "https://ryph.test/gitlab/callback", codeVerifier: "v".repeat(43) };
  const identity = await p.exchangeCode("gitlab", "the-code", leg);
  // The user token never leaves the adapter.
  assertEquals(identity, {
    accountId: "4242@https://gitlab.example",
    login: "grace.h",
    name: "Grace",
    verifiedEmails: ["grace@example.com"],
  });
  assertEquals(exchanges, [{ provider: "gitlab", code: "the-code", leg }]);
  // Without the redirect URI GitLab could accept nothing: refused before the forge is asked.
  await assertRejects(() => p.exchangeCode("gitlab", "the-code", NO_CODE_LEG));
  assertEquals(exchanges.length, 1);
});

test("a bot without an OAuth application offers no GitLab sign-in and redeems no code", async () => {
  const noApp: ForgeProviders = { ...BOT, gitlab: { ...BOT.gitlab!, signIn: false } };
  const { provider: p, exchanges } = await provider(noApp, "member");
  assertEquals(p.providers(), ["github"]);
  const leg = { redirectUri: "https://ryph.test/gitlab/callback", codeVerifier: "v".repeat(43) };
  await assertRejects(() => p.exchangeCode("gitlab", "the-code", leg));
  assertEquals(exchanges, []);
});

test("bot mode: the sign-up gate is the forge's group, asked about the account id, and a missing one says so", async () => {
  const member = await provider(BOT, "member");
  const grace = { login: "grace.h", accountId: "4242@https://gitlab.example" };
  assertEquals(await member.provider.isOrgMember("gitlab", grace), "member");
  // The account id the exchange answered — never the username, which an offboarded person's
  // successor to the name, or whoever took the bot's old name, would hold by now.
  assertEquals(member.memberships, [{
    provider: "gitlab",
    who: "4242@https://gitlab.example",
    installationId: null,
  }]);
  const ungated = await provider(BOT, "no-organization");
  assertEquals(await ungated.provider.isOrgMember("gitlab", grace), "no-organization");
});

test("user mode, or no GitLab: GitLab signs nobody in and gates nobody, without asking", async () => {
  for (
    const answer of [PERSON, { ...BOT, providers: ["github"], gitlab: null } as ForgeProviders]
  ) {
    const { provider: p, exchanges, memberships } = await provider(answer, "member");
    assertEquals(p.providers(), ["github"]);
    await assertRejects(() =>
      p.exchangeCode("gitlab", "c", {
        redirectUri: "https://ryph.test/gitlab/callback",
        codeVerifier: null,
      })
    );
    assertEquals(
      await p.isOrgMember("gitlab", { login: "grace.h", accountId: "4242@https://gitlab.example" }),
      "no-organization",
    );
    assertEquals(exchanges, []);
    assertEquals(memberships, []);
  }
  // A stand-in with no sign-in surface never offers GitLab at all.
  const { forge } = scriptedForge(BOT);
  const bare = forgeIdentityProvider({
    githubConnect: noopForge(silentDiagnostics()),
    store: memoryTaskStore(),
    githubMode: githubModeSource({ forge, diag: silentDiagnostics() }),
  });
  await assertRejects(() =>
    bare.exchangeCode("gitlab", "c", { redirectUri: "https://x.test/cb", codeVerifier: null })
  );
});

// ---- the cached mode and the directory -----------------------------------------------------

test("the GitLab mode is kept for a TTL, served stale through a failed re-read", async () => {
  const scripted = scriptedForge(BOT);
  let at = 0;
  const source = gitlabModeSource({
    forge: scripted.forge,
    diag: silentDiagnostics(),
    now: () => at,
    ttlMs: 1_000,
  });
  assertEquals(source.current(), undefined);
  assertEquals(await source.get(), BOT.gitlab);
  await source.get();
  assertEquals(scripted.calls(), 1);
  at = 1_000;
  scripted.set(new Error("down"));
  assertEquals(await source.get(), BOT.gitlab);
  at = 2_000;
  scripted.set(PERSON);
  assertEquals(await source.get(), PERSON.gitlab);
  await assertRejects(() =>
    gitlabModeSource({ forge: scriptedForge(new Error("x")).forge, diag: silentDiagnostics() })
      .get()
  );
});

test("GitLab user mode: every active user's GitLab login is the token's; bot mode is the link", async () => {
  const ids = fakeIdentityDirectory();
  ids.link("u-1", "grace.h", "gitlab");
  ids.link("u-1", "octo", "github");
  ids.name("u-1", "Grace @h");
  ids.deactivate("u-gone");
  const person = forgeUserModeDirectory(ids.directory, {
    github: null,
    gitlab: gitlabModeSource({ forge: scriptedForge(PERSON).forge, diag: silentDiagnostics() }),
  });
  // The token's account id, never its username: what a permission is asked about.
  assertEquals(await person.subjectFor("u-1", "gitlab"), "1@https://gitlab.example");
  assertEquals(await person.subjectFor("u-other", "gitlab"), "1@https://gitlab.example");
  assertEquals(await person.subjectFor("u-gone", "gitlab"), null);
  // Attribution names the ryph user, never the token's account; other forges are untouched.
  assertEquals(await person.requesterFor("u-1", "gitlab"), { name: "Grace h" });
  assertEquals(await person.subjectFor("u-1", "github"), "octo");

  const bot = forgeUserModeDirectory(ids.directory, {
    github: null,
    gitlab: gitlabModeSource({ forge: scriptedForge(BOT).forge, diag: silentDiagnostics() }),
  });
  assertEquals(await bot.subjectFor("u-1", "gitlab"), "grace.h");
  assertEquals(await bot.requesterFor("u-1", "gitlab"), { login: "grace.h" });
});

test("GitHub's verified addresses are proof here; GitLab's are not", async () => {
  const { provider: p } = await provider(BOT, "member");
  assertEquals(p.trustsEmails("github"), true);
  assertEquals(p.trustsEmails("gitlab"), false);
});

test("a GitLab link made under another instance URL names nobody on this one", async () => {
  const store = memoryAuthStore();
  const at = new Date().toISOString();
  const link = (userId: string, accountId: string, login: string, provider = "gitlab") =>
    store.saveIdentity({
      id: `i-${userId}-${provider}`,
      userId,
      provider,
      providerAccountId: accountId,
      login,
      email: null,
      emailVerified: false,
      createdAt: at,
      updatedAt: at,
    });
  // grace linked 4242 on this instance; old linked 4242 — another person — on the last one.
  await link("u-grace", "4242@https://gitlab.example", "grace.h");
  await link("u-old", "4242@https://old-gitlab.example", "grace.h");
  await link("u-old", "99", "octo", "github");
  const directory = (answer: ForgeProviders | Error) =>
    authStoreIdentityDirectory(store, {
      gitlab: gitlabModeSource({ forge: scriptedForge(answer).forge, diag: silentDiagnostics() }),
    });

  const here = directory(BOT);
  assertEquals(await here.subjectFor("u-grace", "gitlab"), "4242@https://gitlab.example");
  assertEquals(await here.subjectFor("u-old", "gitlab"), null);
  assertEquals(await here.requesterFor("u-old", "gitlab"), null);
  // Nobody on GitLab is found by username, whichever instance they linked on.
  assertEquals(await here.userIdsForLogin("gitlab", "grace.h"), []);
  // GitHub's rows are not GitLab's business.
  assertEquals(await here.subjectFor("u-old", "github"), "octo");
  // A webhook's actor arrives as GitLab's bare id: it is spelled on THIS instance, so 4242 is
  // grace, never the person who linked 4242 on the old one.
  assertEquals(await here.userIdsForAccount("gitlab", "4242"), ["u-grace"]);
  assertEquals(await here.userIdsForAccount("gitlab", "4242@https://old-gitlab.example"), []);
  assertEquals(await here.userIdsForAccount("github", "99"), ["u-old"]);
  // Pointed at the old instance, the same id is the old link's person.
  const old = directory({ ...BOT, gitlab: { ...BOT.gitlab!, url: "https://old-gitlab.example" } });
  assertEquals(await old.userIdsForAccount("gitlab", "4242"), ["u-old"]);

  // A GitLab that has never said where it is vouches for no link at all.
  const unknown = directory(new Error("forge down"));
  assertEquals(await unknown.subjectFor("u-grace", "gitlab"), null);
  assertEquals(await unknown.userIdsForLogin("gitlab", "grace.h"), []);
  assertEquals(await unknown.userIdsForAccount("gitlab", "4242"), []);
});

test("an offboarded person's GitLab username, registered by somebody else, inherits nothing: checks, gate and mentions go by account id", async () => {
  const store = memoryAuthStore();
  const at = new Date().toISOString();
  await store.createUser({
    id: "u-old",
    email: "old@example.com",
    name: "Old Timer",
    passwordHash: null,
    role: "member",
    status: "active",
    emailVerifiedAt: at,
    unprovenEmail: null,
    resetRequestedAt: null,
    createdAt: at,
    updatedAt: at,
  });
  // u-old linked GitLab account 4242 while it was called "grace.h". On GitLab since: 4242 was
  // renamed (offboarded), and a new hire, account 5555, registered "grace.h".
  await store.saveIdentity({
    id: "i-old",
    userId: "u-old",
    provider: "gitlab",
    providerAccountId: "4242@https://gitlab.example",
    login: "grace.h",
    email: null,
    emailVerified: false,
    createdAt: at,
    updatedAt: at,
  });
  const current: Record<string, string> = { "4242@https://gitlab.example": "former-4242" };
  const looked: string[] = [];
  const directory = authStoreIdentityDirectory(store, {
    gitlab: gitlabModeSource({ forge: scriptedForge(BOT).forge, diag: silentDiagnostics() }),
    gitlabUsers: {
      gitlabLogin: (accountId) => {
        looked.push(accountId);
        return Promise.resolve(current[accountId] ?? null);
      },
    },
  });
  // Every permission check is about the account id u-old linked — never "grace.h", which is the
  // new hire's now and would answer with the new hire's rights.
  assertEquals(await directory.subjectFor("u-old", "gitlab"), "4242@https://gitlab.example");
  // A mention names the account by what GitLab calls it now, read by its id: never "grace.h".
  assertEquals(await directory.requesterFor("u-old", "gitlab"), { login: "former-4242" });
  assertEquals(looked, ["4242@https://gitlab.example"]);
  // Deleted on GitLab, or GitLab unreadable: the ryph name, which pings nobody.
  delete current["4242@https://gitlab.example"];
  assertEquals(await directory.requesterFor("u-old", "gitlab"), { name: "Old Timer" });
  // And an event carrying the login "grace.h" — the new hire's — maps to nobody.
  assertEquals(await directory.userIdsForLogin("gitlab", "grace.h"), []);
  assertEquals(await directory.userIdsForAccount("gitlab", "5555"), []);
  assertEquals(await directory.userIdsForAccount("gitlab", "4242"), ["u-old"]);
});

// ---- the wire ------------------------------------------------------------------------------

async function overWire<T>(
  reply: (req: Request) => Response | Promise<Response>,
  fn: (forge: ReturnType<typeof httpForge>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      reply(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init),
      ),
    )) as typeof fetch;
  try {
    return await fn(
      httpForge({ baseUrl: "http://forge.test", forgeToken: "t", diag: silentDiagnostics() }),
    );
  } finally {
    globalThis.fetch = original;
  }
}

const jsonReply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const LISTING: GitlabProjectListing = {
  id: "42",
  pathWithNamespace: "acme/platform/payments",
  url: "https://gitlab.example/acme/platform/payments.git",
  webUrl: "https://gitlab.example/acme/platform/payments",
  defaultBranch: "main",
  visibility: "internal",
  admin: true,
};

test("the projects wire keeps exactly the listing's fields and refuses any malformed one", async () => {
  const listed = await overWire((req) => {
    assertEquals(new URL(req.url).pathname, "/v1/service/gitlab/projects");
    assertEquals(req.method, "GET");
    assertEquals(req.headers.get("authorization"), "Bearer t");
    return jsonReply(200, {
      projects: [{ ...LISTING, extra: "dropped" }, { ...LISTING, id: "43", defaultBranch: null }],
    });
  }, (f) => f.listGitlabProjects());
  assertEquals(listed, [LISTING, { ...LISTING, id: "43", defaultBranch: null }]);

  for (
    const bad of [
      { ...LISTING, id: 42 },
      { ...LISTING, id: "0x2a" },
      { ...LISTING, pathWithNamespace: "solo" },
      { ...LISTING, pathWithNamespace: "acme/../etc" },
      { ...LISTING, url: "javascript:alert(1)" },
      { ...LISTING, webUrl: "ssh://gitlab.example/x" },
      { ...LISTING, defaultBranch: "bad..name" },
      { ...LISTING, visibility: "secret" },
      { ...LISTING, admin: "yes" },
    ]
  ) {
    await assertRejects(() =>
      overWire(() => jsonReply(200, { projects: [LISTING, bad] }), (f) => f.listGitlabProjects())
    );
  }
  for (const status of [501, 502]) {
    await assertRejects(() =>
      overWire(
        () => jsonReply(status, { error: "no GitLab is configured" }),
        (f) => f.listGitlabProjects(),
      )
    );
  }
});

test("the describe wire: a listing, the forge's own terminal 404 as none, anything else a throw", async () => {
  const described = await overWire(async (req) => {
    assertEquals(new URL(req.url).pathname, "/v1/service/gitlab/describe");
    assertEquals(await req.json(), { project: "acme/platform/payments" });
    return jsonReply(200, LISTING);
  }, (f) => f.describeGitlabProject("acme/platform/payments"));
  assertEquals(described, LISTING);
  assertEquals(
    await overWire(
      () => jsonReply(404, { error: "no such project", terminal: true }),
      (f) => f.describeGitlabProject("42"),
    ),
    null,
  );
  for (
    const [status, body] of [[404, {}], [502, { error: "down" }], [200, { id: "42" }]] as const
  ) {
    await assertRejects(() =>
      overWire(() => jsonReply(status, body), (f) => f.describeGitlabProject("42"))
    );
  }
});

test("the hook-token wire takes a 64-hex token and nothing else", async () => {
  const token = "0123456789abcdef".repeat(4);
  assertEquals(
    await overWire(async (req) => {
      assertEquals(new URL(req.url).pathname, "/v1/service/gitlab/hook-token");
      assertEquals(await req.json(), { projectId: "42", generation: 3 });
      return jsonReply(200, { token });
    }, (f) => f.gitlabHookToken("42", 3)),
    token,
  );
  for (const body of [{}, { token: "short" }, { token: token.toUpperCase() }, { token: 1 }]) {
    await assertRejects(() =>
      overWire(() => jsonReply(200, body), (f) => f.gitlabHookToken("42", 1))
    );
  }
  await assertRejects(() =>
    overWire(() => jsonReply(501, { error: "no GitLab" }), (f) => f.gitlabHookToken("42", 1))
  );
});

test("the OAuth wire sends GitLab's redirect URI and verifier, and GitHub's code alone", async () => {
  const bodies: unknown[] = [];
  const reply = async (req: Request) => {
    bodies.push(await req.json());
    return jsonReply(200, { accountId: "1", login: "g", name: null, verifiedEmails: [] });
  };
  await overWire(reply, (f) =>
    f.exchangeForgeOAuthCode("gitlab", "c", {
      redirectUri: "https://ryph.test/gitlab/callback",
      codeVerifier: "v".repeat(43),
    }));
  await overWire(reply, (f) =>
    f.exchangeForgeOAuthCode("gitlab", "c", {
      redirectUri: "https://ryph.test/gitlab/callback",
      codeVerifier: null,
    }));
  await overWire(reply, (f) => f.exchangeOAuthCode("c"));
  assertEquals(bodies, [
    {
      provider: "gitlab",
      code: "c",
      redirectUri: "https://ryph.test/gitlab/callback",
      codeVerifier: "v".repeat(43),
    },
    { provider: "gitlab", code: "c", redirectUri: "https://ryph.test/gitlab/callback" },
    { provider: "github", code: "c" },
  ]);
});
