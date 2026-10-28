import { z } from "zod";

// ---------------------------------------------------------------------------
// RENDERS: an MP4 of an avatar performing a script, made without a live call.
//
// Everything in one shot happens at the same time; shots play one after another.
//
//   {
//     "avatarId": "ava_0123456789abcdef0123456789abcdef",
//     "shots": [
//       { "clipId": "gesture_send_flower", "say": "你终于来了。今天……我有话想对你说。" },
//       { "clipId": "idle_touch_collar", "say": "别笑，我是认真的。", "pauseAfterMs": 800 },
//       { "say": "所以，今晚留下来。" }
//     ]
//   }
//
// A shot has three optional fields:
//   clipId        what she does: a ready clip of the avatar, or "primary" for the avatar's own video.
//   say           what she says; speech starts when the shot starts.
//   pauseAfterMs  how long she stays silent after speaking, 0 to 10,000 ms.
//
// This file is the render resource the API returns, published byte for byte at
// /render.contract.ts, so it imports nothing but zod.
// ---------------------------------------------------------------------------

/** `rnd_` + 32 lowercase hex. */
export const RENDER_ID_PATTERN = /^rnd_[0-9a-f]{32}$/;
export const renderIdSchema = z.string().regex(RENDER_ID_PATTERN, "render id must be rnd_ followed by 32 lowercase hex");

/** `ready` like clips and recordings: the MP4 is stored and can be downloaded. */
export const RENDER_STATUSES = ["queued", "rendering", "ready", "failed"] as const;
export const renderStatusSchema = z.enum(RENDER_STATUSES);
export type RenderStatus = z.infer<typeof renderStatusSchema>;

/**
 * Why a render failed. A mistake in the request is refused when you create the render, with a
 * 400 or a 422, and never becomes a failed render.
 */
export const RENDER_FAILURE_CODES = ["asset_unavailable", "tts_failed", "too_long", "render_failed"] as const;
export const renderFailureCodeSchema = z.enum(RENDER_FAILURE_CODES);
export type RenderFailureCode = z.infer<typeof renderFailureCodeSchema>;

/** The sentence a failed render carries. */
export const RENDER_FAILURE_MESSAGES = {
  asset_unavailable: "The avatar's video or one of its clips could not be loaded. Try again later.",
  tts_failed: "Speech could not be generated for this script. Try again.",
  too_long: "The rendered video would be longer than the maximum length. Shorten the script.",
  render_failed: "The video could not be rendered. Try again.",
} as const satisfies Record<RenderFailureCode, string>;

/** The clip id that means the avatar's own video. It always loops. */
export const RENDER_PRIMARY_CLIP_ID = "primary";

/**
 * How a clip plays in a shot: `once` plays the action one time, `loop` fills the shot. Which one a
 * clip gets is this one rule, word for word in every doc that states it.
 */
export const RENDER_PLAYBACK_RULE =
  "A clip loops if it is \"primary\" or in the avatar's idle pool (behavior.idle.clips in the avatar's clip list); every other clip plays once.";
export const RENDER_PLAYBACKS = ["once", "loop"] as const;
export const renderPlaybackSchema = z.enum(RENDER_PLAYBACKS);
export type RenderPlayback = z.infer<typeof renderPlaybackSchema>;

/** Limits on one request. */
export const RENDER_MAX_SHOTS = 50;
export const RENDER_MAX_SAY_CHARS = 1_000;
export const RENDER_MAX_TOTAL_SAY_CHARS = 4_000;
export const RENDER_MAX_PAUSE_AFTER_MS = 10_000;
/** Different clips one script may name; "primary" does not count. */
export const RENDER_MAX_CLIPS = 16;
/** The longest video one render may produce. */
export const RENDER_MAX_OUTPUT_SECONDS = 180;
/**
 * Every shot's length is rounded up to a whole multiple of this, and no shot is shorter: a shot
 * that only names a loop clip lasts exactly this long.
 */
export const RENDER_SHOT_ROUNDING_MS = 200;
/**
 * Renders one workspace may have queued or rendering at once; the next create is a retryable 429
 * `concurrency_limit_reached`.
 */
export const RENDER_MAX_IN_FLIGHT_PER_WORKSPACE = 4;
/** Constant frame rate of every rendered MP4. */
export const RENDER_FPS = 25;

export const renderErrorSchema = z.object({
  code: renderFailureCodeSchema,
  message: z.string().min(1),
}).strict();

/** Where one shot landed in the video. Every time is milliseconds from the start of the video. */
export const shotTimingSchema = z.object({
  index: z.number().int().nonnegative().describe("The shot's position in your shots list, from 0."),
  startMs: z.number().int().nonnegative().describe("When the shot starts."),
  endMs: z.number().int().positive().describe("When the shot ends; the next shot starts here."),
  clipId: z.string().min(1).describe("The clip the shot played: the one you named, else the loop clip it kept, else \"primary\"."),
  playback: renderPlaybackSchema.describe("once: the clip's action played one time. loop: the clip filled the shot."),
  speechStartMs: z.number().int().nonnegative().nullable().describe("When she starts speaking. Null when the shot has no say."),
  speechEndMs: z.number().int().nonnegative().nullable().describe("When she stops speaking. Null when the shot has no say."),
  clipEndMs: z.number().int().nonnegative().nullable().describe("When the action finished. Once clips only; null for a loop clip."),
  afterClipId: z.string().min(1).nullable()
    .describe("The loop clip shown after the action finished, when the shot outlasts it. Once clips only; otherwise null."),
}).strict();
export type ShotTiming = z.infer<typeof shotTimingSchema>;

export const renderSchema = z.object({
  id: renderIdSchema,
  object: z.literal("render"),
  status: renderStatusSchema,
  avatarId: z.string().min(1),
  voiceId: z.string().min(1).nullable()
    .describe("The voice the render speaks with: the voiceId you sent, else the avatar's own voice. Null when the avatar has no usable voice and the platform's default voice was used."),
  durationMs: z.number().int().positive().nullable().describe("Length of the rendered video. Set once status is ready."),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  timeline: z.array(shotTimingSchema).nullable().describe("One entry per shot, in order. Set once status is ready."),
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
