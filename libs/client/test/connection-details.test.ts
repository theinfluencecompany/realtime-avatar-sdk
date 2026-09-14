import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { ConnectionQuality, ConnectionState, RoomEvent, Track } from "livekit-client";
import type { AvatarCallProps, AvatarConnectionDetails, SessionLifecycleRoomBridgeProps } from "../src/react/index.ts";
import type { AvatarConnectionDetails as NativeDetails, SessionLifecycleRoomBridgeProps as NativeBridgeProps } from "../src/react-native/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type SharedSnapshot = Assert<Equal<AvatarConnectionDetails, NativeDetails>>;
type SharedCallback = Assert<Equal<AvatarCallProps["onConnectionDetailsChange"], NativeBridgeProps["onConnectionDetailsChange"]>>;
type NativeState = Assert<Equal<AvatarConnectionDetails["connectionState"], ConnectionState>>;
type NativeQuality = Assert<Equal<AvatarConnectionDetails["localQuality"], ConnectionQuality>>;
type NativeStream = Assert<Equal<NonNullable<AvatarConnectionDetails["audio"]>["streamState"], Track.StreamState | null>>;
type SnapshotKeys = Assert<Equal<keyof AvatarConnectionDetails, "connectionState" | "localQuality" | "audio" | "video">>;
type Callback = NonNullable<SessionLifecycleRoomBridgeProps["onConnectionDetailsChange"]>;
const legacyBridge: SessionLifecycleRoomBridgeProps = {
  lifecycle: { onConnectionStateChange() {}, setAgentPresent() {}, registerLeaveRoom() {}, markActivity() {} },
};

// The actual shared bridge and AvatarCall execute with controlled React commits and
// native events. Existing lifecycle behavior is stubbed; no browser or network runs.
const bundle = await build({
  stdin: {
    contents: `import {SessionLifecycleRoomBridge} from './session-lifecycle';
      import {useAvatarCall} from './avatar-call';
      export {SessionLifecycleRoomBridge as bridge};
      export const render = () => SessionLifecycleRoomBridge({lifecycle: globalThis.fixture.lifecycle,
        onConnectionDetailsChange: globalThis.fixture.callback});
      export const renderAvatar = () => useAvatarCall({client: {}, avatarId: 'avatar',
        onConnectionDetailsChange: globalThis.fixture.callback});`,
    resolveDir: new URL("../src/react", import.meta.url).pathname,
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "controlled-connection", setup(builder) {
    builder.onResolve({ filter: /^(react|\.\/livekit|\.\/avatar-video-surface|\.\/use-realtime-session)$/ }, ({ path }) => ({ path, namespace: "controlled" }));
    builder.onLoad({ filter: /.*/, namespace: "controlled" }, ({ path }) => ({ contents: path === "react"
      ? `export const useRef = (v) => globalThis.fixture.useRef(v);
         export const useEffect = (fn, deps) => globalThis.fixture.useEffect(fn, deps);
         export const useMemo = (fn) => fn(); export const useCallback = (fn) => fn;
         export const useState = () => {throw Error('unexpected lifecycle state')};
         export const createElement = (type, props, ...children) => {
           const node = {type, props, children}; globalThis.fixture.elements.push(node); return node;
         };`
      : path === "./livekit"
        ? `export const useRoomContext = () => globalThis.fixture.room;
           export const useConnectionState = () => globalThis.fixture.room.state;
           export const useVoiceAssistant = () => globalThis.fixture.assistant;
           export const useTranscriptions = () => []; export const useChat = () => ({send: () => {}});
           export const useLiveKitAvatarGrant = () => {}; export const RealtimeAvatarLiveKitRoom = () => null;`
        : path === "./avatar-video-surface"
          ? "export const AvatarVideoSurface = () => null;"
          : "export const useRealtimeSession = () => globalThis.fixture.session;" }));
  } }],
});

