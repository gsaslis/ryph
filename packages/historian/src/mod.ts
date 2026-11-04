// @ryph/historian — the permanent record of what happened during a run: every transcript
// chunk and every diagnostics event the runner emits, stored append-only and streamed live.
//
// No process of its own (yet): the route list mounts inside the orchestrator, the same trick
// as @ryph/auth and @ryph/model-proxy's control side. Auth is injected, never owned —
// the host supplies the user gate and the per-run bearer check. Storage is a SEPARATE
// database file from the control plane's, so the append firehose can neither contend with
// nor bloat run-state, and a future split-out deployment just takes its file with it.

export {
  type HistoryEvent,
  type HistoryVoice,
  type IncomingHistoryEvent,
  LANE,
  type LaneSummary,
  MAIN_LANE,
  MAX_SUBAGENT_LANES,
} from "./core/types.ts";
export { type HistorianService, makeHistorianService } from "./core/service.ts";
export { type HistorianHttp, historianRoutes, type HistorianRoutesDeps } from "./http/routes.ts";
export type { Route } from "@ryph/shared/http";
export {
  type LiveEvent,
  type LiveFrame,
  type LiveOut,
  type LiveRooms,
  type LiveSnapshot,
  type LiveStatus,
  type LiveTab,
  makeLiveRooms,
} from "./core/live.ts";
export {
  type CommandEndReason,
  type CommandsEvent,
  type CommandsJob,
  type CommandsOut,
  type CommandsRooms,
  type CommandsSnapshot,
  makeCommandsRooms,
} from "./core/commands.ts";
export { IngestBatchSchema, MAX_BATCH, MAX_PAYLOAD_CHARS } from "./schema.ts";
export type { HistoryStore } from "./ports/store.ts";
export type { HistoryBus } from "./ports/bus.ts";
export { memoryHistoryBus } from "./adapters/bus/memory.ts";
export { drizzleHistoryStore } from "./adapters/store/drizzle.ts";
export { type HistorianDbHandle, makeHistorianDb } from "./adapters/store/db/db.ts";
export { scopeHistorianDb } from "./adapters/store/db/db.ts";
