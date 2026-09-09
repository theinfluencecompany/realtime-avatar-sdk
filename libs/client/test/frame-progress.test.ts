import assert from "node:assert/strict";
import test from "node:test";
import { completedFrameGapMs, ongoingFrameGapMs, scoreFrameGap } from "../src/react/frame-progress.ts";

test("ordinary lower-layer cadence cannot continually block a quality recovery", () => {
  // The production trace stayed at 20fps with no new native freezes while these
  // JS gaps repeatedly reset the governor's clean window.
  for (const gap of [101, 110, 116, 117, 134, 160, 200]) {
    assert.equal(scoreFrameGap(gap), 0);
  }
  assert.equal(scoreFrameGap(265), 265);
  assert.equal(scoreFrameGap(650), 650);
});

test("recorded callback coalescing does not become a network freeze", () => {
  // Production browser: 4 frames advanced over a delayed 166.7ms callback.
  assert.equal(completedFrameGapMs(166.7, 31, 35), 0);
  assert.equal(completedFrameGapMs(200, 35, 38), 0);
});

test("a genuinely held frame and a lone recovered frame preserve their gaps", () => {
  assert.equal(ongoingFrameGapMs(650, 100, 100), 650);
  assert.equal(completedFrameGapMs(650, 100, 101), 650);
});

test("progress since the last JS callback is not an ongoing media stall", () => {
  assert.equal(ongoingFrameGapMs(250, 100, 105), 0);
});

test("counter rollback primes a replacement instead of reporting a freeze", () => {
  assert.equal(completedFrameGapMs(500, 500, 1), 0);
  assert.equal(ongoingFrameGapMs(500, 500, 1), 0);
});

test("browsers without the frame counter retain the conservative gap signal", () => {
  assert.equal(completedFrameGapMs(650, null, null), 650);
  assert.equal(ongoingFrameGapMs(650, null, null), 650);
});
