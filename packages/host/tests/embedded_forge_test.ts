// The embedded forge's reach: bound where the control plane is, answering only the names a run
// or this process dials it by, with webhook deliveries let through on their own signature.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { guardExceptDeliveries } from "@ryph/forge";
import type { ServeHandlerInfo } from "@ryph/service";
import { allowedHosts, forgeAllowedHosts, guardHost } from "../src/local_surface.ts";

const ok = () => new Response("ok");

test("an embedded forge answers its gateway's container view and loopback, not a rebound name", async () => {
  // A native Linux engine: runs dial the bridge, which the host detects and binds.
  const hosts = allowedHosts({
    binds: ["127.0.0.1", "172.17.0.1"],
    urls: ["http://host.docker.internal:7411", "http://172.17.0.1:7412", undefined],
    extra: undefined,
  });
  for (const name of ["localhost:7412", "127.0.0.1:7412", "172.17.0.1:7412"]) {
    assert(hosts!.has(name.split(":")[0]), name);
  }
  assert(hosts!.has("host.docker.internal"));
  assert(!hosts!.has("rebound.example"));
  // RYPH_ALLOWED_HOSTS=* turns the check off, as on the control plane.
  assertEquals(
    allowedHosts({ binds: ["127.0.0.1"], urls: [null, null, null], extra: "*" }),
    null,
  );

  const handler = guardExceptDeliveries(ok, (h) => guardHost(h, hosts));
  const info = {} as ServeHandlerInfo;
  const at = (method: string, path: string, host: string) =>
    Promise.resolve(
      handler(new Request(`http://x${path}`, { method, headers: { host } }), info),
    ).then((r) => r.status);
  assertEquals(await at("GET", "/v1/repos", "172.17.0.1:7412"), 200);
  assertEquals(await at("GET", "/v1/repos", "localhost:7412"), 200);
  assertEquals(await at("GET", "/v1/repos", "rebound.example:7412"), 421);
  // A webhook delivery arrives under its tunnel's name and is verified by its signature.
  assertEquals(await at("POST", "/v1/hooks/github", "abc.trycloudflare.com"), 200);
  assertEquals(await at("GET", "/v1/hooks/github", "abc.trycloudflare.com"), 421);
});

test("an embedded forge answers the address a build clones it at (deploy/compose's launcher)", async () => {
  // deploy/compose: runs dial the gate, the launcher clones from ryph by name.
  const opts = {
    binds: ["0.0.0.0"],
    publicUrl: "http://ryph-gate-ryph-compose:7411",
    gitGatewayUrl: "http://ryph-gate-ryph-compose:7412",
    toolsUrl: undefined,
    extra: undefined,
  };
  const hosts = forgeAllowedHosts({ ...opts, buildGatewayUrl: "http://ryph:7412" });
  const handler = guardExceptDeliveries(ok, (h) => guardHost(h, hosts));
  const at = (host: string) =>
    Promise.resolve(
      handler(
        new Request("http://x/repo.git/info/refs", { headers: { host } }),
        {} as ServeHandlerInfo,
      ),
    ).then((r) => r.status);
  assertEquals(await at("ryph:7412"), 200);
  assertEquals(await at("ryph-gate-ryph-compose:7412"), 200);
  assertEquals(await at("rebound.example:7412"), 421);
  // Without it, the clone is the 421 this guards against.
  assert(!forgeAllowedHosts({ ...opts, buildGatewayUrl: null })!.has("ryph"));
});
