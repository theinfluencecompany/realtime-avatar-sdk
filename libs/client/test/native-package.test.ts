import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Room, RoomEvent, ConnectionState } from "livekit-client";
import { LKFeatureContext } from "@livekit/components-react";
import { useContext } from "react";
import { z } from "zod";

// Load the SHIPPED SDK entry and installed RN room/audio implementations. Only the
// native binary boundary is replaced; React, contexts and LiveKit hooks stay real.
const root = new URL("../../../", import.meta.url);
const native = new URL("node_modules/@livekit/react-native/lib/module/", root);
const audioEvents = channel("rta-sdk-native-package-test");
const calls: unknown[] = [];
audioEvents.subscribe((event) => calls.push(event));
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    // Typecheck against the owned source even in a clean checkout; execute its built public entry.
    if (specifier === "../src/react-native/index.ts") return { url: new URL("libs/sdk-server/dist/react-native.js", root).href, shortCircuit: true };
    if (specifier === "@livekit/react-native") return { url: "fixture:livekit-native", shortCircuit: true };
    if (specifier === "react-native") return { url: "fixture:react-native", shortCircuit: true };
    if (specifier === "../LKNativeModule" && context.parentURL === new URL("audio/AudioSession.js", native).href) {
      return { url: new URL("LKNativeModule.js", native).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "fixture:livekit-native") return {
      format: "module", shortCircuit: true,
      source: `export { LiveKitRoom } from ${JSON.stringify(new URL("components/LiveKitRoom.js", native).href)};
        export { default as AudioSession } from ${JSON.stringify(new URL("audio/AudioSession.js", native).href)};
        export function VideoTrack() { throw new Error('RTCView requires a native device'); }
        export function registerGlobals() { throw new Error('WebRTC globals require a native device'); }`,
    };
    if (url === "fixture:react-native") return {
      format: "module", shortCircuit: true,
      source: `import { channel } from 'node:diagnostics_channel';
        export const Platform = { OS: 'ios', select: (options) => options.ios ?? options.default };
        export const StyleSheet = { create: (styles) => styles, absoluteFillObject: {} };
        export const Animated = {}, Image = 'Image', View = 'View', Text = 'Text';
        export const NativeModules = { LivekitReactNativeModule: {
          startAudioSession: async () => channel('rta-sdk-native-package-test').publish('start'),
          stopAudioSession: async () => channel('rta-sdk-native-package-test').publish('stop'),
        } };`,
    };
    return next(url, context);
  },
});
const sdk = await import("../src/react-native/index.ts");
hooks.deregister();

type RoomProps = Parameters<typeof sdk.RealtimeAvatarLiveKitRoom>[0];
const grant = {
  session_id: "native-test", room_name: "native-room", livekit_url: "wss://test.invalid",
  participant_token: "test-token", stt_mode: "server", camera: true,
  status: "ready", participant_identity: "test-user", reservation_expires_at: "2026-10-01T00:00:00Z",
  room_created: true, dispatch_created: true, join_timeout_seconds: 30,
  idle_timeout_seconds: 60, max_session_seconds: 120,
} satisfies NonNullable<RoomProps["grant"]>;

async function mount(props: RoomProps) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => { renderer = create(createElement(sdk.RealtimeAvatarLiveKitRoom, props)); });
  assert.ok(renderer);
  const mounted = renderer;
  return {
    async update(next: RoomProps) {
      await act(async () => { mounted.update(createElement(sdk.RealtimeAvatarLiveKitRoom, next)); });
    },
    async unmount() { await act(async () => { mounted.unmount(); }); },
  };
}

function controlledRoom(t: TestContext) {
  const room = new Room({ adaptiveStream: false, dynacast: true });
  const connect = t.mock.method(room, "connect", async () => {});
  const disconnect = t.mock.method(room, "disconnect", async () => {});
  const microphone = t.mock.method(room.localParticipant, "setMicrophoneEnabled", async () => undefined);
  const camera = t.mock.method(room.localParticipant, "setCameraEnabled", async () => undefined);
  t.mock.method(room.localParticipant, "setScreenShareEnabled", async () => undefined);
  return { room, connect, disconnect, microphone, camera };
}

test("native dependency contract pins one compatible context and transport group", async () => {
  const manifest = z.object({
    devDependencies: z.record(z.string(), z.string()),
    peerDependencies: z.record(z.string(), z.string()).optional(),
  });
  for (const workspace of ["client", "sdk-server"]) {
    const pkg = manifest.parse(JSON.parse(await readFile(new URL(`libs/${workspace}/package.json`, root), "utf8")));
    for (const [name, version] of Object.entries({
      "@livekit/react-native": "3.0.0", "@livekit/react-native-webrtc": "144.2.0",
      "livekit-client": "2.22.3", "@livekit/components-react": "2.9.21",
    })) assert.equal(pkg.devDependencies[name], version, `${workspace}: ${name}`);
    if (pkg.peerDependencies) {
      assert.equal(pkg.peerDependencies["@livekit/react-native"], "^3.0.0");
      assert.equal(pkg.peerDependencies["@livekit/react-native-webrtc"], "^144.2.0");
      assert.equal(pkg.peerDependencies["livekit-client"], "^2.22.3");
    }
  }
});

