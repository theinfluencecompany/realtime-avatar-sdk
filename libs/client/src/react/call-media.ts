"use client";

/**
 * The two local media facts a call can silently get wrong: can the agent HEAR the user (the
 * microphone), and can the user hear HER (audio playback). Both used to be invisible.
 *
 * - A microphone that fails to start (permission denied, no device, a device another app holds)
 *   is reported by LiveKit to the room's `onError`, which the lifecycle rightly ignores as not a
 *   connection failure. So the call read "live" while the agent could never hear a word.
 * - A browser that blocks autoplay mutes her voice until a user gesture calls
 *   `room.startAudio()`. Nothing observed `canPlaybackAudio`, so the call read "live" in silence.
 *
 * Everything here is DERIVED from LiveKit's public surface — `lastMicrophoneError`,
 * `RoomEvent.MediaDevicesError`, the local microphone publication and its track's events,
 * `useAudioPlayback` — and reduced to a product-level value. LiveKit stays the owner of the
 * device: it acquires the microphone when the room's signal connects (`LiveKitRoom`'s `audio`),
 * restarts it on the default device when it ends, and stops it when the room disconnects. This
 * module adds no second state machine, only a reading of that one and two actions on it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useAudioPlayback } from "@livekit/components-react";
import { ConnectionState, ParticipantEvent, RoomEvent, Track, TrackEvent, type Room } from "livekit-client";
import {
  describeMicrophoneFailure,
  microphoneLost,
  type MicrophoneProblem,
} from "../../../browser/src/microphone";

/**
 * The microphone, as a call's UI needs it.
 *
 * - `off`: this call does not listen (`listen={false}`), or it is not connected — before the
 *   room joins and after it ends. Nothing is captured.
 * - `pending`: the device has been asked for and has not answered. The permission prompt may be
 *   open; per the getUserMedia spec it may never settle, so this can last.
 * - `on`: published and live; she can hear the user.
 * - `muted`: published and muted on purpose (`setMicrophoneEnabled(false)`).
 * - `blocked`: refused by the browser, the operating system, or an insecure origin. The user has
 *   to change a setting; `hint` names which one. Retry afterwards.
 * - `unavailable`: no device, a device another app holds, one that stopped mid-call
 *   (`device-lost`), or a failure nobody classified. `message` is what the browser said.
 */
export type CallMicrophone =
  | { status: "off" }
  | { status: "pending" }
  | { status: "on" }
  | { status: "muted" }
  | ({ status: "blocked" } & MicrophoneProblem)
  | ({ status: "unavailable" } & MicrophoneProblem);

/** A microphone state that carries a problem: the argument of `onMicrophoneProblem`. */
export type CallMicrophoneProblem = Extract<CallMicrophone, { status: "blocked" | "unavailable" }>;

/**
 * Whether her audio can play.
 *
 * - `unknown`: not connected yet, and no playback has been attempted.
 * - `allowed`: no playback attempt has been refused (LiveKit's `room.canPlaybackAudio`).
 * - `blocked`: the browser refused playback until a user gesture. Call `startAudio()` from one —
 *   a click or tap handler — or she stays silent.
 */
export type CallAudioPlayback = "unknown" | "allowed" | "blocked";

/** What the in-room bridge reads off LiveKit. Raw facts; {@link callMicrophoneFrom} decides. */
export type CallMicrophoneFacts = Readonly<{
  /** Whether this call publishes the microphone at all. */
  wanted: boolean;
  /** The room is connected (LiveKit acquires the microphone on its way there). */
  connected: boolean;
  /** An enable this SDK started is still in flight. */
  enabling: boolean;
  /** The local microphone publication, if one exists. */
  publication: Readonly<{ muted: boolean; ended: boolean }> | null;
  /** `localParticipant.lastMicrophoneError`, cleared by LiveKit on the next successful capture. */
  deviceError: Error | null;
}>;

const DEVICE_LOST_MESSAGE = "The microphone track ended during the call.";

/**
 * Pure: the product-level microphone state for a set of facts. `publishError` is a failure
 * LiveKit routed only to the room's `onError` (a publish that failed after capture), which the
 * bridge cannot see; the session above the room supplies it. Unit-tested, no DOM.
 */
export function callMicrophoneFrom(facts: CallMicrophoneFacts, publishError: Error | null = null): CallMicrophone {
  if (!facts.wanted) return { status: "off" };
  const { publication } = facts;
  if (publication) {
    // LiveKit restarts an ended track on the default device and MUTES it when that fails too,
    // so an ended track reads as muted: check the end first, or a lost device reads as a choice.
    if (publication.ended) return { status: "unavailable", ...microphoneLost(DEVICE_LOST_MESSAGE) };
    return publication.muted ? { status: "muted" } : { status: "on" };
  }
  if (facts.enabling) return { status: "pending" };
  const error = facts.deviceError ?? publishError;
  if (error) {
    const problem = describeMicrophoneFailure(error);
    const blocked = problem.reason === "denied-by-browser" || problem.reason === "denied-by-os"
      || problem.reason === "insecure-origin";
    return blocked ? { status: "blocked", ...problem } : { status: "unavailable", ...problem };
  }
  return facts.connected ? { status: "pending" } : { status: "off" };
}

