import { RoomEvent, type ByteStreamReader, type Room } from "livekit-client";
import {
  CORRELATED_AUDIO_CONTRACT,
  correlatedAudioHeaderSchema,
  correlatedAudioCancelSchema,
  type CorrelatedAudioHeader,
  type CorrelatedAudioReceipt,
} from "../../http-client/src/generated/correlated-audio.ts";
import type { AttachRemoteAudioOptions } from "./remote-audio.ts";

/** Source PCM consumed by the AudioContext clock, not proof of physical audibility. */
export type CorrelatedAudioPosition = Readonly<Pick<CorrelatedAudioHeader,
  "session_id" | "generation_id" | "utterance_id" | "stream_id" | "epoch"
> & { samples: number; sampleRate: CorrelatedAudioHeader["sample_rate"]; state: "playing" | "finished" }>;
export type CorrelatedAudioInvalidation = "cancelled" | "connection_lost" | "invalid_stream" | "disposed";
export type CorrelatedAudioObserver = Readonly<{
  prepare?: (header: CorrelatedAudioHeader, signal: AbortSignal) => Promise<void>;
  onPosition: (position: CorrelatedAudioPosition) => void;
  onInvalidated: (reason: CorrelatedAudioInvalidation) => void;
  onPlaybackBlocked?: AttachRemoteAudioOptions["onPlaybackBlocked"];
}>;
export type AttachCorrelatedAudioOptions = CorrelatedAudioObserver & Readonly<{
  sessionId: CorrelatedAudioHeader["session_id"];
  agentIdentity: string;
}>;
export type CorrelatedAudioAttachment = Readonly<{ startAudio(): Promise<void>; dispose(): Promise<void> }>;

type AudioReader = Pick<ByteStreamReader, "info"> & {
  withAbortSignal(signal: Parameters<ByteStreamReader["withAbortSignal"]>[0]): AsyncIterable<Uint8Array>;
};
type AudioRoom = Pick<Room, "state" | "on" | "off" | "unregisterByteStreamHandler"> & {
  localParticipant: Pick<Room["localParticipant"], "registerRpcMethod" | "unregisterRpcMethod" | "performRpc">;
  registerByteStreamHandler(topic: string, handler: (reader: AudioReader, participant: Parameters<Parameters<Room["registerByteStreamHandler"]>[1]>[1]) => void): void;
};
const attachments = new WeakSet<AudioRoom>();
const bindings = new WeakMap<AudioRoom, { sessionId: string; epoch: number; unavailable: boolean; seen: Set<string> }>();
type Segment = { node: AudioBufferSourceNode; start: number; offset: number; length: number };
type Source = {
  header: CorrelatedAudioHeader;
  abort: AbortController;
  segments: Segment[];
  received: number;
  consumed: number;
  started: boolean;
  eof: boolean;
  lastReported: number;
  lastPosition: number;
  rpcBusy: boolean;
  pendingReceipt?: CorrelatedAudioReceipt;
};

function notify(callback: () => void): void {
  try { void Promise.resolve(callback()).catch(() => {}); } catch { /* Observers cannot stop playback or cleanup. */ }
}

