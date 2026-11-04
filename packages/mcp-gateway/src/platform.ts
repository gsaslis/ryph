// The platform-server constants, as the `@ryph/mcp-gateway/platform` entry point — a leaf like
// tool_scope.ts and for the same reason: the orchestrator adds the platform memory server to every
// remembering agent's frozen tool scope, and importing that id from the package barrel would embed
// the whole gateway in the control-plane image and the compiled binary. core/platform.ts is where
// they are defined, beside the seed; this file re-exports the strings and nothing else.

export {
  PLATFORM_CHAT_SERVER_ID,
  PLATFORM_CHAT_SLUG,
  PLATFORM_FORGE_SERVER_ID,
  PLATFORM_FORGE_SLUG,
  PLATFORM_MEMORY_SERVER_ID,
  PLATFORM_MEMORY_SLUG,
  PLATFORM_RUN_ID_HEADER,
  PLATFORM_URL_SCHEME,
  PLATFORM_WEB_SERVER_ID,
  PLATFORM_WEB_SLUG,
} from "./core/platform.ts";
