// The transport is NOT re-exported. `livekit-client` and `@livekit/components-react` are peer
// dependencies, so a consumer who needs `Room`, `RoomEvent` or `useRoomContext` imports them from
// LiveKit directly and gets the version they installed. Re-exporting them put LiveKit's types in
// this package's public surface, which meant a LiveKit major could break ours without a line of
// our code changing. 24 names came out on 2026-08-26.

export {
  AvatarCall,
  useAvatarCall,
  type AvatarCallEndReason,
  type AvatarCallHandle,
  type AvatarCallProps,
  type AvatarCallStatus,
} from "./avatar-call";
export {
  DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS,
  RealtimeAvatarLiveKitRoom,
  capacityErrorFromBusy,
  capacityStateFromGrant,
  useAvatarPlayoutDelay,
  useLiveKitAvatarGrant,
  useCallTranscript,
  useReleaseMicLeaseOnTrackEnded,
  splitCallTranscript,
  type CallTranscript,
  type CallTranscriptSegment,
  type LiveKitAvatarGrantState,
  type LiveKitAvatarGrantStatus,
  type LiveKitCapacityState,
  type LiveKitConnectionStatus,
  type RealtimeAvatarLiveKitRoomProps,
  type UseLiveKitAvatarGrantInput,
} from "./livekit";
export {
  AvatarVideoSurface,
  type AvatarVideoFit,
  type AvatarVideoSurfaceProps,
  type LivePlaybackKeeper,
  type PlayableVideoElement,
  type SurfaceLayers,
} from "./avatar-video-surface";
export {
  DEFAULT_IDLE_SECONDS,
  DEFAULT_IDLE_WARN_LEAD_SECONDS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BACKOFF_MS,
  SessionLifecycleRoomBridge,
  useSessionLifecycle,
  type ReconnectPolicy,
  type RecoveryState,
  type RetryStep,
  type RealtimeSessionRoomSinks,
  type SessionEndReason,
  type SessionLifecycleApi,
  type SessionLifecyclePhase,
  type SessionLifecyclePhaseKind,
  type SessionLifecycleRoomBridgeProps,
  type UseSessionLifecycleInput,
} from "./session-lifecycle";
export {
  DEFAULT_APPROACHING_END_LEAD_SECONDS,
  DEFAULT_CREDITS_LOW_LEAD_SECONDS,
  DEFAULT_GRACE_CEILING_SECONDS,
  DEFAULT_GRACE_WINDOW_LEAD_SECONDS,
  useRealtimeSession,
  type ApproachingEndEvent,
  type BehaviorSnapshot,
  type ClipResult,
  type ClosingTurnResult,
  type CreditsLowEvent,
  type EndedEvent,
  type ExtendResult,
  type GraceWindowClosedEvent,
  type GraceWindowOpenEvent,
  type IdleWarningEvent,
  type RealtimeSessionApi,
  type RealtimeSessionMedia,
  type ReconnectingEvent,
  type TurnTimeoutEvent,
  type UseRealtimeSessionInput,
} from "./use-realtime-session";
// Tab-global mic single-flight — the CROSS-call ghost-mic guard (a rapid redial
// must not acquire getUserMedia before the prior room released it). `useMicLease`
// is the React binding adopters fold into their mic-intent signal; the pure
// acquire/release primitives are exported for testing + non-React coordination.
// `useReleaseMicLeaseOnTrackEnded` (from ./livekit) is the in-room companion that
// releases on the mic track's real `ended` event.
export {
  MIC_LEASE_ENDED_TIMEOUT_MS,
  useMicLease,
  type MicLease,
} from "./mic-single-flight";
// Re-export the director ack frame type so consumers can type their onAck handler without
// reaching into the contracts package (the hook's onAck signature uses it).
export {
  type ApproachingEndReason,
  type EndReason,
  type GraceWindowState,
  type SessionClocks,
  type TurnState,
} from "./grace-window";
// Adaptive video-quality governor — the PURE anti-flap core (docs/ADAPTIVE_VIDEO_
// QUALITY.md). The app never touches this directly; it uses the hook that wraps it.
export {
  DEFAULT_GOVERNOR_CONFIG,
  type Governor,
  type GovernorAction,
  type GovernorConfig,
  type GovernorSignal,
  type GovernorState,
  type QualityCap,
} from "./quality-governor";
export {
  useAvatarQualityGovernor,
  type FreezeReadingFn,
  type UseAvatarQualityGovernorInput,
} from "./use-quality-governor";
// Multi-clip choreography protocol pieces apps need to build clip libraries + narrow states.
export {
  knownBehaviorStates,
  sessionBehaviorSchema,
  sessionClipSchema,
  type KnownBehaviorState,
  type SessionBehavior,
  type SessionClip,
} from "../wire";

// The contract `AvatarCall` and the hooks ask for. Exported so a consumer can implement it.
export type {
  AvatarSessionClient,
  LiveKitSessionStartResult,
  RealtimeAvatarRequestOptions,
} from "../session-client";

// `capacityErrorFromBusy` is exported below and RETURNS this, so withholding the class left a
// value a consumer could receive, could not name, and could not `instanceof`. One or the other
// had to go; the mapper is the useful half for building a queue UI, so the class comes with it.
export { RealtimeAvatarCapacityError } from "../errors";
