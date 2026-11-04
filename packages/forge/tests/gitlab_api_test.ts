// The GitLab adapter (bot mode) against a fake GitLab — boot self-checks, the thread spellings,
// the error-mapping doctrine (only a definitive 404 denies; 409 adopts; 429 says when), reviews
// as draft notes published at once, and the connect surface. Every request path is asserted.

import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { serve } from "@ryph/service";
import { deriveScopedSecret } from "@ryph/webhooks";
import {
  gitlabForgeApi,
  type GitlabForgeOptions,
  QUICK_ACTION_ESCAPE_VERIFIED,
} from "../src/adapters/forge_api/gitlab.ts";
import { diffNoteProblem, inertToQuickActions } from "../src/adapters/forge_api/gitlab_client.ts";
import { withSignature } from "../src/core/provenance.ts";
import { positionLines } from "../src/adapters/forge_api/gitlab_reviews.ts";
import { type Audience, ForgeApiError } from "../src/ports/forge_api.ts";
import { gitlabAccountId, gitlabProjectRef } from "../src/gitlab_account.ts";
import { staticUserToken } from "../src/helpers/user_token.ts";
import { GITLAB_TOKEN_NAMES } from "../src/helpers/user_token.ts";
import type { GitlabImageSlots } from "../src/ports/gitlab.ts";
import { recordingDiagnostics, silentDiagnostics } from "./util.ts";

const TOKEN = "glpat-botTokenNeverLogged01";
const BOT_ID = 900;
const BOT = "ryph-bot";
const GROUP_ID = 7;
const P = "42"; // `acme/platform/app`'s id, as the API takes it
/** The project every call names: by its id on the instance under test, which `botApi` sets —
 * the path is a label. */
const repo = { repoRef: "acme/platform/app", tenantId: null, forgeId: "" };

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}
type Responder = (call: Call) => Response | Promise<Response> | null;

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);
const notFound = () => json({ message: "404 Not Found" }, { status: 404 });

/** A programmable fake GitLab under `/api/v4`. It knows who the token is, its version and its
 * scopes; each test answers the paths it exercises. Calls are recorded without the API prefix,
 * and the boot's three reads are left out of `calls` so each test asserts only its own. */
async function fakeGitlab(opts: {
  version?: string;
  scopes?: string[] | null;
  expiresAt?: string | null;
} = {}) {
  const calls: Call[] = [];
  let respond: Responder = () => null;
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v4/, "") + url.search;
    const auth = req.headers.get("authorization");
    const text = req.body === null ? "" : await req.text();
    let body: unknown = undefined;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const call = { method: req.method, path, auth, body };
    if (req.method === "GET" && path === "/user" && auth?.startsWith("Bearer glpat-")) {
      return auth === `Bearer ${TOKEN}`
        ? json({ id: BOT_ID, username: BOT })
        : json({ message: "401 Unauthorized" }, { status: 401 });
    }
    if (req.method === "GET" && path === "/version") {
      return json({ version: opts.version ?? "17.5.1-ee", revision: "abc" });
    }
    if (req.method === "GET" && path === "/personal_access_tokens/self") {
      if (opts.scopes === null) return notFound();
      return json({
        id: 1,
        scopes: opts.scopes ?? ["api", "read_repository", "write_repository"],
        expires_at: opts.expiresAt === undefined ? "2099-01-01" : opts.expiresAt,
        active: true,
      });
    }
    // The sign-up group the boot pins by id.
    if (req.method === "GET" && path === "/groups/acme") {
      return json({ id: GROUP_ID, path: "acme" });
    }
    calls.push(call);
    return (await respond(call)) ?? notFound();
  });
  const base = `http://127.0.0.1:${server.addr.port}`;
  return {
    base,
    calls,
    paths: () => calls.map((c) => `${c.method} ${c.path}`),
    set: (fn: Responder) => {
      respond = fn;
    },
    shutdown: () => server.shutdown(),
  };
}

function botApi(base: string, extra: Partial<GitlabForgeOptions> = {}) {
  repo.forgeId = gitlabProjectRef(base.replace(/\/+$/, ""), P);
  return gitlabForgeApi({
    mode: "bot",
    url: base,
    token: staticUserToken(TOKEN, GITLAB_TOKEN_NAMES),
    webhookSecret: "master-secret",
    oauth: { clientId: "app-id", clientSecret: "app-secret" },
    group: "acme",
    diag: silentDiagnostics(),
    ...extra,
  });
}

// ---- boot -----------------------------------------------------------------------------------

test("boot reads who the token is, the version and the scopes, and answers the mode", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(`${gl.base}/`);
    assertEquals(api.self, { id: String(BOT_ID), login: BOT });
    assertEquals(api.mode, {
      mode: "bot",
      login: BOT,
      accountId: gitlabAccountId(gl.base, String(BOT_ID)),
      url: gl.base,
      signIn: true,
    });
    assertEquals(gl.calls, []);
    // Without an OAuth application nobody signs in through GitLab, and the mode says so.
    assertEquals((await botApi(gl.base, { oauth: null })).mode.signIn, false);
  } finally {
    await gl.shutdown();
  }
});

test("a GitLab older than 17.0 fails the boot, terminally", async () => {
  const gl = await fakeGitlab({ version: "16.11.3" });
  try {
    const err = await assertRejects(() => botApi(gl.base), ForgeApiError);
    assertStringIncludes(err.message, "16.11");
    assertStringIncludes(err.message, "17.0");
    assert(err.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("a bot token missing a scope fails the boot naming it, never the token", async () => {
  const gl = await fakeGitlab({ scopes: ["api", "read_repository"] });
  try {
    const err = await assertRejects(() => botApi(gl.base), ForgeApiError);
    assertStringIncludes(err.message, "write_repository");
    assert(!err.message.includes(TOKEN));
  } finally {
    await gl.shutdown();
  }
});

test("a bot token whose scopes cannot be read fails the boot", async () => {
  const gl = await fakeGitlab({ scopes: null });
  try {
    const err = await assertRejects(() => botApi(gl.base), ForgeApiError);
    assertStringIncludes(err.message, "personal_access_tokens/self");
  } finally {
    await gl.shutdown();
  }
});

test("a token expiring within 14 days warns, and one further out does not", async () => {
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const gl = await fakeGitlab({ expiresAt: soon });
  try {
    const { diag, events } = recordingDiagnostics();
    await botApi(gl.base, { diag });
    assert(events.some((e) => e.event === "gitlab.token_expiring"));
  } finally {
    await gl.shutdown();
  }
  const later = await fakeGitlab();
  try {
    const { diag, events } = recordingDiagnostics();
    await botApi(later.base, { diag });
    assert(!events.some((e) => e.event === "gitlab.token_expiring"));
  } finally {
    await later.shutdown();
  }
});

test("a GitLab newer than the quick-action escape was verified against boots, and says so", async () => {
  const [major, minor] = QUICK_ACTION_ESCAPE_VERIFIED;
  for (
    const [version, warned] of [
      [`${major}.${minor}.3-ee`, false],
      [`${major}.${minor + 1}.0`, true],
      [`${major + 1}.0.0-pre`, true],
    ] as const
  ) {
    const gl = await fakeGitlab({ version });
    try {
      const { diag, events } = recordingDiagnostics();
      await botApi(gl.base, { diag });
      assertEquals(
        events.some((e) =>
          e.level === "warn" && e.event === "gitlab.quick_action_escape_unverified"
        ),
        warned,
        version,
      );
    } finally {
      await gl.shutdown();
    }
  }
});

test("17.0–17.3 boots, and its image reads answer 404 without asking GitLab", async () => {
  const gl = await fakeGitlab({ version: "17.2.0" });
  try {
    const { diag, events } = recordingDiagnostics();
    let got: Response | null = null;
    const slots: GitlabImageSlots = (owner, body, source) =>
      body.includes("/uploads/")
        ? [{
          owner,
          markup: body,
          fetch: async (signal) => {
            got = await source.get(`/projects/${source.projectId}/uploads/abc/x.png`, signal);
            return { kind: "omitted", reason: "unavailable" };
          },
        }]
        : [];
    const api = await botApi(gl.base, { diag, imageSlots: slots });
    assert(events.some((e) => e.event === "gitlab.images_unavailable"));
    gl.set(({ path }) => {
      if (path === `/projects/${P}/issues/3`) {
        return json({
          iid: 3,
          project_id: 42,
          confidential: false,
          title: "t",
          description: "/uploads/x",
          state: "opened",
        });
      }
      if (path.startsWith(`/projects/${P}/issues/3/discussions`)) return json([]);
      return null;
    });
    await api.fetchThread(repo, { kind: "issue", ref: "issue-3" }, { images: { focus: null } });
    assertEquals((got as Response | null)?.status, 404);
    assert(!gl.paths().some((p) => p.includes("/uploads/")));
  } finally {
    await gl.shutdown();
  }
});

test("a GitLab that cannot be reached fails the boot naming where it was dialled", async () => {
  const err = await assertRejects(() => botApi("http://127.0.0.1:1"), ForgeApiError);
  assertStringIncludes(err.message, "http://127.0.0.1:1");
  assert(!err.terminal);
});

test("a token GitLab refuses fails the boot terminally, without the token", async () => {
  const gl = await fakeGitlab();
  try {
    const err = await assertRejects(
      () => botApi(gl.base, { token: staticUserToken("glpat-wrong", GITLAB_TOKEN_NAMES) }),
      ForgeApiError,
    );
    assert(err.terminal);
    assert(!err.message.includes("glpat-wrong"));
  } finally {
    await gl.shutdown();
  }
});

// ---- spellings ------------------------------------------------------------------------------

test("threadKind: !7, mr-7, #12, issue-12 are believed once GitLab has them; a bare number is asked", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      if (path === `/projects/${P}/merge_requests/7`) return json({ iid: 7 });
      if (path === `/projects/${P}/issues/12`) return json({ iid: 12 });
      if (path === `/projects/${P}/issues/5` || path === `/projects/${P}/merge_requests/5`) {
        return json({ iid: 5 });
      }
      return null;
    });
    assertEquals(await api.threadKind(repo, "!7"), "change_request");
    assertEquals(await api.threadKind(repo, "mr-7"), "change_request");
    assertEquals(await api.threadKind(repo, "#12"), "issue");
    assertEquals(await api.threadKind(repo, "issue-12"), "issue");
    assertEquals(await api.threadKind(repo, "12"), "issue");
    assertEquals(await api.threadKind(repo, "7"), "change_request");

    const both = await assertRejects(() => api.threadKind(repo, "5"), ForgeApiError);
    assert(both.terminal);
    assertStringIncludes(both.message, "#5");
    assertStringIncludes(both.message, "!5");

    const none = await assertRejects(() => api.threadKind(repo, "99"), ForgeApiError);
    assert(none.terminal);
    const missing = await assertRejects(() => api.threadKind(repo, "!99"), ForgeApiError);
    assert(missing.terminal);
    const junk = await assertRejects(() => api.threadKind(repo, "pr-3"), ForgeApiError);
    assert(junk.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("a bare number whose probe hits a 5xx is retryable, never a guess", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) =>
      path.includes("/issues/") ? json({ message: "boom" }, { status: 502 }) : null
    );
    const err = await assertRejects(() => api.threadKind(repo, "4"), ForgeApiError);
    assert(!err.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("a repo naming a tenant is a terminal wiring fault", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const err = await assertRejects(
      () => api.threadKind({ repoRef: "acme/app", tenantId: "42" }, "!1"),
      ForgeApiError,
    );
    assert(err.terminal);
    assertEquals(gl.calls, []);
  } finally {
    await gl.shutdown();
  }
});

// ---- permission -----------------------------------------------------------------------------

test("checkPermission: by project id and account id; Developer writes, Maintainer administers, only an active membership counts, 404 denies, 5xx is unknown", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const byId = { ...repo, forgeId: gitlabProjectRef(gl.base, "77") };
    const who = (id: number | string) => gitlabAccountId(gl.base, String(id));
    const levels: Record<string, number> = {
      "1": 30,
      "2": 40,
      "3": 20,
      "6": 40,
      "7": 30,
      [BOT_ID]: 30,
    };
    // GitLab lists a membership awaiting approval, and a blocked account's, with their levels.
    const extra: Record<string, Record<string, string>> = {
      "6": { membership_state: "awaiting", state: "active" },
      "7": { membership_state: "active", state: "blocked" },
    };
    gl.set(({ path }) => {
      const member = /^\/projects\/77\/members\/all\/(\d+)$/.exec(path)?.[1];
      if (member === "5") return json({ message: "oops" }, { status: 503 });
      if (member !== undefined && levels[member] !== undefined) {
        return json({ id: Number(member), access_level: levels[member], ...extra[member] });
      }
      return null;
    });
    assertEquals(await api.checkPermission(byId, who(1), "write"), "allowed");
    assertEquals(await api.checkPermission(byId, who(1), "admin"), "denied");
    assertEquals(await api.checkPermission(byId, who(2), "admin"), "allowed");
    assertEquals(await api.checkPermission(byId, who(3), "write"), "denied");
    assertEquals(await api.checkPermission(byId, who(4), "write"), "denied");
    assertEquals(await api.checkPermission(byId, who(5), "write"), "unknown");
    assertEquals(await api.checkPermission(byId, null, "write"), "denied");
    assertEquals(await api.checkPermission(byId, who(6), "write"), "denied");
    assertEquals(await api.checkPermission(byId, who(7), "write"), "denied");
    assertEquals(await api.checkPermission(byId, who(BOT_ID), "write"), "allowed");
    // Ids only: one read of the membership, nobody looked up by name.
    assert(
      gl.paths().every((p) => p.startsWith("GET /projects/77/members/all/")),
      gl.paths().join(),
    );

    gl.calls.length = 0;
    // A username is never a subject — the bot's own included: a name its holder can give up and
    // anybody can register next would inherit whatever was asked about it.
    assertEquals(await api.checkPermission(byId, "dev", "write"), "denied");
    assertEquals(await api.checkPermission(byId, BOT, "write"), "denied");
    assertEquals(
      await api.checkPermission(byId, "1", "write"),
      "denied",
      "a bare id names no instance",
    );
    // An account on another instance names nobody here.
    assertEquals(
      await api.checkPermission(byId, gitlabAccountId("https://gitlab.example", "1"), "write"),
      "denied",
    );
    // Nor is a project asked about without its id on this instance.
    assertEquals(
      await api.checkPermission({ ...repo, forgeId: undefined }, who(1), "write"),
      "denied",
    );
    assertEquals(
      await api.checkPermission(
        { ...repo, forgeId: gitlabProjectRef("https://gitlab.example", "77") },
        who(1),
        "write",
      ),
      "denied",
    );
    assertEquals(gl.calls, []);
  } finally {
    await gl.shutdown();
  }
});

