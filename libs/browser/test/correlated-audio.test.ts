import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { RoomEvent, Room } from "livekit-client";
import { Encryption_Type } from "@livekit/protocol";
import { attachCorrelatedAudio, type CorrelatedAudioObserver, type CorrelatedAudioPosition } from "../src/correlated-audio.ts";
import { CORRELATED_AUDIO_CONTRACT, correlatedAudioReceiptSchema, type CorrelatedAudioHeader } from "../../http-client/src/generated/correlated-audio.ts";

const header = { version: 1, session_id: "session", generation_id: "generation", utterance_id: "utterance", stream_id: "stream", epoch: 1, sample_rate: 24000, channels: 1, encoding: "pcm_s16le" } as const;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function fixture(observer: Partial<CorrelatedAudioObserver> = {}) {
  let tick = () => {};
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const intervalPeriods: number[] = [];
  const scheduled = deferred();
  let readCount = 0;
  const nodes: { buffer: { data: Float32Array } | null; start: (time: number) => void; stop: () => void; disconnect: () => void; connect: () => void; when: number; stopped: boolean; onended: (() => void) | null }[] = [];
  class Context {
    static current: Context;
    currentTime = 0;
    state = "suspended";
    destination = {};
    onstatechange: (() => void) | null = null;
    constructor() { Context.current = this; }
    async resume() { this.state = "running"; this.onstatechange?.(); }
    async close() { this.state = "closed"; }
    createBuffer(_channels: number, length: number, _rate: number) { return { data: new Float32Array(length), getChannelData() { return this.data; } }; }
    createBufferSource() {
      const node: (typeof nodes)[number] = { buffer: null, when: -1, stopped: false, onended: null, connect() {}, disconnect() {}, start(time: number) { this.when = time; scheduled.resolve(); }, stop() { this.stopped = true; } };
      nodes.push(node); return node;
    }
  }
  const savedContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const savedRequestFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const savedCancelFrame = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => { frames.delete(id); } });
  const interval = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: Context });
  // Only the player timer is replaced; no runtime casts or private LiveKit fields.
  Object.defineProperty(globalThis, "setInterval", { configurable: true, value: (fn: () => void, milliseconds: number) => { tick = fn; intervalPeriods.push(milliseconds); return 1; } });
  Object.defineProperty(globalThis, "clearInterval", { configurable: true, value: () => { tick = () => {}; } });
  let handler: Parameters<Parameters<typeof attachCorrelatedAudio>[0]["registerByteStreamHandler"]>[1] | undefined;
  let cancel: Parameters<Room["localParticipant"]["registerRpcMethod"]>[1] | undefined;
  const receipts: ReturnType<typeof correlatedAudioReceiptSchema.parse>[] = [];
  const events = new Map<string, Set<(...args: never[]) => void>>();
  const room = new Room();
  Object.assign(room, {
    state: "connected",
    registerByteStreamHandler(_topic: string, fn: NonNullable<typeof handler>) { handler = fn; },
    unregisterByteStreamHandler() { handler = undefined; },
    localParticipant: {
      registerRpcMethod(_method: string, fn: NonNullable<typeof cancel>) { cancel = fn; },
      unregisterRpcMethod() { cancel = undefined; },
      async performRpc(data: Parameters<Room["localParticipant"]["performRpc"]>[0]) {
        assert.equal(data.destinationIdentity, "agent");
        assert.equal(data.method, CORRELATED_AUDIO_CONTRACT.receiptMethod);
        receipts.push(correlatedAudioReceiptSchema.parse(JSON.parse(data.payload))); return "";
      },
    },
    on(event: string, fn: (...args: never[]) => void) { if (!events.has(event)) events.set(event, new Set()); events.get(event)?.add(fn); return this; },
    off(event: string, fn: (...args: never[]) => void) { events.get(event)?.delete(fn); return this; },
  });
  const positions: CorrelatedAudioPosition[] = [];
  const invalidated: string[] = [];
  const blocked: boolean[] = [];
  const options = { sessionId: "session", agentIdentity: "agent", onPosition: (p: CorrelatedAudioPosition) => positions.push(p), onInvalidated: (reason: string) => invalidated.push(reason), onPlaybackBlocked: (unlock: unknown) => blocked.push(unlock !== null), ...observer };
  const player = attachCorrelatedAudio(room, options);
  function stream(chunks: Uint8Array[], value: unknown = header, identity = "agent", open = false) {
    let end = () => {};
    const ended = new Promise<void>(resolve => { end = resolve; });
    const streamId = typeof value === "object" && value !== null && "stream_id" in value && typeof value.stream_id === "string" ? value.stream_id : header.stream_id;
    const reader = {
      info: { id: streamId, attributes: { "rta.audio": JSON.stringify(value) }, mimeType: "audio/pcm", name: "audio", topic: CORRELATED_AUDIO_CONTRACT.topic, timestamp: 0, encryptionType: Encryption_Type.NONE },
      withAbortSignal(signal: AbortSignal) {
        return { async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) { if (signal.aborted) return; readCount++; yield chunk; }
          if (open && !signal.aborted) await Promise.race([ended, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
        } };
      },
    };
    assert.ok(handler);
    handler(reader, { identity });
    return end;
  }
  return {
    room, options, player, positions, receipts, invalidated, blocked, nodes, stream, scheduled: scheduled.promise,
    get readCount() { return readCount; },
    async render(seconds: number) { Context.current.currentTime += seconds; const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(Context.current.currentTime * 1000); await nextTurn(); },
    async advance(seconds: number) { if (Context.current.state === "running") Context.current.currentTime += seconds; tick(); await flush(); },
    pause() { Context.current.state = "suspended"; Context.current.onstatechange?.(); },
    async cancel(epoch: number, callerIdentity = "agent") { return cancel?.({ requestId: "req", callerIdentity, payload: JSON.stringify({ version: 1, session_id: "session", epoch }), responseTimeout: 1000 }); },
    emit(event: string) { for (const fn of events.get(event) ?? []) fn(); },
    async cleanup() { await player.dispose(); if (savedContext) Object.defineProperty(globalThis, "AudioContext", savedContext); else Reflect.deleteProperty(globalThis, "AudioContext"); if (savedRequestFrame) Object.defineProperty(globalThis, "requestAnimationFrame", savedRequestFrame); else Reflect.deleteProperty(globalThis, "requestAnimationFrame"); if (savedCancelFrame) Object.defineProperty(globalThis, "cancelAnimationFrame", savedCancelFrame); else Reflect.deleteProperty(globalThis, "cancelAnimationFrame"); globalThis.setInterval = interval; globalThis.clearInterval = clear; },
  };
}

