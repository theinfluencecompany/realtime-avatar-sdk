// Runtime contract only. This subpath is the canonical SDK-side import for
// connection history; it contains no React or room bridge implementation.
export {
  connectionHistoryGrantSchema,
  connectionHistoryObservationSchema,
  connectionHistoryUploadSchema,
  connectionHistoryResponseSchema,
  MAX_CONNECTION_HISTORY_OBSERVATIONS,
  MAX_CONNECTION_HISTORY_BATCH,
  CONNECTION_HISTORY_RETENTION_MS,
} from "../../http-client/src/generated/connection-history.ts";
export type {
  ConnectionHistoryGrant,
  ConnectionHistoryObservation,
  ConnectionHistoryUpload,
  ConnectionHistoryResponse,
} from "../../http-client/src/generated/connection-history.ts";
