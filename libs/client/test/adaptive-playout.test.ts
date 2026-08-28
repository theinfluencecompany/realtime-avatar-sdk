import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AdaptivePlayoutController,
  readInboundRtp,
} from "../src/react/adaptive-playout.ts";

/**
 * The adaptive de-jitter loop trades loss margin for felt latency, so every
 * property below is a safety property first and a latency property second. The
 * flat 0.5s cushion it replaces is load-bearing (measured at ~5% loss it took the
 * stream from ~11fps with multi-second freezes to a steady 25fps) — these tests
 * exist so a refactor cannot quietly turn the descent into a shallow open.
 */

const CLEAN = { jitterSeconds: 0, lossFraction: 0 };
const LOSSY = { jitterSeconds: 0.03, lossFraction: 0.05 };

test("opens AT the ceiling — never shallow, so the first frame is never later than today's", () => {
  const c = new AdaptivePlayoutController();
  assert.equal(c.appliedSeconds, 0.5);
  // The open-small-then-ramp variant shipped, failed twice, and was removed in
  // 2262e4c7b. A controller that starts below the ceiling has re-introduced it.
  assert.ok(c.appliedSeconds >= 0.5, "the loop must open at the flat cushion, not below it");
});

test("descends to the floor on a clean path, and stops there", () => {
  const c = new AdaptivePlayoutController();
  for (let i = 0; i < 200; i++) c.update(CLEAN);
  assert.equal(c.appliedSeconds, 0.15);
  // Clamped: no amount of clean network buys a buffer shallower than the floor.
  for (let i = 0; i < 50; i++) c.update(CLEAN);
  assert.equal(c.appliedSeconds, 0.15);
});

test("grows fast and shrinks slow — a loss burst is recovered in far fewer ticks than it took to descend", () => {
  const descend = new AdaptivePlayoutController();
  let ticksDown = 0;
  while (descend.appliedSeconds > 0.16 && ticksDown < 500) {
    descend.update(CLEAN);
    ticksDown++;
  }
  const climb = new AdaptivePlayoutController();
  for (let i = 0; i < 200; i++) climb.update(CLEAN); // settle at the floor
  assert.equal(climb.appliedSeconds, 0.15);
  let ticksUp = 0;
  while (climb.appliedSeconds < 0.45 && ticksUp < 500) {
    climb.update(LOSSY);
    ticksUp++;
  }
  assert.ok(climb.appliedSeconds >= 0.45, "a 5% loss burst must climb back toward the ceiling");
  assert.ok(
    ticksUp * 3 < ticksDown,
    `grow must be much faster than shrink (up ${ticksUp} ticks vs down ${ticksDown})`,
  );
});

test("clamps to the ceiling — a catastrophic path never buys more than the incumbent cushion", () => {
  const c = new AdaptivePlayoutController();
  for (let i = 0; i < 100; i++) c.update({ jitterSeconds: 5, lossFraction: 1 });
  assert.equal(c.appliedSeconds, 0.5);
});

test("hysteresis: sub-50ms wobble never re-hints the receiver", () => {
  const c = new AdaptivePlayoutController();
  for (let i = 0; i < 200; i++) c.update(CLEAN); // settle at the floor
  let changes = 0;
  // Jitter that maps to a demand a few ms above the floor: real movement, but under
  // the 50ms hysteresis band, so it must never re-anchor the buffer.
  for (let i = 0; i < 100; i++) {
    if (c.update({ jitterSeconds: i % 2 === 0 ? 0.001 : 0.002, lossFraction: 0 }).changed) changes++;
  }
  assert.equal(changes, 0, "a wobble inside the hysteresis band re-hinted the receiver");
});

test("garbage stats degrade to a clean reading, never to NaN", () => {
  const c = new AdaptivePlayoutController();
  const d = c.update({ jitterSeconds: Number.NaN, lossFraction: Number.NaN });
  assert.ok(Number.isFinite(d.targetSeconds));
  assert.ok(d.targetSeconds >= 0.15 && d.targetSeconds <= 0.5);
  const negative = c.update({ jitterSeconds: -1, lossFraction: -1 });
  assert.ok(Number.isFinite(negative.targetSeconds));
});

test("readInboundRtp computes loss as a PER-TICK delta, not a session-long ratio", () => {
  const tick1 = readInboundRtp([
    { type: "inbound-rtp", jitter: 0.01, packetsLost: 100, packetsReceived: 900 },
  ]);
  assert.ok(tick1);
  // First read has no cursor: it seeds, and must not report the whole session's loss.
  assert.equal(tick1.sample.lossFraction, 0);
  assert.deepEqual(tick1.cursor, { packetsLost: 100, packetsReceived: 900 });
  // Second read: 10 lost of 110 in THIS window, even though the session ratio is ~10%.
  const tick2 = readInboundRtp(
    [{ type: "inbound-rtp", jitter: 0.01, packetsLost: 110, packetsReceived: 1000 }],
    tick1.cursor,
  );
  assert.ok(tick2);
  assert.ok(Math.abs(tick2.sample.lossFraction - 10 / 110) < 1e-9);
});

test("readInboundRtp survives a counter reset and reports no report at all honestly", () => {
  const seeded = { packetsLost: 500, packetsReceived: 5000 };
  const afterReset = readInboundRtp(
    [{ type: "inbound-rtp", jitter: 0.005, packetsLost: 2, packetsReceived: 40 }],
    seeded,
  );
  assert.ok(afterReset);
  assert.equal(afterReset.sample.lossFraction, 0, "a counter reset must not read as negative loss");
  // No inbound-rtp entry ⇒ undefined, so the caller SKIPS the tick rather than
  // feeding the controller a fabricated zero (which would descend on no evidence).
  assert.equal(readInboundRtp([{ type: "outbound-rtp", jitter: 0.5 }]), undefined);
  assert.equal(readInboundRtp([]), undefined);
});

test("the surfaces keep the loop opt-in (default false) on both platforms", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const path of [
    "../src/react/avatar-video-surface.ts",
    "../src/react-native/avatar-video-surface.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf-8");
    assert.match(
      source,
      /adaptivePlayout = false/,
      `${path} must default adaptivePlayout to false — the flat cushion is the shipped behavior`,
    );
    assert.match(
      source,
      /useAvatarAdaptivePlayoutDelay\(videoTrack, audioTrack, adaptivePlayout\)/,
      `${path} must pass the flag through rather than hard-enabling the loop`,
    );
  }
});
