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
// their own surface UI on native.
export {
  isLiveTrackProducing,
  isNativeLiveTrackSubscribed,
  resolveSurfaceLayers,
  useDebouncedHide,
  useLiveTrackProducing,
  type AvatarVideoFit,
  type SurfaceLayers,
} from "../react/avatar-video-surface";

export { RealtimeAvatarProvider, useRealtimeAvatarClient, useRealtimeAvatarContext } from "../react/provider";

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
  applyAvatarPlayoutDelay,
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
  disconnectAction,
  idleExpired,
  idlePhaseFor,
  isRecoverableConnectionError,
  lifecyclePhaseFrom,
  needsFreshGrant,
  phaseForReason,
  resolveIdleTimeoutMs,
  resolveReconnectPolicy,
  resolveWarnBeforeMs,
  retryStep,
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
  approachingEndFrom,
  creditsLowFrom,
  endsAtFrom,
  mapTurnState,
  nextGraceWindow,
  resolveEndReason,
  sessionRemainingMsFrom,
  type ApproachingEndReason,
  type EndReason,
  type GraceWindowState,
  type SessionClocks,
  type TurnState,
} from "../react/grace-window";
export {
  DEFAULT_GOVERNOR_CONFIG,
  capToVideoQuality,
  initGovernor,
  step as stepQualityGovernor,
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
} from "realtime-avatar-contracts";

// Mic single-flight lease — the cross-room getUserMedia guard. Both halves are
// RN-safe but were not re-exported on native before; an Android call path needs
// both, so the native entry reaches full parity with the web one.
export { useMicLease } from "../react/mic-single-flight";
export { useReleaseMicLeaseOnTrackEnded } from "../react/livekit";