test("preparation gates PCM reads and cancellation cannot revive a late result", async () => {
  const prepared = deferred();
  const entered = deferred<AbortSignal>();
  const f = fixture({ prepare: async (_header: CorrelatedAudioHeader, signal: AbortSignal) => { entered.resolve(signal); await prepared.promise; } });
  try {
    await f.player.startAudio();
    f.stream([new Uint8Array(4800)]);
    await nextTurn();
    assert.equal(f.readCount, 0);
    assert.equal(f.nodes.length, 0);
    const signal = await entered.promise;
    await f.cancel(2);
    assert.equal(signal.aborted, true);
    prepared.resolve();
    await nextTurn();
    assert.equal(f.nodes.length, 0);
    assert.ok(!f.receipts.some(receipt => receipt.samples > 0));
  } finally { prepared.resolve(); await f.cleanup(); }
});

test("animation frames update positions without flooding progress RPC", async () => {
  const f = fixture();
  try {
    await f.player.startAudio();
    f.stream([new Uint8Array(24000)]);
    await f.scheduled;
    await f.render(0.016);
    const first = f.positions.at(-1)?.samples;
    await f.render(0.016);
    assert.ok(first !== undefined && (f.positions.at(-1)?.samples ?? 0) > first);
    assert.equal(f.receipts.filter(receipt => receipt.status === "progress").length, 0);
    await f.advance(0.1);
    assert.equal(f.receipts.filter(receipt => receipt.status === "progress").length, 1);
  } finally { await f.cleanup(); }
});

test("PCM starts only after running, split samples decode once, and EOF finishes at the source clock", async () => {
  const f = fixture();
  try {
    f.stream([new Uint8Array([0]), new Uint8Array([64, 0, 128])]); await flush();
    assert.equal(f.receipts.length, 0);
    await f.player.startAudio(); await f.advance(0.001);
    assert.deepEqual(f.nodes[0].buffer?.data, new Float32Array([0.5, -1]));
    assert.deepEqual(f.receipts.map(r => r.status), ["started", "finished"]);
    assert.equal(f.positions.at(-1)?.samples, 2);
    assert.equal(f.positions.at(-1)?.state, "finished");
  } finally { await f.cleanup(); }
});

test("hostile sender, wrong session and invalid format never play", async () => {
  const f = fixture();
  try {
    f.stream([new Uint8Array(2)], header, "stranger");
    f.stream([new Uint8Array(2)], { ...header, session_id: "other" });
    f.stream([new Uint8Array(2)], { ...header, sample_rate: 48000 });
    await flush(); await f.player.startAudio(); await f.advance(1);
    assert.equal(f.nodes.length, 0); assert.equal(f.receipts.length, 0);
  } finally { await f.cleanup(); }
});

