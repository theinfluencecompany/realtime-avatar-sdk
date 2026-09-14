import { z } from "zod";

// ---------------------------------------------------------------------------
// SERVER-OWNED RECORDING. The application server chooses this policy before minting.
// Public metadata is durable; credentials and renewable download URLs are separate.
// ---------------------------------------------------------------------------
export const RECORDED_MEDIA_MODES = ["audio", "video", "audio_video"] as const;
export const recordingModeSchema = z
  .enum(["off", ...RECORDED_MEDIA_MODES])
  .describe("Server-owned recording policy; omitted means off. Audio includes user and avatar audio.");
export type RecordingMode = z.infer<typeof recordingModeSchema>;
export const DEFAULT_RECORDING_MODE: RecordingMode = "off";
export const DEFAULT_RECORDING_RETENTION_DAYS = 30;
export const DEFAULT_RECORDING_URL_TTL_SECONDS = 3600;
export const RECORDING_STATUSES = ["pending", "recording", "processing", "ready", "failed", "expired"] as const;
export const recordingArtifactStatusSchema = z.enum(RECORDING_STATUSES);
export type RecordingArtifactStatus = z.infer<typeof recordingArtifactStatusSchema>;
const recordingMetadataSchema = z.object({
  sessionId: z.string().min(1),
  recordingId: z.string().min(1),
  mode: recordingModeSchema.exclude(["off"]),
  createdAt: z.string().datetime({ offset: true }),
  retainedUntil: z.string().datetime({ offset: true }),
});
export const recordingArtifactSchema = z.discriminatedUnion("status", [
  recordingMetadataSchema.extend({ status: z.enum(["pending", "recording", "processing", "expired"]) }).strict(),
  recordingMetadataSchema.extend({
    status: z.literal("ready"),
    mediaType: z.enum(["audio/mp4", "video/mp4"]),
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