// ---- delivery -------------------------------------------------------------------------------

test("openMergeRequest: opens with a Draft prefix, adopts on 409, and names terminality", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ method }) =>
      method === "POST" ? json({ iid: 7, web_url: "https://gl/mr/7" }, { status: 201 }) : null
    );
    assertEquals(
      await api.openMergeRequest(repo, {
        title: "Fix it",
        body: "b",
        head: "ryph/x",
        base: "main",
        draft: true,
      }),
      { ref: "mr-7", url: "https://gl/mr/7" },
    );
    assertEquals(gl.calls[0].path, `/projects/${P}/merge_requests`);
    assertEquals(gl.calls[0].body, {
      source_branch: "ryph/x",
      target_branch: "main",
      title: "Draft: Fix it",
      description: "b",
      allow_collaboration: false,
      remove_source_branch: true,
    });

    gl.calls.length = 0;
    gl.set(({ method, path }) => {
      if (method === "POST") {
        return json({
          message: ["Another open merge request already exists for this source branch: !8"],
        }, { status: 409 });
      }
      if (path.startsWith(`/projects/${P}/merge_requests?`)) {
        return json([
          { iid: 3, source_branch: "ryph/x", target_branch: "release", web_url: "u3" },
          { iid: 8, source_branch: "ryph/x", target_branch: "main", web_url: "u8" },
        ]);
      }
      return null;
    });
    const adopted = await api.openMergeRequest(repo, {
      title: "t",
      body: "b",
      head: "ryph/x",
      base: "main",
      draft: false,
    });
    assertEquals(adopted, { ref: "mr-8", url: "u8" });
    assertEquals(
      gl.calls[1].path,
      `/projects/${P}/merge_requests?state=opened&source_branch=ryph%2Fx&target_branch=main`,
    );

    for (
      const [status, terminal] of [[400, true], [403, true], [500, false], [429, false]] as const
    ) {
      gl.set(() => json({ message: "nope" }, { status }));
      const err = await assertRejects(
        () =>
          api.openMergeRequest(repo, {
            title: "t",
            body: "b",
            head: "h",
            base: "main",
            draft: false,
          }),
        ForgeApiError,
      );
      assertEquals(err.terminal, terminal, `status ${status}`);
    }
    // A 409 with no open match to adopt is final.
    gl.set(({ method }) =>
      method === "POST"
        ? json({ message: ["Another open merge request already exists"] }, { status: 409 })
        : json([])
    );
    const none = await assertRejects(
      () =>
        api.openMergeRequest(repo, {
          title: "t",
          body: "b",
          head: "h",
          base: "main",
          draft: false,
        }),
      ForgeApiError,
    );
    assert(none.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("pushAuth and fetchAuth frame the token as Basic oauth2:, on the instance only", async () => {
  const gl = await fakeGitlab();
  try {
    const { diag, events } = recordingDiagnostics();
    const api = await botApi(gl.base, { diag });
    gl.set(({ path }) =>
      path === `/projects/${P}/members/all/${BOT_ID}` ? json({ access_level: 40 }) : null
    );
    const auth = await api.pushAuth(repo, `${gl.base}/acme/platform/app.git`);
    assertEquals(auth?.basicUser, "oauth2");
    assertEquals(auth?.scheme, "basic");
    assertEquals(auth?.token, TOKEN);
    assertEquals(auth?.origin, gl.base);
    // A fork on the same instance is pushable in bot mode.
    assert((await api.pushAuth(repo, `${gl.base}/someone/app.git`)) !== null);
    // The over-privilege warning is read once per project.
    assertEquals(events.filter((e) => e.event === "gitlab.bot_overprivileged").length, 1);
    assertEquals(gl.paths(), [`GET /projects/${P}/members/all/${BOT_ID}`]);

    const off = await assertRejects(
      () => api.pushAuth(repo, "https://evil.example/acme/platform/app.git"),
      ForgeApiError,
    );
    assert(off.terminal);
    assertEquals(await api.fetchAuth(repo, "https://evil.example/acme/platform/app.git"), null);
    assertEquals(await api.fetchAuth(repo, "/tmp/upstream"), null);
    assertEquals(await api.pushAuth(repo, "/tmp/upstream"), null);
    // A GitLab project is fetched where its id is now (`locateUpstream`), never at a URL.
    assert(assertThrows(() => api.upstreamUrl(repo, "u"), ForgeApiError).terminal);
  } finally {
    await gl.shutdown();
  }
});

// ---- comments -------------------------------------------------------------------------------

test("comments are notes on their noteable, handled as <thread>:<note>", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ method, path }) => {
      if (method === "POST" && path.endsWith("/notes")) return json({ id: 88 }, { status: 201 });
      if (method === "PUT") return json({ id: 88 });
      if (path.endsWith("/award_emoji")) {
        return path.includes("/89/")
          ? json({ message: { name: ["has already been taken"] } }, { status: 400 })
          : json({ id: 1 }, { status: 201 });
      }
      return null;
    });
    assertEquals(
      await api.postComment(repo, { kind: "change_request", ref: "mr-7" }, "hi"),
      { commentId: "mr-7:88" },
    );
    assertEquals(
      await api.createComment(repo, { kind: "issue", ref: "#12" }, "hi"),
      { url: `${gl.base}/acme/platform/app/-/issues/12#note_88` },
    );
    await api.updateComment(repo, "mr-7:88", "edited");
    await api.addReaction(repo, "mr-7:88", "eyes");
    // Already awarded is a success.
    await api.addReaction(repo, "issue-12:89", "eyes");
    // A diff note's remark handle reacts through the same note route.
    await api.addReaction(repo, `mr-7:${"a".repeat(40)}:88`, "eyes");
    assertEquals(gl.paths(), [
      `POST /projects/${P}/merge_requests/7/notes`,
      `POST /projects/${P}/issues/12/notes`,
      `PUT /projects/${P}/merge_requests/7/notes/88`,
      `POST /projects/${P}/merge_requests/7/notes/88/award_emoji`,
      `POST /projects/${P}/issues/12/notes/89/award_emoji`,
      `POST /projects/${P}/merge_requests/7/notes/88/award_emoji`,
    ]);
    assertEquals(gl.calls[3].body, { name: "eyes" });
    const bad = await assertRejects(() => api.updateComment(repo, "88", "x"), ForgeApiError);
    assert(bad.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("inertToQuickActions: no line of what ryph writes starts with a command", () => {
  // GitLab runs a line whose very first character is `/`, then a command name and a space or the
  // line's end; a zero-width space before the `/` renders as nothing, and neither the source line
  // nor the rendered one then starts with `/`.
  const Z = "\u200B";
  // Anywhere but a diff note, which is never escaped (see below).
  const inert = (text: string) => inertToQuickActions(text, { suggestions: false });
  assertEquals(inert("/close"), `${Z}/close`);
  assertEquals(inert("done\n/merge\n/label ~x"), `done\n${Z}/merge\n${Z}/label ~x`);
  // CRLF and a lone CR are line breaks: GitLab deletes `\r`, so `\r/close` would start a line.
  assertEquals(inert("a\r\n/close\r/approve"), `a\n${Z}/close\n${Z}/approve`);
  // After blanks too, which GitLab's rendered text drops.
  assertEquals(inert(" /label ~x\n\t/close"), ` ${Z}/label ~x\n\t${Z}/close`);
  // A leading byte-order mark, which GitLab's markdown drops, is dropped first.
  assertEquals(inert("\uFEFF/close\n\uFEFF\uFEFFx"), `${Z}/close\n\uFEFF\uFEFFx`);
  assertEquals(inert("\uFEFF\uFEFF /close"), ` ${Z}/close`);
  // Whatever block a line is in: code too — no markdown is asked.
  assertEquals(
    inert("```sh\n/close\n  /approve now\n```\n: x\n  ```\n/merge"),
    `\`\`\`sh\n${Z}/close\n  ${Z}/approve now\n\`\`\`\n: x\n  \`\`\`\n${Z}/merge`,
  );
  // Any case, any name-like run past ASCII (Ruby folds `ſ` to `s`), any blank after it.
  assertEquals(
    inert("/CLOSE\n/cloſe\n/close\tx\n/x"),
    `${Z}/CLOSE\n${Z}/cloſe\n${Z}/close\tx\n${Z}/x`,
  );
  // Everything else is left exactly as written: no command name can follow these `/`s.
  const plain = "a/b\n// c\n/* d */\n/ e\n/.f\n/usr/bin/env\n/close/x\n> /close";
  assertEquals(inert(plain), plain);
});

/** A note on a line of the diff: where GitLab finds suggestions. */
const DIFF_NOTE = { suggestions: true };

test("inertToQuickActions: a diff note is posted as written, its clean suggestions first", () => {
  // Taken out, posted first with their lines untouched; the rest as written.
  assertEquals(
    inertToQuickActions("Rather:\n```suggestion:-1+2\n/usr/bin/env\n```\nThanks", DIFF_NOTE),
    "```suggestion:-1+2\n/usr/bin/env\n```\n\nRather:\nThanks",
  );
  // GitLab's spellings: none of lines above or below, escapes and references in the info.
  assertEquals(
    inertToQuickActions("~~~suggestion\nx\n~~~", DIFF_NOTE),
    "```suggestion:-0+0\nx\n```",
  );
  assertEquals(
    inertToQuickActions("```sugg&#x65;stion:+3\nx\n```", DIFF_NOTE),
    "```suggestion:-0+3\nx\n```",
  );
  // A fence longer than any backtick run in it, so none of its lines can close it.
  assertEquals(
    inertToQuickActions("~~~suggestion\n```\n`````\n~~~", DIFF_NOTE),
    "``````suggestion:-0+0\n```\n`````\n``````",
  );
  // A leading byte-order mark is dropped: it hid a column-0 fence that GitLab's markdown, which
  // drops it too, reads as a suggestion.
  assertEquals(
    inertToQuickActions("\uFEFF```suggestion\n/usr/bin/x\n```", DIFF_NOTE),
    "```suggestion:-0+0\n/usr/bin/x\n```",
  );
  // Whatever else GitLab may read as a suggestion — in a container, in raw HTML, front matter,
  // an info string this side does not take — goes out byte for byte, so "Apply suggestion"
  // commits the agent's own text; and no zero-width space is ever added to a diff note.
  for (
    const text of [
      "- ```suggestion\n  x\n  ```",
      " ```suggestion\nx\n```",
      "```suggestion:-1+1 x\nx\n```",
      "```SUGGESTION\nx\n```",
      "```sugg&shy;estion\nx\n```",
      "text\n````md\n```suggestion\nx\n```\n````",
      "> ```suggestion\n> x\n> ```",
      "Term\n: ```suggestion\nx\n```",
      "1. a\n\n   ~~~ sugg\\estion\n   x\n   ~~~",
      "[^1]: ```suggestion\nx\n```",
      '<pre lang="suggestion">\nx\n</pre>',
      'Fix:\n\n<pre data-canonical-lang=\n"suggestion" data-lang-params="-0+0"><code>/* keep */\n' +
      "  int x;\n</code></pre>",
      '<pre data-canonical-lang="&#115uggestion"><code>/usr/bin/env\n</code></pre>',
      "---suggestion\nconst x = 1;\n---\nPlease apply.",
      "\n\n+++ suggestion\nx = 1\n...\n",
      "# -*- coding: utf-8 -*-\n;;;suggestion:-2+0\n  x\n;;;",
      "```suggestion\nnever closed",
      "Just prose, a/b and `/close`.",
    ]
  ) {
    assertEquals(inertToQuickActions(text, DIFF_NOTE), text, text);
  }
});

test("inertToQuickActions: a diff note with a `/` line outside its suggestions is refused", () => {
  // Under every blank, zero-width or format character GitLab or a reader of it might skip, in
  // any block, a suggestion's own lines aside — the round-9 front matter and byte-order-mark
  // bodies among them, whose `/` lines once carried the escape into "Apply suggestion".
  for (
    const [text, line] of [
      ["/close", 1],
      ["Rather:\n```suggestion\nx\n```\n/close", 5],
      ["ok\n /close", 2],
      ["ok\n\t/close", 2],
      ["\u200B/close", 1],
      ["x\n\u200C\u200D\u2060\uFEFF/merge", 2],
      ["x\n\u00A0\u2003\u3000/approve", 2],
      ["x\n\u00AD\u034F\u180E/approve", 2],
      ["x\r/approve", 2],
      ["```sh\n/approve\n```", 2],
      ["x\n/MERGE", 2],
      ["x\n/Merge now", 2],
      ["x\n/merge\t", 2],
      ["x\n/cloſe", 2],
      ["x\n/\u200Bclose", 2],
      ["- ```suggestion\n  /x\n  ```", 2],
      ["> ```suggestion\n/x\n> ```", 2],
      ["```suggestion\n/x", 2],
      ["---suggestion\n/close\nconst x = 1;\n---\nPlease apply.", 2],
      ["\n\n+++ suggestion\n/close\n...\n", 4],
      ["# -*- coding: utf-8 -*-\n;;;suggestion:-2+0\n  /x\n;;;", 3],
      ['<pre lang="suggestion">\n/x\n</pre>', 2],
      ['<pre data-canonical-lang="&#115uggestion"><code>\n/close\n</code></pre>', 2],
      ["\uFEFF\u200B/close", 1],
    ] as const
  ) {
    const err = assertThrows(
      () => inertToQuickActions(text, DIFF_NOTE),
      ForgeApiError,
      `line ${line} starts with "/"`,
    );
    assert(err.terminal, text);
    assertStringIncludes(err.message, "its own fence at the start of a line");
  }
});

test("inertToQuickActions: a diff note's code comments and paths are posted as written", () => {
  // No command name can follow these `/`s, so GitLab's extractor never matches them.
  const text =
    "Like this:\n```ts\n// comment\n/* block */\n/usr/bin/env node\n```\n// also prose\n" +
    "/ spaced\n/.hidden\n/close/x";
  assertEquals(inertToQuickActions(text, DIFF_NOTE), text);
  assertEquals(inertToQuickActions(text, { suggestions: false }), text);
});

test("inertToQuickActions: prose about suggestions is posted wherever it goes", () => {
  const Z = "\u200B";
  // Mentions that open no code block: refused once, they kept a run's merge request from ever
  // opening and its status comment from ever leaving "working".
  const prose = [
    'Replaced the `<ul class="suggestions">` list',
    "Take `lang=suggestion` out of the config.\n/close",
    '```html\n<li class="suggestion" lang="en">\n/x\n```',
    "x ```suggestion is not a fence\n``` a`b suggestion",
    '<div class="suggestions">\n/close\n</div>',
  ];
  for (const text of prose) {
    const escaped = text.split("\n").map((l) => l.replace(/^\//, `${Z}/`)).join("\n");
    assertEquals(inertToQuickActions(text, { suggestions: false }), escaped, text);
    if (escaped === text) assertEquals(inertToQuickActions(text, DIFF_NOTE), text, text);
  }
  // Where GitLab finds no suggestion at all (a description, a note, a review's body), nothing is
  // refused and nothing moves: a suggestion there is an example, escaped like any other text.
  for (
    const text of [
      "- ```suggestion\n  /x\n  ```",
      '<pre data-canonical-lang=\n"suggestion"><code>/x\n</code></pre>',
      "Rather:\n```suggestion:-0+0\n/x\n```",
      "---suggestion\n/x\n---",
    ]
  ) {
    assertEquals(
      inertToQuickActions(text, { suggestions: false }),
      text.split("\n").map((l) => l.replace(/^( *)\//, `$1${Z}/`)).join("\n"),
    );
  }
});

test("every body ryph writes goes out inert to quick actions; a commands-only note is final", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    let commandsOnly = false;
    gl.set(({ method, path }) => {
      if (method === "POST" && path.endsWith("/notes")) {
        return commandsOnly
          ? json({ commands_changes: { state_event: "close" }, summary: ["Closed"] }, {
            status: 202,
          })
          : json({ id: 88 }, { status: 201 });
      }
      if (method === "PUT") return json({ id: 88 });
      if (method === "POST" && path.endsWith("/issues")) {
        return json({ iid: 3, web_url: "https://gl/i/3" }, { status: 201 });
      }
      if (method === "POST" && path.endsWith("/merge_requests")) {
        return json({ iid: 4, web_url: "https://gl/m/4" }, { status: 201 });
      }
      return null;
    });
    const evil = "fine\n/close\n /label ~x";
    const inert = "fine\n\u200B/close\n \u200B/label ~x";
    await api.postComment(repo, { kind: "change_request", ref: "mr-7" }, evil);
    await api.createComment(repo, { kind: "issue", ref: "#12" }, evil);
    await api.updateComment(repo, "mr-7:88", evil);
    // A reply in a diff note's discussion, or an edit of one, is a diff note: never escaped,
    // refused before anything is sent.
    for (
      const write of [
        () => api.replyToReviewComment(repo, "mr-7", `mr-7:${DISC}:11`, evil),
        () => api.updateComment(repo, `mr-7:${DISC}:11`, evil),
      ]
    ) {
      const refused = await assertRejects(write, ForgeApiError, 'line 2 starts with "/"');
      assert(refused.terminal);
    }
    await api.createIssue(repo, { title: "/close", body: evil, labels: [] });
    await api.openMergeRequest(repo, {
      title: "t",
      body: evil,
      head: "feat",
      base: "main",
      draft: false,
    });
    assertEquals(gl.calls.filter((c) => c.method !== "GET").map((c) => c.body), [
      { body: inert },
      { body: inert },
      { body: inert },
      // A title runs no quick action, and is sent as written.
      { title: "/close", description: inert },
      {
        source_branch: "feat",
        target_branch: "main",
        title: "t",
        description: inert,
        allow_collaboration: false,
        remove_source_branch: true,
      },
    ]);

    // GitLab's 202: it carried out commands and stored no note. Asking again would act again.
    commandsOnly = true;
    const err = await assertRejects(
      () => api.postComment(repo, { kind: "issue", ref: "issue-12" }, "x"),
      ForgeApiError,
    );
    assert(err.terminal);
  } finally {
    await gl.shutdown();
  }
});

// ---- threads --------------------------------------------------------------------------------

const note = (id: number, body: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  body,
  created_at: at,
  system: false,
  type: null,
  internal: false,
  confidential: false,
  author: { id: 1, username: "ada" },
  ...extra,
});
const DISC = "6a9c".padEnd(40, "e");

/** A merge request and its projects, as `readHead` asks for them. */
function mrRoutes(path: string, mr: Record<string, unknown> = {}): Response | null {
  if (path === `/projects/${P}/merge_requests/7`) {
    return json({
      iid: 7,
      project_id: 42,
      title: "Add scheduler",
      description: "the MR body",
      state: "opened",
      author: { id: 1, username: "ada" },
      created_at: "2026-10-01T00:00:00Z",
      sha: "head111",
      source_branch: "feat/s",
      target_branch: "main",
      web_url: "https://gl/acme/platform/app/-/merge_requests/7",
      source_project_id: 42,
      target_project_id: 42,
      allow_collaboration: false,
      diff_refs: { base_sha: "base000", start_sha: "start00", head_sha: "head111" },
      ...mr,
    });
  }
  if (path === "/projects/42") {
    return json({
      id: 42,
      path_with_namespace: "acme/platform/app",
      http_url_to_repo: "https://gl/acme/platform/app.git",
      default_branch: "main",
    });
  }
  return null;
}

test("fetchThread reads an issue and its discussions, oldest first", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      if (path === `/projects/${P}/issues/12`) {
        return json({
          iid: 12,
          confidential: false,
          title: "Bug",
          description: "it breaks",
          state: "opened",
          author: { username: "grace" },
          created_at: "2026-10-01T00:00:00Z",
        });
      }
      if (path === `/projects/${P}/issues/12/discussions?per_page=100&page=1`) {
        return json([
          { id: "d1", individual_note: true, notes: [note(2, "second", "2026-10-03T00:00:00Z")] },
          { id: "d0", individual_note: true, notes: [note(1, "first", "2026-10-02T00:00:00Z")] },
          {
            id: "d2",
            individual_note: true,
            notes: [note(3, "added label", "2026-10-04T00:00:00Z", { system: true })],
          },
        ]);
      }
      return null;
    });
    const thread = await api.fetchThread(repo, { kind: "issue", ref: "#12" });
    assertEquals(thread.ref, "issue-12");
    assertEquals(thread.title, "Bug");
    assertEquals(thread.body, "it breaks");
    assertEquals(thread.state, "open");
    assertEquals(thread.authorLogin, "grace");
    assertEquals(thread.changeRequest, null);
    assertEquals(thread.truncated, false);
    assertEquals(thread.entries.map((e) => [e.kind, e.body, e.id]), [
      ["comment", "first", "issue-12:1"],
      ["comment", "second", "issue-12:2"],
    ]);
  } finally {
    await gl.shutdown();
  }
});