function room() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    state: ConnectionState.Connected,
    localParticipant: { connectionQuality: ConnectionQuality.Good },
    on(event: string, callback: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(callback);
    },
    off(event: string, callback: (...args: unknown[]) => void) { listeners.get(event)?.delete(callback); },
    emit(event: string, ...args: unknown[]) { for (const callback of listeners.get(event) ?? []) callback(...args); },
    count() { return [...listeners.values()].reduce((count, set) => count + set.size, 0); },
  };
}

function source(quality: ConnectionQuality) {
  const publication: { track?: { streamState: Track.StreamState } } = { track: { streamState: Track.StreamState.Active } };
  return {
    participant: { connectionQuality: quality },
    publication,
  };
}

function fixture() {
  const callbacks: (() => void)[] = [];
  const refs: { current: unknown }[] = [];
  const effects: { deps: unknown[]; cleanup?: void | (() => void) }[] = [];
  let refIndex = 0, effectIndex = 0;
  const received: (AvatarConnectionDetails | null)[] = [];
  const record: Callback = (details) => { received.push(details); };
  const controlled: {
    room: ReturnType<typeof room>;
    assistant: { agent: ReturnType<typeof source>["participant"]; state: string; audioTrack?: ReturnType<typeof source>; videoTrack?: ReturnType<typeof source> };
    lifecycle: Omit<typeof legacyBridge.lifecycle, "grant"> & { grant?: { session_id: string } | null };
    callback?: Callback;
    elements: { type: unknown; props?: Record<string, unknown> }[];
    session: object;
    useRef: (value: unknown) => { current: unknown };
    useEffect: (setup: () => void | (() => void), deps: unknown[]) => void;
  } = {
    room: room(),
    assistant: { agent: { connectionQuality: ConnectionQuality.Lost }, state: "listening",
      audioTrack: source(ConnectionQuality.Excellent), videoTrack: source(ConnectionQuality.Poor) },
    lifecycle: { ...legacyBridge.lifecycle, grant: { session_id: "first" } },
    callback: record, elements: [],
    session: { phase: { kind: "live" }, clocks: { sessionRemainingMs: null } },
    useRef(value) {
      const index = refIndex++;
      return refs[index] ?? (refs[index] = { current: value });
    },
    useEffect(setup, deps) {
      const index = effectIndex++;
      const previous = effects[index];
      if (previous && deps.every((value, position) => Object.is(value, previous.deps[position]))) return;
      previous?.cleanup?.();
      effects[index] = { deps, cleanup: setup() };
    },
  };
  const module: { exports: { render?: () => void; renderAvatar?: () => void; bridge?: unknown } } = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    fixture: controlled, module, exports: module.exports, require: createRequire(import.meta.url),
    queueMicrotask: (callback: () => void) => { callbacks.push(callback); },
    setInterval() { throw new Error("connection details must not poll"); },
  });
  return {
    controlled, received, record,
    render(callback = controlled.callback) { controlled.callback = callback; refIndex = effectIndex = 0; module.exports.render?.(); },
    renderAvatar() { module.exports.renderAvatar?.(); return controlled.elements.filter((node) => node.type === module.exports.bridge); },
    pending() { return callbacks.length; },
    flush() { while (callbacks.length) callbacks.shift()?.(); },
    dispose() { for (const effect of effects) effect.cleanup?.(); },
  };
}

test("details are opt-in, initial delivery is deferred, and publishers are selected independently", () => {
  const off = fixture(); off.controlled.callback = undefined;
  assert.ok(off.controlled.assistant.audioTrack);
  Object.defineProperty(off.controlled.assistant.audioTrack.publication, "track", {
    get() { throw new Error("opt-out must not read details"); },
  });
  off.render(); assert.equal(off.pending(), 0); off.flush();
  assert.equal(off.controlled.room.count(), 0); assert.deepEqual(off.received, []);
  const f = fixture(); f.render();
  assert.equal(f.received.length, 0);
  f.flush();
  assert.deepEqual(structuredClone(f.received), [{ connectionState: "connected", localQuality: "good",
    audio: { publisherQuality: "excellent", streamState: "active" }, video: { publisherQuality: "poor", streamState: "active" } }]);
  f.dispose(); assert.equal(f.received.at(-1), null); assert.equal(f.controlled.room.count(), 0);
});

