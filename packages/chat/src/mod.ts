// @ryph/chat — chat platforms linked to runs: a Telegram bot in a group, a Zulip bot in an
// organization, a Slack app in a workspace, or a Discord bot in a server; a binding from a run to
// one conversation for the run's lifetime, the platform tool the agent posts through, and the
// poller that hands every mention of the bot to the control plane's mention door.
//
// Two halves, and where each one lands depends on the deployment:
// - the CONTROL side (setup → routes, service, internalRoutes): the management surface for the
//   app, and the orchestrator's `ChatAccess` (bind, close, check a commander, read a thread). In the single process @ryph/host calls
//   setup() and spreads the routes into its router; standalone, src/main.ts serves them on its
//   own listener beside the internal surface a remote orchestrator dials.
// - the DATA side (setup → dataHandler): the MCP route the gateway forwards a run's `post` to,
//   service-authed with the gateway's token and scoped by the run id it names.
//
// Storage is its own schema owner (drizzle.config.ts, one migration set), sharing the instance
// under the single process and owning a database when standalone — the memory service's shape.

export type {
  ChannelVisibility,
  ChatBinding,
  ChatChannel,
  ChatGroup,
  ChatMention,
  ChatMentionOutcome,
  ChatMentionVerdict,
  Chatroom,
  ChatroomKind,
  ChatThread,
  CommanderVerdict,
  MentionImage,
  PollCursor,
  PublicChatroom,
  RoomContext,
  RunClosing,
  ThreadFetch,
} from "./core/types.ts";
export {
  DISCORD_MAX_POST_CHARS,
  imageMarker,
  isLinked,
  MAX_MENTION_IMAGE_BYTES,
  MAX_MENTION_IMAGE_TOTAL_BYTES,
  MAX_MENTION_IMAGES,
  MAX_POST_TEXT,
  SLACK_MAX_POST_CHARS,
  TELEGRAM_MAX_POST_CHARS,
  THREAD_MAX_CHARS,
  THREAD_MAX_MESSAGES,
  toPublicChatroom,
} from "./core/types.ts";
export {
  type ChatDiag,
  ChatRefusedError,
  type ChatService,
  type ChatServiceDeps,
  closingLine,
  type CreateChatroomRequest,
  DOOR_DOWN_REPLY,
  makeChatService,
  NOT_SUBSCRIBED_REPLY,
  type OpenBindingConversation,
  type OpenBindingOutcome,
  type PollStats,
  type PostedImages,
  type PostOutcome,
  splitPost,
  type TokenSealer,
} from "./core/service.ts";
export type { ChatStore } from "./ports/store.ts";
export type {
  BotIdentity,
  ChatCredential,
  ChatTransport,
  ConversationTarget,
  ImageDelivery,
  ImageDownload,
  ImageSource,
  InboundMessage,
  Located,
  OutboundImage,
  PlatformRoom,
  PollBatch,
  PollPosition,
  PollUpdate,
} from "./ports/transport.ts";
export type { MentionDelivery, MentionSink } from "./ports/mention_sink.ts";
export type { ImageResolution, ResolvedImage, RunImages } from "./ports/run_images.ts";
export { type ImageMention, MAX_POST_IMAGES, splitImageRefs } from "./core/agent_images.ts";
export {
  PLATFORM_API_URL_VARS,
  type PlatformApiUrls,
  platformApiUrlsFromEnv,
  platformTransports,
} from "./adapters/transport/api_urls.ts";
export {
  normalizeUpdate,
  telegramTransport,
  type TelegramTransportOptions,
} from "./adapters/transport/telegram.ts";
export {
  stripBotMentions,
  ZulipError,
  zulipTransport,
  type ZulipTransportOptions,
} from "./adapters/transport/zulip.ts";
export {
  conversationKey,
  parseAddress,
  renderSlackText,
  type SlackAddress,
  type SlackDialer,
  SlackError,
  type SlackSocket,
  slackTransport,
  type SlackTransportOptions,
  stripBotMention,
} from "./adapters/transport/slack.ts";
export {
  type DiscordAddress,
  type DiscordDialer,
  DiscordError,
  type DiscordSocket,
  DiscordThreadLockedError,
  discordTransport,
  type DiscordTransportOptions,
  parseDiscordAddress,
  renderDiscordText,
} from "./adapters/transport/discord.ts";
export { httpMentionSink, type HttpMentionSinkOptions } from "./adapters/mention_sink/http.ts";
export { httpRunImages, type HttpRunImagesOptions } from "./adapters/run_images/http.ts";
export {
  CHAT_DISABLED,
  chatRoutes,
  type ChatRoutesDeps,
  disabledChatRoutes,
  type Route,
} from "./http/routes.ts";
export { internalChatRoutes, type InternalRoutesDeps } from "./http/internal.ts";
export { makeChatDataHandler, MCP_PATH, RUN_ID_HEADER } from "./http/data.ts";
export { TOOLS } from "./mcp/tools.ts";
export { type ChatSetup, type ChatSetupDeps, pollLockKey, setup } from "./setup.ts";
export { drizzleChatStore } from "./adapters/store/drizzle.ts";
export { type ChatDbHandle, makeChatDb, scopeChatDb } from "./adapters/store/db/db.ts";
