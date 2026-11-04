// The boot summary names each provider an in-process forge acts on, and as whom: the one line
// that tells the person whose account ryph's writes will appear as, before any of them happen.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { forgeLabel } from "../src/main.ts";

test("GitHub through one person's token says whose; as an App, only its name", () => {
  assertEquals(forgeLabel("github", { mode: "user", login: "ada" }, null), "github (as @ada)");
  assertEquals(forgeLabel("github", { mode: "app", signIn: true }, null), "github");
  assertEquals(forgeLabel("github", null, null), "github");
});

test("GitLab says whose and on which instance, in either mode, a path prefix kept", () => {
  assertEquals(
    forgeLabel("gitlab", null, {
      mode: "user",
      login: "ada",
      accountId: "1@https://gitlab.com",
      url: "https://gitlab.com",
      signIn: false,
    }),
    "gitlab (as @ada at gitlab.com)",
  );
  assertEquals(
    forgeLabel("gitlab", null, {
      mode: "bot",
      login: "ryph-bot",
      accountId: "1@https://git.example.com:8443/gitlab/",
      url: "https://git.example.com:8443/gitlab/",
      signIn: true,
    }),
    "gitlab (as @ryph-bot at git.example.com:8443/gitlab)",
  );
  // A forge that did not say how it acts on GitLab is still named.
  assertEquals(forgeLabel("gitlab", null, null), "gitlab");
});

test("every other provider is its name", () => {
  const ada = {
    mode: "user" as const,
    login: "ada",
    accountId: "1@https://gitlab.com",
    url: "https://gitlab.com",
    signIn: false,
  };
  for (const p of ["radicle", "local"]) {
    assertEquals(forgeLabel(p, { mode: "user", login: "ada" }, ada), p);
  }
});
