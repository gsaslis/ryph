// The status block is the binary's interface, so its decisions are tested like any other
// behaviour. The one that matters most: a deployment that cannot actually run an agent has to
// SAY so. "I created a task and nothing happened" is the first confusion a local install
// produces. `up` refuses to start without a launching provisioner now, so here that is the dev
// opt-in's `manual`.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { HostSummary } from "@ryph/host";
import {
  defaultedLocalRepoRoot,
  describeDeployment,
  flagSetting,
  gitlabName,
  previewListenerFromEnv,
} from "../src/main.ts";
import { status } from "../src/banner.ts";

const summary = (over: Partial<HostSummary> = {}): HostSummary => ({
  controlPlaneUrl: "http://localhost:7411",
  modelProxyUrl: null,
  mcpGatewayUrl: null,
  db: "pglite ./data/ryph",
  historyDb: null,
  historyRemote: null,
  authDisabled: false,
  provisioner: "manual",
  agentImage: null,
  forge: null,
  forgeProviders: null,
  forgeGithub: null,
  forgeGitlab: null,
  forgeLocalRoot: null,
  radicle: null,
  gitGateway: null,
  extra: "http://localhost:3000",
  loginLink: null,
  setupToken: null,
  environments: null,
  checks: null,
  ...over,
});

const rowValue = (s: HostSummary, label: string): string | undefined =>
  describeDeployment(s, []).rows.find((r) => r.label === label)?.value;

test("the default local deployment warns that agents cannot run", () => {
  const block = describeDeployment(summary(), []);
  assertStringIncludes(rowValue(summary(), "agent runner")!, "runs will not start");
  assertEquals(
    block.notes?.some((n) => n.includes("RYPH_PROVISIONER=docker")),
    true,
    "the provisioner note is the whole point",
  );
});

test("docker with an image reads as good and drops the note", () => {
  const s = summary({ provisioner: "docker", agentImage: "ryph-agent:dev" });
  const block = describeDeployment(s, []);
  assertEquals(block.rows.find((r) => r.label === "agent runner")?.tone, "good");
  assertStringIncludes(rowValue(s, "agent runner")!, "ryph-agent:dev");
  assertEquals(block.notes?.some((n) => n.includes("RYPH_PROVISIONER")), false);
});

test("environments: what a run starts from, under a launching provisioner only", () => {
  const docker = { provisioner: "docker", agentImage: "ryph-agent:dev" };
  assertEquals(rowValue(summary(), "environments"), undefined, "manual builds nothing");
  assertEquals(rowValue(summary(docker), "environments"), "off");
  const on = summary({
    ...docker,
    environments: { builder: "docker", refused: null },
    checks: { refused: null },
  });
  assertEquals(rowValue(on, "environments"), "docker builds · checks on");
  assertEquals(
    describeDeployment(on, []).rows.find((r) => r.label === "environments")?.tone,
    "good",
  );
  const refused = summary({
    ...docker,
    environments: { builder: "manual", refused: "this provisioner cannot build" },
  });
  assertEquals(rowValue(refused, "environments"), "off — this provisioner cannot build");
});

test("docker with NO image is still called out — it cannot provision either", () => {
  const block = describeDeployment(summary({ provisioner: "docker", agentImage: null }), []);
  assertEquals(block.notes?.some((n) => n.includes("RYPH_AGENT_IMAGE")), true);
});

test("single-user opens the login link; an unclaimed multi-user one its claim", () => {
  const link = "http://localhost:3000/auth/login-link/abc";
  const signedIn = describeDeployment(summary({ loginLink: link }), ["created the database"]);
  assertEquals(signedIn.open, link);
  assertEquals(signedIn.notes?.some((n) => n.includes("ryph login")), true);

  assertEquals(
    describeDeployment(summary({ setupToken: "f00" }), []).open,
    "http://localhost:3000/register?setup=f00",
  );
  // Neither: the app root, first launch or not.
  assertEquals(
    describeDeployment(summary(), ["created the database"]).open,
    "http://localhost:3000",
  );
  assertEquals(describeDeployment(summary(), []).open, "http://localhost:3000");
});

test("disabled sign-in is surfaced as a warning, not left silent", () => {
  const block = describeDeployment(summary({ authDisabled: true }), []);
  const row = block.rows.find((r) => r.label === "sign-in");
  assertEquals(row?.tone, "warn");
  assertStringIncludes(row!.value, "open");
});

