import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ComponentType, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { build } from "esbuild";
import type { Room as LiveKitRoomType } from "livekit-client";
import type { RealtimeAvatarLiveKitRoomProps } from "../src/react-native/room.ts";

// iOS 26 keeps one input-mute flag per app process, and a server-closed call can leave it MUTED
// for every later call (room.ts clearStaleInputMute carries the device evidence). These run the
// native room bridge against a real livekit-client Room; only the native modules are recorded.
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const require = createRequire(import.meta.url);
const { Room, RoomEvent, Track } = require("livekit-client") as typeof import("livekit-client");
const { RoomContext } = require("@livekit/components-react") as typeof import("@livekit/components-react");
const bundle = await build({
  entryPoints: [new URL("../src/react-native/room.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
});

type Bridge = {
  RealtimeAvatarLiveKitRoom?: ComponentType<RealtimeAvatarLiveKitRoomProps>;
  clearStaleInputMute?: (stillWanted: () => boolean) => Promise<void>;
};
type Engine = { os?: "ios" | "android"; liveAfterPolls?: number; muteMode?: number; failMute?: boolean };

function load(t: TestContext, engine: Engine = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: boolean[] = [];
  const recorder = {
    polls: 0,
    isRecording: () => recorder.polls++ >= (engine.liveAfterPolls ?? 0),
    getMuteMode: () => engine.muteMode ?? 0,
    async setMicrophoneMuted(muted: boolean) {
      writes.push(muted);
      if (muted && engine.failMute) throw new Error("native mute failed");
    },
  };
  function LiveKitRoom({ room, children }: { room?: LiveKitRoomType; children?: ReactNode }) {
    return createElement(RoomContext.Provider, { value: room }, children);
  }
  const module: { exports: Bridge } = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    // Read at call time so the mocked timers reach the bridge inside the sandbox.
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    require: (name: string) => {
      if (name === "react-native") return { Platform: { OS: engine.os ?? "ios" } };
      if (name === "@livekit/react-native-webrtc") return {
        AudioDeviceModule: recorder,
        AudioEngineMuteMode: { Unknown: -1, VoiceProcessing: 0, RestartEngine: 1, InputMixer: 2 },
      };
      if (name === "@livekit/react-native") return {
        LiveKitRoom, AudioSession: { startAudioSession() {}, stopAudioSession() {} },
      };
      return require(name);
    },
  });
  return { bridge: module.exports, writes, recorder };
}

async function advance(t: TestContext, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    t.mock.timers.tick(50);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function mountRoom(t: TestContext, bridge: Bridge) {
  const Wrapper = bridge.RealtimeAvatarLiveKitRoom;
  assert.ok(Wrapper);
  const room = new Room();
  t.mock.method(room, "connect", async () => {});
  t.mock.method(room, "disconnect", async () => {});
  const grant: NonNullable<RealtimeAvatarLiveKitRoomProps["grant"]> = {
    status: "ready", session_id: "s", room_name: "s", livekit_url: "wss://test.invalid",
    participant_token: "s", participant_identity: "user", max_session_seconds: 600,
    idle_timeout_seconds: 120, join_timeout_seconds: 75, reservation_expires_at: "2026-10-10T00:00:00Z",
    stt_mode: "server", room_created: true, dispatch_created: true,
  };
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Wrapper, { grant, room })); });
  assert.ok(renderer);
  const mounted = renderer;
  const local = room.localParticipant;
  // The publication fields the bridge reads; a real one needs a live peer connection.
  const publish = async (source: string, isMuted = false) => {
    const publication = { trackSid: `TR_${source}`, source, isMuted };
    local.trackPublications.set(publication.trackSid, publication as never);
    await act(async () => { room.emit(RoomEvent.LocalTrackPublished, publication as never, local); });
    return publication;
  };
  return {
    room, local, publish,
    async unmount() { await act(async () => { mounted.unmount(); }); },
  };
}

test("iOS: once the published microphone's input is live, the engine mute round-trips true then false, once", async (t) => {
  const f = load(t, { liveAfterPolls: 3 });
  const room = await mountRoom(t, f.bridge);
  await room.publish(Track.Source.Microphone);
  await advance(t, 250);
  assert.deepEqual(f.writes, [], "wrote before this call's input was live");
  await advance(t, 100);
  assert.deepEqual(f.writes, [true, false]);
  const polls = f.recorder.polls;
  await advance(t, 6_000);
  assert.deepEqual(f.writes, [true, false], "a single publication cleared twice");
  assert.equal(f.recorder.polls, polls, "kept polling after the clear");
  await room.unmount();
});

