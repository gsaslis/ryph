// @ryph/service — what every long-running service in this workspace needs from the platform that
// runs it, and nothing else: an HTTP listener for its fetch handler, health probes, a bounded
// drain, a lease for work only one replica may do at a time, and the boot refusal for public
// placeholder secrets.
//
// Small and shared on purpose. Health probes, drain ordering and leader election are identical in
// every service that has them, they are pure policy with no dependencies, and all three are easy
// to get quietly wrong in ways that only show up during an incident — a `/healthz` that reports
// its database and crash-loops the fleet, a drain that hangs on an SSE tail until the platform
// SIGKILLs it mid-request, a lease judged expired by comparing two pods' clocks. One
// implementation, tested once. The same reasoning that makes @ryph/logger a package.
//
// What does NOT belong here: anything a service could reasonably want to answer differently.
// Routing, authentication, and the readiness check itself all stay with the service.

export {
  DEFAULT_HEADERS_MS,
  DEFAULT_KEEP_ALIVE_MS,
  type HttpServer,
  type NetAddr,
  serve,
  type ServeHandler,
  type ServeHandlerInfo,
  type ServeOptions,
  type UpgradeWebSocketOptions,
} from "./serve.ts";
export { bindError, listenNode } from "./listen.ts";
export { FIRST_REQUEST_MS, frontHttpServer, type FrontOptions } from "./front.ts";
export { secretFromEnv } from "./secret_env.ts";
export { mintedFile, writeSecretFile } from "./secret_file.ts";
export { neverReached, REACH_MS, type ReachOptions, untilReached } from "./reach.ts";
export { type CaFetch, caFetch } from "./ca_fetch.ts";
export { realWs, type WsModule, type WsServer, type WsServerOptions, type WsSocket } from "./ws.ts";
export { type Health, type HealthDeps, type HealthRoute, makeHealth } from "./health.ts";
export {
  type Drainable,
  type DrainLog,
  type DrainOptions,
  installDrain,
  type Listener,
} from "./drain.ts";
export {
  DrainingError,
  type FetchHandler,
  quietDrainErrors,
  type StreamTracker,
  trackStreams,
  type TrackStreamsOptions,
} from "./streams.ts";
export {
  DEFAULT_LEASE_TIMINGS,
  type Lease,
  type LeaseDeps,
  type LeaseHolder,
  type LeaseTimings,
  makeLease,
} from "./lease.ts";
export type { LeaseRecord, LeaseStore, VersionedLease } from "./lease_store.ts";
export {
  ALLOW_DEV_SECRETS,
  type DevSecretsVerdict,
  findPublicDevSecrets,
  judgeDevSecrets,
  PUBLIC_DEV_SECRETS,
  refuseHostileEnvironment,
  refusePublicDevSecrets,
} from "./dev_secrets.ts";
export {
  kubernetesLeaseStore,
  type LeaseApi,
  type LeaseLocation,
  type LeaseManifest,
  leaseManifest,
  leaseRecord,
  microTime,
} from "./kubernetes_lease.ts";
