// Server-only entry. These helpers hash/verify API keys with a secret pepper
// and are meant to run on YOUR backend (the platform), never shipped to a
// browser or handed to API consumers. They are deliberately kept out of the
// default client entry so the published SDK exposes no key-verification logic.
//
//   import { hashRealtimeAvatarApiKey } from "realtime-avatar/server";
export {
  RealtimeAvatarClient,
  DEFAULT_BROWSER_PROXY_URL,
  DEFAULT_PLATFORM_BASE_URL,
  type RealtimeAvatarRequestOptions,
  type RealtimeAvatarServerOptions,
} from "./client";
export type {
  ConfiguredLLMProviders,
  OpenAICompatibleLLMProviderCredentials,
  LLMProviderCredentials,
  LLMCredentialsConfig,
  SecretSource,
} from "./llm";
export {
  createRouteHandler,
  handleRealtimeAvatarProxy,
  type RealtimeAvatarProxyOperation,
  type RealtimeAvatarRouteHandler,
  type RealtimeAvatarRouteHandlerOptions,
} from "./server/proxy";

export {
  RealtimeAvatarApiKeyError,
  assertRealtimeAvatarApiKeyActive,
  hashRealtimeAvatarApiKey,
  parseRealtimeAvatarApiKey,
  redactRealtimeAvatarApiKey,
  verifyRealtimeAvatarApiKeyHash,
  type ParsedRealtimeAvatarApiKey,
  type RealtimeAvatarApiKeyEnvironment,
} from "./api-keys";

export {
  createRealtimeAvatarHandler,
  type ConnectClip,
  type ConnectContextMessage,
  type ConnectPolicy,
  type ConnectSessionContext,
  type ConnectVideo,
  type ConnectVideoState,
  type CreateRealtimeAvatarHandlerOptions,
  type RealtimeAvatarHandler,
} from "./connect/handler";