/** The two actions, registered by the bridge so the session above the room can call them. */
export type CallMediaControls = Readonly<{
  /** `room.startAudio()`. Must run inside a user gesture to unblock playback. */
  startAudio: () => Promise<void>;
  /** Mute, unmute, or retry after the user fixed a blocked or unavailable microphone. */
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
}>;

/** The sinks the bridge fills. All optional: a bare lifecycle simply does not observe media. */
export type CallMediaSinks = Partial<Readonly<{
  setMicrophoneFacts: (facts: CallMicrophoneFacts) => void;
  setAudioPlayback: (playback: CallAudioPlayback) => void;
  registerMediaControls: (controls: CallMediaControls | null) => void;
}>>;

function microphoneFacts(room: Room, wanted: boolean, connected: boolean, enabling: boolean): CallMicrophoneFacts {
  const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = publication?.track;
  return {
    wanted,
    connected,
    enabling,
    publication: track
      ? { muted: publication.isMuted, ended: track.mediaStreamTrack?.readyState === "ended" }
      : null,
    deviceError: room.localParticipant.lastMicrophoneError ?? null,
  };
}

/**
 * In-room: observe the microphone and audio playback and report them up, and register the two
 * actions. Mounted by {@link SessionLifecycleRoomBridge}; inert unless its sinks are present.
 */
export function useCallMedia(room: Room, options: CallMediaSinks & {
  microphoneWanted: boolean;
  connectionState: ConnectionState;
}): void {
  const { setMicrophoneFacts, setAudioPlayback, registerMediaControls, microphoneWanted, connectionState } = options;
  const connected = connectionState === ConnectionState.Connected;
  const [enabling, setEnabling] = useState(false);
  const [version, setVersion] = useState(0);
  const sinksRef = useRef({ setMicrophoneFacts, setAudioPlayback });
  sinksRef.current = { setMicrophoneFacts, setAudioPlayback };

  // Re-read on every LiveKit event that can change the local microphone, and on the track's own
  // end/restart/mute (a device unplugged mid-call reaches the room only as a later mute, if at all).
  useEffect(() => {
    if (!setMicrophoneFacts) return;
    const bump = (): void => setVersion((value) => value + 1);
    const participant = room.localParticipant;
    let watched: { off: () => void } | null = null;
    const watchTrack = (): void => {
      watched?.off();
      const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
      if (!track) { watched = null; return; }
      track.on(TrackEvent.Ended, bump).on(TrackEvent.Restarted, bump)
        .on(TrackEvent.Muted, bump).on(TrackEvent.Unmuted, bump);
      watched = { off: () => { track.off(TrackEvent.Ended, bump).off(TrackEvent.Restarted, bump)
        .off(TrackEvent.Muted, bump).off(TrackEvent.Unmuted, bump); } };
    };
    const onPublications = (): void => { watchTrack(); bump(); };
    room.on(RoomEvent.MediaDevicesError, bump)
      .on(RoomEvent.LocalTrackPublished, onPublications)
      .on(RoomEvent.LocalTrackUnpublished, onPublications);
    participant.on(ParticipantEvent.TrackMuted, bump).on(ParticipantEvent.TrackUnmuted, bump);
    watchTrack();
    return () => {
      watched?.off();
      room.off(RoomEvent.MediaDevicesError, bump)
        .off(RoomEvent.LocalTrackPublished, onPublications)
        .off(RoomEvent.LocalTrackUnpublished, onPublications);
      participant.off(ParticipantEvent.TrackMuted, bump).off(ParticipantEvent.TrackUnmuted, bump);
    };
  }, [room, setMicrophoneFacts]);

  useEffect(() => {
    sinksRef.current.setMicrophoneFacts?.(microphoneFacts(room, microphoneWanted, connected, enabling));
  }, [room, microphoneWanted, connected, enabling, version]);

  const { canPlayAudio } = useAudioPlayback(room);
  useEffect(() => {
    // `canPlaybackAudio` starts true and only drops when an attempt is refused, so before the
    // room is connected `true` proves nothing: unknown. A refusal is known whenever it happens.
    sinksRef.current.setAudioPlayback?.(!canPlayAudio ? "blocked" : connected ? "allowed" : "unknown");
  }, [canPlayAudio, connected]);

  // The connect path is the last moment the gesture that started the call may still be live
  // (Chromium keeps transient activation for seconds; iOS needs LiveKit's silent element started
  // inside one). Unlock opportunistically; a refusal here only makes `blocked` known sooner.
  useEffect(() => {
    if (!setAudioPlayback) return;
    void room.startAudio().catch(() => undefined);
  }, [room, setAudioPlayback]);

  const controls = useMemo<CallMediaControls>(() => ({
    startAudio: () => room.startAudio(),
    setMicrophoneEnabled: async (enabled) => {
      if (enabled) setEnabling(true);
      try {
        await room.localParticipant.setMicrophoneEnabled(enabled);
      } catch {
        // Recorded by LiveKit as `lastMicrophoneError` and announced as `MediaDevicesError`; the
        // facts above are re-read from there, so the failure is a state, not a rejection.
      } finally {
        if (enabled) setEnabling(false);
        setVersion((value) => value + 1);
      }
    },
  }), [room]);
  useEffect(() => {
    if (!registerMediaControls) return;
    registerMediaControls(controls);
    return () => registerMediaControls(null);
  }, [controls, registerMediaControls]);
}
