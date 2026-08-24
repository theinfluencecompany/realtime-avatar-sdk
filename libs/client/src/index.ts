export {
  normalizeRealtimeAvatarError,
  RealtimeAvatarApiError,
  RealtimeAvatarCapacityError,
  RealtimeAvatarConfigError,
  RealtimeAvatarValidationError,
} from "./errors";
export {
  RealtimeAvatarClient,
  DEFAULT_BROWSER_PROXY_URL,
  DEFAULT_PLATFORM_BASE_URL,
  type RealtimeAvatarBrowserOptions,
  type LiveKitSessionStartResult,
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
  RealtimeAvatarApiKeyError,
  parseRealtimeAvatarApiKey,
  redactRealtimeAvatarApiKey,
  type ParsedRealtimeAvatarApiKey,
  type RealtimeAvatarApiKeyEnvironment,
} from "./api-keys";
export {
  toLiveKitSessionWireRequest,
  type ClientMetadata,
  type LiveKitCapacitySnapshot,
  type LiveKitSessionGrant,
  type LiveKitSessionRequest,
  type LiveKitSttMode,
  type TranscriptWebhook,
} from "./livekit-grant";
export type {
  AvatarSourceKind,
  BreezeVoiceSpec,
  CartesiaTtsModel,
  CartesiaVoiceSpec,
  FishTtsModel,
  FishVoiceSpec,
  LLMConfig,
  LLMProvider,
  LLMSelection,
  LLMSelectionForProvider,
  VoiceSpec,
  VoiceSpecInput,
} from "./types";
export { LLM_PROVIDERS, REALTIME_AVATAR_MODEL_IDS } from "./platform";
export type {
  RealtimeAvatarPlatformEnvironment,
  PlatformAssetKind,
  PlatformAvatarSourceKind,
  PlatformAvatarModelId,
  PlatformAvatarStatus,
  PlatformApiKeyScope,
  PlatformCreditBalance,
  PlatformAsset,
  PlatformAvatar,
  SyncAvatarClipsResult,
  UpdatePlatformAvatarRequest,
  CreatePlatformAvatarRequest,
  AvatarVoiceOption,
  CartesiaExplicitVoiceOption,
  CartesiaAutoVoiceOption,
  UploadPlatformAssetOptions,
  CreateRemotePlatformAssetRequest,
  CreateImageAvatarOptions,
  CreateImageAvatarResult,
  CreateVideoAvatarOptions,
  CreateVideoAvatarFromUrlOptions,
  CreateVideoAvatarResult,
} from "./platform";
