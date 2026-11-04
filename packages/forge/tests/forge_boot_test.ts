// The composition root's own reading of its settings, booted for real (no network is dialed at
// boot): what a standalone forge makes of the values the binary's config file may hold.

import { test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { openDbCluster } from "@ryph/db";
import {
  deriveScopedSecret,
  drizzleHookStore,
  type Hook,
  scopeWebhooksDb,
  setup as setupWebhooks,
  VERIFIED_SCOPE_HEADER,
} from "@ryph/webhooks";
import * as webhooksSchema from "@ryph/webhooks/schema";
import { command } from "@ryph/process";
import { serve } from "@ryph/service";
import {
  readGithubSettings,
  readGitlabSettings,
  startForge,
  warnAboutUserScopes,
  wireGitlab,
} from "../src/main.ts";
import type { GitlabForgeOptions } from "../src/adapters/forge_api/gitlab.ts";
import { gitlabHookDedupeKey } from "../src/adapters/forge_api/gitlab_webhooks.ts";
import type { GitlabForge } from "../src/ports/gitlab.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { makeRouter } from "@ryph/shared/http";
import { silentDiagnostics } from "./util.ts";

async function boot(localRoot: string | null | undefined) {
  const dataDir = await mkdtemp(join(tmpdir(), "ryph-"));
  const forge = await startForge({
    port: 0,
    orchestratorUrl: "http://127.0.0.1:9",
    forgeToken: "forge-token",
    dataDir,
    ...(localRoot === undefined ? {} : { localRoot }),
  });
  try {
    return forge.forges;
  } finally {
    forge.beginDrain();
    await forge.server.shutdown();
    await forge.close();
    await rm(dataDir, { recursive: true });
  }
}

test("RYPH_LOCAL_REPO_ROOT=off boots a forge with no local provider, in any case and spacing", async () => {
  // The spelling the binary's host takes for "no local repos": the same config file must mean
  // the same thing to a forge standing alone, rather than fail its boot as a relative path.
  for (const off of ["off", "OFF", " Off "]) {
    assertEquals((await boot(off)).includes("local"), false, JSON.stringify(off));
  }
  const before = process.env.RYPH_LOCAL_REPO_ROOT;
  process.env.RYPH_LOCAL_REPO_ROOT = "off";
  try {
    assertEquals((await boot(undefined)).includes("local"), false);
  } finally {
    if (before === undefined) delete process.env.RYPH_LOCAL_REPO_ROOT;
    else process.env.RYPH_LOCAL_REPO_ROOT = before;
  }
  // A real root still turns it on.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    assertEquals((await boot(root)).includes("local"), true);
  } finally {
    await rm(root, { recursive: true });
  }
});

// ---- Where it listens, and which names it answers to -----------------------------------------

/** One raw HTTP/1.1 request, so the Host header is exactly the one given. Returns the status. */
async function statusFor(port: number, method: string, path: string, host: string) {
  const conn = connect({ host: "127.0.0.1", port });
  try {
    await once(conn, "connect");
    conn.write(
      `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0\r\n` +
        "Connection: close\r\n\r\n",
    );
    let text = "";
    for await (const chunk of conn) {
      text += new TextDecoder().decode(chunk as Uint8Array);
      if (text.includes("\r\n")) break;
    }
    return Number(text.split(" ")[1]);
  } finally {
    conn.destroy();
  }
}

test("standalone, the forge listens on every interface, as it does in its own container", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ryph-"));
  const forge = await startForge({
    port: 0,
    orchestratorUrl: "http://127.0.0.1:9",
    forgeToken: "forge-token",
    dataDir,
    localRoot: null,
  });
  try {
    assertEquals(forge.server.addr.hostname, "0.0.0.0");
    assertEquals(
      await statusFor(forge.server.addr.port, "GET", "/healthz", "anything.example"),
      200,
    );
  } finally {
    forge.beginDrain();
    await forge.server.shutdown();
    await forge.close();
    await rm(dataDir, { recursive: true });
  }
});

