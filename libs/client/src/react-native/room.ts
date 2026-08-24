// ---------------------------------------------------------------------------
// RealtimeAvatarLiveKitRoom — the REACT NATIVE twin of the web bridge in
// src/react/livekit.ts. Same job (a thin typed bridge from a Realtime Avatar
// grant into LiveKitRoom), same hard room defaults, two platform differences:
//
//  1. The room component is `@livekit/react-native`'s LiveKitRoom (native
//     WebRTC via @livekit/react-native-webrtc), not the DOM one.
//  2. There is NO RoomAudioRenderer: on native, subscribed remote audio plays
//     through the OS audio session automatically — no <audio> element exists to
//     render. What native needs instead is an ACTIVE audio session, so this
//     bridge starts/stops `AudioSession` around the connected room (opt out
//     with `manageAudioSession={false}` if the app owns session config, e.g.
//     to set an Apple category before connecting).
//
// The app MUST call `registerGlobals()` (re-exported from the ./react-native
// entry) once at startup before any LiveKit code runs — it installs the WebRTC
// globals livekit-client expects.
// ---------------------------------------------------------------------------
import { AudioSession, LiveKitRoom, type LiveKitRoomProps } from "@livekit/react-native";
import { createElement, useEffect } from "react";
import type { ReactElement, ReactNode } from "react";
import type { LiveKitSessionGrant } from "../livekit-grant";

export type RealtimeAvatarLiveKitRoomProps = Omit<
  LiveKitRoomProps,
  "serverUrl" | "token" | "connect" | "audio" | "video" | "options"
> & {
  grant: LiveKitSessionGrant | null | undefined;
  connect?: boolean;
  /** Native LiveKit audio publish option. Defaults to server-STT sessions only. */
  audio?: LiveKitRoomProps["audio"];
  /** Native LiveKit video publish option. Defaults to false for avatar calls. */
  video?: LiveKitRoomProps["video"];
  /** Passed directly to LiveKitRoom. */
  options?: LiveKitRoomProps["options"];
  /**
   * Start the OS audio session while the room is connected (and stop it after).
   * Default true — without an active session, iOS plays no call audio. Set false
   * when the app manages `AudioSession` itself (custom category/mode).
   */
  manageAudioSession?: boolean;
  children?: ReactNode;
};

/**
 * Own the native OS audio session for the duration of `enabled`. Split out of
 * the room bridge so an app that composes its own room (imperative Room, custom
 * LiveKitRoom props) can still one-line the session lifecycle.
 */
export function useRealtimeAvatarAudioSession(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    void AudioSession.startAudioSession();
    return () => {
      void AudioSession.stopAudioSession();
    };
  }, [enabled]);
}

/** Thin typed bridge from a Realtime Avatar grant into the native LiveKitRoom. */
export function RealtimeAvatarLiveKitRoom(props: RealtimeAvatarLiveKitRoomProps): ReactElement {
  const {
    grant,
    connect = true,
    audio,
    video = false,
    options,
    manageAudioSession = true,
    children,
    ...roomProps
  } = props;
  const shouldConnect = Boolean(grant && connect);
  useRealtimeAvatarAudioSession(manageAudioSession && shouldConnect);
  // Same hard defaults as the web bridge, for the same reasons (docs/
  // the video-layering design doc): adaptiveStream selects layers by rendered
  // element size/visibility — the wrong lever for a full-screen avatar whose
  // congestion adaptation is owned by the SFU's BWE + the SDK's quality
  // governor. dynacast is publisher-side and harmless here. `options` spreads
  // last so an adopter can still override both.
  const roomOptions = { adaptiveStream: false, dynacast: true, ...options };
  return createElement(
    LiveKitRoom,
    {
      ...roomProps,
      serverUrl: grant?.livekit_url,
      token: grant?.participant_token,
      connect: shouldConnect,
      audio: audio ?? (grant?.stt_mode === "server"),
      video,
      options: roomOptions,
    },
    children,
  );
}
