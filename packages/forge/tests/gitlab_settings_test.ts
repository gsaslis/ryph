// GitLab's configuration, read from the environment: one instance, one mode, one token, and
// every partial or contradictory set refused with a sentence that never prints a secret.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { gitlabUrlOf, readGitlabSettings } from "../src/main.ts";

const TOKEN = "glpat-bootTokenNeverPrinted01";
const SECRET = "webhook-master-never-printed";

const read = (vars: Record<string, string>) => readGitlabSettings((n) => vars[n] || undefined);

const refused = (vars: Record<string, string>, says: string) => {
  const err = assertThrows(() => read(vars), Error);
  assertStringIncludes(err.message, says);
  assert(!err.message.includes(TOKEN), "a boot error never prints the token");
  assert(!err.message.includes(SECRET), "nor the webhook secret");
};

test("no GitLab variable is no GitLab", () => {
  assertEquals(read({}), null);
});

test("a token alone is a bot on gitlab.com", () => {
  assertEquals(read({ RYPH_GITLAB_TOKEN: TOKEN }), {
    mode: "bot",
    url: "https://gitlab.com",
    token: { kind: "static", token: TOKEN },
    webhookSecret: null,
    oauth: null,
    group: null,
  });
});

test("a full bot set on a self-managed instance under a path prefix", () => {
  assertEquals(
    read({
      RYPH_GITLAB_URL: "https://git.example.com/gitlab/",
      RYPH_GITLAB_MODE: "bot",
      RYPH_GITLAB_TOKEN: TOKEN,
      RYPH_GITLAB_WEBHOOK_SECRET: SECRET,
      RYPH_GITLAB_CLIENT_ID: "client",
      RYPH_GITLAB_CLIENT_SECRET: "client-secret",
      RYPH_GITLAB_GROUP: "acme/platform",
    }),
    {
      mode: "bot",
      url: "https://git.example.com/gitlab",
      token: { kind: "static", token: TOKEN },
      webhookSecret: SECRET,
      oauth: { clientId: "client", clientSecret: "client-secret" },
      group: "acme/platform",
    },
  );
});

test("user mode takes a token command and nothing a bot has", () => {
  assertEquals(
    read({
      RYPH_GITLAB_MODE: "user",
      RYPH_GITLAB_TOKEN_COMMAND: "glab config get token --host gitlab.com",
    }),
    {
      mode: "user",
      url: "https://gitlab.com",
      token: { kind: "command", command: "glab config get token --host gitlab.com" },
      webhookSecret: null,
      oauth: null,
      group: null,
    },
  );
  for (
    const extra of [
      { RYPH_GITLAB_WEBHOOK_SECRET: SECRET },
      { RYPH_GITLAB_CLIENT_ID: "c", RYPH_GITLAB_CLIENT_SECRET: "s" },
      { RYPH_GITLAB_GROUP: "acme" },
    ] as Array<Record<string, string>>
  ) {
    refused({ RYPH_GITLAB_MODE: "user", RYPH_GITLAB_TOKEN: TOKEN, ...extra }, "user mode");
  }
});

test("every partial or contradictory set is refused by name", () => {
  refused({ RYPH_GITLAB_URL: "https://gitlab.example.com" }, "neither RYPH_GITLAB_TOKEN");
  refused({ RYPH_GITLAB_WEBHOOK_SECRET: SECRET }, "neither RYPH_GITLAB_TOKEN");
  refused(
    {
      RYPH_GITLAB_TOKEN: TOKEN,
      RYPH_GITLAB_TOKEN_COMMAND: "glab config get token --host gitlab.com",
    },
    "both set",
  );
  refused(
    {
      RYPH_GITLAB_TOKEN_COMMAND: "glab config get token --host gitlab.com",
      RYPH_FORGE_NO_TOKEN_COMMAND: "1",
    },
    "may not run a token command",
  );
  refused({ RYPH_GITLAB_TOKEN: TOKEN, RYPH_GITLAB_MODE: "app" }, "RYPH_GITLAB_MODE");
  refused({ RYPH_GITLAB_TOKEN: TOKEN, RYPH_GITLAB_CLIENT_ID: "c" }, "needs both");
  refused({ RYPH_GITLAB_TOKEN: TOKEN, RYPH_GITLAB_URL: "gitlab.com" }, "RYPH_GITLAB_URL");
  refused({ RYPH_GITLAB_TOKEN: TOKEN, RYPH_GITLAB_GROUP: "../x" }, "RYPH_GITLAB_GROUP");
});

test("the instance URL is an origin and a path, nothing else", () => {
  assertEquals(gitlabUrlOf("https://gitlab.com"), "https://gitlab.com");
  assertEquals(gitlabUrlOf("https://gitlab.com/"), "https://gitlab.com");
  assertEquals(gitlabUrlOf("http://localhost:8080/gl//"), "http://localhost:8080/gl");
  assertEquals(gitlabUrlOf("https://user:pw@gitlab.com"), null);
  assertEquals(gitlabUrlOf("https://gitlab.com/?x=1"), null);
  assertEquals(gitlabUrlOf("https://gitlab.com/#x"), null);
  assertEquals(gitlabUrlOf("ftp://gitlab.com"), null);
  assertEquals(gitlabUrlOf("gitlab.com"), null);
});
