/**
 * Wire schemas for the public Realtime Avatar API.
 *
 * Code only, by policy: this file carries schemas and no narrative. Prose is where
 * boundaries are hardest to hold, because a sentence explaining WHY a field exists tends
 * to describe the thing on the other side of it.
 *
 * What may appear here is bounded by `public-surface.txt` and enforced by
 * `npm run surface`: every export must be named on that allowlist, so a new one is
 * refused until someone decides it is public. Documentation lives at
 * https://realtimeavatar.ai/docs.
 */
import { z } from "zod";

const DEFAULT_AVATAR_ID = "maria";
const DEFAULT_BACKGROUND_ID = "plain_white";

const sessionModeSchema = z.enum(["avatar", "voice"]);
type SessionMode = z.infer<typeof sessionModeSchema>;
const DEFAULT_SESSION_MODE: SessionMode = "avatar";

const DEFAULT_JOIN_TIMEOUT_SECONDS = 75;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_SESSION_SECONDS = 1_800;

const avatarSourceKindSchema = z.enum(["portrait", "source_video"]);
const liveKitSttModeSchema = z.enum(["server", "off"]);

/**
 * The server's chosen rendering path, carried through opaquely.
 *
 * Deliberately NOT an enum. Nothing in this SDK reads the value — it appears only in two
 * optional passthrough fields — so enumerating the alternatives bought no validation the
 * client acts on, while writing the server-side engine names into `dist/*.d.ts` and
 * therefore onto the public registry.
 *
 * Opaque is also the more forward-compatible choice: a new rendering path on the server
 * no longer fails an installed client's parse. If a caller ever needs to branch on this,
 * expose a narrow union of the CALLER-facing modes instead of the internal names —
 * `video.mode` is already that knob.
 */
export const renderBackendSchema = z.string();
export type RenderBackend = z.infer<typeof renderBackendSchema>;

const sessionLiveEditSchema = z
  .object({
    rules: z.string().min(1).max(2_000),
    cooldown_seconds: z.number().int().min(5).max(600).optional(),
    // Which machinery runs the re-edit. Absent ⇒ the server default ("editor"). A deploy
    // that cannot provide the requested renderer serves the editor lane and logs it,
    // rather than failing a call that would otherwise have connected fine.
    renderer: z.enum(["editor", "generative"]).optional(),
  })
  .strict();

const sessionSupportEditsSchema = z
  .object({
    instruction: z.string().min(1).max(1_000),
    reference_url: z.string().url().optional(),
    live_edit: sessionLiveEditSchema.optional(),
  })
  .strict();

export const LLM_PROVIDERS = ["local", "gemini", "openai"] as const;
export const llmProviderSchema = z.enum(LLM_PROVIDERS);

export const llmConfigSchema = z
  .object({
    backend: llmProviderSchema.optional(),
    model: z.string().max(200).nullable().optional(),
  })
  .strict();

export const llmSelectionSchema = z
  .object({
    provider: llmProviderSchema,
    model: z.string().max(200).nullable().optional(),
  })
  .strict();

const liveKitInitialContextMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1).max(4_000),
  })
  .strict();

const CARTESIA_TTS_MODELS = [
  "cartesia/sonic-2",
  "cartesia/sonic-2-latest",
  "cartesia/sonic-3",
  "cartesia/sonic-3-latest",
  "cartesia/sonic-turbo",
  "cartesia/sonic-turbo-latest",
] as const;
const cartesiaTtsModelSchema = z.enum(CARTESIA_TTS_MODELS);

const cartesiaVoiceSpecSchema = z
  .object({
    provider: z.literal("cartesia"),
    model: cartesiaTtsModelSchema.default("cartesia/sonic-3"),
    voice_id: z.string().min(1).max(120),
    speed: z.number().min(0.5).max(2).nullable().optional(),
    emotion: z.string().min(1).max(80).nullable().optional(),
    language: z.string().min(2).max(16).nullable().optional(),
  })
  .strict();