test("native changes deduplicate unchanged facts and ignore unrelated participants", () => {
  const f = fixture(); f.render(); f.flush();
  const r = f.controlled.room;
  r.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Poor, { connectionQuality: ConnectionQuality.Poor });
  r.emit(RoomEvent.TrackStreamStateChanged, {}, Track.StreamState.Paused);
  r.emit(RoomEvent.TrackSubscribed, {}, {});
  r.emit(RoomEvent.TrackUnsubscribed, {}, {});
  assert.equal(f.pending(), 0);
  r.emit(RoomEvent.ConnectionStateChanged, r.state); f.flush();
  assert.equal(f.received.length, 1);
  r.localParticipant.connectionQuality = ConnectionQuality.Poor;
  r.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Poor, r.localParticipant); f.flush();
  assert.equal(f.received.at(-1)?.localQuality, ConnectionQuality.Poor);
  assert.equal(f.received.length, 2);
  r.state = ConnectionState.Reconnecting;
  r.emit(RoomEvent.ConnectionStateChanged, r.state); f.flush();
  assert.equal(f.received.at(-1)?.connectionState, ConnectionState.Reconnecting);
  const video = f.controlled.assistant.videoTrack; assert.ok(video?.publication.track);
  video.publication.track.streamState = Track.StreamState.Paused;
  r.emit(RoomEvent.TrackStreamStateChanged, video.publication, Track.StreamState.Paused, video.participant); f.flush();
  assert.equal(f.received.at(-1)?.video?.streamState, Track.StreamState.Paused);
  assert.equal(f.received.at(-1)?.audio?.streamState, Track.StreamState.Active);
  f.dispose();
});

test("absent publishers differ from Unknown and unsubscription clears only stream state", () => {
  const f = fixture(); f.controlled.assistant.audioTrack = undefined; f.controlled.assistant.videoTrack = undefined;
  f.render(); f.flush(); assert.equal(f.received.at(-1)?.audio, null); assert.equal(f.received.at(-1)?.video, null);
  const video = source(ConnectionQuality.Unknown); f.controlled.assistant.videoTrack = video;
  f.render(); f.flush(); assert.equal(f.received.at(-1)?.video?.publisherQuality, ConnectionQuality.Unknown);
  video.publication.track = undefined;
  f.controlled.room.emit(RoomEvent.TrackUnsubscribed, {}, video.publication); f.flush();
  assert.equal(f.received.at(-1)?.video?.streamState, null);
  f.controlled.assistant.videoTrack = undefined; f.render(); f.flush();
  assert.equal(f.received.at(-1)?.video, null); f.dispose();
});

test("publisher replacement with equal facts rebinds future events without duplicate delivery", () => {
  const f = fixture(); f.render(); f.flush();
  const old = f.controlled.assistant.videoTrack;
  const next = source(ConnectionQuality.Poor); f.controlled.assistant.videoTrack = next;
  f.render(); f.flush(); assert.equal(f.received.length, 1);
  f.controlled.room.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Excellent, old?.participant); f.flush();
  assert.equal(f.received.length, 1);
  next.participant.connectionQuality = ConnectionQuality.Good;
  f.controlled.room.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Good, next.participant); f.flush();
  assert.equal(f.received.at(-1)?.video?.publisherQuality, ConnectionQuality.Good); f.dispose();
});

