// Where an embedded launcher may host MCP servers for this process: on the docker host, or as a
// container the run gate reaches by name — and nowhere in between, which boot refuses.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { embeddedHostingRefusal } from "../src/launcher.ts";

test("a containerised binary hosting with no gate target is refused, naming the fix", () => {
  const refused = embeddedHostingRefusal({ hosting: true, joined: false, inContainer: true });
  assertStringIncludes(refused ?? "", "RYPH_DOCKER_GATE_TARGET");
  assertStringIncludes(refused ?? "", "RYPH_LAUNCHER_URL");
  // On the docker host, joined, or hosting nothing: each position is a working one.
  assertEquals(embeddedHostingRefusal({ hosting: true, joined: false, inContainer: false }), null);
  assertEquals(embeddedHostingRefusal({ hosting: true, joined: true, inContainer: true }), null);
  assertEquals(embeddedHostingRefusal({ hosting: false, joined: false, inContainer: true }), null);
});
