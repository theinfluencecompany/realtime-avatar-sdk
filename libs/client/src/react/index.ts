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
// The adaptive de-jitter loop (opt-in; `<AvatarVideoSurface adaptivePlayout>` is the
// ordinary way in — these are for a consumer driving its own surface).
export { useAvatarAdaptivePlayoutDelay } from "./use-adaptive-playout";
export {
  AdaptivePlayoutController,
  readInboundRtp,
  type AdaptivePlayoutDecision,
  type AdaptivePlayoutOptions,
  type AdaptivePlayoutSample,
  type InboundRtpCursor,
  type InboundRtpReading,
} from "./adaptive-playout";
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
  shouldReplayPendingTurn,
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
// The turn/grace-window vocabulary the session hooks speak. `mapTurnState` is a value on
// purpose: transport is not re-exported, so an app reading `useVoiceAssistant().state` off
// its own LiveKit peer needs the same 4-value mapping the hooks use.
export {
  mapTurnState,
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
// The mint's cap on `instructions`, so an app can budget prompt assembly without probing.
export { MAX_SESSION_INSTRUCTIONS_CHARS } from "../wire";

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

// The client AvatarCall asks for, pointed at your proxy route. Keyless by construction.
export { createProxyClient, type ProxyClientOptions } from "../proxy-client";

/**
 * The types a consumer needs to NAME in order to build the argument these hooks take.
 *
 * `AvatarSessionClient.createLiveKitSessionOrBusy` accepts a `LiveKitSessionRequest`, and until
 * now that type was reachable only as `Parameters<...>[0]` — the same shape of gap as the
 * capacity error above: a type in a public signature that no consumer could write down. The
 * criterion for what belongs here is exactly that, and nothing wider: if you must name it to
 * construct a public argument, it is exported; if it is machinery, it is not.
 *
 * So `toLiveKitSessionWireRequest` and `normalizeRealtimeAvatarError` stay unexported. They are
 * how the request becomes bytes and how an error is shaped, which is the SDK's job, not yours.
 */
// LiveKitSessionRequest comes from livekit-grant, NOT wire — wire.ts declares a type of the
// SAME NAME that is the zod OUTPUT (defaults applied, `model` required). The one the client
// actually accepts is the ergonomic generic here. Exporting the wrong one produced a type that
// imported fine and could not be constructed, which is a worse failure than not exporting it.
export type { LiveKitSessionRequest } from "../livekit-grant";
export type {
  LLMProvider,
  LLMSelection,
  VoiceSpec,
  VoiceSpecInput,
  CartesiaTtsModel,
  FishTtsModel,
} from "../wire";
