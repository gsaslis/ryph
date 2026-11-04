// A ToolHost with no container runtime behind it: launches are recorded, containers are entries
// in a map, and every failure a real backend can produce is one call away. What the hosting
// service is tested against — the adapters' own tests pin their argv separately.

import type {
  ToolContainerState,
  ToolHost,
  ToolLaunch,
  ToolLaunchSpec,
} from "../src/ports/tool_host.ts";

export interface FakeContainer {
  spec: ToolLaunchSpec;
  state: ToolContainerState;
  address: string;
}

export interface FakeToolHost extends ToolHost {
  /** Every launch, in order, including the guard's. */
  launches: ToolLaunchSpec[];
  /** Every stop, by handle. */
  stops: string[];
  containers: Map<string, FakeContainer>;
  networkEnsured: boolean;
  /** The next launch whose name matches throws this. */
  failLaunch(match: RegExp, message: string): void;
  failNetwork(message: string): void;
  /** Every `list` from here on throws this — a backend that will not enumerate. */
  failList(message: string): void;
  /** The container dies behind the gateway's back. */
  crash(name: string): void;
  /** Lines `logs` answers for a handle. */
  setLogs(handle: string, text: string): void;
  /** The last launch of the guard, or undefined. */
  guard(): ToolLaunchSpec | undefined;
}

export function fakeToolHost(
  opts: { reachesGuard?: boolean; egressProxy?: string | null; guardImage?: string } = {},
): FakeToolHost {
  const reachesGuard = opts.reachesGuard ?? false;
  const launches: ToolLaunchSpec[] = [];
  const stops: string[] = [];
  const containers = new Map<string, FakeContainer>();
  const logs = new Map<string, string>();
  const launchFailures: Array<{ match: RegExp; message: string }> = [];
  let networkFailure: string | null = null;
  let listFailure: string | null = null;
  let nextIp = 2;

  const host: FakeToolHost = {
    kind: "fake",
    reachesGuard,
    ...(opts.egressProxy === undefined ? {} : { egressProxy: opts.egressProxy }),
    ...(opts.guardImage === undefined ? {} : { guardImage: opts.guardImage }),
    launches,
    stops,
    containers,
    networkEnsured: false,

    ensureNetwork() {
      if (networkFailure !== null) return Promise.reject(new Error(networkFailure));
      host.networkEnsured = true;
      return Promise.resolve();
    },

    launch(spec): Promise<ToolLaunch> {
      launches.push(structuredClone(spec));
      const failure = launchFailures.findIndex((f) => f.match.test(spec.name));
      if (failure !== -1) {
        const [{ message }] = launchFailures.splice(failure, 1);
        return Promise.reject(new Error(message));
      }
      // Like the real backends: a published launch is reached on loopback; a vendor's by its
      // name (docker) or its name's Service (kubernetes, where the backend reaches containers);
      // an unpublished guard at an address the backend hands out, a fresh one every time.
      const address = spec.publish !== undefined
        ? `127.0.0.1:${
          spec.publish.hostPort === 0 ? 40000 + launches.length : spec.publish.hostPort
        }`
        : !reachesGuard
        ? `${spec.name}:${spec.port}`
        : spec.name.startsWith("ryph-tool-guard")
        ? `10.9.0.${nextIp++}:${spec.port}`
        : `${spec.name}.ryph-tools.svc:${spec.port}`;
      containers.set(spec.name, { spec: structuredClone(spec), state: "running", address });
      return Promise.resolve({ handle: spec.name, address });
    },

    stop(handle) {
      stops.push(handle);
      containers.delete(handle);
      return Promise.resolve();
    },

    list() {
      if (listFailure !== null) return Promise.reject(new Error(listFailure));
      return Promise.resolve([...containers.keys()]);
    },

    inspect(handle) {
      return Promise.resolve(containers.get(handle)?.state ?? "unknown");
    },

    address(handle) {
      const c = containers.get(handle);
      return Promise.resolve(c?.state === "running" ? c.address : null);
    },

    logs(handle, tail) {
      const lines = (logs.get(handle) ?? "").split("\n");
      return Promise.resolve(lines.slice(-tail).join("\n"));
    },

    failLaunch(match, message) {
      launchFailures.push({ match, message });
    },
    failNetwork(message) {
      networkFailure = message;
    },
    failList(message) {
      listFailure = message;
    },
    crash(name) {
      const c = containers.get(name);
      if (c) c.state = "exited";
    },
    setLogs(handle, text) {
      logs.set(handle, text);
    },
    guard() {
      return [...launches].reverse().find((l) => l.name === "ryph-tool-guard");
    },
  };
  return host;
}