const FISH_TTS_MODELS = ["speech-1.6", "s1", "s2-pro", "speech-1.5", "s1-mini"] as const;
const fishTtsModelSchema = z.enum(FISH_TTS_MODELS);

const breezeVoiceSpecSchema = z
  .object({
    provider: z.literal("breezeblue"),
    model: z.string().min(1).max(80).default("bluebell-v1-en"),
    voice_id: z.string().min(1).max(120),
    guidance_scale: z.number().min(1).max(10).nullable().optional(),
    instructions: z.string().min(1).max(1_000).nullable().optional(),
    language: z.string().min(2).max(16).nullable().optional(),
  })
  .strict();

const fishVoiceSpecSchema = z
  .object({
    provider: z.literal("fish"),
    model: fishTtsModelSchema.default("speech-1.6"),
    voice_id: z.string().min(1).max(120),
    speed: z.number().min(0.5).max(2).nullable().optional(),
    emotion: z.string().min(1).max(80).nullable().optional(),
    language: z.string().min(2).max(16).nullable().optional(),
  })
  .strict();

export const voiceSpecSchema = z.discriminatedUnion("provider", [
  cartesiaVoiceSpecSchema,
  breezeVoiceSpecSchema,
  fishVoiceSpecSchema,
]);

const nullableUrlSchema = z.string().url().nullable();

const clipTriggerSchema = z.enum([
  "idle", 
  "listen", 
  "think", 
  "directive", 
]);

export const sessionClipSchema = z
  .object({
    clip_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, "clip_id must be a slug")
      .refine((id) => id !== "primary", "'primary' is reserved for the avatar's source video"),
    source_video_url: z.string().url().optional(),
    video_cache_id: z.string().min(8).max(160).optional(),
    max_seconds: z.number().min(1).max(10).optional(),

    trigger: clipTriggerSchema.optional(),

    loop: z.boolean().optional(),

    weight: z.number().min(0).max(100).optional(),

    crossfade_ms: z.number().int().min(0).max(1000).optional(),

    trim_start_ms: z.number().int().min(0).max(2000).optional(),

    trim_end_ms: z.number().int().min(0).max(2000).optional(),

    // The cue the character reads to decide this clip. `when` is the public name and the
    // one the docs use; `hint` is the name the wire first shipped under and still accepts.
    // Both are listed because this object is `.strict()` — omitting `when` would make the
    // public name a validation error. Send one, never both.
    when: z.string().min(1).max(120).optional(),
    hint: z.string().min(1).max(120).optional(),
  })
  .strict()
  .refine((clip) => clip.source_video_url || clip.video_cache_id, {
    message: "a clip needs source_video_url or video_cache_id",
  })
  // One cue, one name. Sending both is rejected at the edge, so catching it here turns a
  // remote 422 into a local error that says which field to drop.
  .refine((clip) => !(clip.when && clip.hint), {
    message: "set `when` or `hint`, not both — they are the same field",
    path: ["when"],
  });

const sessionChoreographySchema = z
  .object({

    idle_dwell_min_seconds: z.number().min(1).max(60).optional(),
    idle_dwell_max_seconds: z.number().min(1).max(120).optional(),

    special_weight: z.number().min(0).max(100).optional(),

    start_grace_seconds: z.number().min(0).max(60).optional(),

    crossfade_ms: z.number().int().min(0).max(1000).optional(),

    crossfade_easing: z.enum(["linear", "smooth", "ease_out"]).optional(),

    wrap_crossfade_ms: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.idle_dwell_min_seconds === undefined ||
      c.idle_dwell_max_seconds === undefined ||
      c.idle_dwell_min_seconds <= c.idle_dwell_max_seconds,
    { message: "idle_dwell_min_seconds must be <= idle_dwell_max_seconds" },
  );

export type SessionClip = z.infer<typeof sessionClipSchema>;

export const sessionBehaviorSchema = z
  .object({

    gestures_enabled: z.boolean().optional(),

    gesture_freq: z.enum(["sparse", "balanced", "lively"]).optional(),
  })
  .strict();
export type SessionBehavior = z.infer<typeof sessionBehaviorSchema>;

const _SCENE_CLIP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const sceneIdSchema = z.string().regex(/^[a-z0-9_]{1,40}$/, "scene_id must be a lowercase slug");

const sceneTransitionSchema = z
  .object({
    clip_id: z.string().regex(_SCENE_CLIP_ID_RE, "clip_id must be a slug"),
    source_video_url: z.string().url(),
    from_scene: sceneIdSchema,
    to_scene: sceneIdSchema,
    max_seconds: z.number().min(1).max(10).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.from_scene === v.to_scene) {
      ctx.addIssue({ code: "custom", message: "a transition's from_scene must differ from to_scene", path: ["to_scene"] });
    }
  });

