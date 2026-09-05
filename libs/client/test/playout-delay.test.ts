import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  applyAvatarPlayoutDelay,
  applyPlayoutDelay,
  DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS,
} from "../src/browser/playout-delay.ts";

/**
 * The flat 0.5s cushion is load-bearing (measured at ~5% loss it took the stream from
 * ~11fps with multi-second freezes to a steady 25fps). These pin the number, the
 * both-tracks-equal invariant that keeps lips on the voice, and — the reason the file
 * moved — that a vanilla page can reach the helper without importing React.
 */

function fakeTrack() {
  const calls: number[] = [];
  return { calls, setPlayoutDelay: (s: number) => void calls.push(s) };
}

test("the default cushion is 0.5s — the measured freeze-free depth, not a round number", () => {
  assert.equal(DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS, 0.5);
});

test("applyPlayoutDelay sets the hint on a subscribed track and reports that it did", () => {
  const t = fakeTrack();
  assert.equal(applyPlayoutDelay(t), true);
  assert.deepEqual(t.calls, [0.5]);
  assert.equal(applyPlayoutDelay(t, 0.2), true);
  assert.deepEqual(t.calls, [0.5, 0.2]);
});

test("a negative delay is floored at 0 — it can never throw into the call", () => {
  const t = fakeTrack();
  assert.equal(applyPlayoutDelay(t, -3), true);
  assert.deepEqual(t.calls, [0]);
});

test("objects that cannot take the hint are skipped, never thrown on, and reported as such", () => {
  for (const notATrack of [undefined, null, {}, { setPlayoutDelay: 1 }, "track", 42, [] as unknown[]]) {
    assert.equal(applyPlayoutDelay(notATrack), false, String(notATrack));
  }
});

test("applyAvatarPlayoutDelay keeps both tracks at the SAME depth so a/v stays lip-locked", () => {
  const video = fakeTrack();
  const audio = fakeTrack();
  applyAvatarPlayoutDelay(video, audio);
  assert.deepEqual(video.calls, [0.5]);
  assert.deepEqual(audio.calls, [0.5]);
  applyAvatarPlayoutDelay(video, audio, -1);
  assert.deepEqual(video.calls, [0.5, 0]);
  assert.deepEqual(audio.calls, [0.5, 0]);
  // a placeholder on one side does not stop the other side being set
  const only = fakeTrack();
  applyAvatarPlayoutDelay(undefined, only, 0.3);
  assert.deepEqual(only.calls, [0.3]);
});

test("one implementation, two doors: the browser entry exports it and the React module imports it rather than owning a copy", () => {
  // The React module cannot be imported under plain node (it pulls React and livekit-client),
  // so the invariant is read off the source the same way the README-surface test does.
  const here = new URL(".", import.meta.url);
  const browserIndex = readFileSync(new URL("../src/browser/index.ts", here), "utf8");
  const reactLiveKit = readFileSync(new URL("../src/react/livekit.ts", here), "utf8");
  assert.match(browserIndex, /applyPlayoutDelay,[\s\S]*from "\.\/playout-delay"/, "the vanilla entry exports the helper");
  assert.match(reactLiveKit, /import \{ applyAvatarPlayoutDelay, DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS \} from "\.\.\/browser\/playout-delay"/, "React imports the shared implementation");
  assert.doesNotMatch(reactLiveKit, /export function applyAvatarPlayoutDelay/, "React no longer owns a second copy");
  assert.doesNotMatch(reactLiveKit, /export const DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS/, "one source for the number");
  assert.match(reactLiveKit, /export \{ applyAvatarPlayoutDelay, DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS \};/, "and re-exports both so /react keeps its names");
});