test("packaged native room preserves grant, callbacks, shared room and feature contexts", async (t) => {
  const f = controlledRoom(t);
  const baseline = new Map([RoomEvent.SignalConnected, RoomEvent.Connected, RoomEvent.Disconnected, RoomEvent.MediaDevicesError]
    .map((event) => [event, f.room.listenerCount(event)]));
  const connected = t.mock.fn();
  const disconnected = t.mock.fn();
  const errors: Error[] = [];
  const featureFlags = { autoSubscription: true };
  let seenRoom: Room | undefined;
  let seenState: ConnectionState | undefined;
  let seenFlags: unknown;
  function Consumer() {
    seenRoom = sdk.useRoomContext();
    seenState = sdk.useConnectionState();
    seenFlags = useContext(LKFeatureContext);
    assert.equal(sdk.useLocalParticipant().localParticipant, f.room.localParticipant);
    return null;
  }
  calls.length = 0;
  const mounted = await mount({ grant, room: f.room, connectOptions: { autoSubscribe: false },
    onConnected: connected, onDisconnected: disconnected, onError: (error) => errors.push(error),
    featureFlags, children: createElement(Consumer) });
  assert.equal(seenRoom, f.room);
  assert.equal(seenState, ConnectionState.Disconnected);
  assert.equal(seenFlags, featureFlags);
  assert.deepEqual(f.connect.mock.calls[0].arguments, [grant.livekit_url, grant.participant_token, { autoSubscribe: false }]);
  assert.deepEqual(calls, ["start"]);
  await act(async () => { f.room.emit(RoomEvent.SignalConnected); f.room.emit(RoomEvent.Connected); });
  assert.deepEqual(f.microphone.mock.calls[0].arguments, [true, undefined]);
  assert.deepEqual(f.camera.mock.calls[0].arguments, [false, undefined]);
  assert.equal(connected.mock.callCount(), 1);
  await act(async () => { f.room.emit(RoomEvent.Disconnected); });
  assert.equal(disconnected.mock.callCount(), 1);
  assert.deepEqual(errors, []);
  await mounted.unmount();
  assert.deepEqual(calls, ["start", "stop"]);
  assert.equal(f.disconnect.mock.callCount(), 1);
  for (const [event, count] of baseline) {
    assert.equal(f.room.listenerCount(event), count, `leaked ${event} listener`);
  }
});

test("native room applies receiver defaults and allows explicit room-option overrides", async () => {
  let observed: Room | undefined;
  function Consumer() { observed = sdk.useRoomContext(); return null; }
  const defaults = await mount({ grant: null, children: createElement(Consumer) });
  assert.ok(observed);
  assert.equal(observed.options.adaptiveStream, false);
  assert.equal(observed.options.dynacast, true);
  await defaults.unmount();
  const overridden = await mount({ grant: null, options: { adaptiveStream: true, dynacast: false }, children: createElement(Consumer) });
  assert.equal(observed.options.adaptiveStream, true);
  assert.equal(observed.options.dynacast, false);
  await overridden.unmount();
});

test("native audio ownership follows connect intent, with opt-out and redial cleanup", async (t) => {
  const f = controlledRoom(t);
  calls.length = 0;
  const mounted = await mount({ grant: null, room: f.room });
  assert.deepEqual(calls, []);
  assert.equal(f.connect.mock.callCount(), 0);
  await mounted.update({ grant, room: f.room, connect: false });
  assert.deepEqual(calls, []);
  await mounted.update({ grant, room: f.room });
  await mounted.update({ grant, room: f.room, audio: false });
  assert.deepEqual(calls, ["start"], "rerenders must not restart the OS session");
  await mounted.update({ grant, room: f.room, connect: false });
  assert.deepEqual(calls, ["start", "stop"]);
  await mounted.update({ grant, room: f.room });
  await mounted.unmount();
  assert.deepEqual(calls, ["start", "stop", "start", "stop"]);
  calls.length = 0;
  const appOwned = await mount({ grant, room: f.room, manageAudioSession: false });
  await appOwned.unmount();
  assert.deepEqual(calls, []);
});

test("native camera requires server permission plus caller opt-in and passes capture options", async (t) => {
  const f = controlledRoom(t);
  const mounted = await mount({ grant: { ...grant, camera: false }, room: f.room, video: true });
  await act(async () => { f.room.emit(RoomEvent.SignalConnected); });
  assert.deepEqual(f.camera.mock.calls.at(-1)?.arguments, [false, undefined]);
  await mounted.update({ grant, room: f.room, video: true });
  await act(async () => { f.room.emit(RoomEvent.SignalConnected); });
  assert.deepEqual(f.camera.mock.calls.at(-1)?.arguments, [true, {
    resolution: { width: 640, height: 360, frameRate: 5 }, facingMode: "user",
  }]);
  const video = { facingMode: "environment" } satisfies RoomProps["video"];
  const audio = { echoCancellation: false };
  await mounted.update({ grant: { ...grant, stt_mode: "off" }, room: f.room, video, audio });
  await act(async () => { f.room.emit(RoomEvent.SignalConnected); });
  assert.deepEqual(f.camera.mock.calls.at(-1)?.arguments, [true, video]);
  assert.deepEqual(f.microphone.mock.calls.at(-1)?.arguments, [true, audio]);
  await mounted.update({ grant: { ...grant, stt_mode: "off" }, room: f.room });
  await act(async () => { f.room.emit(RoomEvent.SignalConnected); });
  assert.deepEqual(f.microphone.mock.calls.at(-1)?.arguments, [false, undefined]);
  await mounted.unmount();
});

test("native room forwards connection and media failures through LiveKit callbacks", async (t) => {
  const f = controlledRoom(t);
  const failure = new Error("connection refused");
  f.connect.mock.mockImplementation(async () => { throw failure; });
  const errors: Error[] = [];
  const mounted = await mount({ grant, room: f.room, onError: (error) => errors.push(error) });
  assert.deepEqual(errors, [failure]);
  const denied = new Error("permission denied");
  f.camera.mock.mockImplementation(async () => { throw denied; });
  await act(async () => { f.room.emit(RoomEvent.SignalConnected); });
  assert.deepEqual(errors, [failure, denied]);
  await mounted.unmount();
});
