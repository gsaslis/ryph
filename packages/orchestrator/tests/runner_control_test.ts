// The cancel push goes where the provisioner placed the run, and nowhere a run or a reply
// points it: the address is derived, never reported, and a redirect is a refusal.

import { afterEach, test } from "bun:test";
import { assertEquals } from "@std/assert";
import { httpRunnerControl } from "../src/adapters/runner_control/http.ts";
import { runContainerName, runControlUrl } from "../src/adapters/provisioner/docker.ts";
import { launcherClients } from "../src/adapters/launcher/mod.ts";
import { RUNNER_CONTROL_PORT } from "../src/core/services.ts";
import type { Provisioner } from "../src/ports/provisioner.ts";
import { silentDiagnostics } from "./doubles.ts";

const servers: Array<{ stop(): unknown }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** A loopback listener recording what reached it, answering each path as `routes` says. */
function listen(routes: Record<string, (url: URL) => Response>) {
  const hits: Array<{ method: string; path: string; auth: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      hits.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") });
      return (routes[url.pathname] ?? (() => new Response("no", { status: 404 })))(url);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, hits };
}

const RUN = { id: "r-1", handle: "c0ffee", controlToken: "control-secret" };

test("the push goes to the address the provisioner derives for that run, with its token", async () => {
  const runner = listen({ "/cancel": () => new Response(null, { status: 202 }) });
  const asked: Array<{ id: string; handle: string }> = [];
  const provisioner: Pick<Provisioner, "controlUrl"> = {
    controlUrl(run) {
      asked.push(run);
      return `${runner.base}/cancel`;
    },
  };
  const control = httpRunnerControl(provisioner, silentDiagnostics());
  assertEquals(await control.requestCancel(RUN), true);
  assertEquals(asked, [{ id: "r-1", handle: "c0ffee" }]);
  assertEquals(runner.hits, [{ method: "POST", path: "/cancel", auth: "Bearer control-secret" }]);
});

test("no address, no push: a provisioner that places none, or a run never launched", async () => {
  let asked = 0;
  const none = httpRunnerControl({ controlUrl: () => (asked++, null) }, silentDiagnostics());
  assertEquals(await none.requestCancel(RUN), false);
  assertEquals(asked, 1);
  // Kubernetes and the manual adapter leave it undefined.
  assertEquals(await httpRunnerControl({}, silentDiagnostics()).requestCancel(RUN), false);
  // A run with no container yet has nowhere to be.
  assertEquals(await none.requestCancel({ ...RUN, handle: null }), false);
  assertEquals(asked, 1);
});

test("a redirect is a refusal, and is not followed", async () => {
  const elsewhere = listen({ "/internal": () => new Response("secret") });
  for (const status of [301, 302, 303, 307, 308]) {
    const runner = listen({
      "/cancel": () =>
        new Response(null, { status, headers: { location: `${elsewhere.base}/internal` } }),
    });
    const control = httpRunnerControl(
      { controlUrl: () => `${runner.base}/cancel` },
      silentDiagnostics(),
    );
    assertEquals(await control.requestCancel(RUN), false, `a ${status} pushed nothing`);
    assertEquals(runner.hits.length, 1);
  }
  assertEquals(elsewhere.hits, [], "the control plane never followed one");
});

test("docker places a run by its container's name, from the run id alone", () => {
  assertEquals(runContainerName("r-1"), "ryph-run-r-1");
  assertEquals(runControlUrl("r-1"), `http://ryph-run-r-1:${RUNNER_CONTROL_PORT}/cancel`);
  // The launcher's client derives the same address without asking the launcher anything.
  const { provisioner } = launcherClients(
    { url: "http://launcher.invalid", token: "t" },
    silentDiagnostics(),
  );
  assertEquals(
    provisioner.controlUrl?.({ id: "r-1", handle: "c0ffee" }),
    `http://ryph-run-r-1:${RUNNER_CONTROL_PORT}/cancel`,
  );
});