test("fetchThread never reads an internal note, nor its images, nor a confidential issue", async () => {
  const gl = await fakeGitlab();
  try {
    const bodies: string[] = [];
    const slots: GitlabImageSlots = (_owner, body) => {
      bodies.push(body);
      return [];
    };
    const api = await botApi(gl.base, { imageSlots: slots });
    let confidential: unknown = false;
    gl.set(({ path }) => {
      if (path === `/projects/${P}/issues/12`) {
        return json({
          iid: 12,
          project_id: 42,
          title: "Bug",
          description: "it breaks",
          state: "opened",
          ...(confidential === undefined ? {} : { confidential }),
        });
      }
      if (path === `/projects/${P}/issues/12/discussions?per_page=100&page=1`) {
        return json([
          { id: "d0", individual_note: true, notes: [note(1, "public", "2026-10-02T00:00:00Z")] },
          {
            id: "d1",
            individual_note: true,
            notes: [
              note(2, "staff ![x](/uploads/ab/x.png)", "2026-10-03T00:00:00Z", { internal: true }),
            ],
          },
          {
            id: "d2",
            individual_note: true,
            // The older name alone.
            notes: [note(3, "old name", "2026-10-04T00:00:00Z", { confidential: true })],
          },
          {
            id: "d3",
            individual_note: true,
            // An answer that does not say is taken to be internal.
            notes: [note(4, "unsaid", "2026-10-05T00:00:00Z", { internal: undefined })],
          },
        ]);
      }
      return null;
    });
    const thread = await api.fetchThread(repo, { kind: "issue", ref: "#12" }, {
      images: { focus: null },
    });
    assertEquals(thread.entries.map((e) => e.body), ["public"]);
    assert(!bodies.some((b) => b.includes("staff")));

    for (const said of [true, undefined]) {
      confidential = said;
      gl.calls.length = 0;
      const err = await assertRejects(
        () => api.fetchThread(repo, { kind: "issue", ref: "#12" }),
        ForgeApiError,
      );
      assert(err.terminal);
      assertStringIncludes(err.message, "confidential");
      assert(!gl.paths().some((p) => p.includes("/discussions")));
    }
  } finally {
    await gl.shutdown();
  }
});

