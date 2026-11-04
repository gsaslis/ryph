// A caller and a launcher of different versions read each other's strict schemas as bugs; the
// wire revision in /v1/info makes that a boot refusal naming both, never a run of 400s.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { LAUNCHER_WIRE_REVISION } from "@ryph/mcp-gateway/tool-host";
import {
  awaitLauncherInfo,
  checkedInfo,
  launcherClients,
  LauncherWireMismatch,
} from "../src/adapters/launcher/mod.ts";
import { silentDiagnostics } from "./doubles.ts";

const INFO = {
  wire: LAUNCHER_WIRE_REVISION,
  engine: null,
  network: null,
  runNetwork: null,
  gate: null,
  routes: null,
  runtime: null,
  checks: true,
  builds: false,
  buildsRefused: null,
  prefetch: false,
};

test("the launcher's info is read only at this process's own wire revision", () => {
  assertEquals(checkedInfo(INFO, "http://l"), INFO);
  for (const wire of [LAUNCHER_WIRE_REVISION + 1, "1", undefined]) {
    let thrown: unknown = null;
    try {
      checkedInfo({ ...INFO, wire }, "http://l");
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof LauncherWireMismatch, String(thrown));
    assertStringIncludes(
      thrown.message,
      `this process speaks wire revision ${LAUNCHER_WIRE_REVISION}`,
    );
    assertStringIncludes(thrown.message, "same version");
  }
});

test("boot refuses a launcher of another revision at once rather than wait it out", async () => {
  let asked = 0;
  const clients = launcherClients({
    url: "http://launcher:7470",
    token: "t",
    fetch: (() => {
      asked++;
      return Promise.resolve(Response.json({ ...INFO, wire: LAUNCHER_WIRE_REVISION + 1 }));
    }) as unknown as typeof fetch,
  }, silentDiagnostics());
  const err = await assertRejects(() => awaitLauncherInfo(clients, "http://launcher:7470", 30_000));
  assertStringIncludes(String(err), `wire revision ${LAUNCHER_WIRE_REVISION + 1}`);
  assertEquals(asked, 1);
});
