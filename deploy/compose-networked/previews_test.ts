// Assert the Compose previews service's memory bounds as parsed data, without starting Docker.
/* oxlint-disable typescript/no-explicit-any */
import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { readFile } from "node:fs/promises";

test("compose-networked: previews caps its sockets' kernel buffers and has a memory limit, as the chart's pods do", async () => {
  const manifest = new URL("./compose.yaml", import.meta.url);
  const { services } = Bun.YAML.parse(await readFile(manifest, "utf8")) as any;
  const previews = services.previews;
  // Both buffers at 128 KiB, a socket's worth of the tunnel's frames.
  assertEquals(previews.sysctls, {
    "net.ipv4.tcp_rmem": "4096 32768 131072",
    "net.ipv4.tcp_wmem": "4096 16384 131072",
  });
  // The chart's default limit: the cgroup's memory.max the service's guard reads.
  assertEquals(previews.mem_limit, "768m");
});

test("compose-networked: runs reach the previews tunnel port through the gate, never the API port", async () => {
  const manifest = new URL("./compose.yaml", import.meta.url);
  const { services } = Bun.YAML.parse(await readFile(manifest, "utf8")) as any;
  const env = services.previews.environment;
  assertEquals([env.RYPH_PREVIEWS_TUNNEL_PORT, env.RYPH_PREVIEWS_API_PORT], [7491, 7493]);
  // The control plane calls the API port directly, and hands runs the tunnel port through the
  // gate.
  const cp = services["control-plane"].environment;
  assertEquals(cp.RYPH_PREVIEWS_URL, "http://previews:7493");
  assertEquals(cp.RYPH_RUN_PREVIEWS_URL, "http://ryph-gate-ryph:7491");
  // The gate relays the tunnel port, and no route reaches the API port.
  const routes = String(services.launcher.environment.RYPH_DOCKER_GATE_ROUTES)
    .split(",");
  assertEquals(routes.filter((route) => route.includes("previews")), ["7491=previews:7491"]);
  assertEquals(routes.some((route) => route.includes(":7493")), false);
});
