// The public surface — what a mounting host imports. Everything else is wiring detail.

export { type AutomationsSetup, type AutomationsSetupDeps, setupAutomations } from "./setup.ts";
export type {
  Automation,
  AutomationEvent,
  AutomationTrigger,
  Fire,
  FireOutcome,
  ResponseConversation,
  ResponseCorrelation,
  ResponsePolicy,
  ScheduleTrigger,
  TriggerRateLimit,
  TriggerVerification,
  WebhookTrigger,
} from "./core/types.ts";
export { DEFAULT_ATTENDED_IDLE_MS, DEFAULT_IDLE_MS } from "./core/types.ts";
export {
  defaultCorrelation,
  type FireSignal,
  FORMAT_PRESETS,
  type FormatPreset,
  formatYieldsKeys,
  type HeaderSource,
  presetOf,
  type PresetVerification,
  readSignal,
  type SecretSource,
  type SignalMapping,
  type SignalStatus,
  unknownSignal,
  WEBHOOK_FORMAT_KINDS,
  type WebhookFormat,
  type WebhookFormatKind,
} from "./core/formats.ts";
export { automationRoutes, type RoutesDeps } from "./http/routes.ts";
export { makeUserAuth } from "./http/auth.ts";
export type { Route } from "@ryph/shared/http";
export type { AutomationStore } from "./ports/automation_store.ts";
export type { DeliverResult, EventSink } from "./ports/event_sink.ts";
export type { Diagnostics } from "./ports/diagnostics.ts";
export { httpEventSink } from "./adapters/event_sink/http.ts";
export type { ChatroomDirectory, ChatroomPlatform } from "./ports/chatroom_directory.ts";
export {
  httpChatroomDirectory,
  type HttpChatroomDirectoryOptions,
} from "./adapters/chatroom_directory/http.ts";
export { drizzleAutomationStore } from "./adapters/store/drizzle.ts";
export {
  type AutomationsDbHandle,
  makeAutomationsDb,
  scopeAutomationsDb,
} from "./adapters/store/db/db.ts";