test("embedded, the forge listens where the host says and answers only the names it allows, webhook deliveries aside", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ryph-"));
  const misdirected = () => new Response("misdirected", { status: 421 });
  const forge = await startForge({
    port: 0,
    orchestratorUrl: "http://127.0.0.1:9",
    forgeToken: "forge-token",
    dataDir,
    localRoot: null,
    serve: (handler) => serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, handler),
    guard: (handler) => (req, info) =>
      req.headers.get("host")?.split(":")[0] === "localhost" ? handler(req, info) : misdirected(),
  });
  try {
    assertEquals(forge.server.addr.hostname, "127.0.0.1");
    const port = forge.server.addr.port;
    assertEquals(await statusFor(port, "GET", "/healthz", `localhost:${port}`), 200);
    // A page whose own name was rebound to 127.0.0.1 is refused, on any route.
    assertEquals(await statusFor(port, "GET", "/healthz", "rebound.example"), 421);
    // A webhook delivery passes whatever name its tunnel gave it: its signature is its check.
    // (No mailroom here, so the door itself is absent — but it was not the guard that said so.)
    const delivery = await statusFor(port, "POST", "/v1/hooks/github", "tunnel.example");
    assert(delivery !== 421, `a delivery reached the guard: ${delivery}`);
    // Only a POST to the door is a delivery.
    assertEquals(await statusFor(port, "GET", "/v1/hooks/github", "tunnel.example"), 421);
  } finally {
    forge.beginDrain();
    await forge.server.shutdown();
    await forge.close();
    await rm(dataDir, { recursive: true });
  }
});

// ---- GitHub: an App or one person, never both ------------------------------------------------

const TOKEN = "ghp_bootTokenNeverPrinted0001";

const settingsFrom = (vars: Record<string, string>) =>
  readGithubSettings((name) => vars[name] || undefined);

test("GitHub settings: user mode from a token or a command, and every mix refused", async () => {
  assertEquals(await settingsFrom({}), null);
  assertEquals(await settingsFrom({ RYPH_GITHUB_TOKEN: TOKEN }), {
    mode: "user",
    token: { kind: "static", token: TOKEN },
  });
  assertEquals(await settingsFrom({ RYPH_GITHUB_TOKEN_COMMAND: "gh auth token" }), {
    mode: "user",
    token: { kind: "command", command: "gh auth token" },
  });

  const refused = async (vars: Record<string, string>, says: string) => {
    const err = await assertRejects(() => settingsFrom(vars), Error);
    assertStringIncludes(err.message, says);
    assert(!err.message.includes(TOKEN), "a boot error never prints the token");
  };
  await refused(
    { RYPH_GITHUB_TOKEN: TOKEN, RYPH_GITHUB_TOKEN_COMMAND: "gh auth token" },
    "both set",
  );
  for (
    const app of [
      "RYPH_GITHUB_APP_ID",
      "RYPH_GITHUB_PRIVATE_KEY",
      "RYPH_GITHUB_PRIVATE_KEY_PATH",
      "RYPH_GITHUB_CLIENT_ID",
      "RYPH_GITHUB_CLIENT_SECRET",
    ]
  ) {
    await refused({ RYPH_GITHUB_TOKEN: TOKEN, [app]: "x" }, "never both");
    await refused({ RYPH_GITHUB_TOKEN_COMMAND: "gh auth token", [app]: "x" }, "never both");
  }
  await refused(
    { RYPH_GITHUB_TOKEN: TOKEN, RYPH_GITHUB_WEBHOOK_SECRET: "whsec" },
    "user mode has no webhooks",
  );
  await refused({ RYPH_GITHUB_APP_ID: "1" }, "some are set, some are not");
  await refused({ RYPH_GITHUB_CLIENT_ID: "c", RYPH_GITHUB_CLIENT_SECRET: "s" }, "some are set");
  await refused(
    { RYPH_GITHUB_APP_ID: "1", RYPH_GITHUB_PRIVATE_KEY: "pem", RYPH_GITHUB_CLIENT_ID: "c" },
    "needs both",
  );
});

