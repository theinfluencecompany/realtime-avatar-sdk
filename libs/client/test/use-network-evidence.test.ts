import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { ConnectionQuality, ConnectionState, RoomEvent, Track } from "livekit-client";
import type { useAvatarNetworkEvidence } from "../src/react/use-network-evidence.ts";
import type { AvatarNetworkEvidenceManifest, AvatarNetworkEvidenceObserver, AvatarNetworkEvidenceSample } from "../src/react/network-evidence.ts";

// Exercise the actual observer with controlled effect commits and microtask delivery.
// These tests model lifecycle boundaries; browser rendering itself is not simulated.
const bundle = await build({
  entryPoints: [new URL("../src/react/use-network-evidence.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "controlled-hook-inputs", setup(builder) {
    builder.onResolve({ filter: /^(react|@livekit\/components-react)$/ }, ({ path }) => ({ path, namespace: "controlled" }));
    builder.onLoad({ filter: /.*/, namespace: "controlled" }, ({ path }) => ({ contents: path === "react"
      ? "export const useRef = (v) => globalThis.fixture.useRef(v); export const useEffect = (fn, deps) => globalThis.fixture.useEffect(fn, deps);"
      : "export const useMaybeRoomContext = () => globalThis.fixture.room; export const useVoiceAssistant = () => globalThis.fixture.tracks;" }));
  } }],
});

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("uninitialized promise"); };
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fixture() {
  const callbacks: (() => void)[] = [];
  const timers = new Map<number, () => void>();
  const intervals: number[] = [];
  const refs: { current: unknown }[] = [];
  const effects: { deps: unknown[]; cleanup?: void | (() => void) }[] = [];
  let refIndex = 0, effectIndex = 0, timerId = 0, statsReads = 0;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const samples: AvatarNetworkEvidenceSample[] = [];
  const manifests: AvatarNetworkEvidenceManifest[] = [];
  const agent = { sid: "PA_avatar", connectionQuality: ConnectionQuality.Good };
  const publication = { trackSid: "TR_avatar", track: { mediaStreamTrack: { id: "avatar" }, streamState: Track.StreamState.Active } };
  const room = {
    state: ConnectionState.Connected,
    localParticipant: { sid: "PA_local" },
    getSid: () => Promise.resolve("RM_room"),
    engine: { pcManager: { subscriber: { getStats: async (): Promise<RTCStatsReport> => {
      statsReads += 1;
      return new Map([["video", { id: "video", type: "inbound-rtp", kind: "video", trackIdentifier: "avatar", framesDecoded: 12 }]]);
    } } } },
    on(event: string, callback: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(callback);
    },
    off(event: string, callback: (...args: unknown[]) => void) { listeners.get(event)?.delete(callback); },
  };
  const observer: AvatarNetworkEvidenceObserver = {
    context: { evidenceId: "580c0052-a0c9-47a7-8e52-2b85788743b3", sessionId: "rts_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", surface: "web", mode: "avatar" },
    onManifest: (manifest) => { manifests.push(manifest); },
    onSample: (sample) => { samples.push(sample); },
  };
  const tracks: { agent: typeof agent; videoTrack?: { participant: typeof agent; publication: typeof publication } } = {
    agent, videoTrack: { participant: agent, publication },
  };
  const controlled = {
    room,
    tracks,
    useRef(value: unknown) {
      const index = refIndex++;
      return refs[index] ?? (refs[index] = { current: value });
    },
    useEffect(setup: () => void | (() => void), deps: unknown[]) {
      const index = effectIndex++;
      const previous = effects[index];
      if (previous && deps.every((value, position) => Object.is(value, previous.deps[position]))) return;
      previous?.cleanup?.();
      effects[index] = { deps, cleanup: setup() };
    },
  };
  const module: { exports: { useAvatarNetworkEvidence?: typeof useAvatarNetworkEvidence } } = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    fixture: controlled, module, exports: module.exports, require: createRequire(import.meta.url),
    performance, Date, queueMicrotask: (callback: () => void) => { callbacks.push(callback); },
    setInterval(callback: () => void, interval: number) { intervals.push(interval); timers.set(++timerId, callback); return timerId; },
    clearInterval(id: number) { timers.delete(id); },
  });
  const hook = module.exports.useAvatarNetworkEvidence;
  if (!hook) throw new Error("observer export missing");
  return {
    ...controlled, observer, samples, manifests, intervals,
    render(input: Parameters<typeof useAvatarNetworkEvidence>[0] = { observer }) { refIndex = 0; effectIndex = 0; hook(input); },
    async settle() { for (let index = 0; index < 10; index++) await Promise.resolve(); },
    flush() { while (callbacks.length) callbacks.shift()?.(); },
    tick() { for (const callback of timers.values()) callback(); },
    emit(event: string, ...args: unknown[]) { for (const callback of listeners.get(event) ?? []) callback(...args); },
    dispose() { for (const effect of effects) effect.cleanup?.(); },
    activity() { return { listeners: [...listeners.values()].reduce((count, set) => count + set.size, 0), timers: timers.size, statsReads }; },
  };
}

