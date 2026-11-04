// GitLab's settings set where nothing reads them are warned of at boot. The forge reads all of
// them; in-process memory reads RYPH_GITLAB_URL too (a repo-file memory on a self-managed
// instance), so with memory here that one is never said to do nothing; the binary's app reads it
// and the client id beside a remote forge (its GitLab sign-in, where PUBLIC_GITLAB_* are unset).

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { unreadGitlabSettings } from "../src/main.ts";

const set = (names: string[]) => (name: string) => names.includes(name) ? "x" : undefined;

test("an in-process forge reads every GitLab setting", () => {
  const env = set(["RYPH_GITLAB_URL", "RYPH_GITLAB_TOKEN"]);
  assertEquals(
    unreadGitlabSettings(env, { forgeEmbedded: true, memoryInProcess: false, appInProcess: false }),
    [],
  );
});

test("beside a remote forge, in-process memory still reads the instance URL", () => {
  const env = set(["RYPH_GITLAB_URL", "RYPH_GITLAB_TOKEN"]);
  assertEquals(
    unreadGitlabSettings(env, { forgeEmbedded: false, memoryInProcess: true, appInProcess: false }),
    [
      "RYPH_GITLAB_TOKEN",
    ],
  );
  assertEquals(
    unreadGitlabSettings(set(["RYPH_GITLAB_URL"]), {
      forgeEmbedded: false,
      memoryInProcess: true,
      appInProcess: false,
    }),
    [],
  );
});

test("with neither here, every GitLab setting set is unread", () => {
  const env = set(["RYPH_GITLAB_URL", "RYPH_GITLAB_TOKEN"]);
  assertEquals(
    unreadGitlabSettings(env, {
      forgeEmbedded: false,
      memoryInProcess: false,
      appInProcess: false,
    }),
    [
      "RYPH_GITLAB_URL",
      "RYPH_GITLAB_TOKEN",
    ],
  );
});

test("beside a remote forge, the binary's app reads the instance URL and client id", () => {
  // Its GitLab sign-in falls back to them where PUBLIC_GITLAB_* are unset (ryph's appEnv).
  const env = set(["RYPH_GITLAB_URL", "RYPH_GITLAB_CLIENT_ID", "RYPH_GITLAB_TOKEN"]);
  assertEquals(
    unreadGitlabSettings(env, { forgeEmbedded: false, memoryInProcess: false, appInProcess: true }),
    ["RYPH_GITLAB_TOKEN"],
  );
});