test("a build with no UI says so instead of offering a dead link", () => {
  const block = describeDeployment(summary({ extra: null }), []);
  assertEquals(block.rows.find((r) => r.label === "web UI")?.tone, "warn");
  assertEquals(block.open, undefined);
});

test("with no way to reach a repository, the note says every option", () => {
  const block = describeDeployment(summary(), []);
  assertEquals(rowValue(summary(), "repositories"), "none configured");
  const note = block.notes?.find((n) => n.includes("no way to reach a repository"));
  assertStringIncludes(note!, "RYPH_LOCAL_REPO_ROOT");
  assertStringIncludes(note!, "RYPH_GITHUB_TOKEN_COMMAND");
});

test("a local root is named as where to add repositories, and is enough on its own", () => {
  const s = summary({
    forge: "in-process on :7412 · local",
    forgeProviders: ["local"],
    forgeLocalRoot: "/Users/me",
  });
  assertEquals(rowValue(s, "repositories"), "add from /Users/me in the UI");
  const block = describeDeployment(s, []);
  assertEquals(block.notes?.some((n) => n.includes("no way to reach")), false);
  // The forge is in-process by default now, so there is no "branch only" caveat left to give.
  assertEquals(block.notes?.some((n) => n.includes("pull request")), false);
});

test("an in-process forge with nothing wired is not a way in", () => {
  const s = summary({ forge: "in-process on :7412 · no forge wired", forgeProviders: [] });
  assertEquals(rowValue(s, "repositories"), "none configured");
});

test("every configured way in is listed together", () => {
  const s = summary({
    forgeLocalRoot: "/srv/repos",
    forge: "in-process on :7412 · github, local",
    forgeProviders: ["github", "local"],
  });
  const value = rowValue(s, "repositories")!;
  assertStringIncludes(value, "add from /srv/repos in the UI");
  // Local is the root named first; the forge's part of the row names only the rest.
  assertStringIncludes(value, "forge in-process on :7412 · github");
  assertEquals(value.includes("github, local"), false);
  assertEquals(
    describeDeployment(s, []).rows.find((r) => r.label === "repositories")?.tone,
    "good",
  );
});

test("GitHub in user mode is named with the login it acts as", () => {
  const s = summary({
    forge: "in-process on :7412 · github (as @ada), local",
    forgeProviders: ["github", "local"],
    forgeGithub: { mode: "user", login: "ada" },
    forgeLocalRoot: "/srv/repos",
  });
  const value = rowValue(s, "repositories")!;
  assertStringIncludes(value, "forge in-process on :7412 · github (as @ada)");
  assertEquals(value.includes("local"), false);
});

test("GitLab is named with the login it acts as, and its host off gitlab.com", () => {
  const s = summary({
    forge: "in-process on :7412 · gitlab, local",
    forgeProviders: ["gitlab", "local"],
    forgeLocalRoot: "/srv/repos",
    forgeGitlab: {
      mode: "user",
      login: "ada.l",
      accountId: "7@https://gitlab.com",
      url: "https://gitlab.com",
      signIn: false,
    },
  });
  assertStringIncludes(
    rowValue(s, "repositories")!,
    "forge in-process on :7412 · gitlab (as @ada.l)",
  );
  // A bot acts under its own name too; a self-managed instance says where.
  const bot = summary({
    ...s,
    forgeGitlab: {
      mode: "bot",
      login: "ryph-bot",
      accountId: "1@https://git.example.com/gitlab",
      url: "https://git.example.com/gitlab",
      signIn: true,
    },
  });
  assertStringIncludes(rowValue(bot, "repositories")!, "gitlab (as @ryph-bot at git.example.com)");
  // A host that does not report one names the provider bare.
  assertStringIncludes(
    rowValue(summary({ forge: s.forge, forgeProviders: s.forgeProviders }), "repositories")!,
    "· gitlab",
  );
  assertEquals(
    gitlabName({
      mode: "user",
      login: "x",
      accountId: "1@not a url",
      url: "not a url",
      signIn: false,
    }),
    "as @x",
  );
});