test("manifest delivery is asynchronous and precedes connected samples", async () => {
  const f = fixture();
  const delivered: string[] = [];
  f.observer.onManifest = () => { delivered.push("manifest"); };
  f.observer.onSample = (sample) => { delivered.push(sample.trigger); };
  f.render(); await f.settle();
  assert.deepEqual(delivered, []);
  f.flush();
  assert.deepEqual(delivered, ["manifest", "connected"]);
  f.dispose();
});

test("queued samples stay with their original session when a remint reuses the evidence ID", async () => {
  const f = fixture(); f.render(); await f.settle(); f.flush();
  f.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Poor, f.tracks.agent);
  const next: AvatarNetworkEvidenceSample[] = [];
  f.render({ observer: { ...f.observer, context: { ...f.observer.context, sessionId: "rts_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, onSample: (sample) => { next.push(sample); } } });
  f.flush();
  assert.equal(next.length, 0);
  assert.equal(f.samples.at(-1)?.trigger, "quality");
  await f.settle(); f.flush();
  assert.equal(next[0]?.sampleSeq, 1);
  f.dispose();
});

test("missing bound video never borrows another participant's sole inbound report", async () => {
  const f = fixture(); f.tracks.videoTrack = undefined;
  f.render(); await f.settle(); f.flush(); f.tick(); await f.settle(); f.flush();
  assert.equal(f.samples.at(-1)?.stats.video, undefined);
  assert.equal(f.samples.at(-1)?.statsStatus, "unavailable");
  f.dispose();
});

test("late stats cannot cross replacement, reconnect, or unmount boundaries", async () => {
  for (const boundary of ["replace", "reconnect", "unmount"]) {
    const f = fixture(); const pending = deferred<RTCStatsReport>();
    f.room.engine.pcManager.subscriber.getStats = () => pending.promise;
    f.render(); await f.settle(); f.flush(); f.tick();
    if (boundary === "replace" && f.tracks.videoTrack) f.tracks.videoTrack.publication.track.mediaStreamTrack.id = "replacement";
    if (boundary === "reconnect") f.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);
    if (boundary === "unmount") f.dispose();
    pending.resolve(new Map()); await f.settle(); f.flush();
    assert.equal(f.samples.some((sample) => sample.trigger === "interval"), false, boundary);
    f.dispose();
    assert.deepEqual(f.activity(), { listeners: 0, timers: 0, statsReads: 0 });
  }
});

test("subscription is not first-frame proof and observed first frame is emitted once", async () => {
  const f = fixture(); f.render(); await f.settle(); f.flush();
  f.emit(RoomEvent.TrackSubscribed, {}, f.tracks.videoTrack?.publication); f.flush();
  assert.equal(f.samples.some((sample) => sample.trigger === "first_video_frame"), false);
  f.render({ observer: f.observer, presentation: { liveFrameSeen: true } }); f.flush();
  f.render({ observer: f.observer, presentation: { liveFrameSeen: false } });
  f.render({ observer: f.observer, presentation: { liveFrameSeen: true } }); f.flush();
  assert.equal(f.samples.filter((sample) => sample.trigger === "first_video_frame").length, 1);
  f.dispose();
});

test("non-finite intervals cannot create a tight polling loop", () => {
  for (const intervalMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const f = fixture(); f.render({ observer: { ...f.observer, intervalMs } });
    assert.equal(f.intervals[0], 5_000);
    f.dispose();
  }
});

test("disabled observation installs no work and throwing sinks cannot break cleanup", async () => {
  const disabled = fixture(); disabled.render({});
  assert.deepEqual(disabled.activity(), { listeners: 0, timers: 0, statsReads: 0 });
  const f = fixture();
  f.observer.onManifest = f.observer.onSample = () => { throw new Error("sink unavailable"); };
  f.render(); await f.settle(); assert.doesNotThrow(() => f.flush());
  f.dispose(); assert.equal(f.activity().listeners, 0); assert.equal(f.activity().timers, 0);
});

test("rejected asynchronous sinks are caught for manifests and samples", async () => {
  const f = fixture();
  let calls = 0;
  f.observer.onManifest = f.observer.onSample = async () => { calls += 1; throw new Error("async sink unavailable"); };
  f.render(); await f.settle(); f.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  f.dispose();
});