const sceneClusterSchema = z
  .object({
    scene_id: sceneIdSchema,
    hub_clip_id: z.string().regex(_SCENE_CLIP_ID_RE, "hub_clip_id must be a slug"),
    clips: z.array(sessionClipSchema).min(1).max(4),
  })
  .strict();

const sceneGraphSchema = z
  .object({
    scenes: z.array(sceneClusterSchema).min(1).max(4),
    transitions: z.array(sceneTransitionSchema).min(2).max(12),
  })
  .strict();

const transcriptWebhookSchema = z
  .object({

    url: z.string().url().max(500),

    secret: z.string().min(16).max(200),
  })
  .strict();
export type TranscriptWebhook = z.infer<typeof transcriptWebhookSchema>;

const clientMetadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(200))
  .refine((value) => Object.keys(value).length <= 16, {
    message: "client_metadata carries at most 16 entries",
  });
export type ClientMetadata = z.infer<typeof clientMetadataSchema>;

export const liveKitSessionWireRequestSchema = z
  .object({
    avatar_id: z.string().min(1).max(160).default(DEFAULT_AVATAR_ID),
    background_id: z.string().min(1).max(160).default(DEFAULT_BACKGROUND_ID),

    mode: sessionModeSchema.default(DEFAULT_SESSION_MODE),
    create_room: z.boolean().default(true),
    dispatch_agent: z.boolean().default(true),
    instructions: z.string().min(1).max(4_000).optional(),
    initial_context: z.array(liveKitInitialContextMessageSchema).max(32).default([]),
    initial_say: z.string().min(1).max(1_000).optional(),
    llm: llmConfigSchema.nullable().optional(),
    max_session_seconds: z.number().int().min(1).max(DEFAULT_MAX_SESSION_SECONDS).optional(),
    participant_identity: z.string().min(1).max(160).optional(),
    participant_name: z.string().max(160).optional(),
    queue_ticket_id: z.string().min(1).max(160).optional(),
    portrait_url: nullableUrlSchema.optional(),
    room_name: z.string().min(1).max(160).optional(),
    source_kind: avatarSourceKindSchema.default("portrait"),
    source_video_url: nullableUrlSchema.optional(),
    stt_mode: liveKitSttModeSchema.default("server"),
    video_cache_id: z.string().min(1).max(240).nullable().optional(),
    voice: voiceSpecSchema.nullable().optional(),
    voice_id: z.string().min(1).max(240).nullable().optional(),

    // Deliberately UNBOUNDED. This object is `.strict()`, so it rejects rather than trims:
    // a count cap here does not mean "use fewer clips", it means "there is no call". How
    // many a session actually warms is decided where the clips are loaded, and loading
    // fewer is always safe — so the wire must not hold a number too.
    clip_library: z.array(sessionClipSchema).optional(),

    choreography: sessionChoreographySchema.optional(),

    scene_graph: sceneGraphSchema.optional(),
    behavior: sessionBehaviorSchema.optional(),

    expression_profile: z.string().min(1).max(40).optional(),

    render_backend: renderBackendSchema.optional(),
    support_edits: sessionSupportEditsSchema.optional(),

    transcript_webhook: transcriptWebhookSchema.optional(),

    client_metadata: clientMetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.support_edits && value.render_backend === "generative") {
      ctx.addIssue({
        code: "custom",
        message:
          "support_edits needs a source video to edit; it cannot be combined with render_backend='generative'",
        path: ["support_edits"],
      });
    }
    if (value.support_edits && value.mode === "voice") {
      ctx.addIssue({
        code: "custom",
        message: "support_edits needs a video session; it cannot be combined with mode='voice'",
        path: ["support_edits"],
      });
    }
    if (value.source_kind === "portrait") {
      if (value.source_video_url || value.video_cache_id) {
        ctx.addIssue({
          code: "custom",
          message: "source_video_url/video_cache_id require source_kind='source_video'",
          path: ["source_kind"],
        });
      }
      return;
    }
    if (value.portrait_url) {
      ctx.addIssue({
        code: "custom",
        message: "portrait_url cannot be combined with source_kind='source_video'",
        path: ["portrait_url"],
      });
    }
    if (!value.source_video_url && !value.video_cache_id) {
      ctx.addIssue({
        code: "custom",
        message: "source_kind='source_video' requires source_video_url or video_cache_id",
        path: ["source_video_url"],
      });
    }
  });