test("pause and underflow never advance consumed samples or release sender credit", async () => {
  const f = fixture();
  try {
    const eof = f.stream([new Uint8Array(24000)], header, "agent", true);
    await flush(); await f.player.startAudio(); await f.advance(0.25);
    const halfway = f.positions.at(-1)?.samples;
    assert.equal(halfway, 6000);
    f.pause(); await f.advance(10); assert.equal(f.positions.at(-1)?.samples, halfway);
    await f.player.startAudio(); await f.advance(0.25); assert.equal(f.positions.at(-1)?.samples, 12000);
    await f.advance(10); assert.equal(f.positions.at(-1)?.samples, 12000);
    assert.notEqual(f.receipts.at(-1)?.status, "finished");
    eof(); await flush(); await f.advance(0);
    assert.equal(f.receipts.at(-1)?.status, "finished");
  } finally { await f.cleanup(); }
});

test("cancel stops sources and reader, retires old epoch, rejects hostile RPC and permits new epoch", async () => {
  const f = fixture();
  try {
    f.stream([new Uint8Array(24000)], header, "agent", true); await flush();
    await f.player.startAudio(); await f.advance(0.1);
    await assert.rejects(f.cancel(2, "stranger"));
    await f.cancel(2); await flush();
    assert.ok(f.nodes.every(node => node.stopped)); assert.deepEqual(f.invalidated, ["cancelled"]);
    const count = f.nodes.length;
    f.stream([new Uint8Array(2)]); await flush(); assert.equal(f.nodes.length, count);
    f.stream([new Uint8Array(2)], { ...header, epoch: 2, stream_id: "next" }); await flush(); await f.advance(1);
    assert.equal(f.receipts.at(-1)?.epoch, 2);
  } finally { await f.cleanup(); }
});

test("dispose and reconnect stop everything; duplicate attachment and stale streams cannot double-play", async () => {
  const f = fixture();
  try {
    assert.throws(() => attachCorrelatedAudio(f.room, f.options));
    f.stream([new Uint8Array(24000)], header, "agent", true); await flush();
    f.emit(RoomEvent.Reconnecting); await flush();
    f.stream([new Uint8Array(2)]); await flush();
    assert.ok(f.nodes.every(node => node.stopped));
    assert.deepEqual(f.invalidated, ["connection_lost"]);
    await f.player.dispose(); await f.player.dispose();
  } finally { await f.cleanup(); }
});

test("next sentence after production EOF queues continuously before the first finishes playing", async () => {
  const f = fixture();
  try {
    f.stream([new Uint8Array(24000)]); await flush();
    f.stream([new Uint8Array(24000)], { ...header, stream_id: "second", utterance_id: "second" }); await flush();
    assert.deepEqual(f.nodes.map(node => node.when), [0, 0.5]);
    await f.player.startAudio(); await f.advance(0.25);
    assert.ok(f.positions.every(position => position.stream_id === "stream"));
    await f.advance(0.5);
    assert.equal(f.positions.at(-1)?.stream_id, "second");
    assert.equal(f.positions.at(-1)?.samples, 6000);
    await f.advance(0.25);
    assert.deepEqual(f.receipts.filter(r => r.status === "finished").map(r => r.stream_id), ["stream", "second"]);
  } finally { await f.cleanup(); }
});

test("two-second queue waits for consumed credit and cancellation releases its waiter", async () => {
  const f = fixture();
  try {
    f.stream([new Uint8Array(48000), new Uint8Array(48000), new Uint8Array(48000)], header, "agent", true);
    await flush();
    assert.equal(f.nodes.length, 2);
    assert.equal(f.receipts.length, 0);
    await f.player.startAudio(); await f.advance(0.5);
    assert.equal(f.nodes.length, 2);
    await f.advance(0.5); assert.equal(f.nodes.length, 3);
    assert.equal(f.receipts.at(-1)?.samples, 24000);
    await f.cancel(2); await flush();
    assert.ok(f.nodes.every(node => node.stopped || node.when === 0));
  } finally { await f.cleanup(); }
});

test("odd EOF, oversized chunks, and empty EOF never claim finished playback", async () => {
  for (const chunks of [[new Uint8Array(1)], [new Uint8Array(CORRELATED_AUDIO_CONTRACT.maxChunkBytes + 1)], []]) {
    const f = fixture();
    try { f.stream(chunks); await flush(); await f.player.startAudio(); await f.advance(1); assert.ok(!f.receipts.some(r => r.status === "finished")); }
    finally { await f.cleanup(); }
  }
});
