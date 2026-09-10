import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  step,
  type Governor,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";
import { readFileSync } from "node:fs";

// `avatar-video-surface.ts` cannot be imported here: it reaches React and livekit through
// extensionless specifiers that node's ESM resolver rejects. Its two relevant facts are
// therefore READ FROM SOURCE, which is not a shortcut. It is the only way this test can
// fail when someone edits that file, and the whole point is the RELATIONSHIP between a
// constant declared there and one declared in the governor. Importing one and hard-coding
// the other would let the pair drift apart silently, which is exactly the bug.
const SURFACE_SRC = readFileSync(
  new URL("../src/react/avatar-video-surface.ts", import.meta.url),
  "utf8",
);
const FLOOR = Number(
  /AVATAR_FRAME_GAP_FREEZE_FLOOR_MS\s*=\s*(\d+)/.exec(SURFACE_SRC)?.[1] ?? NaN,
);
/** Mirrors `freezeMsFromFrameGap`. The assertion below pins the mirror to the original. */
const freezeMsFromFrameGap = (gapMs: number): number =>
  !Number.isFinite(gapMs) || gapMs <= FLOOR ? 0 : gapMs;

/**
 * THE MARGIN BETWEEN "ORDINARY FRAME SPACING" AND "DEMOTE THIS STREAM" IS ZERO.
 *
 * Two constants were chosen independently and land on the same number. The frame-gap
 * floor exists, by its own comment, to "ignore ordinary 15-25fps presentation spacing",
 * and it forgives a gap of exactly FLOOR. But the converter it guards returns the WHOLE
 * gap once the gap clears the floor, not the excess over it, and the probation bar is
 * the same 100. So the first gap the floor does not forgive is instantly a probation
 * failure, with nothing in between.
 *
 * These are not style tests. Four instrumented production calls on 2026-09-10, over links
 * that lost between 0 and 6 packets for an entire call, showed the stream leaving the top
 * rung at ~6.9s and not returning for 20s. The timing below is the reducer's own arithmetic
 * for that walk, so if these tests change, that user-facing behaviour changed with them.
 */

const CLEAN: GovernorSignal = {
  paused: false,
  freezeMsInWindow: 0,
  jitterRising: false,
  connectionQuality: "excellent",
  inhibited: false,
};
const gap = (ms: number): GovernorSignal => ({ ...CLEAN, freezeMsInWindow: freezeMsFromFrameGap(ms) });
const at = (state: Governor["state"], cap: Governor["cap"], failures = 0, enteredAtMs = 0): Governor => ({
  state, cap, failures, enteredAtMs, healthySinceMs: null,
});

test("the mirrored converter still matches the shipped one", () => {
  assert.ok(Number.isFinite(FLOOR), "could not read AVATAR_FRAME_GAP_FREEZE_FLOOR_MS from source");
  // Pin BOTH halves of the shipped implementation: the forgiving comparison, and that what
  // it returns past the floor is the WHOLE gap rather than the excess over it. If either
  // changes, this mirror is wrong and every assertion below is worthless, so fail loudly.
  assert.match(
    SURFACE_SRC,
    /gapMs\s*<=\s*AVATAR_FRAME_GAP_FREEZE_FLOOR_MS\)\s*return 0;\s*\n\s*return gapMs;/,
    "freezeMsFromFrameGap changed shape; update the mirror in this test",
  );
});

test("the frame-gap floor forgives a gap, then charges the FULL gap for one more millisecond", () => {
  assert.equal(freezeMsFromFrameGap(FLOOR), 0, "a gap AT the floor is forgiven");
  // The cliff. Not 1ms of freeze for 1ms over the floor: the whole gap, all at once.
  assert.equal(freezeMsFromFrameGap(FLOOR + 1), FLOOR + 1);
  assert.ok(
    freezeMsFromFrameGap(FLOOR + 1) >= CFG.probationFreezeMs,
    "one millisecond past the floor already clears the probation bar, so the floor buys no margin at all",
  );
});

test("a single 101ms gap demotes a probing stream instantly", () => {
  const { governor, action } = step(at("probing_up", "high"), gap(FLOOR + 1), 1_000, CFG);
  assert.equal(action?.setCap, "low");
  assert.equal(governor.cap, "low");
  assert.equal(governor.failures, 1, "an unproven high that loses counts as a failure");
});

test("that gap is TWO FRAMES of ordinary spacing at the rung prod actually delivers", () => {
  // Deployed sub-top simulcast rungs declare 20fps, so frames are 50ms apart and a single
  // dropped frame is a 100ms gap. The floor forgives exactly that and nothing beyond it.
  const twentyFps = 1_000 / 20;
  assert.equal(freezeMsFromFrameGap(twentyFps * 2), 0, "one dropped frame at 20fps is forgiven, barely");
  assert.ok(freezeMsFromFrameGap(twentyFps * 2 + 1) >= CFG.probationFreezeMs);
  // And the floor's stated purpose, covering 15fps spacing, is not met: two frames at
  // 15fps is 133ms, which is over the floor and therefore an instant probation failure.
  assert.ok(
    freezeMsFromFrameGap((1_000 / 15) * 2) >= CFG.probationFreezeMs,
    "the floor claims to ignore ordinary 15-25fps spacing; at 15fps it does not",
  );
});

test("a committed cap is judged on the LOOSER bar, so the two paths do not share a threshold", () => {
  // Worth pinning, because it is easy to assume one freeze bar. A gap that instantly kills
  // an unproven high is not enough to unseat a proven one: 101 < downgradeFreezeMs.
  const survives = step(at("cap_high_stable", "high", 0), gap(FLOOR + 1), 5_000, CFG);
  assert.equal(survives.governor.cap, "high");
  assert.ok(CFG.probationFreezeMs < CFG.downgradeFreezeMs);
});

test("exponential backoff is unreachable from a COMMITTED cap, so a steady-state flap never slows down", () => {
  // Past the looser bar the committed high DOES fall. What it does not do is remember.
  const gapPastDowngradeBar = CFG.downgradeFreezeMs + 1;
  const committed = step(at("cap_high_stable", "high", 0), gap(gapPastDowngradeBar), 5_000, CFG);
  assert.equal(committed.governor.cap, "low", "the committed high falls past the looser bar");
  assert.equal(
    committed.governor.failures,
    0,
    "and records NO failure, because `failed = onProbation`. Dwell is dwellBase * 2^failures, "
      + "so a link that keeps losing a proven high re-probes on the SAME short dwell forever: "
      + "the exponential backoff exists but this path can never reach it.",
  );
  // Contrast: the identical gap during probation is remembered. That asymmetry is the bug.
  const probing = step(at("probing_up", "high", 0), gap(gapPastDowngradeBar), 5_000, CFG);
  assert.equal(probing.governor.failures, 1);
});

test("one opening failure explains a 20-second hold, which is what production does", () => {
  // Measured clean-link call: left the top rung at 6.9s, returned at 27.6s.
  const demoted = step(at("opening_high", "high", 0), gap(FLOOR + 1), 6_900, CFG).governor;
  assert.equal(demoted.cap, "low");
  assert.equal(demoted.failures, 1);
  const dwellMs = Math.min(CFG.dwellBaseMs * 2 ** demoted.failures, CFG.dwellMaxMs);
  assert.equal(dwellMs, 16_000);
  // Dwell, then a clean window, then the probe fires. Decoder reconfigure and the
  // keyframe wait land on top of that, which is the rest of the measured 27.6s.
  assert.equal(6_900 + dwellMs + CFG.cleanMs, 25_900);
});