test("iOS: the unmute is written even when the mute half fails, and nothing throws", async (t) => {
  const f = load(t, { failMute: true });
  const room = await mountRoom(t, f.bridge);
  await room.publish(Track.Source.Microphone);
  await advance(t, 100);
  assert.deepEqual(f.writes, [true, false]);
  assert.ok(f.bridge.clearStaleInputMute);
  await f.bridge.clearStaleInputMute(() => true);
  assert.deepEqual(f.writes, [true, false, true, false]);
  await room.unmount();
});

test("iOS: nothing is written when input never goes live, and the wait is bounded", async (t) => {
  const f = load(t, { liveAfterPolls: Number.POSITIVE_INFINITY });
  const room = await mountRoom(t, f.bridge);
  await room.publish(Track.Source.Microphone);
  await advance(t, 6_000);
  assert.equal(f.recorder.polls, 51, "polls every 100 ms for 5 s");
  assert.deepEqual(f.writes, []);
  await room.unmount();
});

test("iOS: nothing is written once the microphone is unpublished or muted, or the room unmounts, before input is live", async (t) => {
  const unpublished = load(t, { liveAfterPolls: 5 });
  const a = await mountRoom(t, unpublished.bridge);
  const mic = await a.publish(Track.Source.Microphone);
  await advance(t, 200);
  a.local.trackPublications.delete(mic.trackSid);
  await advance(t, 6_000);
  assert.deepEqual(unpublished.writes, []);
  assert.ok(unpublished.recorder.polls > 0, "never waited for this microphone's input");
  assert.ok(unpublished.recorder.polls < 5, "kept polling for an unpublished microphone");
  await a.unmount();
  t.mock.timers.reset();

  const muted = load(t, { liveAfterPolls: 5 });
  const b = await mountRoom(t, muted.bridge);
  const mutedMic = await b.publish(Track.Source.Microphone);
  await advance(t, 200);
  mutedMic.isMuted = true;
  await advance(t, 6_000);
  assert.ok(muted.recorder.polls > 0 && muted.recorder.polls < 5, "did not stop waiting for a muted microphone");
  assert.deepEqual(muted.writes, []);
  await b.unmount();
  t.mock.timers.reset();

  const unmounted = load(t, { liveAfterPolls: 5 });
  const c = await mountRoom(t, unmounted.bridge);
  await c.publish(Track.Source.Microphone);
  await advance(t, 200);
  await c.unmount();
  await advance(t, 6_000);
  assert.ok(unmounted.recorder.polls > 0 && unmounted.recorder.polls < 5, "did not stop waiting after unmount");
  assert.deepEqual(unmounted.writes, []);
});

test("nothing is written when the engine mutes another way, or on Android", async (t) => {
  const restart = load(t, { muteMode: 1 });
  const a = await mountRoom(t, restart.bridge);
  await a.publish(Track.Source.Microphone);
  await advance(t, 500);
  assert.ok(restart.recorder.polls > 0, "never checked the engine");
  assert.deepEqual(restart.writes, [], "a non-Voice-Processing mute restarts the engine instead");
  await a.unmount();
  t.mock.timers.reset();

  const android = load(t, { os: "android" });
  const b = await mountRoom(t, android.bridge);
  await b.publish(Track.Source.Microphone);
  await advance(t, 500);
  assert.ok(android.bridge.clearStaleInputMute);
  await android.bridge.clearStaleInputMute(() => true);
  assert.equal(android.recorder.polls, 0, "touched the iOS-only engine on Android");
  assert.deepEqual(android.writes, []);
  await b.unmount();
});

test("iOS: a later unmute of the microphone clears again; a muted publish, the camera and remote tracks do not", async (t) => {
  const f = load(t);
  const room = await mountRoom(t, f.bridge);
  const mic = await room.publish(Track.Source.Microphone, true);
  await room.publish(Track.Source.Camera);
  await advance(t, 500);
  assert.deepEqual(f.writes, [], "cleared for a muted microphone or a camera");
  mic.isMuted = false;
  const remote = { identity: "agent" };
  await act(async () => { room.room.emit(RoomEvent.TrackUnmuted, mic as never, remote as never); });
  await advance(t, 500);
  assert.deepEqual(f.writes, [], "cleared for another participant's unmute");
  await act(async () => { room.room.emit(RoomEvent.TrackUnmuted, mic as never, room.local); });
  await advance(t, 100);
  assert.deepEqual(f.writes, [true, false]);
  await room.unmount();
});

test("the web entry never imports the native audio engine", async () => {
  const web = await readFile(new URL("../../sdk-server/dist/react.js", import.meta.url), "utf8");
  const native = await readFile(new URL("../../sdk-server/dist/react-native.js", import.meta.url), "utf8");
  assert.doesNotMatch(web, /react-native-webrtc/);
  assert.match(native, /from ["']@livekit\/react-native-webrtc["']/);
});