test("fetchThread on a merge request: comments, diff notes as remarks, verdicts from system notes, the head", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      if (path === `/projects/${P}/merge_requests/7/discussions?per_page=100&page=1`) {
        return json([
          {
            id: "c".repeat(40),
            individual_note: true,
            notes: [note(10, "looks big", "2026-10-02T00:00:00Z")],
          },
          {
            id: DISC,
            individual_note: false,
            notes: [
              note(11, "rename this", "2026-10-03T00:00:00Z", {
                type: "DiffNote",
                resolvable: true,
                resolved: true,
                position: {
                  new_path: "src/a.ts",
                  new_line: 14,
                  old_path: "src/a.ts",
                  old_line: null,
                },
              }),
              note(12, "done", "2026-10-04T00:00:00Z", {
                type: "DiffNote",
                resolvable: true,
                resolved: true,
                position: { new_path: "src/a.ts", new_line: 14 },
              }),
            ],
          },
          {
            id: "d".repeat(40),
            individual_note: false,
            notes: [
              note(13, "why removed?", "2026-10-03T12:00:00Z", {
                type: "DiffNote",
                resolvable: true,
                resolved: false,
                position: {
                  old_path: "src/b.ts",
                  old_line: 3,
                  new_path: "src/b.ts",
                  new_line: null,
                },
              }),
            ],
          },
          {
            id: "e".repeat(40),
            individual_note: true,
            notes: [
              note(14, "approved this merge request", "2026-10-05T00:00:00Z", {
                system: true,
                author: { username: "grace" },
              }),
            ],
          },
          {
            id: "f".repeat(40),
            individual_note: true,
            notes: [note(15, "changed the description", "2026-10-05T01:00:00Z", { system: true })],
          },
        ]);
      }
      return mrRoutes(path);
    });
    const thread = await api.fetchThread(repo, { kind: "change_request", ref: "!7" });
    assertEquals(thread.ref, "mr-7");
    assertEquals(
      thread.entries.map((e) => [e.kind, e.authorLogin, e.body, e.state, e.location]),
      [
        ["comment", "ada", "looks big", null, null],
        ["review_comment", "ada", "rename this", null, "src/a.ts:14"],
        ["review_comment", "ada", "why removed?", null, "src/b.ts:3"],
        ["review_comment", "ada", "done", null, "src/a.ts:14"],
        ["review", "grace", "", "approved", null],
      ],
    );
    const [, opener, open, reply] = thread.entries;
    assertEquals(opener.id, "mr-7:11");
    assertEquals(opener.remark, { id: `mr-7:${DISC}:11`, replyTo: null, resolved: true });
    assertEquals(reply.remark, {
      id: `mr-7:${DISC}:12`,
      replyTo: `mr-7:${DISC}:11`,
      resolved: true,
    });
    assertEquals(open.remark?.resolved, false);
    assertEquals(thread.changeRequest?.ref, "mr-7");
    assertEquals(thread.changeRequest?.headSha, "head111");
    assertEquals(thread.changeRequest?.defaultBranch, "main");
    assertEquals(thread.changeRequest?.headRepoRef, "acme/platform/app");
  } finally {
    await gl.shutdown();
  }
});

test("verdict system notes: approved, unapproved and requested changes", async () => {
  const { verdictOf } = await import("../src/adapters/forge_api/gitlab_threads.ts");
  assertEquals(verdictOf("approved this merge request"), "approved");
  assertEquals(verdictOf("unapproved this merge request"), "unapproved");
  assertEquals(verdictOf("requested changes"), "changes_requested");
  assertEquals(verdictOf("added 1 commit"), null);
});

test("fetchThread: a deleted thread is terminal, a bad minute is not", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(() => null);
    const gone = await assertRejects(
      () => api.fetchThread(repo, { kind: "issue", ref: "issue-4" }),
      ForgeApiError,
    );
    assert(gone.terminal);
    gl.set(() => json({ message: "down" }, { status: 503 }));
    const flaky = await assertRejects(
      () => api.fetchThread(repo, { kind: "issue", ref: "issue-4" }),
      ForgeApiError,
    );
    assert(!flaky.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("fetchThread reports the page ceiling as a truncated prefix, never a whole thread", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      if (path === `/projects/${P}/issues/1`) {
        return json({ iid: 1, title: "t", state: "opened", confidential: false });
      }
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
      if (path.includes("/discussions")) {
        const discussions = Array.from({ length: 100 }, (_, i) => {
          const n = (page - 1) * 100 + i;
          const at = new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
          return { id: `d${n}`, individual_note: true, notes: [note(n + 1, `c${n}`, at)] };
        });
        return json(discussions, { headers: { "x-next-page": String(page + 1) } });
      }
      return null;
    });
    const thread = await api.fetchThread(repo, { kind: "issue", ref: "issue-1" });
    assert(thread.truncated);
    // Five pages read; the last discussion's start is the horizon, exclusive.
    assertEquals(thread.entries.length, 499);
    assertEquals(gl.paths().filter((p) => p.includes("/discussions")).length, 5);
  } finally {
    await gl.shutdown();
  }
});

