import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Fragment } from "react";
import { act, create } from "react-test-renderer";
import { RoomContext } from "@livekit/components-react";
import { ConnectionState, Room, RoomEvent, Track } from "livekit-client";
import type {
  AvatarSessionClient,
  RealtimeSessionApi,
  SessionLifecycleRoomBridge as Bridge,
  useRealtimeSession as UseRealtimeSession,
} from "../src/react/index.ts";

/**
 * Whether she can hear the user, and whether the user can hear her, are states of the call.
 *
 * Both failures used to be invisible behind a "live" call:
 * - A microphone LiveKit could not start (permission denied, no device, a device another app
 *   holds) reached only the room's `onError`, which the lifecycle ignores because it is not a
 *   connection failure. She could never hear a word.
 * - A browser that blocks autoplay keeps her voice silent until `room.startAudio()` runs inside a
 *   user gesture. Nothing read `canPlaybackAudio`, nothing offered the gesture.
 *
 * Drives the RENDERED session hook and the in-room bridge of the shipped `realtime-avatar/react`
 * entry against a real LiveKit `Room` that never connects: the facts LiveKit would produce are
 * emitted as its own public events.
 */
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
globalThis.fetch = async () => new Response(null, { status: 204 });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {}, removeEventListener: () => {} },
});

const sdk: { useRealtimeSession: typeof UseRealtimeSession; SessionLifecycleRoomBridge: typeof Bridge } = await import(
  new URL("../../sdk-server/dist/react.js", import.meta.url).href
);

const client: AvatarSessionClient = {
  createLiveKitSessionOrBusy: () => new Promise(() => {}),
  releaseLiveKitSession: async () => true,
  releaseLiveKitSessionBeacon: () => false,
  releaseLiveKitQueueTicket: async () => true,
  releaseLiveKitQueueTicketBeacon: () => false,
};

function domError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** A real Room whose device and playback facts the test sets, as LiveKit would. */
function scriptedRoom() {
  const room = new Room();
  const facts: { micError: Error | undefined; canPlay: boolean; startAudioCalls: number; micTrack: { muted: boolean; readyState: string } | null } = {
    micError: undefined, canPlay: true, startAudioCalls: 0, micTrack: null,
  };
  Object.defineProperty(room.localParticipant, "lastMicrophoneError", { configurable: true, get: () => facts.micError });
  Object.defineProperty(room, "canPlaybackAudio", { configurable: true, get: () => facts.canPlay });
  const listeners = new Map<string, () => void>();
  const track = {
    get mediaStreamTrack() { return { readyState: facts.micTrack?.readyState ?? "live" }; },
    on(event: string, fn: () => void) { listeners.set(event, fn); return track; },
    off() { return track; },
  };
  room.localParticipant.getTrackPublication = (source: Track.Source) =>
    source === Track.Source.Microphone && facts.micTrack
      ? ({ isMuted: facts.micTrack.muted, track } as unknown as ReturnType<Room["localParticipant"]["getTrackPublication"]>)
      : undefined;
  room.startAudio = async () => {
    facts.startAudioCalls += 1;
    facts.canPlay = true;
    room.emit(RoomEvent.AudioPlaybackStatusChanged, true);
  };
  return { room, facts, emitTrack: (event: string) => listeners.get(event)?.() };
}

async function mount(room: Room, microphone = true) {
  let session: RealtimeSessionApi | undefined;
  function Call(): ReturnType<typeof createElement> {
    session = sdk.useRealtimeSession({ client, session: null });
    return createElement(
      RoomContext.Provider,
      { value: room },
      createElement(Fragment, null, createElement(sdk.SessionLifecycleRoomBridge, { lifecycle: session, microphone })),
    );
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call)); });
  return { get: () => session, unmount: () => act(async () => renderer?.unmount()) };
}

const connect = (room: Room) => act(async () => {
  room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
});

