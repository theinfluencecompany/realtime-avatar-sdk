import { z } from "zod";

// ---------------------------------------------------------------------------
// SERVER-OWNED RECORDING. The application server chooses this policy before minting.
// Public metadata is durable; credentials and renewable download URLs are separate.
// ---------------------------------------------------------------------------
export const RECORDED_MEDIA_MODES = ["audio", "video", "audio_video"] as const;
export type RecordedMediaMode = (typeof RECORDED_MEDIA_MODES)[number];
// A per-participant file always carries that participant's own audio, so video-only is not one
// of its modes. This narrower list is the vocabulary `platform_participant_recordings.mode`
// CHECKs, and the annotation is what keeps it a subset of the one above.
export const PARTICIPANT_RECORDED_MEDIA_MODES: readonly [RecordedMediaMode, ...RecordedMediaMode[]] = ["audio", "audio_video"];
export const recordingModeSchema = z
  .enum(["off", ...RECORDED_MEDIA_MODES, "participants", "tracks"])
  .describe("Server-owned recording policy; omitted means off. Legacy audio includes user and avatar audio. participants saves one continuous audio/video file per participant, without mixing their voices. tracks saves each published participant audio/video track separately; list recordings by session after capture.");
export type RecordingMode = z.infer<typeof recordingModeSchema>;
export const DEFAULT_RECORDING_MODE: RecordingMode = "off";
// Recordings are not auto-deleted. The platform asks RTA to capture the call so the media survives
// it, and nothing removes that media later. `retainedUntil` is a required, finite field on the
// public artifact, so this 100-year horizon is how "no expiry" is expressed without a wire change.
export const DEFAULT_RECORDING_RETENTION_DAYS = 36_500;
export const DEFAULT_RECORDING_URL_TTL_SECONDS = 3600;
export const RECORDING_STATUSES = ["pending", "recording", "processing", "ready", "failed", "expired"] as const;
export const recordingArtifactStatusSchema = z.enum(RECORDING_STATUSES);
export type RecordingArtifactStatus = z.infer<typeof recordingArtifactStatusSchema>;
export const recordingParticipantSchema = z.object({
  participantIdentity: z.string().min(1).max(160),
  role: z.enum(["user", "avatar"]),
}).strict();
export type RecordingParticipant = z.infer<typeof recordingParticipantSchema>;
const recordingMutedIntervalSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
}).strict().refine((interval) => interval.endMs > interval.startMs, "Muted interval must end after it starts");
const recordingMetadataSchema = z.object({
  sessionId: z.string().min(1),
  recordingId: z.string().min(1),
  mode: z.enum(RECORDED_MEDIA_MODES),
  createdAt: z.string().datetime({ offset: true }),
  retainedUntil: z.string().datetime({ offset: true }),
  participant: recordingParticipantSchema.optional(),
  mediaStartedAt: z.string().datetime({ offset: true }).optional(),
  mediaEndedAt: z.string().datetime({ offset: true }).optional(),
  mediaStartOffsetMs: z.number().int().min(0).optional()
    .describe("First playable native media timestamp relative to mediaStartedAt. Playback retains this offset; it does not reset the file clock to zero."),
  mediaMutedIntervalsMs: z.array(recordingMutedIntervalSchema).optional()
    .describe("Intervals of hidden camera video relative to mediaStartedAt, using native media timestamps. Audio playback continues through these intervals."),
});
export const recordingArtifactSchema = z.discriminatedUnion("status", [
  recordingMetadataSchema.extend({ status: z.enum(["pending", "recording", "processing", "expired"]) }).strict(),
  recordingMetadataSchema.extend({
    status: z.literal("ready"),
    mediaType: z.enum(["audio/mp4", "video/mp4", "audio/ogg", "video/webm"]),
    sizeBytes: z.number().int().positive(),
    durationMs: z.number().int().nonnegative().nullable(),
  }).strict(),
  recordingMetadataSchema.extend({
    status: z.literal("failed"),
    errorCode: z.enum(["recording_failed", "recording_unavailable"]),
  }).strict(),
]);
export type RecordingArtifact = z.infer<typeof recordingArtifactSchema>;
export const listRecordingsQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
}).strict();
export type ListRecordingsQuery = Partial<z.infer<typeof listRecordingsQuerySchema>>;
export const listRecordingsResponseSchema = z.object({
  data: z.array(recordingArtifactSchema), nextCursor: z.string().nullable(),
}).strict();
export type ListRecordingsResponse = z.infer<typeof listRecordingsResponseSchema>;
export const recordingAccessResponseSchema = z.object({
  recordingId: z.string().min(1),
  url: z.string().url(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type RecordingAccessResponse = z.infer<typeof recordingAccessResponseSchema>;