/** Opt-in only. Never combine with RoomAudioRenderer or attachRemoteAudio on this call. */
export function attachCorrelatedAudio(room: AudioRoom, options: AttachCorrelatedAudioOptions): CorrelatedAudioAttachment {
  if (attachments.has(room)) throw new Error("Correlated audio is already attached to this room");
  if (!options.sessionId || !options.agentIdentity) throw new Error("Correlated audio requires the held session and bound agent");
  attachments.add(room);
  let context: AudioContext | undefined;
  let disposed = false;
  const previous = bindings.get(room);
  const binding = previous?.sessionId === options.sessionId ? previous : { sessionId: options.sessionId, epoch: 1, unavailable: false, seen: new Set<string>() };
  bindings.set(room, binding);
  const sources: Source[] = [];
  const active = (source: Source): boolean => sources.includes(source);
  const buffered = (): number => sources.reduce((sum, source) => sum + source.received - source.consumed, 0);
  let nextStart = 0;
  let blocked: boolean | undefined;
  let closing: Promise<void> | undefined;
  const seen = binding.seen;
  const waiters = new Set<() => void>();
  const wake = (): void => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const identity = (header: CorrelatedAudioHeader) => ({
    session_id: header.session_id, generation_id: header.generation_id,
    utterance_id: header.utterance_id, stream_id: header.stream_id, epoch: header.epoch,
  });
  const position = (current: Source, state: CorrelatedAudioPosition["state"]): void => {
    notify(() => options.onPosition({ ...identity(current.header), samples: current.consumed, sampleRate: current.header.sample_rate, state }));
  };
  const receipt = (current: Source, status: CorrelatedAudioReceipt["status"]): void => {
    const payload: CorrelatedAudioReceipt = { ...identity(current.header), status, samples: current.consumed };
    // One in-flight RPC and one coalesced absolute checkpoint preserve start/progress/finish
    // order without accumulating receipts when the network is slower than the audio clock.
    if (current.rpcBusy) { current.pendingReceipt = payload; return; }
    const send = async (next: CorrelatedAudioReceipt): Promise<void> => {
      current.rpcBusy = true;
      try {
        await room.localParticipant.performRpc({
          destinationIdentity: options.agentIdentity, method: CORRELATED_AUDIO_CONTRACT.receiptMethod,
          payload: JSON.stringify(next), responseTimeout: 2000,
        });
      } catch { if (!disposed && next.epoch === binding.epoch) invalidate("connection_lost"); }
      finally {
        current.rpcBusy = false;
        const pending = current.pendingReceipt;
        current.pendingReceipt = undefined;
        if (pending && !disposed && pending.epoch === binding.epoch && !binding.unavailable) void send(pending);
      }
    };
    void send(payload);
  };
  const clear = (): void => {
    for (const current of sources.splice(0)) {
      current.abort.abort();
      for (const segment of current.segments) { segment.node.onended = null; segment.node.stop(); segment.node.disconnect(); }
      current.segments.length = 0;
    }
    nextStart = context?.currentTime ?? 0;
    wake();
  };
  const invalidate = (reason: CorrelatedAudioInvalidation): void => {
    if (disposed) return;
    if (reason === "connection_lost") {
      if (binding.unavailable) return;
      // A resumed room cannot establish whether an unseen pre-reconnect epoch is stale.
      // Fail closed for this attachment; the application must obtain a fresh grant.
      binding.unavailable = true;
    }
    if (reason === "invalid_stream" || reason === "disposed") for (const current of sources) receipt(current, "cancelled");
    clear();
    notify(() => options.onInvalidated(reason));
  };
  const tick = (reportCredit = true): void => {
    if (!context || context.state !== "running" || disposed || binding.unavailable) return;
    for (const current of [...sources]) {
      if (!active(current)) continue;
      let consumed = current.consumed;
      for (const segment of current.segments) {
        if (context.currentTime < segment.start) break;
        const samples = Math.min(segment.length, Math.max(0, Math.floor((context.currentTime - segment.start) * current.header.sample_rate + 1e-6)));
        consumed = Math.max(consumed, segment.offset + samples);
        if (!current.started && samples > 0) {
          current.started = true;
          receipt(current, "started");
          position(current, "playing");
          current.lastPosition = current.consumed;
        }
      }
      current.consumed = consumed;
      while (current.segments.length && current.segments[0].offset + current.segments[0].length <= consumed) {
        const segment = current.segments.shift();
        if (segment) { segment.node.onended = null; segment.node.disconnect(); }
      }
      if (current.started && current.eof && consumed === current.received && consumed > 0) {
        position(current, "finished");
        if (!active(current)) continue;
        receipt(current, "finished");
        sources.splice(sources.indexOf(current), 1);
        wake();
      } else {
        if (current.started && consumed > current.lastPosition) {
          current.lastPosition = consumed;
          position(current, "playing");
        }
        if (!active(current)) continue;
        if (reportCredit && consumed > current.lastReported) {
          current.lastReported = consumed;
          receipt(current, "progress");
        }
        wake();
      }
    }
  };
  const playbackState = (): void => {
    const next = context?.state !== "running";
    if (next !== blocked) {
      blocked = next;
      notify(() => options.onPlaybackBlocked?.(next ? startAudio : null));
    }
    tick();
  };
  const getContext = (): AudioContext => {
    if (!context) {
      context = new AudioContext({ sampleRate: correlatedAudioHeaderSchema.shape.sample_rate.value });
      context.onstatechange = playbackState;
      playbackState();
    }
    return context;
  };
  async function startAudio(): Promise<void> {
    if (disposed || binding.unavailable) throw new Error("Correlated audio binding is no longer available");
    const ctx = getContext();
    await ctx.resume();
    playbackState();
    if (ctx.state !== "running") throw new Error("Correlated audio playback is blocked");
  }
  async function receive(reader: AudioReader, participant: { identity: string }): Promise<void> {
    if (disposed || binding.unavailable || room.state !== "connected" || participant.identity !== options.agentIdentity) return;
    let value: unknown;
    try { value = JSON.parse(reader.info.attributes?.["rta.audio"] ?? ""); } catch { return; }
    const parsed = correlatedAudioHeaderSchema.safeParse(value);
    if (!parsed.success || parsed.data.session_id !== options.sessionId || parsed.data.epoch < binding.epoch) return;
    const header = parsed.data;
    if (header.stream_id !== reader.info.id) return;
    if (header.epoch > binding.epoch) { binding.epoch = header.epoch; invalidate("cancelled"); }
    const key = `${header.epoch}/${header.stream_id}`;
    if (seen.has(key)) return;
    // A producer may open the next sentence after EOF while the previous one is still
    // playing. The common schedule and global sample budget keep these sequential.
    if (sources.length >= 128 || seen.size >= 10000) { invalidate("invalid_stream"); return; }
    seen.add(key);
    const previousSource = sources.at(-1);
    const current: Source = { header, abort: new AbortController(), segments: [], received: 0, consumed: 0, started: false, eof: false, lastReported: 0, lastPosition: -1, rpcBusy: false };
    sources.push(current);
    let carry: number | undefined;
    try {
      if (options.prepare) await options.prepare(header, current.abort.signal);
      if (!active(current) || current.abort.signal.aborted) return;
      const ctx = getContext();
      while (active(current) && ((previousSource && active(previousSource) && !previousSource.eof) || buffered() > CORRELATED_AUDIO_CONTRACT.maxBufferedSamples - CORRELATED_AUDIO_CONTRACT.maxChunkBytes / 2)) {
        await new Promise<void>(resolve => waiters.add(resolve));
      }
      if (!active(current)) return;
      for await (const chunk of reader.withAbortSignal(current.abort.signal)) {
        if (!active(current)) break;
        if (chunk.byteLength > CORRELATED_AUDIO_CONTRACT.maxChunkBytes) throw new Error("PCM chunk exceeds contract");
        const count = Math.floor((chunk.byteLength + (carry === undefined ? 0 : 1)) / 2);
        if (current.received + count > CORRELATED_AUDIO_CONTRACT.maxSamples) throw new Error("PCM stream exceeds contract");
        // Sender credit is driven ONLY by consumed samples, not reads or scheduled bytes.
        // Keep at most two seconds scheduled and one bounded incoming chunk while waiting.
        while (active(current) && buffered() + count > CORRELATED_AUDIO_CONTRACT.maxBufferedSamples) {
          await new Promise<void>(resolve => waiters.add(resolve));
        }
        if (!active(current)) break;
        if (!count) { if (chunk.length) carry = chunk[0]; continue; }
        const buffer = ctx.createBuffer(header.channels, count, header.sample_rate);
        const data = buffer.getChannelData(0);
        let cursor = 0;
        for (let i = 0; i < count; i++) {
          const low = carry ?? chunk[cursor++];
          carry = undefined;
          const raw = low | (chunk[cursor++] << 8);
          data[i] = (raw >= 0x8000 ? raw - 0x10000 : raw) / 0x8000;
        }
        if (cursor < chunk.length) carry = chunk[cursor];
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        const start = Math.max(ctx.currentTime, nextStart);
        current.segments.push({ node, start, offset: current.received, length: count });
        current.received += count;
        nextStart = start + count / header.sample_rate;
        node.onended = () => tick();
        node.start(start);
        // Reserve room for the largest next chunk before asking LiveKit for it. A paused
        // context therefore holds at most maxBufferedSamples, including the next read.
        while (active(current) && buffered() > CORRELATED_AUDIO_CONTRACT.maxBufferedSamples - CORRELATED_AUDIO_CONTRACT.maxChunkBytes / 2) {
          await new Promise<void>(resolve => waiters.add(resolve));
        }
      }
      if (!active(current)) return;
      if (carry !== undefined || current.received === 0) throw new Error("Incomplete PCM stream");
      current.eof = true;
      wake();
      tick(false);
    } catch {
      if (active(current)) invalidate("invalid_stream");
    }
  }
  const cancel: Parameters<Room["localParticipant"]["registerRpcMethod"]>[1] = async data => {
    if (disposed || binding.unavailable || room.state !== "connected" || data.callerIdentity !== options.agentIdentity) throw new Error("Unbound audio cancellation");
    const value: unknown = JSON.parse(data.payload);
    const frame = correlatedAudioCancelSchema.parse(value);
    if (frame.session_id !== options.sessionId) throw new Error("Wrong audio session");
    if (frame.epoch <= binding.epoch) return "";
    binding.epoch = frame.epoch;
    invalidate("cancelled");
    return "";
  };
  const lost = (): void => invalidate("connection_lost");
  const changed = (): void => { if (["disconnected", "reconnecting", "signalReconnecting"].includes(room.state)) lost(); };
  const participantLeft = (participant: { identity: string }): void => { if (participant.identity === options.agentIdentity) lost(); };
  let registered = false;
  try {
    room.registerByteStreamHandler(CORRELATED_AUDIO_CONTRACT.topic, (reader, participant) => { void receive(reader, participant); });
    registered = true;
    room.localParticipant.registerRpcMethod(CORRELATED_AUDIO_CONTRACT.cancelMethod, cancel);
  } catch (error) {
    if (registered) room.unregisterByteStreamHandler(CORRELATED_AUDIO_CONTRACT.topic);
    attachments.delete(room);
    throw error;
  }
  room.on(RoomEvent.Reconnecting, lost);
  room.on(RoomEvent.SignalReconnecting, lost);
  room.on(RoomEvent.Disconnected, lost);
  room.on(RoomEvent.ConnectionStateChanged, changed);
  room.on(RoomEvent.ParticipantDisconnected, participantLeft);
  const timer = setInterval(() => tick(), 100);
  let frame = 0;
  const render = (): void => {
    if (disposed) return;
    tick(false);
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);
  return {
    startAudio,
    dispose() {
      if (closing) return closing;
      invalidate("disposed");
      disposed = true;
      clearInterval(timer);
      cancelAnimationFrame(frame);
      room.unregisterByteStreamHandler(CORRELATED_AUDIO_CONTRACT.topic);
      room.localParticipant.unregisterRpcMethod(CORRELATED_AUDIO_CONTRACT.cancelMethod);
      room.off(RoomEvent.Reconnecting, lost);
      room.off(RoomEvent.SignalReconnecting, lost);
      room.off(RoomEvent.Disconnected, lost);
      room.off(RoomEvent.ConnectionStateChanged, changed);
      room.off(RoomEvent.ParticipantDisconnected, participantLeft);
      attachments.delete(room);
      if (context) context.onstatechange = null;
      closing = context?.close().catch(() => {}) ?? Promise.resolve();
      return closing;
    },
  };
}