export const liveKitSessionRequestSchema = z
  .object({
    avatarId: z.string().min(1).max(160),
    backgroundId: z.string().min(1).max(160).default(DEFAULT_BACKGROUND_ID),

    mode: sessionModeSchema.default(DEFAULT_SESSION_MODE),
    createRoom: z.boolean().default(true),
    dispatchAgent: z.boolean().default(true),
    instructions: z.string().min(1).max(4_000).optional(),
    initialContext: z.array(liveKitInitialContextMessageSchema).max(32).default([]),
    initialSay: z.string().min(1).max(1_000).optional(),
    llm: llmSelectionSchema.nullable().optional(),
    maxSessionSeconds: z.number().int().min(1).max(DEFAULT_MAX_SESSION_SECONDS).optional(),
    participantIdentity: z.string().min(1).max(160).optional(),
    participantName: z.string().max(160).optional(),
    queueTicketId: z.string().min(1).max(160).optional(),
    roomName: z.string().min(1).max(160).optional(),
    sttMode: liveKitSttModeSchema.default("server"),
    voice: voiceSpecSchema.nullable().optional(),
    voiceId: z.string().min(1).max(240).nullable().optional(),

    // Unbounded, for the same reason as `clip_library` on the wire schema above.
    clipLibrary: z.array(sessionClipSchema).optional(),

    sceneGraph: sceneGraphSchema.optional(),

    behavior: sessionBehaviorSchema.optional(),

    renderBackend: renderBackendSchema.optional(),

    supportEdits: sessionSupportEditsSchema.optional(),

    transcriptWebhook: transcriptWebhookSchema.optional(),

    clientMetadata: clientMetadataSchema.optional(),
  })
  .strict();

export const liveKitSessionGrantSchema = z
  .object({
    status: z.literal("ready").default("ready"),
    session_id: z.string().min(1),
    room_name: z.string().min(1),
    livekit_url: z.string().min(1),
    participant_token: z.string().min(1),
    participant_identity: z.string().min(1),
    reservation_expires_at: z.string().datetime({ offset: true }),
    stt_mode: liveKitSttModeSchema.default("off"),
    room_created: z.boolean().default(false),
    dispatch_created: z.boolean().default(false),
    join_timeout_seconds: z.number().int().nonnegative().default(DEFAULT_JOIN_TIMEOUT_SECONDS),
    idle_timeout_seconds: z.number().int().nonnegative().default(DEFAULT_IDLE_TIMEOUT_SECONDS),
    max_session_seconds: z.number().int().nonnegative().default(DEFAULT_MAX_SESSION_SECONDS),
  })
  .passthrough();

