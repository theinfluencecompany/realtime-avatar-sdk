import type { CartesiaTtsModel, LLMSelection } from "realtime-avatar-contracts";
export { LLM_PROVIDERS } from "realtime-avatar-contracts";

/**
 * Cartesia voice selector for avatar creation. The client just forwards it — no
 * provider logic in the SDK; the platform resolves it into a `default_voice_id`:
 *   - explicit: `{ provider:'cartesia', cartesiaVoiceId, cartesiaModel? }`
 *   - AUTO (LLM picks from the bundled catalog): `{ provider:'cartesia', mode:'auto', language?, gender? }`
 */
export type CartesiaExplicitVoiceOption = {
  provider: "cartesia";
  cartesiaVoiceId: string;
  cartesiaModel?: CartesiaTtsModel;
};

export type CartesiaAutoVoiceOption = {
  provider: "cartesia";
  mode: "auto";
  language?: string;
  gender?: string;
};

export type AvatarVoiceOption = CartesiaExplicitVoiceOption | CartesiaAutoVoiceOption;

export const REALTIME_AVATAR_MODEL_IDS = {
  live: "realtime-avatar-live-v1",
  video: "realtime-avatar-video-v1",
} as const;

export type RealtimeAvatarPlatformEnvironment = "live" | "test";
export type PlatformAssetKind = "image" | "video" | "audio";
export type PlatformAvatarSourceKind = "image" | "video";
export type PlatformAvatarModelId = (typeof REALTIME_AVATAR_MODEL_IDS)[keyof typeof REALTIME_AVATAR_MODEL_IDS];
export type PlatformAvatarStatus = "draft" | "preprocessing" | "ready" | "failed" | "disabled" | "deleted";
export type PlatformApiKeyScope =
  | "*"
  | "api_keys:write"
  | "credits:read"
  | "avatars:read"
  | "avatars:write"
  | "realtime:write"
  | "usage:read"
  | "usage:write";

export type PlatformCreditBalance = {
  tenantId: string;
  balanceCreditMicros: number;
  reservedCreditMicros: number;
  availableCreditMicros: number;
  lifetimeGrantedCreditMicros: number;
  lifetimeUsedCreditMicros: number;
  updatedAt: string;
};

export type PlatformAsset = {
  id: string;
  tenantId: string;
  kind: PlatformAssetKind;
  status: "pending_upload" | "uploaded" | "processing" | "ready" | "failed" | "deleted";
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
  publicUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformAvatar = {
  id: string;
  tenantId: string;
  displayName: string;
  sourceKind: PlatformAvatarSourceKind;
  modelId: PlatformAvatarModelId;
  sourceAssetId: string | null;
  status: PlatformAvatarStatus;
  defaultVoiceId: string | null;
  llm: LLMSelection | null;
  createdAt: string;
  updatedAt: string;
};

export type UpdatePlatformAvatarRequest = {
  displayName?: string;
  defaultVoiceId?: string | null;
  llm?: LLMSelection | null;
  /** Free-form; `settings.persona` / `metadata.persona` drive the avatar's spoken context. */
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CreatePlatformAvatarRequest = {
  displayName: string;
  sourceKind: PlatformAvatarSourceKind;
  modelId?: PlatformAvatarModelId;
  sourceAssetId?: string;
  defaultVoiceId?: string;
  /**
   * Optional Cartesia voice selector (explicit voice id, or AUTO via the LLM).
   * Ignored when `defaultVoiceId` is set; both omitted keeps the prior default.
   */
  voice?: AvatarVoiceOption;
  llm?: LLMSelection | null;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type UploadPlatformAssetOptions = {
  kind?: PlatformAssetKind;
  filename?: string;
  contentType?: string;
};

export type CreateRemotePlatformAssetRequest = {
  kind: PlatformAssetKind;
  remoteUrl: string;
  originalFilename?: string;
  metadata?: Record<string, unknown>;
};

export type CreateImageAvatarOptions = {
  displayName: string;
  image: Blob;
  filename?: string;
  defaultVoiceId?: string;
  /** Optional Cartesia voice (explicit id or AUTO). Forwarded to the platform. */
  voice?: AvatarVoiceOption;
  llm?: LLMSelection | null;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CreateVideoAvatarOptions = {
  displayName: string;
  video: Blob;
  filename?: string;
  defaultVoiceId?: string;
  /** Optional Cartesia voice (explicit id or AUTO). Forwarded to the platform. */
  voice?: AvatarVoiceOption;
  llm?: LLMSelection | null;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CreateVideoAvatarFromUrlOptions = {
  displayName: string;
  videoUrl: string;
  filename?: string;
  defaultVoiceId?: string;
  /** Optional Cartesia voice (explicit id or AUTO). Forwarded to the platform. */
  voice?: AvatarVoiceOption;
  llm?: LLMSelection | null;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  assetMetadata?: Record<string, unknown>;
};

export type CreateImageAvatarResult = {
  asset: PlatformAsset;
  avatar: PlatformAvatar;
};

export type CreateVideoAvatarResult = {
  asset: PlatformAsset;
  avatar: PlatformAvatar;
};

/**
 * Non-streaming lipsync: render an audio URL to a talking-head MP4 and get back
 * its public URL. Provide an existing `avatarId` or a `portraitUrl` to register
 * on the fly.
 */
export type LipsyncOptions = {
  audioUrl: string;
  avatarId?: string;
  portraitUrl?: string;
  backgroundId?: string;
};

export type LipsyncResult = {
  url: string;
  avatarId: string;
  frames: number;
  fps: number;
  durationSeconds: number;
};

/** The outcome of reconciling an avatar's external clip library to the video-cache tier
 *  (see RealtimeAvatarClient.syncAvatarClips). Content-addressed cache ids. */
export type SyncAvatarClipsResult = {
  /** Cache ids newly queued for an offline build (were missing or not yet ready). */
  queued: string[];
  /** Cache ids already ready — left untouched. */
  ready: string[];
  /** Cache ids retired because their clip URL is no longer in the library. */
  retired: string[];
};
