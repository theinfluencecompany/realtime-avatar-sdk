import { z } from "zod";

// ---------------------------------------------------------------------------
// RENDER EXPORT: a pre-rendered, lip-synced MP4 of an avatar speaking a script, made offline on a
// GPU with no live call. The platform publishes this file byte for byte at /render.contract.ts
// (`x-render-contract`), so it imports nothing but zod. The create request and the GPU wire,
// which need the session contract's voice and lip-gain schemas, live in render-export.ts.
// ---------------------------------------------------------------------------

/** `rnd_` + 32 lowercase hex. The render's id on the public API and on the GPU wire alike. */
export const RENDER_ID_PATTERN = /^rnd_[0-9a-f]{32}$/;
export const renderIdSchema = z.string().regex(RENDER_ID_PATTERN, "render id must be rnd_ followed by 32 lowercase hex");

export const RENDER_STATUSES = ["queued", "rendering", "succeeded", "failed"] as const;
export const renderStatusSchema = z.enum(RENDER_STATUSES);
export type RenderStatus = z.infer<typeof renderStatusSchema>;

/**
 * Why a render failed, and what the caller can do about it. The GPU reports the same codes, so a
 * failure crosses both hops without being renamed; one the platform itself hits (the GPU never
 * answered, the file could not be stored) is `render_failed`.
 */
export const RENDER_FAILURE_CODES = ["invalid_request", "asset_unavailable", "tts_failed", "too_long", "render_failed"] as const;
export const renderFailureCodeSchema = z.enum(RENDER_FAILURE_CODES);
export type RenderFailureCode = z.infer<typeof renderFailureCodeSchema>;

/** The sentence a failed render carries. Upstream prose never reaches the caller. */
export const RENDER_FAILURE_MESSAGES = {
  invalid_request: "The render request could not be rendered as written. Check the segments and clips.",
  asset_unavailable: "The avatar's video or one of its clips could not be loaded. Try again later.",
  tts_failed: "Speech could not be generated for this script. Try again.",
  too_long: "The rendered video would be longer than the maximum length. Shorten the script.",
  render_failed: "The video could not be rendered. Try again.",
} as const satisfies Record<RenderFailureCode, string>;

/** Limits on one request. The GPU enforces the same numbers. */
export const RENDER_MAX_SEGMENTS = 50;
export const RENDER_MAX_SEGMENT_TEXT_CHARS = 1_000;
export const RENDER_MAX_TOTAL_TEXT_CHARS = 4_000;
export const RENDER_MIN_PAUSE_MS = 100;
export const RENDER_MAX_PAUSE_MS = 10_000;
export const RENDER_MAX_CLIPS = 16;
/** The longest video one render may produce; longer fails `too_long`. */
export const RENDER_MAX_OUTPUT_SECONDS = 180;
/** Constant frame rate of every rendered MP4. */
export const RENDER_FPS = 25;

export const renderErrorSchema = z.object({
  code: renderFailureCodeSchema,
  message: z.string().min(1),
}).strict();

export const renderSchema = z.object({
  id: renderIdSchema,
  object: z.literal("render"),
  status: renderStatusSchema,
  avatarId: z.string().min(1),
  durationMs: z.number().int().positive().nullable().describe("Length of the rendered video. Set once status is succeeded."),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  error: renderErrorSchema.nullable().describe("Set only when status is failed."),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export type Render = z.infer<typeof renderSchema>;

export const listRendersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
}).strict();
export type ListRendersQuery = Partial<z.infer<typeof listRendersQuerySchema>>;

export const listRendersResponseSchema = z.object({
  data: z.array(renderSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type ListRendersResponse = z.infer<typeof listRendersResponseSchema>;

export const renderAccessResponseSchema = z.object({
  id: renderIdSchema,
  url: z.string().url(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type RenderAccessResponse = z.infer<typeof renderAccessResponseSchema>;