test("fetchThread bounds the bytes it holds, not only the number of notes", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const big = "x".repeat(16_000);
    gl.set(({ path }) => {
      if (path === `/projects/${P}/issues/1`) {
        return json({ iid: 1, title: "t", state: "opened", confidential: false });
      }
      if (path.includes("/discussions")) {
        return json(Array.from({ length: 30 }, (_, i) => ({
          id: `d${i}`,
          individual_note: true,
          notes: [note(i + 1, `${big}${i}`, `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`)],
        })));
      }
      return null;
    });
    const thread = await api.fetchThread(repo, { kind: "issue", ref: "issue-1" });
    assert(thread.truncated);
    assert(thread.entries.length < 30);
    assert(thread.entries.every((e) => e.body.length <= 16_000));
  } finally {
    await gl.shutdown();
  }
});

test("fetchThread with images builds slots per body against the project, with the token", async () => {
  const gl = await fakeGitlab();
  try {
    const seen: Array<{ owner: unknown; body: string; projectId: string; projectPath: string }> =
      [];
    const slots: GitlabImageSlots = (owner, body, source) => {
      seen.push({ owner, body, projectId: source.projectId, projectPath: source.projectPath });
      if (!body.includes("/uploads/")) return [];
      return [{
        owner,
        markup: "![x](/uploads/0123/x.png)",
        fetch: async (signal) => {
          const res = await source.get(`/projects/${source.projectId}/uploads/0123/x.png`, signal);
          return res.status === 200
            ? { kind: "image", bytes: new Uint8Array(await res.arrayBuffer()) }
            : { kind: "omitted", reason: "unavailable" };
        },
      }];
    };
    const api = await botApi(gl.base, { imageSlots: slots });
    gl.set(({ path, auth }) => {
      if (path === `/projects/${P}/issues/3`) {
        return json({
          iid: 3,
          project_id: 42,
          confidential: false,
          title: "t",
          description: "see ![x](/uploads/0123/x.png)",
          state: "opened",
        });
      }
      if (path.startsWith(`/projects/${P}/issues/3/discussions`)) {
        return json([{
          id: "d",
          individual_note: true,
          notes: [note(5, "plain", "2026-01-01T00:00:00Z")],
        }]);
      }
      if (path === "/projects/42/uploads/0123/x.png") {
        assertEquals(auth, `Bearer ${TOKEN}`);
        return new Response(new Uint8Array([1, 2, 3]));
      }
      return null;
    });
    const thread = await api.fetchThread(
      repo,
      { kind: "issue", ref: "issue-3" },
      { images: { focus: null } },
    );
    assertEquals(seen.map((s) => [s.owner, s.projectId, s.projectPath]), [
      ["body", "42", "acme/platform/app"],
      [0, "42", "acme/platform/app"],
    ]);
    assertEquals(thread.bodyImages?.[0].kind, "image");
  } finally {
    await gl.shutdown();
  }
});

// ---- merge requests -------------------------------------------------------------------------

test("describeChangeRequest names where the head lives: here, a fork, a deleted fork, or gone", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    let mr: Record<string, unknown> = {};
    gl.set(({ path }) => {
      if (path === "/projects/77") {
        return json({
          id: 77,
          path_with_namespace: "someone/app",
          http_url_to_repo: "https://gl/someone/app.git",
          default_branch: "trunk",
        });
      }
      if (path.startsWith(`/projects/${P}/merge_requests/7/discussions`)) return json([]);
      return mrRoutes(path, mr);
    });
    const here = await api.describeChangeRequest(repo, "mr-7");
    assertEquals(here.state, "open");
    assertEquals(here.merged, false);
    assertEquals(here.headRef, "feat/s");
    assertEquals(here.baseRef, "main");
    assertEquals(here.headRepoRef, "acme/platform/app");
    // Fork or not by the project ids, which no rename changes.
    assertEquals(here.sameRepo, true);
    assertEquals(here.maintainerCanModify, false);
    assertEquals(here.commitCount, null);

    mr = { source_project_id: 77, allow_collaboration: true };
    const fork = await api.describeChangeRequest(repo, "!7");
    assertEquals(fork.headRepoRef, "someone/app");
    assertEquals(fork.sameRepo, false);
    assertEquals(fork.headRepoUrl, "https://gl/someone/app.git");
    assertEquals(fork.headRepoDefaultBranch, "trunk");
    assertEquals(fork.maintainerCanModify, true);
    assertEquals(fork.defaultBranch, "main");

    // A fork the bot may not see answers 404, as a missing project does — but it has a source
    // id, so it is a fork still: worked from the target's merge request ref, never pushed to.
    mr = { source_project_id: 78 };
    const hidden = await api.describeChangeRequest(repo, "mr-7");
    assertEquals(hidden.headRepoRef, "project 78");
    assertEquals(hidden.headRepoHidden, true);
    assertEquals(hidden.sameRepo, false);
    assertEquals(hidden.headRepoUrl, null);
    assertEquals(hidden.headRepoDefaultBranch, null);

    // A deleted fork: GitLab nulls the merge request's source project (and closes it).
    mr = { source_project_id: null, state: "closed" };
    const deleted = await api.describeChangeRequest(repo, "mr-7");
    assertEquals(deleted.headRepoRef, null);
    assertEquals(deleted.headRepoHidden, undefined);
    assertEquals(deleted.sameRepo, false);
    assertEquals(deleted.headRepoUrl, null);

    // `locked` is a merge underway, never an end: ask again, neither push nor refuse for good.
    mr = { state: "locked" };
    const locked = await assertRejects(
      () => api.describeChangeRequest(repo, "mr-7"),
      ForgeApiError,
    );
    assert(!locked.terminal);
    const lockedState = await api.readChangeRequestState(repo, "mr-7");
    assertEquals([lockedState?.state, lockedState?.merged], ["open", false]);
    const lockedThread = await api.fetchThread(repo, { kind: "change_request", ref: "mr-7" });
    assertEquals([lockedThread.state, lockedThread.changeRequest?.state], ["open", "open"]);
    mr = { state: "merged" };
    const merged = await api.describeChangeRequest(repo, "mr-7");
    assertEquals([merged.state, merged.merged], ["closed", true]);

    mr = { sha: undefined };
    const malformed = await assertRejects(
      () => api.describeChangeRequest(repo, "mr-7"),
      ForgeApiError,
    );
    assert(!malformed.terminal);

    const gone = await assertRejects(() => api.describeChangeRequest(repo, "mr-8"), ForgeApiError);
    assert(gone.terminal);
    const issue = await assertRejects(() => api.describeChangeRequest(repo, "#8"), ForgeApiError);
    assert(issue.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("readChangeRequestState is one read, and knows the bot's own by id", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    let mr: Record<string, unknown> = { author: { id: BOT_ID, username: "renamed-bot" } };
    gl.set(({ path }) => mrRoutes(path, mr));
    const ours = await api.readChangeRequestState(repo, "mr-7");
    assertEquals(ours, {
      ref: "mr-7",
      state: "open",
      merged: false,
      headSha: "head111",
      authorHeadSha: "head111",
      baseRef: "main",
      openedByUs: true,
      mergedHeads: [],
    });
    assertEquals(gl.paths(), [`GET /projects/${P}/merge_requests/7`]);
    mr = { state: "merged", author: { id: 1 } };
    const merged = await api.readChangeRequestState(repo, "mr-7");
    assertEquals(merged?.openedByUs, false);
    assertEquals(merged?.mergedHeads, ["head111"]);
    assertEquals(await api.readChangeRequestState(repo, "mr-9"), null);
  } finally {
    await gl.shutdown();
  }
});

test("classifyBranch: only an MR's head from the project itself is the repo's own", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    let mr: Record<string, unknown> = {};
    gl.set(({ path }) => mrRoutes(path, mr));
    assertEquals(await api.classifyBranch(repo, "feat/x"), "branch");
    assertEquals(gl.calls, []);
    assertEquals(await api.classifyBranch(repo, "merge-requests/7/head"), "branch");
    // The merge result and a merge train hold more than the source branch — a fork's head, or
    // every MR queued ahead — even when this MR's own source is the project. Not even asked.
    const asked = gl.calls.length;
    for (const ref of ["merge-requests/7/merge", "merge-requests/7/train", "merge-requests/7"]) {
      assertEquals(await api.classifyBranch(repo, ref), "foreign", ref);
    }
    assertEquals(gl.calls.length, asked);
    mr = { source_project_id: 77 };
    assertEquals(await api.classifyBranch(repo, "merge-requests/7/head"), "foreign");
    const gone = await assertRejects(
      () => api.classifyBranch(repo, "merge-requests/9/head"),
      ForgeApiError,
    );
    assert(gone.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("files are counted off the hunks; a diff /diffs withheld is read from the head's version", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    let versionBase = "base000";
    gl.set(({ path }) => {
      if (path === `/projects/${P}/merge_requests/7/versions?per_page=100`) {
        return json([{ id: 4, head_commit_sha: "head111" }, { id: 3, head_commit_sha: "older00" }]);
      }
      if (path === `/projects/${P}/merge_requests/7/versions/4`) {
        return json({
          base_commit_sha: versionBase,
          start_commit_sha: "start00",
          head_commit_sha: "head111",
          diffs: [
            { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-x\n+y\n" },
            { old_path: "big", new_path: "big", diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" },
            { old_path: "d.ts", new_path: "d.ts", deleted_file: true, diff: "" },
          ],
        });
      }
      if (path === `/projects/${P}/merge_requests/7/diffs?per_page=100&page=1`) {
        return json([
          { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1,2 +1,3 @@\n x\n-y\n+z\n+w\n" },
          { old_path: "n.ts", new_path: "n.ts", new_file: true, diff: "@@ -0,0 +1 @@\n+n\n" },
          { old_path: "o.ts", new_path: "p.ts", renamed_file: true, diff: "" },
          { old_path: "big", new_path: "big", diff: "@@ -1 +1 @@\n-a\n+b\n", too_large: true },
          { old_path: "d.ts", new_path: "d.ts", deleted_file: true, collapsed: true, diff: "" },
        ], { headers: { "x-next-page": "" } });
      }
      return mrRoutes(path);
    });
    const page = await api.listChangeRequestFiles(repo, "!7");
    assertEquals(page.hasMore, false);
    assertEquals(page.items, [
      {
        path: "a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1,2 +1,3 @@\n x\n-y\n+z\n+w\n",
      },
      { path: "n.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+n\n" },
      { path: "p.ts", status: "renamed", additions: 0, deletions: 0, patch: null },
      // Past ~20 KB `/diffs` gives no hunks; the head's version carries them up to 200 KB.
      {
        path: "big",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1,2 @@\n-a\n+b\n+c\n",
      },
      { path: "d.ts", status: "removed", additions: 0, deletions: 0, patch: null },
    ]);
    // A version on other refs is another diff: nothing is taken from it.
    versionBase = "elsewhere";
    const other = await api.listChangeRequestFiles(repo, "!7");
    assertEquals(other.items.find((f) => f.path === "big")?.patch, null);
  } finally {
    await gl.shutdown();
  }
});

test("listChangeRequestPatches walks every page and answers the diff's head", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      const page = /\/diffs\?per_page=100&page=(\d+)/.exec(path)?.[1];
      if (page !== undefined) {
        return json([{ new_path: `f${page}`, diff: "@@ -1 +1 @@\n-a\n+b" }], {
          headers: { "x-next-page": page === "1" ? "2" : "" },
        });
      }
      return mrRoutes(path, { sha: "newer", diff_refs: { head_sha: "head111" } });
    });
    const out = await api.listChangeRequestPatches(repo, "mr-7");
    assertEquals(out.headSha, "head111");
    assertEquals(out.complete, true);
    assertEquals(out.files.map((f) => f.path), ["f1", "f2"]);
  } finally {
    await gl.shutdown();
  }
});

