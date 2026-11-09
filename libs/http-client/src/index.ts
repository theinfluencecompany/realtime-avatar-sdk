export { RealtimeAvatar, type RealtimeAvatarOptions, type StartCallOptions } from "./client.ts";
export { RealtimeAvatarError, RealtimeAvatarHttpError, RealtimeAvatarWebhookError, type WebhookVerificationErrorCode } from "./errors.ts";
export { verifyTranscript, verifyVoiceWebhook } from "./webhook.ts";
export {
  externalTurnContextSchema, externalUtteranceSchema,
  type ExternalTurnContext, type ExternalUtterance,
} from "./generated/external-performance.ts";
export { isQueued } from "./types.ts";
export { clipLibraryDeclarationSchema } from "./generated/clip-library-schema.ts";
export { fishTtsModelSchema, DEFAULT_FISH_TTS_MODEL, type FishTtsModel, FISH_DELIVERY_MODELS, type FishDelivery } from "./generated/fish-tts-model.ts";
export { recordingModeSchema, recordingArtifactSchema, listRecordingsResponseSchema, recordingAccessResponseSchema } from "./generated/recording.ts";
export { renderSchema, listRendersResponseSchema, renderAccessResponseSchema } from "./generated/render.ts";
export type {
  RecordingMode,
  RecordingArtifactStatus,
  RecordingArtifact,
  ListRecordingsQuery,
  ListRecordingsResponse,
  RecordingAccessResponse,
  RenderStatus,
  RenderFailureCode,
  RenderPlayback,
  ShotTiming,
  Render,
  ListRendersQuery,
  ListRendersResponse,
  RenderAccessResponse,
  CreateRenderInput,
  RenderShot,
  Asset,
  AssetKind,
  Avatar,
  CreateLive2dAvatarInput,
  RegisteredAvatar,
  AvatarClip,
  AvatarSourceSwap,
  AvatarUpdate,
  CallConnection,
  CallMode,
  CallPolicy,
  CallQueued,
  ClipDeclaration,
  ClipLibrary,
  ClipLibraryDeclaration,
  ClipLibraryPlan,
  ClipLibraryUpdate,
  LoopRedirect,
  ClipSource,
  ContextMessage,
  CreditBalance,
  EndCallOptions,
  EndCallReason,
  ExternalLlm,
  ListSessionsOptions,
  StartCallResult,
  TranscriptPayload,
  UsageSession,
  UsageSessionPage,
  VideoPolicy,
  VoiceWebhook,
  VoiceWebhookErrorCode,
  VoiceWebhookRequest,
} from "./types.ts";