test("a denied microphone is BLOCKED with the fix named, and a retry after the fix turns it on", async () => {
  const { room, facts } = scriptedRoom();
  const call = await mount(room);
  assert.equal(call.get()?.microphone.status, "off", "nothing is captured before the room connects");
  await connect(room);
  assert.equal(call.get()?.microphone.status, "pending", "connected and asked, not yet answered");

  facts.micError = domError("NotAllowedError", "Permission denied");
  await act(async () => { room.emit(RoomEvent.MediaDevicesError, facts.micError!, "audioinput"); });
  const blocked = call.get()?.microphone;
  assert.equal(blocked?.status, "blocked", "the call read live while she could never hear the user");
  assert.equal(blocked?.status === "blocked" ? blocked.reason : null, "denied-by-browser");

  room.localParticipant.setMicrophoneEnabled = async () => {
    facts.micError = undefined;
    facts.micTrack = { muted: false, readyState: "live" };
    room.emit(RoomEvent.LocalTrackPublished, undefined as never, room.localParticipant);
    return undefined;
  };
  await act(async () => { await call.get()?.setMicrophoneEnabled(true); });
  assert.equal(call.get()?.microphone.status, "on");
  await call.unmount();
});

test("an OS denial, a missing device and a busy device each name a different fix", async () => {
  const cases: Array<[Error, string, string]> = [
    [domError("NotAllowedError", "Permission denied by system"), "blocked", "denied-by-os"],
    [domError("NotFoundError", "Requested device not found"), "unavailable", "no-device"],
    [domError("NotReadableError", "Could not start audio source"), "unavailable", "device-in-use"],
  ];
  for (const [error, status, reason] of cases) {
    const { room, facts } = scriptedRoom();
    const call = await mount(room);
    await connect(room);
    facts.micError = error;
    await act(async () => { room.emit(RoomEvent.MediaDevicesError, error, "audioinput"); });
    const mic = call.get()?.microphone;
    assert.equal(mic?.status, status, error.name);
    assert.equal(mic && "reason" in mic ? mic.reason : null, reason, error.name);
    assert.ok(mic && "hint" in mic && mic.hint.length > 0);
    await call.unmount();
  }
});

test("a publish failure LiveKit sends only to the room's onError is a microphone problem too", async () => {
  const { room } = scriptedRoom();
  const call = await mount(room);
  await connect(room);
  await act(async () => { call.get()?.onConnectionError(domError("NotAllowedError", "Permission denied")); });
  assert.equal(call.get()?.microphone.status, "blocked");
  assert.equal(call.get()?.phase.kind, "idle", "a device failure must not enter connection recovery");
  await call.unmount();
});

test("mute, unmute, and a device lost mid-call", async () => {
  const { room, facts, emitTrack } = scriptedRoom();
  facts.micTrack = { muted: false, readyState: "live" };
  const call = await mount(room);
  await connect(room);
  assert.equal(call.get()?.microphone.status, "on");
  facts.micTrack.muted = true;
  await act(async () => { emitTrack("muted"); });
  assert.equal(call.get()?.microphone.status, "muted");
  // Unplugged: LiveKit fails to restart on the default device and mutes the ended track.
  facts.micTrack.readyState = "ended";
  await act(async () => { emitTrack("ended"); });
  const lost = call.get()?.microphone;
  assert.equal(lost?.status, "unavailable", "a lost device must not read as a deliberate mute");
  assert.equal(lost && "reason" in lost ? lost.reason : null, "device-lost");
  await call.unmount();
});

test("a call that does not listen reports the microphone off, never pending", async () => {
  const { room } = scriptedRoom();
  const call = await mount(room, false);
  await connect(room);
  assert.equal(call.get()?.microphone.status, "off");
  await call.unmount();
});

test("blocked audio is a state, and startAudio from the gesture unblocks it", async () => {
  const { room, facts } = scriptedRoom();
  facts.canPlay = false;
  // The opportunistic unlock on mount fails here: there is no gesture.
  room.startAudio = async () => {
    facts.startAudioCalls += 1;
    room.emit(RoomEvent.AudioPlaybackStatusChanged, false);
  };
  const call = await mount(room);
  assert.ok(facts.startAudioCalls >= 1, "the connect path did not try to unlock audio while the click may still count");
  await connect(room);
  assert.equal(call.get()?.audioPlayback, "blocked", "the call read live in silence");

  room.startAudio = async () => {
    facts.canPlay = true;
    room.emit(RoomEvent.AudioPlaybackStatusChanged, true);
  };
  await act(async () => { await call.get()?.startAudio(); });
  assert.equal(call.get()?.audioPlayback, "allowed");
  await call.unmount();
});

test("audio playback is unknown, not allowed, before the room connects", async () => {
  const { room } = scriptedRoom();
  const call = await mount(room);
  assert.equal(call.get()?.audioPlayback, "unknown");
  await call.unmount();
});