test("a merge request's commits: the newest window, oldest first, with the total GitLab counted, the git author's name where GitLab names no account", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      if (path === `/projects/${P}/merge_requests/7/commits?per_page=2&page=1`) {
        return json([
          // A git author's name is free text anyone pushing sets: never taken for a login.
          { id: "c3", title: "third", author_name: "@root", authored_date: "2026-10-03" },
          {
            id: "c2",
            title: "second",
            author_name: "Grace",
            author: { username: "grace" },
            authored_date: "2026-10-02",
          },
        ], { headers: { "x-total": "3", "x-next-page": "2" } });
      }
      return null;
    });
    const history = await api.listChangeRequestCommits(repo, "mr-7", 2);
    assertEquals(history, {
      items: [
        { sha: "c2", authorLogin: "grace", date: "2026-10-02", summary: "second" },
        { sha: "c3", authorLogin: "@root", date: "2026-10-03", summary: "third" },
      ],
      older: 1,
      unit: "commit",
      atHead: true,
      total: 3,
    });
  } finally {
    await gl.shutdown();
  }
});

// ---- reviews --------------------------------------------------------------------------------

test("positionLines: added and deleted lines carry one number, context lines both", () => {
  const patch = "@@ -10,4 +10,4 @@\n ctx\n-old\n+new\n ctx2\n";
  assertEquals(positionLines(patch, "RIGHT", 10), { old_line: 10, new_line: 10 });
  assertEquals(positionLines(patch, "LEFT", 11), { old_line: 11 });
  assertEquals(positionLines(patch, "RIGHT", 11), { new_line: 11 });
  assertEquals(positionLines(patch, "LEFT", 12), { old_line: 12, new_line: 12 });
  assertEquals(positionLines(patch, "RIGHT", 40), null);
});

/** A merge request with one file's diff, drafts that record what was made, and publish. */
function reviewRoutes(
  drafts: {
    made: unknown[];
    deleted: string[];
    failAt?: number;
    stale?: number[];
    published?: string[];
    failPublishAt?: number;
  },
) {
  return ({ method, path, body }: Call): Response | null => {
    const base = `/projects/${P}/merge_requests/7/draft_notes`;
    if (path === `${base}?per_page=100` && method === "GET") {
      return json((drafts.stale ?? []).map((id) => ({ id })));
    }
    if (path === base && method === "POST") {
      if (drafts.failAt === drafts.made.length) return json({ message: "boom" }, { status: 500 });
      drafts.made.push(body);
      return json({ id: 500 + drafts.made.length }, { status: 201 });
    }
    if (method === "DELETE" && path.startsWith(`${base}/`)) {
      drafts.deleted.push(path.slice(base.length + 1));
      return new Response(null, { status: 204 });
    }
    const publish = /^\/(\d+)\/publish$/.exec(path.slice(base.length));
    if (publish !== null && method === "PUT") {
      drafts.published ??= [];
      if (drafts.failPublishAt === drafts.published.length) {
        return json({ message: "boom" }, { status: 500 });
      }
      drafts.published.push(publish[1]!);
      return new Response(null, { status: 204 });
    }
    if (path.startsWith(`/projects/${P}/merge_requests/7/diffs`)) {
      return json([{
        old_path: "a.ts",
        new_path: "a.ts",
        diff: "@@ -10,3 +10,3 @@\n ctx\n-old\n+new\n",
      }]);
    }
    return mrRoutes(path);
  };
}

test("createReview drafts one note per remark pinned to the diff, then the body, then publishes its own, in order", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const drafts = { made: [] as unknown[], deleted: [] as string[], published: [] as string[] };
    gl.set(reviewRoutes(drafts));
    const out = await api.createReview(repo, "mr-7", {
      body: "Overall fine.",
      comments: [
        { path: "a.ts", line: 11, side: "RIGHT", body: "new line" },
        { path: "a.ts", line: 10, side: "RIGHT", body: "context line" },
        { path: "a.ts", line: 11, side: "LEFT", body: "old line" },
      ],
      headSha: "head111",
    });
    assertEquals(out.url, "https://gl/acme/platform/app/-/merge_requests/7");
    const refs = {
      position_type: "text",
      base_sha: "base000",
      start_sha: "start00",
      head_sha: "head111",
      old_path: "a.ts",
      new_path: "a.ts",
    };
    assertEquals(drafts.made, [
      { note: "new line", position: { ...refs, new_line: 11 } },
      { note: "context line", position: { ...refs, old_line: 10, new_line: 10 } },
      { note: "old line", position: { ...refs, old_line: 11 } },
      { note: "Overall fine." },
    ]);
    assertEquals(drafts.published, ["501", "502", "503", "504"]);
    assert(!gl.paths().some((p) => p.includes("bulk_publish")));
    assertEquals(drafts.deleted, []);
  } finally {
    await gl.shutdown();
  }
});

test("createReview: a failure before the publish deletes the drafts it made", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const drafts = { made: [] as unknown[], deleted: [] as string[], failAt: 1 };
    gl.set(reviewRoutes(drafts));
    const err = await assertRejects(
      () =>
        api.createReview(repo, "mr-7", {
          body: "b",
          comments: [{ path: "a.ts", line: 11, side: "RIGHT", body: "x" }],
          headSha: "head111",
        }),
      ForgeApiError,
    );
    assert(!err.terminal);
    assertEquals(drafts.deleted, ["501"]);
    assert(!gl.paths().some((p) => p.endsWith("/publish")));
  } finally {
    await gl.shutdown();
  }
});

test("createReview: a failure while publishing deletes only its own drafts not yet published", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const drafts = {
      made: [] as unknown[],
      deleted: [] as string[],
      published: [] as string[],
      failPublishAt: 1,
    };
    gl.set(reviewRoutes(drafts));
    await assertRejects(
      () =>
        api.createReview(repo, "mr-7", {
          body: "b",
          comments: [
            { path: "a.ts", line: 11, side: "RIGHT", body: "x" },
            { path: "a.ts", line: 10, side: "RIGHT", body: "y" },
          ],
          headSha: "head111",
        }),
      ForgeApiError,
    );
    assertEquals(drafts.published, ["501"]);
    assertEquals(drafts.deleted, ["502", "503"]);
  } finally {
    await gl.shutdown();
  }
});

test("createReview: another pending draft of the bot is never touched, and an unanchorable remark posts nothing", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const drafts = {
      made: [] as unknown[],
      deleted: [] as string[],
      stale: [41],
      published: [] as string[],
    };
    gl.set(reviewRoutes(drafts));
    await api.createReview(repo, "mr-7", { body: "b", comments: [], headSha: null });
    // Draft 41 may be another review's, being drafted right now under the same token.
    assertEquals(drafts.deleted, []);
    assertEquals(drafts.published, ["501"]);
    assert(!gl.paths().includes(`GET /projects/${P}/merge_requests/7/draft_notes?per_page=100`));

    drafts.deleted.length = 0;
    gl.calls.length = 0;
    const err = await assertRejects(
      () =>
        api.createReview(repo, "mr-7", {
          body: "b",
          comments: [{ path: "a.ts", line: 99, side: "RIGHT", body: "x" }],
          headSha: "head111",
        }),
      ForgeApiError,
    );
    assert(err.terminal);
    assert(!gl.calls.some((c) => c.method !== "GET"));
  } finally {
    await gl.shutdown();
  }
});

test("createReview at a head that moved pins to that version's SHAs", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const drafts = { made: [] as unknown[], deleted: [] as string[] };
    const routes = reviewRoutes(drafts);
    gl.set((call) => {
      if (call.path === `/projects/${P}/merge_requests/7/versions?per_page=100`) {
        return json([{ id: 3, head_commit_sha: "older00" }, { id: 4, head_commit_sha: "head111" }]);
      }
      if (call.path === `/projects/${P}/merge_requests/7/versions/3`) {
        return json({
          base_commit_sha: "vbase",
          start_commit_sha: "vstart",
          head_commit_sha: "older00",
          diffs: [{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" }],
        });
      }
      return routes(call);
    });
    await api.createReview(repo, "mr-7", {
      body: "",
      comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "x" }],
      headSha: "older00",
    });
    assertEquals(drafts.made, [{
      note: "x",
      position: {
        position_type: "text",
        base_sha: "vbase",
        start_sha: "vstart",
        head_sha: "older00",
        old_path: "a.ts",
        new_path: "a.ts",
        new_line: 1,
      },
    }]);
  } finally {
    await gl.shutdown();
  }
});

test("replies and resolution act on the remark's discussion, on that merge request only", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ method }) =>
      method === "POST" ? json({ id: 99 }, { status: 201 }) : method === "PUT" ? json({}) : null
    );
    const handle = `mr-7:${DISC}:11`;
    assertEquals(
      await api.replyToReviewComment(repo, "!7", handle, "fixed"),
      { url: `${gl.base}/acme/platform/app/-/merge_requests/7#note_99` },
    );
    await api.resolveReviewThread(repo, "mr-7", handle);
    assertEquals(gl.paths(), [
      `POST /projects/${P}/merge_requests/7/discussions/${DISC}/notes`,
      `PUT /projects/${P}/merge_requests/7/discussions/${DISC}?resolved=true`,
    ]);
    for (const bad of [`mr-8:${DISC}:11`, "mr-7:11", "11"]) {
      const err = await assertRejects(
        () => api.replyToReviewComment(repo, "mr-7", bad, "x"),
        ForgeApiError,
      );
      assert(err.terminal, bad);
    }
    const onIssue = await assertRejects(
      () => api.resolveReviewThread(repo, "#7", handle),
      ForgeApiError,
    );
    assert(onIssue.terminal);
    assertEquals(gl.calls.length, 2);
  } finally {
    await gl.shutdown();
  }
});

// ---- the rest of door ⑤ ---------------------------------------------------------------------