test("Radicle in user mode is named with the identity it acts as", () => {
  const radicle = {
    did: "did:key:z6MkehUNS8bxayxDsyV7fwquX89NgTpU614CuxXy9V6Qxibb",
    alias: "ada",
    home: "/Users/ada/.radicle",
    nodeRunning: true,
  };
  const s = summary({
    forge: "in-process on :7412 · radicle, local",
    forgeProviders: ["radicle", "local"],
    forgeLocalRoot: "/Users/ada",
    radicle,
  });
  assertStringIncludes(
    rowValue(s, "repositories")!,
    "forge in-process on :7412 · radicle (as did:key:z6MkehUNS8bx…Qxibb (ada))",
  );
  assertEquals(describeDeployment(s, []).notes?.some((n) => n.includes("radicle-node")), false);
  // A node that is down is said, with the command that starts it.
  const down = describeDeployment(
    summary({ ...s, radicle: { ...radicle, nodeRunning: false } }),
    [],
  );
  assertEquals(down.notes?.some((n) => n.includes("rad node start")), true);
  // An identity that could not be read is its own problem, and not said to be the node's.
  const unread = describeDeployment(summary({ ...s, radicle: { ...radicle, did: null } }), []);
  assertEquals(unread.notes?.some((n) => n.includes("could not read your Radicle identity")), true);
  assertEquals(unread.notes?.some((n) => n.includes("rad node start")), false);
});

test("a remote historian is named; a separate local one shows its own database", () => {
  assertStringIncludes(
    rowValue(summary({ historyRemote: "http://historian:7413" }), "run history")!,
    "remote http://historian:7413",
  );
  assertEquals(
    rowValue(summary({ historyDb: "pglite ./data/hist" }), "run history"),
    "pglite ./data/hist",
  );
  // Sharing the control plane's database is the default and adds no row.
  assertEquals(rowValue(summary(), "run history"), undefined);
});

test("status() renders without colour when NO_COLOR is set", () => {
  process.env.NO_COLOR = "1";
  try {
    const text = status(describeDeployment(summary(), ["created the database"]));
    assertEquals(text.includes("\x1b["), false, "no escape sequences with NO_COLOR");
    assertStringIncludes(text, "First launch");
    assertStringIncludes(text, "web UI");
  } finally {
    delete process.env.NO_COLOR;
  }
});

test("up defaults the local root to home only when it is unset and the forge is in-process", () => {
  assertEquals(defaultedLocalRepoRoot("embedded", undefined, "/Users/me"), "/Users/me");
  assertEquals(defaultedLocalRepoRoot("embedded", "", "/Users/me"), "/Users/me");
  // Said out loud, it is kept: a narrower root, or `off`, which the host reads as no root.
  assertEquals(defaultedLocalRepoRoot("embedded", "/srv/repos", "/Users/me"), null);
  assertEquals(defaultedLocalRepoRoot("embedded", "off", "/Users/me"), null);
  // A forge elsewhere reads its own.
  assertEquals(defaultedLocalRepoRoot("http://forge:7412", undefined, "/Users/me"), null);
  assertEquals(defaultedLocalRepoRoot("embedded", undefined, null), null);
});

test("an on/off setting is read strictly, and unset is its default", () => {
  assertEquals(flagSetting("RYPH_LOCAL_PREVIEWS", undefined, true), true);
  assertEquals(flagSetting("RYPH_LOCAL_PREVIEWS", " ", true), true);
  assertEquals(flagSetting("RYPH_LOCAL_PREVIEWS", "off", true), false);
  assertEquals(flagSetting("RYPH_LOCAL_PREVIEWS", "FALSE", true), false);
  assertEquals(flagSetting("RYPH_LOCAL_PREVIEWS", "on", false), true);
  // A typo is fatal rather than read as either answer.
  assertThrows(() => flagSetting("RYPH_LOCAL_PREVIEWS", "of", true), Error, "must be on or off");
});

test("previews share one port only when it is named, and its companions need it", () => {
  assertEquals(previewListenerFromEnv({}), undefined);
  assertEquals(previewListenerFromEnv({ RYPH_LOCAL_PREVIEWS_PORT: "7490" }), {
    port: 7490,
    hostname: "127.0.0.1",
  });
  assertEquals(
    previewListenerFromEnv({
      RYPH_LOCAL_PREVIEWS_PORT: "7490",
      RYPH_LOCAL_PREVIEWS_BIND: "0.0.0.0",
      RYPH_LOCAL_PREVIEWS_PUBLIC_PORT: "8490",
    }),
    { port: 7490, hostname: "0.0.0.0", publicPort: 8490 },
  );
  assertThrows(
    () => previewListenerFromEnv({ RYPH_LOCAL_PREVIEWS_PORT: "70000" }),
    Error,
    "must be a port number",
  );
  assertThrows(
    () => previewListenerFromEnv({ RYPH_LOCAL_PREVIEWS_BIND: "0.0.0.0" }),
    Error,
    "need RYPH_LOCAL_PREVIEWS_PORT",
  );
});
