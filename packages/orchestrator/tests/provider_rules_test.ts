// The per-provider rules a fourth forge had to be taught: GitLab's addresses, its change request
// heads and labels, who it hears from, and who ryph writes as there.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { isRepoRef } from "../src/schema.ts";
import { actsAsPerson, commandTier, forgeName, providerHasEvents } from "../src/core/forge_repo.ts";
import { changeRequestBranch } from "../src/core/checks.ts";
import { changeRequestHeadRef, normalizeBaseRef } from "@ryph/shared/refs";
import type { ForgeProviders } from "../src/ports/forge.ts";

const BOT = {
  mode: "bot" as const,
  login: "ryph-bot",
  accountId: "1@https://gitlab.com",
  url: "https://gitlab.com",
  signIn: true,
};
const PERSON = { ...BOT, mode: "user" as const, signIn: false };

test("a GitLab address is a nested path, and nothing that walks one", () => {
  assert(isRepoRef("gitlab", "acme/platform/app"));
  assert(!isRepoRef("gitlab", "app"));
  assert(!isRepoRef("gitlab", "acme/../app"));
  assert(!isRepoRef("github", "acme/platform/app"), "GitHub's stays owner/name");
});

test("a merge request's head is served as merge-requests/<iid>/head", () => {
  assertEquals(changeRequestHeadRef("gitlab", "mr-7"), "refs/merge-requests/7/head");
  assertEquals(changeRequestBranch("gitlab", "mr-7"), "merge-requests/7/head");
  assertEquals(normalizeBaseRef("merge-requests/7/head").remoteRef, "refs/merge-requests/7/head");
});

test("GitLab's command tier is write, as GitHub's, and its name is its own", () => {
  assertEquals(commandTier("gitlab"), "write");
  assertEquals(forgeName("gitlab"), "GitLab");
});

test("who sends events: a GitLab bot does, a GitLab person does not", () => {
  const with_ = (gitlab: ForgeProviders["gitlab"]) => ({ github: null, gitlab, radicle: null });
  assertEquals(providerHasEvents("gitlab", with_(BOT)), true);
  assertEquals(providerHasEvents("gitlab", with_(PERSON)), false);
  assertEquals(providerHasEvents("gitlab", with_(null)), false);
  assertEquals(
    providerHasEvents("github", {
      github: { mode: "app", signIn: true },
      gitlab: null,
      radicle: null,
    }),
    true,
  );
  assertEquals(
    providerHasEvents("github", {
      github: { mode: "user", login: "a" },
      gitlab: null,
      radicle: null,
    }),
    false,
  );
  assertEquals(providerHasEvents("local", with_(BOT)), false);
});

test("ryph writes as a person on GitLab in user mode, and when the mode is not known", () => {
  const gitlab = { provider: "gitlab" as const, installationId: null };
  assertEquals(actsAsPerson(gitlab, { gitlab: BOT }), false);
  assertEquals(actsAsPerson(gitlab, { gitlab: PERSON }), true);
  assertEquals(actsAsPerson(gitlab, undefined), true);
  assertEquals(actsAsPerson({ provider: "github", installationId: null }, undefined), true);
  assertEquals(actsAsPerson({ provider: "github", installationId: "1" }, undefined), false);
  assertEquals(actsAsPerson({ provider: "radicle", installationId: null }, undefined), false);
});
