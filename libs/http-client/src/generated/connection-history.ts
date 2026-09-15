import { z } from "zod";

const ConnectionQuality = { Excellent: "excellent", Good: "good", Poor: "poor", Lost: "lost", Unknown: "unknown" } as const;
const ConnectionState = { Disconnected: "disconnected", Connecting: "connecting", Connected: "connected", Reconnecting: "reconnecting", SignalReconnecting: "signalReconnecting" } as const;

export const MAX_CONNECTION_HISTORY_OBSERVATIONS = 240;
export const MAX_CONNECTION_HISTORY_BATCH = 32;
export const CONNECTION_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const quality = z.enum(ConnectionQuality);
export const connectionHistoryObservationSchema = z.object({
  sequence: z.number().int().min(1).max(MAX_CONNECTION_HISTORY_OBSERVATIONS),
  elapsedMs: z.number().int().min(0).max(86_400_000),
  clientObservedAt: z.string().datetime({ offset: true }).nullable(),
  connectionState: z.enum(ConnectionState),
  localQuality: quality,
  audioQuality: quality.nullable(),
  videoQuality: quality.nullable(),
}).strict();

export const connectionHistoryGrantSchema = z.object({
  endpoint: z.string().url().startsWith("https://"),
  token: z.string().min(32).max(4096),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const connectionHistoryUploadSchema = z.object({
  sessionId: z.string().min(1).max(200),
  observations: z.array(connectionHistoryObservationSchema).min(1).max(MAX_CONNECTION_HISTORY_BATCH),
}).strict();

export const connectionHistoryResponseSchema = z.object({
  sessionId: z.string().min(1).max(200),
  observations: z.array(connectionHistoryObservationSchema).max(MAX_CONNECTION_HISTORY_OBSERVATIONS),
}).strict();

export type ConnectionHistoryObservation = z.infer<typeof connectionHistoryObservationSchema>;
export type ConnectionHistoryGrant = z.infer<typeof connectionHistoryGrantSchema>;
export type ConnectionHistoryUpload = z.infer<typeof connectionHistoryUploadSchema>;
export type ConnectionHistoryResponse = z.infer<typeof connectionHistoryResponseSchema>;