test("repoVisibility: internal is the instance's audience both ways, nothing is defaulted", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const open = {
      repository_access_level: "enabled",
      merge_requests_access_level: "enabled",
      issues_access_level: "disabled",
      builds_access_level: "enabled",
    };
    const v: Record<string, Record<string, string>> = {
      "1": { visibility: "public", ...open },
      "2": { visibility: "internal", ...open },
      "3": { visibility: "private", ...open },
      "4": { visibility: "public", ...open, builds_access_level: "private" },
      "7": { visibility: "private", ...open, merge_requests_access_level: "public" },
    };
    gl.set(({ path }) => {
      const p = /^\/projects\/(.+)$/.exec(path)?.[1];
      if (p === "5") return json({ id: 1 });
      // A feature level GitLab did not say is no answer either.
      if (p === "6") return json({ visibility: "public" });
      return p !== undefined && v[p] ? json(v[p]) : null;
    });
    const at = (id: string) => gitlabProjectRef(gl.base, id);
    const out = await api.repoVisibility(null, ["1", "2", "3", "4", "7"].map(at));
    const roles = (source: Audience, issue: Audience, change_request: Audience) => ({
      source,
      target: { issue, change_request },
    });
    assertEquals([...out], [
      [at("1"), roles("public", "public", "public")],
      // Every account on the instance reads an internal project, and what is written there.
      [at("2"), roles("instance", "instance", "instance")],
      [at("3"), roles("members", "members", "members")],
      // Members-only CI makes the project members-only to read, never its issues to write on.
      [at("4"), roles("members", "public", "public")],
      // A feature opened to the public is public to write on, even in a private project.
      [at("7"), roles("members", "members", "public")],
    ]);
    const odd = await assertRejects(() => api.repoVisibility(null, [at("5")]), ForgeApiError);
    assert(!odd.terminal);
    await assertRejects(() => api.repoVisibility(null, [at("6")]), ForgeApiError);
    await assertRejects(() => api.repoVisibility("7", [at("1")]), ForgeApiError);
    // A path, or an id on another instance, is never read: either may name another project.
    gl.calls.length = 0;
    for (const ref of ["a/pub", "1", gitlabProjectRef("https://gitlab.example", "1")]) {
      const err = await assertRejects(() => api.repoVisibility(null, [ref]), ForgeApiError);
      assert(err.terminal);
    }
    assertEquals(gl.calls, []);
  } finally {
    await gl.shutdown();
  }
});

test("repoLabels includes group labels and says when the listing was cut short", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) =>
      path.startsWith(`/projects/${P}/labels?include_ancestor_groups=true`)
        ? json([{ name: "bug" }], { headers: { "x-next-page": "9" } })
        : null
    );
    const out = await api.repoLabels(repo);
    assertEquals(out.complete, false);
    assertEquals(out.labels.length, 10);
  } finally {
    await gl.shutdown();
  }
});

test("listings: issues by GitLab's state and never confidential, merge requests with closed covering merged", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      if (path.startsWith(`/projects/${P}/issues?`)) {
        return json([{
          iid: 3,
          title: "t",
          state: "opened",
          confidential: false,
          author: { username: "ada" },
          labels: ["bug"],
          user_notes_count: 2,
          updated_at: "u",
        }, {
          // Listed anyway (an instance that ignored the filter): still held out.
          iid: 4,
          title: "secret",
          state: "opened",
          confidential: true,
        }, {
          // One that does not say is taken to be confidential.
          iid: 5,
          title: "unsaid",
          state: "opened",
        }], { headers: { "x-next-page": "" } });
      }
      if (path.startsWith(`/projects/${P}/merge_requests?`)) {
        return json([
          { iid: 1, state: "opened", source_branch: "a", target_branch: "main" },
          { iid: 4, state: "locked", source_branch: "d", target_branch: "main" },
          { iid: 2, state: "merged", draft: true, source_branch: "b", target_branch: "main" },
          { iid: 3, state: "closed", source_branch: "c", target_branch: "main" },
        ]);
      }
      return null;
    });
    const issues = await api.listIssues(repo, { state: "open", labels: ["bug", "ui"], page: 2 });
    assertEquals(issues.items, [{
      ref: "issue-3",
      title: "t",
      state: "open",
      authorLogin: "ada",
      labels: ["bug"],
      comments: 2,
      updatedAt: "u",
    }]);
    assertEquals(issues.hasMore, false);
    assertEquals(
      gl.calls[0].path,
      `/projects/${P}/issues?state=opened&labels=bug%2Cui&confidential=false&per_page=30&page=2`,
    );
    const closed = await api.listChangeRequests(repo, { state: "closed", page: 1 });
    assertEquals(closed.items.map((m) => [m.ref, m.state, m.draft]), [
      ["mr-2", "merged", true],
      ["mr-3", "closed", false],
    ]);
    assertEquals(gl.calls[1].path, `/projects/${P}/merge_requests?state=all&per_page=30&page=1`);
  } finally {
    await gl.shutdown();
  }
});

test("createIssue, addLabels, closeIssue: GitLab's fields, and not_planned said in a note first", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    let state = "opened";
    gl.set(({ method, path }) => {
      if (method === "POST" && path === `/projects/${P}/issues`) {
        return json({ iid: 5, web_url: "w5" }, { status: 201 });
      }
      if (method === "POST" && path.endsWith("/notes")) return json({ id: 1 }, { status: 201 });
      if (path === `/projects/${P}/issues/5`) {
        if (method === "PUT") state = "closed";
        return json({ iid: 5, state, web_url: "w5" });
      }
      if (method === "PUT" && path === `/projects/${P}/merge_requests/7`) {
        return json({ web_url: "w7" });
      }
      return null;
    });
    assertEquals(
      await api.createIssue(repo, { title: "T", body: "B", labels: ["a", "b"] }),
      { ref: "issue-5", url: "w5" },
    );
    assertEquals(gl.calls[0].body, { title: "T", description: "B", labels: "a,b" });
    assertEquals(await api.addLabels(repo, { kind: "change_request", ref: "!7" }, ["x", "y"]), {
      url: "w7",
    });
    assertEquals(gl.calls[1].body, { add_labels: "x,y" });
    gl.calls.length = 0;
    assertEquals(await api.closeIssue(repo, "#5", "not_planned"), { url: "w5" });
    assertEquals(gl.paths(), [
      `GET /projects/${P}/issues/5`,
      `POST /projects/${P}/issues/5/notes`,
      `PUT /projects/${P}/issues/5`,
    ]);
    assertEquals(gl.calls[2].body, { state_event: "close" });
    // Closed already: nothing more is said or done.
    gl.calls.length = 0;
    await api.closeIssue(repo, "#5", "not_planned");
    assertEquals(gl.paths(), [`GET /projects/${P}/issues/5`]);
    const mr = await assertRejects(() => api.closeIssue(repo, "!7", "completed"), ForgeApiError);
    assert(mr.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("findMarkedWrite finds the bot's own write carrying the marker, and stops at `since`", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      if (path.startsWith(`/projects/${P}/issues?author_id=${BOT_ID}`)) {
        return json([{ iid: 9, description: "x <!-- m1 -->", web_url: "w9" }]);
      }
      if (path.startsWith(`/projects/${P}/merge_requests/7/notes?`)) {
        return json([
          {
            id: 3,
            body: "by someone <!-- m2 -->",
            author: { id: 1 },
            created_at: "2026-10-02T00:00:00Z",
          },
          {
            id: 2,
            body: "ours <!-- m2 -->",
            author: { id: BOT_ID },
            created_at: "2026-10-02T00:00:00Z",
          },
          {
            id: 1,
            body: "old <!-- m3 -->",
            author: { id: BOT_ID },
            created_at: "2026-09-01T00:00:00Z",
          },
        ]);
      }
      return null;
    });
    const since = "2026-10-01T00:00:00Z";
    assertEquals(
      await api.findMarkedWrite(repo, { kind: "issue" }, "<!-- m1 -->", since),
      { url: "w9", createdRef: "issue-9" },
    );
    assertStringIncludes(gl.calls[0].path, "created_after=2026-10-01T00%3A00%3A00Z");
    assertEquals(
      await api.findMarkedWrite(
        repo,
        { kind: "review_reply", threadRef: "mr-7" },
        "<!-- m2 -->",
        since,
      ),
      { url: `${gl.base}/acme/platform/app/-/merge_requests/7#note_2`, createdRef: null },
    );
    assertEquals(
      await api.findMarkedWrite(repo, { kind: "comment", threadRef: "mr-7" }, "<!-- m3 -->", since),
      null,
    );
  } finally {
    await gl.shutdown();
  }
});

test("a lost review is found by its body, never by a remark: remarks carry its marker and publish first", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    let bodyPublished = false;
    gl.set(({ path }) => {
      if (!path.startsWith(`/projects/${P}/merge_requests/7/notes?`)) return null;
      const remark = {
        id: 5,
        type: "DiffNote",
        position: { new_line: 2 },
        body: "remark <!-- m4 -->",
        author: { id: BOT_ID },
        created_at: "2026-10-02T00:00:01Z",
      };
      const body = {
        id: 6,
        type: null,
        body: "verdict <!-- m4 -->",
        author: { id: BOT_ID },
        created_at: "2026-10-02T00:00:02Z",
      };
      return json(bodyPublished ? [body, remark] : [remark]);
    });
    const since = "2026-10-01T00:00:00Z";
    const target = { kind: "review", threadRef: "mr-7" } as const;
    assertEquals(await api.findMarkedWrite(repo, target, "<!-- m4 -->", since), null);
    bodyPublished = true;
    assertEquals(
      await api.findMarkedWrite(repo, target, "<!-- m4 -->", since),
      { url: `${gl.base}/acme/platform/app/-/merge_requests/7#note_6`, createdRef: null },
    );
  } finally {
    await gl.shutdown();
  }
});

test("a signed remark's refused line is named by the agent's own count", () => {
  const signed = withSignature(
    "```suggestion\nx\n```\nfine\n/merge",
    { agentName: "Ada", runUrl: "https://ryph.test/r", requestedBy: null, requestedVia: null },
    "fa-1",
    "gitlab",
  );
  assertStringIncludes(diffNoteProblem(signed)!, "line 5 starts with");
});

