import { test } from "node:test";
import assert from "node:assert/strict";

import { prepareAvatarRoom } from "../src/prepare-room.ts";
import { attachRemoteAudio } from "../src/remote-audio.ts";

/**
 * The point: a page that builds its own Room gets the freeze-free receiver buffer from ONE
 * call — or from none, if it already follows the documented attachRemoteAudio pattern.
 * Structural fakes only; no livekit-client, no DOM.
 */

function fakeTrack(kind = "video") {
  const delays: number[] = [];
  return {
    kind,
    delays,
    setPlayoutDelay: (s: number) => void delays.push(s),
    attach: () => ({ remove() {}, autoplay: false }) as unknown as HTMLMediaElement,
    detach: () => [],
  };
}

function fakeRoom(existing: ReturnType<typeof fakeTrack>[] = []) {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  return {
    listeners,
    canPlaybackAudio: true,
    startAudio: () => Promise.resolve(),
    remoteParticipants: new Map([
      ["p1", { trackPublications: new Map(existing.map((t, i) => [`pub${i}`, { track: t }])) }],
    ]),
    on(event: string, listener: (...args: never[]) => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);
      return this;
    },
    off(event: string, listener: (...args: never[]) => void) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
    },
  };
}

test("every track subscribed after the call gets the 0.5s cushion, audio and video alike", () => {
  const room = fakeRoom();
  const handle = prepareAvatarRoom(room);
  assert.equal(handle.playoutDelaySeconds, 0.5);
  const video = fakeTrack("video");
  const audio = fakeTrack("audio");
  room.emit("trackSubscribed", video);
  room.emit("trackSubscribed", audio);
  assert.deepEqual(video.delays, [0.5]);
  assert.deepEqual(audio.delays, [0.5], "the pair stays lip-locked: same depth on both");
});

test("tracks already subscribed before the call are covered immediately", () => {
  const early = fakeTrack();
  const room = fakeRoom([early]);
  prepareAvatarRoom(room, { playoutDelaySeconds: 0.3 });
  assert.deepEqual(early.delays, [0.3]);
});

test("calling it twice is safe: one listener, same handle, and a new explicit delay re-applies to what is on screen", () => {
  const early = fakeTrack();
  const room = fakeRoom([early]);
  const a = prepareAvatarRoom(room);
  const b = prepareAvatarRoom(room);
  assert.equal(a, b);
  assert.equal(room.listeners.get("trackSubscribed")?.size, 1, "no duplicate listener");
  const later = fakeTrack();
  room.emit("trackSubscribed", later);
  assert.deepEqual(later.delays, [0.5], "one application per subscription, not two");
  const c = prepareAvatarRoom(room, { playoutDelaySeconds: 0.2 });
  assert.equal(c, a);
  assert.equal(a.playoutDelaySeconds, 0.2);
  assert.deepEqual(early.delays, [0.5, 0.2], "the explicit delay re-applies to existing tracks");
  const next = fakeTrack();
  room.emit("trackSubscribed", next);
  assert.deepEqual(next.delays, [0.2], "and governs new ones");
});

test("detach stops listening and is idempotent; a fresh prepare afterwards starts clean", () => {
  const room = fakeRoom();
  const handle = prepareAvatarRoom(room);
  handle.detach();
  handle.detach();
  assert.equal(room.listeners.get("trackSubscribed")?.size ?? 0, 0);
  const t = fakeTrack();
  room.emit("trackSubscribed", t);
  assert.deepEqual(t.delays, []);
  const again = prepareAvatarRoom(room, { playoutDelaySeconds: 0.4 });
  assert.notEqual(again, handle);
  room.emit("trackSubscribed", t);
  assert.deepEqual(t.delays, [0.4]);
});

test("objects that cannot take the hint are skipped without throwing", () => {
  const room = fakeRoom();
  prepareAvatarRoom(room);
  assert.doesNotThrow(() => room.emit("trackSubscribed", {}));
  assert.doesNotThrow(() => room.emit("trackSubscribed", undefined));
  assert.doesNotThrow(() => room.emit("trackSubscribed", { setPlayoutDelay: "nope" }));
});

test("a room without remoteParticipants, or with a plain iterable of entries, is fine", () => {
  const bare = { on() { return this; }, off() { return this; } };
  assert.doesNotThrow(() => prepareAvatarRoom(bare));
  const t = fakeTrack();
  const iterableRoom = {
    on() { return this; },
    off() { return this; },
    remoteParticipants: [["p", { trackPublications: [["x", { track: t }]] }]] as Iterable<[unknown, { trackPublications: Iterable<[unknown, { track?: unknown }]> }]>,
  };
  prepareAvatarRoom(iterableRoom);
  assert.deepEqual(t.delays, [0.5]);
});

test("attachRemoteAudio applies the cushion for you — the documented pattern is covered with no extra line", () => {
  const room = fakeRoom();
  const container = { appendChild() {} } as unknown as HTMLElement;
  attachRemoteAudio(room, { container });
  const video = fakeTrack("video");
  const audio = fakeTrack("audio");
  room.emit("trackSubscribed", video);
  room.emit("trackSubscribed", audio);
  assert.deepEqual(video.delays, [0.5], "video too, though attachRemoteAudio itself only attaches audio");
  assert.deepEqual(audio.delays, [0.5]);
});

test("attachRemoteAudio honours an explicit delay and a false opt-out, and detaching the audio leaves the cushion in place", () => {
  const room = fakeRoom();
  const container = { appendChild() {} } as unknown as HTMLElement;
  const audio = attachRemoteAudio(room, { container, playoutDelaySeconds: 0.25 });
  const t = fakeTrack();
  room.emit("trackSubscribed", t);
  assert.deepEqual(t.delays, [0.25]);
  audio.detach();
  const later = fakeTrack();
  room.emit("trackSubscribed", later);
  assert.deepEqual(later.delays, [0.25], "a shallower buffer mid-call would only bring the freezes back");

  const untouched = fakeRoom();
  attachRemoteAudio(untouched, { container, playoutDelaySeconds: false });
  const u = fakeTrack();
  untouched.emit("trackSubscribed", u);
  assert.deepEqual(u.delays, [], "false means the page owns its own buffering");
});