export const RTA_LIFECYCLE_TOPIC = "rta.lifecycle";

export const RTA_TURN_INSTRUCTIONS_ATTR = "rta.turn_instructions";
export const RTA_CLOSING_TURN_ATTR = "rta.closing_turn";
export const RTA_TURN_ID_ATTR = "rta.turn_id";

const sessionEndReasonSchema = z.enum([
  "user_ended",
  "session_cap",
  "idle",
  "disconnected",
  "out_of_credits",
  "agent_ended",
  "failed",
]);
export type SessionEndReasonLabel = z.infer<typeof sessionEndReasonSchema>;

const approachingEndReasonSchema = z.enum(["session_cap", "idle"]);
export type ApproachingEndReason = z.infer<typeof approachingEndReasonSchema>;

const sessionClockFrameSchema = z
  .object({
    kind: z.literal("session_clock"),
    started_at_unix_ms: z.number().int().nonnegative(),
    max_session_seconds: z.number().int().nonnegative(),
    idle_timeout_seconds: z.number().int().nonnegative(),
  })
  .strict();

const endingFrameSchema = z
  .object({ kind: z.literal("ending"), reason: approachingEndReasonSchema })
  .strict();

const closingTurnDoneFrameSchema = z
  .object({ kind: z.literal("closing_turn_done"), turn_id: z.string().min(1) })
  .strict();

const endedFrameSchema = z
  .object({ kind: z.literal("ended"), reason: sessionEndReasonSchema })
  .strict();

export const knownBehaviorStates = ["idle", "listening", "thinking", "speaking"] as const;
export type KnownBehaviorState = (typeof knownBehaviorStates)[number];

const behaviorStateFrameSchema = z
  .object({
    kind: z.literal("behavior_state"),
    state: z.string().min(1).max(32),
    clip_id: z.string().min(1).max(64).optional(),

    trigger: clipTriggerSchema.optional(),
    loop: z.boolean().optional(),

    prev_clip_id: z.string().min(1).max(64).optional(),

    scene: z.string().min(1).max(40).optional(),

    scene_transition: z
      .object({
        clip_id: z.string().min(1).max(64),
        from_scene: z.string().min(1).max(40),
        to_scene: z.string().min(1).max(40),
      })
      .optional(),
  })
  .strip();

const clipAckFrameSchema = z
  .object({
    kind: z.literal("clip_ack"),
    request_id: z.string().max(64),
    accepted: z.boolean(),
    reason: z.string().max(64),
  })
  .strip();

export const lifecycleServerFrameSchema = z.discriminatedUnion("kind", [
  sessionClockFrameSchema,
  endingFrameSchema,
  closingTurnDoneFrameSchema,
  endedFrameSchema,
  behaviorStateFrameSchema,
  clipAckFrameSchema,
]);

export const liveKitCapacitySnapshotSchema = z
  .object({
    // Placement identity + per-worker session ceiling. These are always present on the
    // wire (the platform serializes them and they come back on the grant, so a customer
    // already sees them) but are typed OPTIONAL here on purpose: this SDK is the defensive
    // READER of that wire, so a consumer must tolerate a response variant that omits them
    // rather than hard-fail parse. `max_sessions_per_gpu` is how many sessions one waking
    // worker serves — a queue-depth estimate input a consumer reads off the busy response.
    capacity_pool: z.string().min(1).optional(),
    agent_name: z.string().min(1).optional(),
    max_sessions: z.number().int().nonnegative(),
    max_sessions_per_gpu: z.number().int().positive().optional(),
    worker_count: z.number().int().nonnegative(),
    active_sessions: z.number().int().nonnegative(),
    reserved_sessions: z.number().int().nonnegative(),
    observed_worker_active_sessions: z.number().int().nonnegative(),
    available_sessions: z.number().int().nonnegative(),
    queue_size: z.number().int().nonnegative(),
    admission_open: z.boolean(),
    recommended_retry_ms: z.number().int().nonnegative(),
    load: z.number().min(0).max(1),
  })
  .passthrough();

