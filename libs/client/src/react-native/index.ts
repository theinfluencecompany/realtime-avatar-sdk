// ---------------------------------------------------------------------------
// realtime-avatar/react-native — the React Native client.
//
// The session brain is SHARED with the web entry, not forked: the grant hook,
// the session lifecycle state machine, the realtime-session facade, the grace
// window, the quality governor, and the emotion director are the SAME modules
// as ./react (they are DOM-free — timers, LiveKit events, and TextEncoder all
// exist on RN). Only the MEDIA layer is native: the room bridge rides
// @livekit/react-native (native WebRTC + OS audio session) and the video
// surface renders a native RTCView instead of a DOM <video>.
//
// App setup (once, before any LiveKit code runs):
//
//   import { registerGlobals } from "realtime-avatar/react-native";
//   registerGlobals();
//
// Peer deps the app installs: @livekit/react-native, @livekit/react-native-webrtc.
// ---------------------------------------------------------------------------

// Native platform bootstrap + audio-session control, re-exported so an app
// never takes a second, drifting dependency on @livekit/react-native for the
// pieces this SDK's flows require.
export { AudioSession, registerGlobals } from "@livekit/react-native";
export { VideoTrack, type VideoTrackProps } from "@livekit/react-native";

// The native room bridge + audio-session hook (twins of the web ./react ones).
export {
  RealtimeAvatarLiveKitRoom,
  useRealtimeAvatarAudioSession,
  type RealtimeAvatarLiveKitRoomProps,
} from "./room";

// The native avatar video surface (twin of the web ./react one; the idle clip
// is app-injected via renderIdleVideo — see the module doc).
export {
  AvatarVideoSurface,
  type AvatarVideoSurfaceProps,
  type IdleVideoRender,
} from "./avatar-video-surface";
// The shared pure/reactive pieces the surface is built on, for apps composing
// their own surface UI on native — and the two producing predicates, so the
// surface's `isProducing` prop has something to be passed. The RN default is
// `isNativeLiveTrackSubscribed`; `isLiveTrackProducing` is the strict web gate,
// available for an app that has measured it working on its own devices.
export {
  isLiveTrackProducing,
  isNativeLiveTrackSubscribed,
  useLiveTrackProducing,
  type AvatarVideoFit,
  type SurfaceLayers,
} from "../react/avatar-video-surface";


// The grant/capacity layer + portable LiveKit re-exports. Web-only pieces are
// deliberately ABSENT here: RoomAudioRenderer/StartAudio exist for the browser
// autoplay policy (native audio plays via the OS audio session), and the DOM
// components (AudioTrack, TrackToggle, ConnectionStateToast, web LiveKitRoom /
// VideoTrack) have native twins above.
export {
  DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  capacityErrorFromBusy,
  capacityStateFromGrant,
  splitCallTranscript,
  useAvatarPlayoutDelay,
  useCallTranscript,
  useLiveKitAvatarGrant,
  type CallTranscript,
  type CallTranscriptSegment,
  type LiveKitAvatarGrantState,
  type LiveKitAvatarGrantStatus,
  type LiveKitCapacityState,
  type LiveKitConnectionStatus,
  type RemoteAudioTrack,
  type RemoteTrack,
  type RemoteVideoTrack,
  type SendTextOptions,
  type UseLiveKitAvatarGrantInput,
} from "../react/livekit";
// The adaptive de-jitter loop — shared verbatim with web (stats-driven, no DOM),
// so the two platforms cannot drift on the buffer law.
export { useAvatarAdaptivePlayoutDelay } from "../react/use-adaptive-playout";
export {
  AdaptivePlayoutController,
  readInboundRtp,
  type AdaptivePlayoutDecision,
  type AdaptivePlayoutOptions,
  type AdaptivePlayoutSample,
  type InboundRtpCursor,
  type InboundRtpReading,
} from "../react/adaptive-playout";

// LiveKit's own React hooks, re-exported for room-context consumers — the same
// hooks the RN LiveKit SDK itself builds on (they are DOM-free React over
// livekit-client). useStartAudio is browser-only and intentionally absent.
export {
  useChat,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useTrackToggle,
  useTranscriptions,
  useVoiceAssistant,
} from "@livekit/components-react";

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
} from "../react/session-lifecycle";
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
} from "../react/use-realtime-session";
export {
  mapTurnState,
  type ApproachingEndReason,
  type EndReason,
  type GraceWindowState,
  type SessionClocks,
  type TurnState,
} from "../react/grace-window";
export {
  DEFAULT_GOVERNOR_CONFIG,
  type Governor,
  type GovernorAction,
  type GovernorConfig,
  type GovernorSignal,
  type GovernorState,
  type QualityCap,
} from "../react/quality-governor";
export {
  useAvatarQualityGovernor,
  type FreezeReadingFn,
  type UseAvatarQualityGovernorInput,
} from "../react/use-quality-governor";
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

// Mic single-flight lease — the cross-room getUserMedia guard. Both halves are
// RN-safe but were not re-exported on native before; an Android call path needs
// both, so the native entry reaches full parity with the web one.
export { useMicLease } from "../react/mic-single-flight";
export { useReleaseMicLeaseOnTrackEnded } from "../react/livekit";

// The contract `AvatarCall` and the hooks ask for. Exported so a consumer can implement it.
export type {
  AvatarSessionClient,
  LiveKitSessionStartResult,
  RealtimeAvatarRequestOptions,
} from "../session-client";

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