test("a rate limit says when it lifts, and a write's 5xx is not terminal", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(() =>
      json({ message: "Retry later" }, { status: 429, headers: { "retry-after": "120" } })
    );
    const limited = await assertRejects(
      () => api.createIssue(repo, { title: "t", body: "b", labels: [] }),
      ForgeApiError,
    );
    assertEquals(limited.retryAfterMs, 120_000);
    assert(!limited.terminal);
    assertStringIncludes(limited.message, "about 2 minutes");

    const reset = Math.floor(Date.now() / 1000) + 300;
    gl.set(() =>
      json({ message: "x" }, { status: 429, headers: { "ratelimit-reset": String(reset) } })
    );
    const dated = await assertRejects(
      () => api.createIssue(repo, { title: "t", body: "b", labels: [] }),
      ForgeApiError,
    );
    assert(dated.retryAfterMs !== null && dated.retryAfterMs > 290_000);

    gl.set(() => json({ message: "x" }, { status: 429 }));
    const undated = await assertRejects(
      () => api.createIssue(repo, { title: "t", body: "b", labels: [] }),
      ForgeApiError,
    );
    assertEquals(undated.retryAfterMs, null);

    gl.set(() => json({ message: "x" }, { status: 502 }));
    assert(
      !(await assertRejects(
        () => api.createIssue(repo, { title: "t", body: "b", labels: [] }),
        ForgeApiError,
      )).terminal,
    );
    gl.set(() => json({ message: { title: ["is too long"] } }, { status: 400 }));
    const bad = await assertRejects(
      () => api.createIssue(repo, { title: "t", body: "b", labels: [] }),
      ForgeApiError,
    );
    assert(bad.terminal);
    assertStringIncludes(bad.message, "is too long");
  } finally {
    await gl.shutdown();
  }
});

test("a redirect off the instance is not followed with the token", async () => {
  const gl = await fakeGitlab();
  const other = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) =>
      path === `/projects/${P}/issues/1`
        ? new Response(null, { status: 302, headers: { location: `${other.base}/api/v4/x` } })
        : null
    );
    await assertRejects(
      () => api.fetchThread(repo, { kind: "issue", ref: "issue-1" }),
      ForgeApiError,
    );
    assertEquals(other.calls, []);
  } finally {
    await gl.shutdown();
    await other.shutdown();
  }
});

// ---- the connect surface --------------------------------------------------------------------

const projectJson = (id: number, path: string, extra: Record<string, unknown> = {}) => ({
  id,
  path_with_namespace: path,
  http_url_to_repo: `https://gl/${path}.git`,
  web_url: `https://gl/${path}`,
  default_branch: "main",
  visibility: "private",
  ...extra,
});

test("listProjects: the bot's Developer reach, with admin where it holds Maintainer", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      if (path.startsWith("/projects?membership=true&min_access_level=30")) {
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
        return page === 1
          ? json([projectJson(1, "a/one"), projectJson(2, "a/two", { default_branch: null })], {
            headers: { "x-next-page": "2" },
          })
          : json([projectJson(3, "a/three", { visibility: "internal" }), { id: 4 }], {
            headers: { "x-next-page": "" },
          });
      }
      if (path.startsWith("/projects?membership=true&min_access_level=40")) {
        return json([projectJson(2, "a/two")], { headers: { "x-next-page": "" } });
      }
      return null;
    });
    const listed = await api.listProjects();
    assertEquals(
      listed.map((p) => [p.id, p.pathWithNamespace, p.defaultBranch, p.visibility, p.admin]),
      [
        ["1", "a/one", "main", "private", false],
        ["2", "a/two", null, "private", true],
        ["3", "a/three", "main", "internal", false],
      ],
    );
  } finally {
    await gl.shutdown();
  }
});

test("describeProject by id or path: live, admin read off the membership, null on 404", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) => {
      if (path === "/projects/5" || path === "/projects/a%2Fb") return json(projectJson(5, "a/b"));
      if (path === `/projects/5/members/all/${BOT_ID}`) return json({ access_level: 30 });
      if (path === "/projects/6") return json({ message: "x" }, { status: 500 });
      return null;
    });
    assertEquals((await api.describeProject("5"))?.pathWithNamespace, "a/b");
    assertEquals((await api.describeProject("a/b"))?.admin, false);
    assertEquals(await api.describeProject("9"), null);
    const flaky = await assertRejects(() => api.describeProject("6"), ForgeApiError);
    assert(!flaky.terminal);
  } finally {
    await gl.shutdown();
  }
});

test("hookToken is the mailroom's derivation for that project and generation, digits only", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    assertEquals(
      await api.hookToken("42", 3),
      await deriveScopedSecret("master-secret", "gitlab-hook:", "42", "3"),
    );
    assert((await api.hookToken("42", 1)) !== (await api.hookToken("43", 1)));
    // Rotating is a new generation: the old token is another string.
    assert((await api.hookToken("42", 1)) !== (await api.hookToken("42", 2)));
    assert((await assertRejects(() => api.hookToken("4/2", 1), ForgeApiError)).terminal);
    assert((await assertRejects(() => api.hookToken("42", 0), ForgeApiError)).terminal);
    const none = await botApi(gl.base, { webhookSecret: null });
    assert((await assertRejects(() => none.hookToken("42", 1), ForgeApiError)).terminal);
  } finally {
    await gl.shutdown();
  }
});

test("exchangeOAuthCode redeems the code with the redirect URI and verifier, keeps confirmed emails, drops the token", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    let tokenForm: URLSearchParams | null = null;
    const serverCalls: string[] = [];
    gl.set(({ method, path, body, auth }) => {
      serverCalls.push(`${method} ${path}`);
      if (method === "POST" && path === "/oauth/token") {
        tokenForm = new URLSearchParams(String(body));
        return json({ access_token: "user-oauth-token", token_type: "Bearer" });
      }
      if (auth !== "Bearer user-oauth-token") return null;
      if (path === "/user") {
        return json({
          id: 77,
          username: "grace.h",
          name: "Grace",
          email: "g@x.io",
          confirmed_at: "2020-01-01",
        });
      }
      if (path === "/user/emails") {
        return json([
          { email: "alt@x.io", confirmed_at: "2021-01-01" },
          { email: "unconfirmed@x.io", confirmed_at: null },
        ]);
      }
      return null;
    });
    const who = await api.exchangeOAuthCode(
      "the-code",
      "https://ryph.example/gitlab/callback",
      "verifier",
    );
    assertEquals(who, {
      accountId: `77@${gl.base}`,
      login: "grace.h",
      name: "Grace",
      verifiedEmails: ["g@x.io", "alt@x.io"],
      accessToken: null,
    });
    const form = tokenForm as URLSearchParams | null;
    assertEquals(form?.get("code"), "the-code");
    assertEquals(form?.get("redirect_uri"), "https://ryph.example/gitlab/callback");
    assertEquals(form?.get("code_verifier"), "verifier");
    assertEquals(form?.get("grant_type"), "authorization_code");
    assertEquals(form?.get("client_secret"), "app-secret");

    gl.set(({ path }) =>
      path === "/oauth/token" ? json({ error: "invalid_grant" }, { status: 400 }) : null
    );
    const refused = await assertRejects(
      () => api.exchangeOAuthCode("bad", "https://ryph.example/gitlab/callback", null),
      ForgeApiError,
    );
    assertStringIncludes(refused.message, "invalid_grant");
    const noApp = await botApi(gl.base, { oauth: null });
    assert(
      (await assertRejects(() => noApp.exchangeOAuthCode("c", "r", null), ForgeApiError)).terminal,
    );
  } finally {
    await gl.shutdown();
  }
});

test("checkGroupMembership: by account id in the group pinned at boot; any level is a member, 404 is not, anything else unknown, null with no group", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    const who = (id: number) => gitlabAccountId(gl.base, String(id));
    gl.set(({ path }) => {
      if (path === `/groups/${GROUP_ID}/members/all/1`) return json({ id: 1, access_level: 10 });
      if (path === `/groups/${GROUP_ID}/members/all/3`) return json({}, { status: 502 });
      return null;
    });
    assertEquals(await api.checkGroupMembership(who(1)), "member");
    assertEquals(await api.checkGroupMembership(who(2)), "not-member");
    assertEquals(await api.checkGroupMembership(who(3)), "unknown");
    // The group by the id the boot pinned, the person by theirs: nothing is looked up by name.
    assert(gl.paths().every((p) => p.startsWith(`GET /groups/${GROUP_ID}/members/all/`)));
    gl.calls.length = 0;
    // A username — whoever holds it now — and an account on another instance are no members.
    assertEquals(await api.checkGroupMembership("in"), "not-member");
    assertEquals(await api.checkGroupMembership(BOT), "not-member");
    assertEquals(
      await api.checkGroupMembership(gitlabAccountId("https://gitlab.example", "1")),
      "not-member",
    );
    assertEquals(gl.calls, []);
    const ungated = await botApi(gl.base, { group: null });
    assertEquals(await ungated.checkGroupMembership(who(1)), null);
  } finally {
    await gl.shutdown();
  }
});

test("every call names the project by its id on this instance: without one, or with another instance's, it is refused before GitLab is asked", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(() => json({ id: 42, iid: 1, path_with_namespace: "acme/platform/app" }));
    const unaddressed = [
      { repoRef: "acme/platform/app", tenantId: null },
      { repoRef: "acme/platform/app", tenantId: null, forgeId: "42" },
      { repoRef: "acme/platform/app", tenantId: null, forgeId: `42@${gl.base}/other` },
      { repoRef: "acme/platform/app", tenantId: null, forgeId: "acme/platform/app" },
    ];
    for (const r of unaddressed) {
      const calls: Array<() => Promise<unknown>> = [
        () => api.fetchThread(r, { kind: "issue", ref: "issue-1" }),
        () => api.postComment(r, { kind: "issue", ref: "issue-1" }, "hi"),
        () => api.describeChangeRequest(r, "mr-1"),
        () => api.readChangeRequestState(r, "mr-1"),
        () => api.listIssues(r, { state: "open", labels: [], page: 1 }),
        () => api.createIssue(r, { title: "t", body: "b", labels: [] }),
        () => api.fetchAuth(r, `${gl.base}/acme/platform/app.git`),
        // The transport's half takes the id by type, and refuses the cast-away case too.
        () => api.pushAuth(r as never, `${gl.base}/acme/platform/app.git`),
        () =>
          api.openMergeRequest(r as never, {
            title: "t",
            body: "b",
            head: "x",
            base: "main",
            draft: false,
          }),
        () => api.locateUpstream!(r as never),
      ];
      for (const call of calls) {
        const err = await assertRejects(call, ForgeApiError);
        assert(err.terminal, err.message);
      }
    }
    assertEquals(gl.calls, []);
  } finally {
    await gl.shutdown();
  }
});

test("the boot pins RYPH_GITLAB_GROUP to the group's id, and refuses a group GitLab does not show", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await botApi(gl.base);
    gl.set(({ path }) =>
      path === `/groups/${GROUP_ID}/members/all/1` ? json({ access_level: 30 }) : null
    );
    assertEquals(await api.checkGroupMembership(gitlabAccountId(gl.base, "1")), "member");
    // Renaming the group while the forge runs changes nothing: it is never asked by name again.
    assertEquals(gl.paths(), [`GET /groups/${GROUP_ID}/members/all/1`]);
    const err = await assertRejects(() => botApi(gl.base, { group: "nope" }), ForgeApiError);
    assertStringIncludes(err.message, "RYPH_GITLAB_GROUP");
  } finally {
    await gl.shutdown();
  }
});