test("GitHub settings: an App signs people in only with its OAuth client pair", async () => {
  const app = { RYPH_GITHUB_APP_ID: "1", RYPH_GITHUB_PRIVATE_KEY: "pem" };
  assertEquals(await settingsFrom(app), {
    mode: "app",
    appId: "1",
    privateKeyPem: "pem",
    privateKeySource: "RYPH_GITHUB_PRIVATE_KEY",
    oauth: null,
  });
  assertEquals(
    await settingsFrom({
      ...app,
      RYPH_GITHUB_CLIENT_ID: "client",
      RYPH_GITHUB_CLIENT_SECRET: "client-secret",
    }),
    {
      mode: "app",
      appId: "1",
      privateKeyPem: "pem",
      privateKeySource: "RYPH_GITHUB_PRIVATE_KEY",
      oauth: { clientId: "client", clientSecret: "client-secret" },
    },
  );
});

test("a token command is user mode, except where RYPH_FORGE_NO_TOKEN_COMMAND=1 refuses it", async () => {
  // No runtime permission says whether `sh` may run any more, so the networked forge's image
  // says so itself: there the token command is a boot error that names what to use instead.
  const read = (vars: Record<string, string>) => readGithubSettings((n) => vars[n] || undefined);
  assertEquals(await read({ RYPH_GITHUB_TOKEN_COMMAND: "gh auth token" }), {
    mode: "user",
    token: { kind: "command", command: "gh auth token" },
  });
  const err = await assertRejects(
    () => read({ RYPH_GITHUB_TOKEN_COMMAND: "gh auth token", RYPH_FORGE_NO_TOKEN_COMMAND: "1" }),
    Error,
  );
  assertStringIncludes(err.message, "may not run a token command");
  assertStringIncludes(err.message, "RYPH_GITHUB_TOKEN");
  // A static token needs no shell.
  assertEquals(
    (await read({ RYPH_GITHUB_TOKEN: TOKEN, RYPH_FORGE_NO_TOKEN_COMMAND: "1" }))?.mode,
    "user",
  );

  // And the real boot, as the image runs it: the command is never run.
  const marker = join(tmpdir(), `ryph-token-command-${crypto.randomUUID()}`);
  const { code, output } = await bootProcess({
    RYPH_GITHUB_TOKEN_COMMAND: `touch ${marker}; echo ghp_x`,
    RYPH_FORGE_NO_TOKEN_COMMAND: "1",
  });
  assertEquals(code, 2, output);
  assertStringIncludes(output, "may not run a token command");
  assertEquals(await stat(marker).then(() => true, () => false), false);
});

test("a user token's scopes: a missing `repo` and a held `workflow` are each said at boot", () => {
  const said = (scopes: string[] | null) => {
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    warnAboutUserScopes({ login: "ada", scopes }, {
      warn: (event, fields) => events.push({ event, fields }),
    });
    return events;
  };
  assertEquals(said(["repo"]), []);
  // A fine-grained token sends no scopes: nothing this header could say.
  assertEquals(said(null), []);
  assertEquals(said(["gist"]).map((e) => e.event), ["github_user.missing_scopes"]);
  // What `gh auth login` over HTTPS commonly grants: agents could push workflow files, which
  // run with the repo's secrets, and the boot says so with a way out.
  const workflow = said(["repo", "workflow", "read:org"]);
  assertEquals(workflow.map((e) => e.event), ["github_user.workflow_scope"]);
  assertStringIncludes(String(workflow[0].fields?.note), "secrets");
  assertStringIncludes(String(workflow[0].fields?.fix), "SSH");
});

/** A fake GitHub that knows one token and says which scopes it holds. */
async function fakeGithubUser() {
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    if (new URL(req.url).pathname !== "/user") return new Response(null, { status: 404 });
    return req.headers.get("authorization") === `Bearer ${TOKEN}`
      ? Response.json({ login: "ada" }, { headers: { "x-oauth-scopes": "gist" } })
      : Response.json({ message: "Bad credentials" }, { status: 401 });
  });
  return { base: `http://127.0.0.1:${server.addr.port}`, shutdown: () => server.shutdown() };
}

