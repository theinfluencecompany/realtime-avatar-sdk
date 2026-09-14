import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AVATAR_FRAME_GAP_FREEZE_FLOOR_MS as FLOOR,
  AVATAR_SETTLE_FRAMES,
  AVATAR_SETTLE_MAX_GAP_MS,
  initialFrameSample,
  nextFrameSample,
  readFreezeFromSample,
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

// ---------------------------------------------------------------------------
// THE SETTLE MUST COVER THE GAP THAT IS STILL OPEN.
//
// `nextFrameSample` exempts the gaps BETWEEN settling frames, which are the gaps already
// recorded when a frame lands. But the governor tick does not land on a frame: it lands
// wherever it lands, and it reads the gap that is STILL OPEN (now - lastFrameAtMs). During
// the opening that ongoing gap is the decoder warming up and the jitter buffer filling
// behind frame 1 — the same class of event, from the same five frames — and it was charged
// in full. A tick that landed 900 ms after frame 2 of a HIGH opening therefore booked 800 ms
// of freeze and demoted the rung, which is the opening-demote shape the settle exists to
// remove (9 of the 12 demotes caught on the wire on 2026-09-11 were opening demotes).
//
// Read at the freezeReading level, which is where the two paths meet.
// ---------------------------------------------------------------------------

const env = { hidden: false, trackProducing: true } as const;
/** A binding that has presented `frames` frames, 400 ms apart, ending at t=12_000. */
const afterFrames = (frames: number): FrameSample => {
  let sample = initialFrameSample(10_000, false);
  for (let i = 0; i < frames; i++) sample = nextFrameSample(sample, 12_000 - 400 * (frames - 1 - i), "584x1024");
  return sample;
};

test("a tick inside the opening settle charges nothing, however late it lands", () => {
  for (let frames = 1; frames < AVATAR_SETTLE_FRAMES; frames++) {
    const { reading } = readFreezeFromSample(afterFrames(frames), 12_900, env);
    assert.equal(reading.freezeMsInWindow, 0, `${frames} frames in: an ongoing 900 ms gap is still the opening`);
    assert.equal(reading.inhibited, false, "and the tick is NOT inhibited: the governor still runs");
  }
});

test("the very same tick one frame later IS charged, so the exemption is bounded", () => {
  const { reading } = readFreezeFromSample(afterFrames(AVATAR_SETTLE_FRAMES), 12_900, env);
  assert.equal(reading.freezeMsInWindow, 900 - FLOOR, "frame 5 is the last settling frame; the gap after it counts");
});

test("the recorded gap and the ongoing gap are exempted by the SAME rule", () => {
  // Both inputs of the max() must agree about the opening, or the settle only half-applies —
  // and they must agree about its BOUND too. A gap longer than the first-frame grace is not
  // decoder warm-up whatever the frame count says, so neither input may exempt it (a binding
  // that presents four frames and stops would otherwise read as a perfect link forever).
  const settling = afterFrames(2);
  assert.equal(settling.maxGapMs, 0, "the recorded gap was already exempt");
  const warmUp: FrameSample = { ...settling, maxGapMs: AVATAR_SETTLE_MAX_GAP_MS - 100 };
  assert.equal(readFreezeFromSample(warmUp, 12_900, env).reading.freezeMsInWindow, 0);
  const stalled: FrameSample = { ...settling, maxGapMs: 5_000 };
  assert.equal(
    readFreezeFromSample(stalled, 12_900, env).reading.freezeMsInWindow,
    5_000 - FLOOR,
    "a stall-sized recorded gap is charged on the same rule the ongoing gap uses",
  );
});

test("reading consumes the recorded gap and leaves the rest of the ledger alone", () => {
  const settled = afterFrames(AVATAR_SETTLE_FRAMES + 2);
  const withGap: FrameSample = { ...settled, maxGapMs: 700 };
  const { reading, sample } = readFreezeFromSample(withGap, 12_100, env);
  assert.equal(reading.freezeMsInWindow, 700 - FLOOR, "the longest gap since the last read");
  assert.equal(sample.maxGapMs, 0, "consumed, so the next tick does not re-charge it");
  assert.equal(sample.lastFrameAtMs, withGap.lastFrameAtMs, "the presentation clock is untouched");
  assert.equal(sample.framesSeen, withGap.framesSeen);
  // A second read of an unchanged ledger returns the same object: no churn on a quiet call.
  assert.equal(readFreezeFromSample(sample, 12_100, env).sample, sample);
});

test("the first-frame wait is still reported, past the grace, before any frame exists", () => {
  const producing = initialFrameSample(10_000, false);
  assert.equal(readFreezeFromSample(producing, 10_500, env).reading.freezeMsInWindow, 0, "inside the grace");
  const waited = readFreezeFromSample(producing, 12_400, env).reading;
  assert.equal(waited.freezeMsInWindow, 1_400, "2.4 s of waiting, minus the 1 s grace");
  assert.equal(waited.inhibited, false, "a starved HIGH opening must stay demotable");
});

test("a hidden tab, a pending resume and a track that is not producing all inhibit", () => {
  const settled = { ...afterFrames(AVATAR_SETTLE_FRAMES + 2), maxGapMs: 5_000 };
  for (const [why, input] of [
    ["hidden", { sample: settled, env: { hidden: true, trackProducing: true } }],
    ["resume pending", { sample: { ...settled, resumePending: true }, env }],
    ["not producing", { sample: settled, env: { hidden: false, trackProducing: false } }],
  ] as const) {
    const { reading, sample } = readFreezeFromSample(input.sample, 20_000, input.env);
    assert.deepEqual(reading, { freezeMsInWindow: 0, inhibited: true }, why);
    assert.equal(sample.maxGapMs, 0, `${why}: the stale gap is dropped, not carried into the next window`);
  }
});
