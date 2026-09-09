export { RealtimeAvatar, type RealtimeAvatarOptions, type StartCallOptions } from "./client.ts";
export { RealtimeAvatarError, RealtimeAvatarHttpError } from "./errors.ts";
export { verifyTranscript } from "./webhook.ts";
export { isQueued } from "./types.ts";
export { clipLibraryDeclarationSchema } from "./generated/clip-library-schema.ts";
export type {
  Asset,
  AssetKind,
  Avatar,
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
  ListSessionsOptions,
  StartCallResult,
  TranscriptPayload,
  UsageSession,
  UsageSessionPage,
  VideoPolicy,
} from "./types.ts";