test("a forge booted with a GitHub token says who it acts as", async () => {
  const gh = await fakeGithubUser();
  const vars = { RYPH_GITHUB_TOKEN: TOKEN, RYPH_GITHUB_API: gh.base, RYPH_GITHUB_OAUTH: gh.base };
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  const dataDir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const forge = await startForge({
      port: 0,
      orchestratorUrl: "http://127.0.0.1:9",
      forgeToken: "forge-token",
      dataDir,
      localRoot: null,
    });
    try {
      assertEquals(forge.github, { mode: "user", login: "ada" });
      assertEquals(forge.forges, ["github"]);
    } finally {
      forge.beginDrain();
      await forge.server.shutdown();
      await forge.close();
    }
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dataDir, { recursive: true });
    await gh.shutdown();
  }
});

/** The standalone forge as a process, for a boot that must exit — and what it printed. */
async function bootProcess(env: Record<string, string>) {
  const dataDir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const out = await command(process.execPath, {
      args: ["--no-env-file", new URL("../src/main.ts", import.meta.url).pathname],
      env: {
        RYPH_ORCHESTRATOR_URL: "http://127.0.0.1:9",
        RYPH_FORGE_TOKEN: "forge-token",
        RYPH_FORGE_DATA: dataDir,
        // Every boot here fails before it listens; a port that cannot be bound keeps one that
        // unexpectedly did not from lingering.
        RYPH_FORGE_PORT: "1",
        RYPH_LOCAL_REPO_ROOT: "off",
        ...env,
      },
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
    const text = new TextDecoder();
    return { code: out.code, output: text.decode(out.stdout) + text.decode(out.stderr) };
  } finally {
    await rm(dataDir, { recursive: true });
  }
}

test("a token GitHub refuses fails the boot loudly, and never prints the token", async () => {
  const gh = await fakeGithubUser();
  try {
    const bad = "ghp_wrongTokenNeverPrinted0002";
    const { code, output } = await bootProcess({
      RYPH_GITHUB_TOKEN: bad,
      RYPH_GITHUB_API: gh.base,
      RYPH_GITHUB_OAUTH: gh.base,
    });
    assertEquals(code, 2);
    assertStringIncludes(output, "GitHub user mode");
    assertStringIncludes(output, "401");
    assert(!output.includes(bad));

    const mixed = await bootProcess({ RYPH_GITHUB_TOKEN: bad, RYPH_GITHUB_APP_ID: "1" });
    assertEquals(mixed.code, 2);
    assertStringIncludes(mixed.output, "never both");
    assert(!mixed.output.includes(bad));

    const hooked = await bootProcess({
      RYPH_GITHUB_TOKEN_COMMAND: `echo ${bad}`,
      RYPH_GITHUB_WEBHOOK_SECRET: "whsec",
    });
    assertEquals(hooked.code, 2);
    assertStringIncludes(hooked.output, "no webhooks");
  } finally {
    await gh.shutdown();
  }
});

// ---- Radicle, handed over by a host that runs the bridge itself ------------------------------

test("a host's own bridge is taken from the options, and the environment is not read", async () => {
  // The values a misreading would trip on: not a URL, so a forge that read them would fail its
  // boot (and take this test process with it) rather than quietly ignore them.
  const before = {
    url: process.env.RYPH_RADICLE_URL,
    token: process.env.RYPH_RADICLE_TOKEN,
  };
  process.env.RYPH_RADICLE_URL = "embedded";
  delete process.env.RYPH_RADICLE_TOKEN;
  const dataDir = await mkdtemp(join(tmpdir(), "ryph-"));
  // The mailroom the bridge's events go to: the automations set carries its table, as in the
  // binary's one database — borrowed, as the host lends it, so a forge's close leaves it open.
  const cluster = await openDbCluster("pglite:memory://");
  const webhooksDb = scopeWebhooksDb(cluster);
  await cluster.migrate(
    new URL("../../automations/drizzle", import.meta.url).pathname,
    "__drizzle_migrations_automations",
  );
  try {
    const start = (radicle: { url: string; token: string; mode: "user" } | null) =>
      startForge({
        port: 0,
        orchestratorUrl: "http://127.0.0.1:9",
        forgeToken: "forge-token",
        dataDir,
        localRoot: null,
        webhooksDb,
        radicle,
      });
    for (
      const [radicle, expected] of [
        [{ url: "http://127.0.0.1:9", token: "a-minted-token", mode: "user" }, ["radicle"]],
        [null, []],
      ] as const
    ) {
      const forge = await start(radicle);
      try {
        assertEquals(forge.forges, [...expected]);
      } finally {
        forge.beginDrain();
        await forge.server.shutdown();
        await forge.close();
      }
    }
  } finally {
    if (before.url === undefined) delete process.env.RYPH_RADICLE_URL;
    else process.env.RYPH_RADICLE_URL = before.url;
    if (before.token !== undefined) process.env.RYPH_RADICLE_TOKEN = before.token;
    await cluster.close();
    await rm(dataDir, { recursive: true });
  }
});

// ---- GitLab: one instance, as a bot or as one person -----------------------------------------

const GITLAB_TOKEN = "glpat-bootTokenNeverPrinted01";
const GITLAB_SECRET = "gitlab-master-never-printed";
/** A control plane that admits every GitLab delivery. */
const CURRENT_GATE = {
  admit: () =>
    Promise.resolve({ admission: "current" as const, connectedAt: "2026-01-01T00:00:00.000Z" }),
  dropped: () => Promise.resolve(),
};

test("a GitLab the forge cannot reach fails the boot, naming the mode and instance and never the token", async () => {
  const { code, output } = await bootProcess({
    RYPH_GITLAB_URL: "http://127.0.0.1:9",
    RYPH_GITLAB_TOKEN: GITLAB_TOKEN,
  });
  assertEquals(code, 2, output);
  assertStringIncludes(output, "GitLab (bot mode at http://127.0.0.1:9)");
  assert(!output.includes(GITLAB_TOKEN), "a boot error never prints the token");
});

test("GitLab's configuration errors fail the boot before GitLab is dialed", async () => {
  // A webhook secret with no mailroom to queue into: said before any request to GitLab, so the
  // unreachable instance below is never what the boot dies of.
  const hooked = await bootProcess({
    RYPH_GITLAB_URL: "http://127.0.0.1:9",
    RYPH_GITLAB_TOKEN: GITLAB_TOKEN,
    RYPH_GITLAB_WEBHOOK_SECRET: GITLAB_SECRET,
  });
  assertEquals(hooked.code, 2, hooked.output);
  assertStringIncludes(hooked.output, "RYPH_GITLAB_WEBHOOK_SECRET is set but RYPH_FORGE_DB is not");
  assert(!hooked.output.includes(GITLAB_SECRET));

  const userHooks = await bootProcess({
    RYPH_GITLAB_MODE: "user",
    RYPH_GITLAB_TOKEN: GITLAB_TOKEN,
    RYPH_GITLAB_WEBHOOK_SECRET: GITLAB_SECRET,
  });
  assertEquals(userHooks.code, 2);
  assertStringIncludes(userHooks.output, "user mode has no webhooks");

  // The networked image's rule holds for GitLab's token command too: it is never run.
  const marker = join(tmpdir(), `ryph-gitlab-token-command-${crypto.randomUUID()}`);
  const command = await bootProcess({
    RYPH_GITLAB_TOKEN_COMMAND: `touch ${marker}; echo glpat-x`,
    RYPH_FORGE_NO_TOKEN_COMMAND: "1",
  });
  assertEquals(command.code, 2);
  assertStringIncludes(command.output, "RYPH_GITLAB_TOKEN_COMMAND");
  assertEquals(await stat(marker).then(() => true, () => false), false);
});

/** A GitLab adapter that only says who it is — what the wiring reads of it. */
function fakeGitlabForge(opts: GitlabForgeOptions): GitlabForge {
  return {
    mode: { mode: opts.mode, login: "ryph-bot", url: opts.url },
    self: { id: "7", login: "ryph-bot" },
  } as unknown as GitlabForge;
}

const gitlabSettings = (vars: Record<string, string>) => {
  const settings = readGitlabSettings((n) => vars[n] || undefined);
  if (settings === null) throw new Error("no GitLab");
  return settings;
};

test("GitLab's wiring hands the adapter its settings and a token speaking GitLab's names", async () => {
  const diag = silentDiagnostics();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const cache = localFsRepoCache({ root, diag });
    const sink = { deliver: () => Promise.resolve({ kind: "delivered" as const }) };
    let given: GitlabForgeOptions | null = null;
    const wiring = await wireGitlab(
      gitlabSettings({
        RYPH_GITLAB_URL: "https://git.example/gitlab/",
        RYPH_GITLAB_TOKEN: GITLAB_TOKEN,
        RYPH_GITLAB_WEBHOOK_SECRET: GITLAB_SECRET,
        RYPH_GITLAB_CLIENT_ID: "client",
        RYPH_GITLAB_CLIENT_SECRET: "client-secret",
        RYPH_GITLAB_GROUP: "acme",
      }),
      {
        cache,
        diag,
        sink: sink as never,
        gate: CURRENT_GATE,
        build: (opts) => {
          given = opts;
          return Promise.resolve(fakeGitlabForge(opts));
        },
      },
    );
    const opts = given! as GitlabForgeOptions;
    assertEquals(opts.mode, "bot");
    assertEquals(opts.url, "https://git.example/gitlab");
    assertEquals(opts.webhookSecret, GITLAB_SECRET);
    assertEquals(opts.oauth, { clientId: "client", clientSecret: "client-secret" });
    assertEquals(opts.group, "acme");
    assertEquals(await opts.token.current(), GITLAB_TOKEN);
    assertEquals(wiring.forge.mode.login, "ryph-bot");
    assert(typeof wiring.transport.deliver === "function");
    assertEquals(wiring.mailbox?.id, "gitlab");
    assertEquals(wiring.mailbox?.verification, {
      kind: "derived-secret-header",
      header: "x-gitlab-token",
      master: GITLAB_SECRET,
      label: "gitlab-hook:",
      scopeParam: "project",
      generationParam: "generation",
    });

    // User mode, and a bot without a secret: no mailbox — merges are polled instead.
    for (
      const vars of [
        { RYPH_GITLAB_MODE: "user", RYPH_GITLAB_TOKEN: GITLAB_TOKEN },
        { RYPH_GITLAB_TOKEN: GITLAB_TOKEN },
      ] as Record<string, string>[]
    ) {
      const quiet = await wireGitlab(gitlabSettings(vars), {
        cache,
        diag,
        sink: sink as never,
        gate: CURRENT_GATE,
        build: (o) => Promise.resolve(fakeGitlabForge(o)),
      });
      assertEquals(quiet.mailbox, null, JSON.stringify(vars));
    }

    // A token that could never be a header is refused in GitLab's words, before any build.
    const err = await assertRejects(
      () =>
        wireGitlab(gitlabSettings({ RYPH_GITLAB_TOKEN: "two words" }), {
          cache,
          diag,
          sink: sink as never,
          gate: CURRENT_GATE,
          build: () => Promise.reject(new Error("never built")),
        }),
      Error,
    );
    assertStringIncludes(err.message, "RYPH_GITLAB_TOKEN is not a usable token");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("GitLab's mailbox as wired refuses a rotated or unconnected token at the door, and spends a budget per project", async () => {
  const diag = silentDiagnostics();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const cluster = await openDbCluster("pglite:memory://");
  const webhooksDb = scopeWebhooksDb(cluster);
  await cluster.migrate(
    new URL("../../automations/drizzle", import.meta.url).pathname,
    "__drizzle_migrations_automations",
  );
  try {
    // The control plane: project 42 connected at generation 2 (1 was rotated away), 43 at 1.
    const asked: string[] = [];
    const wiring = await wireGitlab(
      gitlabSettings({
        RYPH_GITLAB_TOKEN: GITLAB_TOKEN,
        RYPH_GITLAB_WEBHOOK_SECRET: GITLAB_SECRET,
      }),
      {
        cache: localFsRepoCache({ root, diag }),
        diag,
        sink: { deliver: () => Promise.resolve({ kind: "delivered" }) } as never,
        gate: {
          admit: (project, generation) => {
            asked.push(`${project}@${generation}`);
            const current = project === "42" ? "2" : project === "43" ? "1" : null;
            return Promise.resolve(
              current === null
                ? { admission: "unconnected" as const }
                : current === generation
                ? { admission: "current" as const, connectedAt: "2026-01-01T00:00:00.000Z" }
                : { admission: "stale" as const },
            );
          },
          dropped: () => Promise.resolve(),
        },
        build: (o) => Promise.resolve(fakeGitlabForge(o)),
      },
    );
    assertEquals(wiring.mailbox?.retainTerminalMs, 7 * 24 * 60 * 60_000);
    // A note rung again is dropped by the mailroom unread.
    assertEquals(wiring.mailbox?.dedupeKey, gitlabHookDedupeKey);
    const mailroom = setupWebhooks({
      store: drizzleHookStore(webhooksDb.db),
      diag,
      now: () => new Date(),
    });
    mailroom.register(wiring.mailbox!);
    const handler = makeRouter(mailroom.routes);
    const deliver = async (project: string, generation: string) => {
      const res = await handler(
        new Request(`http://forge/v1/hooks/gitlab?project=${project}&generation=${generation}`, {
          method: "POST",
          headers: {
            "x-gitlab-event": "Note Hook",
            "x-gitlab-token": await deriveScopedSecret(
              GITLAB_SECRET,
              "gitlab-hook:",
              project,
              generation,
            ),
          },
          body: "{}",
        }),
      );
      await res.body?.cancel();
      return res.status;
    };
    const stored = async () => {
      const store = drizzleHookStore(webhooksDb.db);
      return [
        (await store.getHeadHook("gitlab", "42"))?.scope,
        (await store.getHeadHook("gitlab", "43"))?.scope,
      ];
    };

    // A demoted Maintainer's rotated token, and a token for a project connected nowhere now:
    // verified, and refused before a row is written — asked once, then from the door's memory.
    assertEquals(await deliver("42", "1"), 403);
    assertEquals(await deliver("42", "1"), 403);
    assertEquals(await deliver("44", "1"), 403);
    assertEquals(await stored(), [undefined, undefined]);
    assertEquals(asked, ["42@1", "44@1"]);

    // The current token is taken — up to its project's own budget; another project's is apart.
    // Past it a delivery is acknowledged and dropped, never 429: GitLab counts a 4xx toward
    // disabling the hook, which would lose every later delivery of the project.
    for (let i = 0; i < 60; i++) assertEquals(await deliver("42", "2"), 202);
    assertEquals(await deliver("42", "2"), 202);
    assertEquals(await deliver("43", "1"), 202);
    assertEquals(await stored(), ["42", "43"]);
    const rows = await webhooksDb.db.select().from(webhooksSchema.webhooks);
    assertEquals(rows.filter((r) => r.scope === "42").length, 60, "the 61st was not stored");
  } finally {
    await cluster.close();
    await rm(root, { recursive: true });
  }
});

test("GitLab's mailbox spends comments and other events from budgets apart: merge request churn never drops a /ryph note", async () => {
  const diag = silentDiagnostics();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const cluster = await openDbCluster("pglite:memory://");
  const webhooksDb = scopeWebhooksDb(cluster);
  await cluster.migrate(
    new URL("../../automations/drizzle", import.meta.url).pathname,
    "__drizzle_migrations_automations",
  );
  try {
    const reported: string[] = [];
    const wiring = await wireGitlab(
      gitlabSettings({
        RYPH_GITLAB_TOKEN: GITLAB_TOKEN,
        RYPH_GITLAB_WEBHOOK_SECRET: GITLAB_SECRET,
      }),
      {
        cache: localFsRepoCache({ root, diag }),
        diag,
        sink: { deliver: () => Promise.resolve({ kind: "delivered" }) } as never,
        gate: CURRENT_GATE,
        build: (o) => Promise.resolve(fakeGitlabForge(o)),
      },
    );
    const mailroom = setupWebhooks({
      store: drizzleHookStore(webhooksDb.db),
      diag,
      now: () => new Date(),
    });
    mailroom.register({
      ...wiring.mailbox!,
      onOverLimit: (scope, generation, lane) => reported.push(`${scope}@${generation}:${lane}`),
    });
    const handler = makeRouter(mailroom.routes);
    const token = await deriveScopedSecret(GITLAB_SECRET, "gitlab-hook:", "42", "1");
    const deliver = async (event: string) => {
      const res = await handler(
        new Request(`http://forge/v1/hooks/gitlab?project=42&generation=1`, {
          method: "POST",
          headers: { "x-gitlab-event": event, "x-gitlab-token": token },
          body: "{}",
        }),
      );
      await res.body?.cancel();
      return res.status;
    };
    const stored = async (event: string) =>
      (await webhooksDb.db.select().from(webhooksSchema.webhooks))
        .filter((r) => (r.headers as Record<string, string>)["x-gitlab-event"] === event).length;

    // A busy merge request: labels, approvals, a rebase of every open MR — far past a minute's
    // budget of them, and of pushes beside it.
    for (let i = 0; i < 70; i++) assertEquals(await deliver("Merge Request Hook"), 202);
    for (let i = 0; i < 5; i++) assertEquals(await deliver("Push Hook"), 202);
    assertEquals((await stored("Merge Request Hook")) + (await stored("Push Hook")), 60);
    // The /ryph note in the middle of it is taken: comments spend a budget of their own.
    assertEquals(await deliver("Note Hook"), 202);
    assertEquals(await stored("Note Hook"), 1);
    // A sender naming some other event spends the other events' budget, never a third one.
    assertEquals(await deliver("Made Up Hook"), 202);
    assertEquals(await stored("Made Up Hook"), 0);
    assertEquals(reported.length, 16);
    assert(reported.every((r) => r === "42@1:other"), reported.join());
  } finally {
    await cluster.close();
    await rm(root, { recursive: true });
  }
});

test("GitLab's mailbox takes a delivery only with the token derived for the project and generation it names", async () => {
  const diag = silentDiagnostics();
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const cluster = await openDbCluster("pglite:memory://");
  const webhooksDb = scopeWebhooksDb(cluster);
  await cluster.migrate(
    new URL("../../automations/drizzle", import.meta.url).pathname,
    "__drizzle_migrations_automations",
  );
  try {
    const wiring = await wireGitlab(
      gitlabSettings({
        RYPH_GITLAB_TOKEN: GITLAB_TOKEN,
        RYPH_GITLAB_WEBHOOK_SECRET: GITLAB_SECRET,
      }),
      {
        cache: localFsRepoCache({ root, diag }),
        diag,
        sink: { deliver: () => Promise.resolve({ kind: "delivered" }) } as never,
        gate: CURRENT_GATE,
        build: (o) => Promise.resolve(fakeGitlabForge(o)),
      },
    );
    // The registration as wired, with a recorder standing in for the consumer (chunk D's).
    const consumed: Hook[] = [];
    const mailroom = setupWebhooks({
      store: drizzleHookStore(webhooksDb.db),
      diag,
      now: () => new Date(),
    });
    mailroom.register({
      ...wiring.mailbox!,
      consumer: (hook) => {
        consumed.push(hook);
        return Promise.resolve({ kind: "ok" });
      },
    });
    const handler = makeRouter(mailroom.routes);
    const deliver = (project: string, token: string, generation = "1") =>
      handler(
        new Request(`http://forge/v1/hooks/gitlab?project=${project}&generation=${generation}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gitlab-event": "Note Hook",
            "x-gitlab-token": token,
          },
          body: JSON.stringify({ object_kind: "note", project: { id: Number(project) } }),
        }),
      );
    const for42 = await deriveScopedSecret(GITLAB_SECRET, "gitlab-hook:", "42", "1");
    const accepted = await deliver("42", for42);
    assertEquals(accepted.status, 202);
    await accepted.body?.cancel();
    // A token leaked from project 42 vouches for 42 only.
    const forged = await deliver("43", for42);
    assertEquals(forged.status, 401);
    await forged.body?.cancel();
    // Nor for another generation of 42: a rotated token's URL names the old one.
    const rotated = await deliver("42", for42, "2");
    assertEquals(rotated.status, 401);
    await rotated.body?.cancel();
    const master = await deliver("42", GITLAB_SECRET);
    assertEquals(master.status, 401);
    await master.body?.cancel();

    await mailroom.sweep();
    assertEquals(consumed.length, 1);
    assertEquals(consumed[0]!.headers[VERIFIED_SCOPE_HEADER], "42");
    assertEquals(consumed[0]!.headers["x-gitlab-token"], undefined, "the credential is not stored");
  } finally {
    await cluster.close();
    await rm(root, { recursive: true });
  }
});