test("replacing the callback keeps the binding and sends pending facts only to the current handler", () => {
  const f = fixture(); f.render(); f.flush(); const count = f.controlled.room.count();
  const next: (AvatarConnectionDetails | null)[] = [];
  const handler: Callback = (details) => { next.push(details); };
  f.controlled.room.localParticipant.connectionQuality = ConnectionQuality.Lost;
  f.controlled.room.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Lost, f.controlled.room.localParticipant);
  f.render(handler); f.flush();
  assert.equal(f.controlled.room.count(), count); assert.equal(f.received.length, 1);
  assert.equal(next.length, 1); assert.equal(next[0]?.localQuality, ConnectionQuality.Lost);
  f.render((details) => { next.push(details); }); f.flush(); assert.equal(next.length, 1);
  f.dispose(); assert.equal(next.at(-1), null);
});

test("room replacement and same-room remints reset the old handler before the new snapshot", () => {
  for (const replaceRoom of [false, true]) {
    const f = fixture(); f.render(); f.flush(); const oldRoom = f.controlled.room;
    oldRoom.localParticipant.connectionQuality = ConnectionQuality.Lost;
    oldRoom.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Lost, oldRoom.localParticipant);
    if (replaceRoom) f.controlled.room = room();
    f.controlled.lifecycle.grant = { session_id: "second" };
    const next: (AvatarConnectionDetails | null)[] = [];
    f.render((details) => { next.push(details); });
    assert.equal(f.received.at(-1), null); assert.equal(next.length, 0);
    f.flush(); assert.equal(f.received.length, 2); assert.equal(next.length, 1);
    if (replaceRoom) assert.equal(oldRoom.count(), 0);
    f.dispose(); assert.equal(next.at(-1), null);
  }
});

test("retiring an opt-in clears the old view and cancels pending delivery", () => {
  const f = fixture(); f.render();
  f.controlled.callback = undefined; f.render(); f.flush();
  assert.deepEqual(f.received, [null]); assert.equal(f.controlled.room.count(), 0);
  f.render(f.record); f.flush(); assert.equal(f.received.length, 2);
  f.dispose(); f.flush(); assert.equal(f.received.at(-1), null); assert.equal(f.received.length, 3);
});

test("a cleared grant stays reset until a new grant arrives on the same room", () => {
  const f = fixture(); f.controlled.lifecycle.grant = null;
  f.render(); f.flush();
  assert.equal(f.controlled.room.count(), 0); assert.deepEqual(f.received, []);
  f.controlled.lifecycle.grant = { session_id: "first" };
  f.render(); f.flush(); assert.equal(f.received.length, 1);
  f.controlled.room.localParticipant.connectionQuality = ConnectionQuality.Lost;
  f.controlled.room.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Lost, f.controlled.room.localParticipant);
  f.controlled.lifecycle.grant = null;
  f.render(); f.flush();
  assert.equal(f.received.at(-1), null); assert.equal(f.received.length, 2);
  assert.equal(f.controlled.room.count(), 0);
  f.controlled.lifecycle.grant = { session_id: "second" };
  f.render(); f.flush(); assert.equal(f.received.length, 3);
  f.dispose();
});

test("legacy bridges without a grant still report their bound room", () => {
  const f = fixture(); delete f.controlled.lifecycle.grant;
  f.render(); f.flush(); assert.equal(f.received.length, 1);
  f.dispose(); assert.equal(f.received.at(-1), null);
});

test("throwing and rejected handlers cannot interrupt native events or cleanup", async () => {
  for (const asyncFailure of [false, true]) {
    const f = fixture();
    f.render(() => { if (asyncFailure) return Promise.reject(new Error("sink failed")); throw new Error("sink failed"); });
    assert.doesNotThrow(() => f.flush()); assert.doesNotThrow(() => f.dispose());
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.controlled.room.count(), 0);
  }
});

test("AvatarCall forwards the optional callback to its one existing shared bridge", () => {
  const f = fixture(); const bridges = f.renderAvatar();
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0]?.props?.onConnectionDetailsChange, f.record);
});
