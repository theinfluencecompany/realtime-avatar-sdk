import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AVATAR_SETTLE_FRAMES,
  initialFrameSample,
  nextFrameSample,
  type FrameSample,
} from "../src/react/frame-recovery.ts";

// ---------------------------------------------------------------------------
// STARTUP SETTLE. Nine of the twelve demotes caught on the wire (2026-09-11) were OPENING
// demotes: the gaps between the first few presented frames (decoder warm-up, the jitter
// buffer filling behind frame 1, the first keyframe's own size) were charged to the link.
// Chrome's own freeze detector refuses to score anything before five rendered frames; the
// rVFC path now agrees with it, so the two inputs of the governor's max() cannot disagree
// about the opening.
// ---------------------------------------------------------------------------

const settled = (start: FrameSample, sizeKey = "584x1024"): { sample: FrameSample; nowMs: number } => {
  let sample = start;
  let now = 10_000;
  for (let i = 0; i < AVATAR_SETTLE_FRAMES; i++) {
    now += 400;
    sample = nextFrameSample(sample, now, sizeKey);
  }
  return { sample, nowMs: now };
};

test("Chrome's minimum rendered-frame count is the settle length", () => {
  assert.equal(AVATAR_SETTLE_FRAMES, 5);
});

test("frames 1..5 with 400 ms gaps charge nothing; frame 6 charges the gap", () => {
  const { sample, nowMs } = settled(initialFrameSample(10_000, false));
  assert.equal(sample.framesSeen, AVATAR_SETTLE_FRAMES);
  assert.equal(sample.maxGapMs, 0, "every gap inside the settle is exempt");
  assert.equal(sample.seenFrame, true);
  assert.equal(sample.lastFrameAtMs, nowMs, "the clock is re-baselined on every settling frame");
  const sixth = nextFrameSample(sample, nowMs + 400, "584x1024");
  assert.equal(sixth.maxGapMs, 400, "from frame 6 the raw gap is booked (the floor is subtracted in freezeReading)");
  assert.equal(sixth.framesSeen, AVATAR_SETTLE_FRAMES + 1);
});

test("a size change after settle still resets exactly once", () => {
  const { sample, nowMs } = settled(initialFrameSample(10_000, false));
  const switched = nextFrameSample(sample, nowMs + 600, "360x630");
  assert.equal(switched.maxGapMs, 0, "the switch's own keyframe gap is not the link");
  assert.equal(switched.lastSizeKey, "360x630");
  const after = nextFrameSample(switched, nowMs + 1_200, "360x630");
  assert.equal(after.maxGapMs, 600, "the next gap at the new size is charged");
});

test("the first frame at a size is a baseline, never a switch", () => {
  const first = nextFrameSample(initialFrameSample(0, false), 500, "584x1024");
  assert.equal(first.lastSizeKey, "584x1024");
  assert.equal(first.maxGapMs, 0);
  assert.equal(first.framesSeen, 1);
});

test("a bfcache resume is still a reset and still ends the pending state", () => {
  const { sample, nowMs } = settled(initialFrameSample(10_000, false));
  const resumed = nextFrameSample({ ...sample, resumePending: true }, nowMs + 5_000, "584x1024");
  assert.equal(resumed.maxGapMs, 0);
  assert.equal(resumed.resumePending, false);
});

test("maxGapMs accumulates the LONGEST gap since the last read once settled", () => {
  const { sample, nowMs } = settled(initialFrameSample(10_000, false));
  const a = nextFrameSample(sample, nowMs + 300, "584x1024");
  const b = nextFrameSample(a, nowMs + 300 + 40, "584x1024");
  assert.equal(b.maxGapMs, 300, "a short gap after a long one does not lower the reading");
});
