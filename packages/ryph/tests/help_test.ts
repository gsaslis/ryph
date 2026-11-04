// `ryph up --help`'s GitLab section: what a hand-configured bot needs, and nothing the binary
// ignores.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { HELP } from "../src/main.ts";

const gitlab = HELP.slice(HELP.indexOf("RYPH_GITLAB_URL"), HELP.indexOf("RYPH_RADICLE_URL"));

test("a bot by hand is told it needs its token, an OAuth pair and a webhook secret", () => {
  for (
    const name of [
      "RYPH_GITLAB_TOKEN",
      "RYPH_GITLAB_CLIENT_ID",
      "RYPH_GITLAB_CLIENT_SECRET",
      "RYPH_GITLAB_WEBHOOK_SECRET",
      "/gitlab/callback",
    ]
  ) {
    assert(gitlab.includes(name), name);
  }
});

test("GitLab's webhooks are never said to need RYPH_FORGE_DB: the binary's forge always has one", () => {
  assertEquals(gitlab.includes("RYPH_FORGE_DB"), false);
});
