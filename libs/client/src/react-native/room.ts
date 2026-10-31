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
//
// It also clears the iOS app-wide input mute an earlier call can leave behind
// (see clearStaleInputMute).
// ---------------------------------------------------------------------------
import { useMaybeRoomContext } from "@livekit/components-react";
import { AudioSession, LiveKitRoom, type LiveKitRoomProps } from "@livekit/react-native";
import { AudioDeviceModule, AudioEngineMuteMode } from "@livekit/react-native-webrtc";
import { RoomEvent, Track, type Participant, type Room, type TrackPublication } from "livekit-client";
import { createElement, useEffect } from "react";
import type { ReactElement, ReactNode } from "react";
import { Platform } from "react-native";
import type { LiveKitSessionGrant } from "../livekit-grant";
import { cameraPublishOptions } from "../camera";

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

const INPUT_LIVE_WAIT_MS = 5_000;
const INPUT_LIVE_POLL_MS = 100;
let inputMuteWrites: Promise<void> = Promise.resolve();

/**
 * Clear a microphone mute an earlier call left on the whole app, once this call's input is live.
 *
 * iOS 26 keeps ONE input-mute flag per app process, and libwebrtc's audio engine sets it through
 * Voice Processing whenever a send track still attached to a live peer connection is disabled.
 * livekit-client does exactly that when the SERVER closes the room (it stops the microphone track
 * before closing the connection, and on React Native `stop()` only disables it); an app's own
 * mute on a live room takes the same path. The engine is then rebuilt playout-only without
 * writing the flag back, and every later engine assumes it starts unmuted, so later calls
 * publish an unmuted track of digital silence until the app is relaunched or a live unmute
 * happens. Measured 2026-10-31 in a device's syslog: MUTED at a capped call's server close,
 * three silent calls, UNMUTED only at a user hang-up; in production about 30% of iOS calls that
 * followed a server-ended call heard nothing, against 3.4% after a user hang-up and 2-3% on
 * Android. A mute and unmute round trip with input live makes the engine write UNMUTED itself.
 *
 * `RealtimeAvatarLiveKitRoom` runs this for you; call it (or `useClearStaleInputMute`) only
 * when you compose your own room. A no-op off iOS, and it never throws.
 */
export async function clearStaleInputMute(stillWanted: () => boolean): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    for (let waited = 0; !AudioDeviceModule.isRecording(); waited += INPUT_LIVE_POLL_MS) {
      if (waited >= INPUT_LIVE_WAIT_MS || !stillWanted()) return;
      await new Promise((resolve) => setTimeout(resolve, INPUT_LIVE_POLL_MS));
    }
    // Only the Voice Processing mute writes the app flag; the other modes restart the engine.
    if (AudioDeviceModule.getMuteMode() !== AudioEngineMuteMode.VoiceProcessing) return;
  } catch {
    return;
  }
  // One round trip at a time, so two clears cannot leave the engine muted between them.
  inputMuteWrites = inputMuteWrites
    .then(async () => {
      if (!stillWanted()) return;
      try {
        await AudioDeviceModule.setMicrophoneMuted(true);
      } finally {
        await AudioDeviceModule.setMicrophoneMuted(false);
      }
    })
    .catch(() => {});
  await inputMuteWrites;
}

/**
 * Run `clearStaleInputMute` each time `room`'s local microphone goes live: when it is published
 * unmuted and when it is unmuted later, for as long as that publication stays published and
 * unmuted and this hook stays mounted.
 */
export function useClearStaleInputMute(room: Room | undefined): void {
  useEffect(() => {
    if (!room) return;
    let mounted = true;
    const local = room.localParticipant;
    const clearIfLive = (publication: TrackPublication | undefined) => {
      if (publication?.source !== Track.Source.Microphone || publication.isMuted) return;
      void clearStaleInputMute(
        () =>
          mounted &&
          !publication.isMuted &&
          local.getTrackPublication(Track.Source.Microphone) === publication,
      );
    };
    const onUnmuted = (publication: TrackPublication, participant: Participant) => {
      if (participant === local) clearIfLive(publication);
    };
    room.on(RoomEvent.LocalTrackPublished, clearIfLive).on(RoomEvent.TrackUnmuted, onUnmuted);
    clearIfLive(local.getTrackPublication(Track.Source.Microphone));
    return () => {
      mounted = false;
      room.off(RoomEvent.LocalTrackPublished, clearIfLive).off(RoomEvent.TrackUnmuted, onUnmuted);
    };
  }, [room]);
}

function StaleInputMuteClearer(): null {
  useClearStaleInputMute(useMaybeRoomContext());
  return null;
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
      // Keep the room and its in-room observers scoped to the grant, as on web.
      key: grant?.session_id ?? "no-session",
      serverUrl: grant?.livekit_url,
      token: grant?.participant_token,
      connect: shouldConnect,
      audio: audio ?? (grant?.stt_mode === "server"),
      video: cameraPublishOptions(grant, video),
      options: roomOptions,
    },
    createElement(StaleInputMuteClearer),
    children,
  );
}