export const capacityBusyResponseSchema = z
  .object({
    message: z.string().min(1),
    capacity: liveKitCapacitySnapshotSchema,
    queue_size: z.number().int().nonnegative(),
    queue_ticket_id: z.string().min(1).optional(),
    queue_position: z.number().int().positive().optional(),
    recommended_retry_ms: z.number().int().nonnegative(),
  })
  .strict();

const liveKitSessionReleaseReasonSchema = z.enum([
  "page_hide", 
  "disconnected", 
  "superseded", 
  "unmount", 
  "manual", 
  "idle_timeout", 

]);

export type AvatarSourceKind = z.infer<typeof avatarSourceKindSchema>;
export type LiveKitSttMode = z.infer<typeof liveKitSttModeSchema>;
export type LLMProvider = z.infer<typeof llmProviderSchema>;
export type LLMConfig = z.infer<typeof llmConfigSchema>;
export type LLMSelection = z.infer<typeof llmSelectionSchema>;
export type LLMSelectionForProvider<TProvider extends LLMProvider = LLMProvider> =
  TProvider extends LLMProvider
    ? Omit<LLMSelection, "provider"> & { provider: TProvider }
    : never;
export type LiveKitInitialContextMessage = z.infer<typeof liveKitInitialContextMessageSchema>;
export type CartesiaTtsModel = z.infer<typeof cartesiaTtsModelSchema>;
export type FishTtsModel = z.infer<typeof fishTtsModelSchema>;
export type CartesiaVoiceSpec = z.infer<typeof cartesiaVoiceSpecSchema>;
export type BreezeVoiceSpec = z.infer<typeof breezeVoiceSpecSchema>;
export type FishVoiceSpec = z.infer<typeof fishVoiceSpecSchema>;

export type VoiceSpec = z.infer<typeof voiceSpecSchema>;

export type VoiceSpecInput = z.input<typeof voiceSpecSchema>;
export type LiveKitSessionRequestInput = z.input<typeof liveKitSessionRequestSchema>;
export type LiveKitSessionRequest = z.infer<typeof liveKitSessionRequestSchema>;
export type LiveKitSessionWireRequestInput = z.input<typeof liveKitSessionWireRequestSchema>;
export type LiveKitSessionGrant = z.infer<typeof liveKitSessionGrantSchema>;
export type LiveKitCapacitySnapshot = z.infer<typeof liveKitCapacitySnapshotSchema>;
export type CapacityBusyResponse = z.infer<typeof capacityBusyResponseSchema>;
export type LiveKitSessionReleaseReason = z.infer<typeof liveKitSessionReleaseReasonSchema>;

export const toLiveKitSessionWireRequest = (
  input: LiveKitSessionRequestInput,
): LiveKitSessionWireRequestInput => {
  const request = liveKitSessionRequestSchema.parse(input);
  return defined({
    avatar_id: request.avatarId,
    background_id: request.backgroundId,
    mode: request.mode,
    create_room: request.createRoom,
    dispatch_agent: request.dispatchAgent,
    instructions: request.instructions,
    initial_context: request.initialContext,
    initial_say: request.initialSay,
    llm: request.llm
      ? {
          backend: request.llm.provider,
          model: request.llm.model ?? undefined,
        }
      : request.llm,
    max_session_seconds: request.maxSessionSeconds,
    participant_identity: request.participantIdentity,
    participant_name: request.participantName,
    queue_ticket_id: request.queueTicketId,
    room_name: request.roomName,
    stt_mode: request.sttMode,
    voice: request.voice,
    voice_id: request.voiceId,
    clip_library: request.clipLibrary,
    behavior: request.behavior,
    render_backend: request.renderBackend,
    support_edits: request.supportEdits,
    transcript_webhook: request.transcriptWebhook,
    client_metadata: request.clientMetadata,
  });
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
};

const defined = <T extends Record<string, unknown>>(value: T): T => {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  ) as T;
};
