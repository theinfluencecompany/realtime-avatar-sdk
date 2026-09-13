import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  LOW_CAP_STEP_AFTER_UNHEALTHY,
  resolveLowCapQuality,
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
  !Number.isFinite(gapMs) || gapMs <= FLOOR ? 0 : gapMs - FLOOR;

/**
 * THE MARGIN BETWEEN "ORDINARY FRAME SPACING" AND "DEMOTE THIS STREAM".
 *
 * Two constants were chosen independently and land on the same number: the frame-gap
 * floor and the governor's probation bar are both 100. For a long time the converter
 * between them returned the WHOLE gap once past the floor rather than the excess, so the
 * first gap the floor declined to forgive was already, by itself, an instant demote.
 * These tests pin the margin that now exists, and the two behaviours that depend on it.
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
const at = (
  state: Governor["state"], cap: Governor["cap"], failures = 0, enteredAtMs = 0, lowUnhealthy = 0,
): Governor => ({ state, cap, failures, enteredAtMs, healthySinceMs: null, lowUnhealthy });

test("the mirrored converter still matches the shipped one", () => {
  assert.ok(Number.isFinite(FLOOR), "could not read AVATAR_FRAME_GAP_FREEZE_FLOOR_MS from source");
  // Pin BOTH halves of the shipped implementation: the forgiving comparison, and that what
  // it returns past the floor is the WHOLE gap rather than the excess over it. If either
  // changes, this mirror is wrong and every assertion below is worthless, so fail loudly.
  assert.match(
    SURFACE_SRC,
    /gapMs\s*<=\s*AVATAR_FRAME_GAP_FREEZE_FLOOR_MS\)\s*return 0;\s*\n\s*return gapMs - AVATAR_FRAME_GAP_FREEZE_FLOOR_MS;/,
    "freezeMsFromFrameGap changed shape; update the mirror in this test",
  );
});

test("the floor charges the EXCESS, so one millisecond past it costs one millisecond", () => {
  assert.equal(freezeMsFromFrameGap(FLOOR), 0, "a gap AT the floor is forgiven");
  assert.equal(freezeMsFromFrameGap(FLOOR + 1), 1, "not the whole gap: the excess over the floor");
  assert.ok(
    freezeMsFromFrameGap(FLOOR + 1) < CFG.probationFreezeMs,
    "and it is nowhere near the probation bar, which is the margin the floor was always supposed to buy",
  );
  // The floor's stated purpose, finally met: two frames at 15fps is 133ms and costs 33.
  assert.equal(Math.round(freezeMsFromFrameGap((1_000 / 15) * 2)), 33);
});

test("a single 101ms gap no longer demotes a probing stream", () => {
  const { governor, action } = step(at("probing_up", "high"), gap(FLOOR + 1), 1_000, CFG);
  assert.equal(action, undefined, "no cap action: one dropped frame is not a verdict");
  assert.equal(governor.cap, "high");
  // A gap big enough to matter still kills an unproven high, fast. The bar moved, not the policy.
  const real = step(at("probing_up", "high"), gap(FLOOR + CFG.probationFreezeMs + 1), 1_000, CFG);
  assert.equal(real.action?.setCap, "low");
  assert.equal(real.governor.failures, 1, "an unproven high that loses still counts as a failure");
});

test("one dropped frame at the rung actually delivered is survivable now", () => {
  // Deployed sub-top simulcast rungs declare 20fps, so frames are 50ms apart and a single
  // dropped frame is a 100ms gap. The floor forgives exactly that and nothing beyond it.
  const twentyFps = 1_000 / 20;
  assert.equal(freezeMsFromFrameGap(twentyFps * 2), 0, "one dropped frame at 20fps is forgiven");
  assert.ok(
    freezeMsFromFrameGap(twentyFps * 2 + 1) < CFG.probationFreezeMs,
    "and one millisecond more is no longer a demote, which is the whole point",
  );
});

test("a committed cap is still judged on the LOOSER bar", () => {
  const survives = step(at("cap_high_stable", "high", 0), gap(FLOOR + 1), 5_000, CFG);
  assert.equal(survives.governor.cap, "high");
  assert.ok(CFG.probationFreezeMs < CFG.downgradeFreezeMs);
});

test("a COMMITTED cap that falls records NO failure, and that is deliberate", () => {
  const gapPast = FLOOR + CFG.downgradeFreezeMs + 1;
  const committed = step(at("cap_high_stable", "high", 0), gap(gapPast), 5_000, CFG);
  assert.equal(committed.governor.cap, "low");
  // Counting this was tried and measured. It left the switch count unchanged (10 vs 10 on
  // a 500ms blip once a minute) while spending 10.7 percentage points LESS time on the top
  // rung, because each blip doubled the dwell. The asymmetry stays until the dwell curve
  // itself is revisited.
  assert.equal(committed.governor.failures, 0);
  // An UNPROVEN high that loses is still remembered, which is what drives the backoff and
  // what steps the low cap down a rung.
  const probing = step(at("probing_up", "high", 0), gap(gapPast), 5_000, CFG);
  assert.equal(probing.governor.failures, 1);
});

test("one opening failure now costs 9 seconds, not 19", () => {
  // Measured clean-link call before the fix: left the top rung at 6.9s, returned at 27.6s.
  // The DWELL arithmetic is unchanged; what changed is how easily a failure is earned.
  const demoted = step(at("opening_high", "high", 0), gap(FLOOR + CFG.probationFreezeMs + 1), 6_900, CFG).governor;
  assert.equal(demoted.cap, "low");
  assert.equal(demoted.failures, 1);
  const dwellMs = Math.min(CFG.dwellBaseMs * 2 ** demoted.failures, CFG.dwellMaxMs);
  assert.equal(dwellMs, 6_000, "3s base, doubled once");
  // Dwell, then a clean window, then the probe fires. Decoder reconfigure and the
  // keyframe wait land on top of that, which is the rest of the measured 27.6s.
  assert.equal(6_900 + dwellMs + CFG.cleanMs, 15_900);
  // The worst single spell on the low cap is now bounded by dwellMax, not by 2^failures
  // running away to two minutes.
  assert.equal(CFG.dwellMaxMs, 12_000);
});

test("the low cap steps on evidence from the LOW rung, never on a failed reach for HIGH", () => {
  // Two-layer ladder (the fleet default at long edge 768): both branches agree, so this
  // is byte-identical there. That is the safety property worth pinning.
  assert.equal(resolveLowCapQuality([1, 2], 0), 1);
  assert.equal(resolveLowCapQuality([1, 2], 9), 1);
  // Three-layer ladder (long edge 1024, which is what the production pool publishes).
  assert.equal(resolveLowCapQuality([0, 1, 2], 0), 1, "no low-rung evidence: the middle rung");
  assert.equal(resolveLowCapQuality([0, 1, 2], 1), 1, "ONE unhealthy tick is noise, not a verdict");
  assert.equal(
    resolveLowCapQuality([0, 1, 2], LOW_CAP_STEP_AFTER_UNHEALTHY),
    0,
    "the low rung has now failed on its own terms, so the bottom rung becomes reachable",
  );
  // Order of the declared layers must not matter; the publisher decides the labels.
  assert.equal(resolveLowCapQuality([2, 0, 1], LOW_CAP_STEP_AFTER_UNHEALTHY), 0);
  // A degenerate ladder keeps its historical answer rather than inventing a rung.
  assert.equal(resolveLowCapQuality([2], 9), 1);
});

test("a slow OPENING must not reach the bottom rung, which is the regression this replaces", () => {
  // A starved opening reports the first-frame wait as a freeze, so essentially every real
  // session books failures=1 before the link has carried anything. Measured on production,
  // first frames ran 2.4s to 28s. Keying the rung step on `failures` therefore sent the
  // FIRST demote to the bottom rung, including on a captured call with ZERO freezes.
  const openingFailed = step(at("opening_high", "high", 0), gap(FLOOR + CFG.probationFreezeMs + 1), 2_000, CFG).governor;
  assert.equal(openingFailed.cap, "low");
  assert.equal(openingFailed.failures, 1, "the opening failure still drives dwell backoff");
  assert.equal(openingFailed.lowUnhealthy, 0, "but it is NOT evidence about the low rung");
  assert.equal(
    resolveLowCapQuality([0, 1, 2], openingFailed.lowUnhealthy),
    1,
    "so the demote lands on the middle rung, not the bottom",
  );
});

test("sitting on the low rung while it keeps freezing DOES reach the bottom", () => {
  let g = at("cap_low_sticky", "low", 1, 0);
  for (let i = 0; i < LOW_CAP_STEP_AFTER_UNHEALTHY; i++) {
    g = step(g, gap(FLOOR + CFG.downgradeFreezeMs + 1), 1_000 * (i + 1), CFG).governor;
  }
  assert.ok(g.lowUnhealthy >= LOW_CAP_STEP_AFTER_UNHEALTHY);
  assert.equal(resolveLowCapQuality([0, 1, 2], g.lowUnhealthy), 0);
});

// ---------------------------------------------------------------------------
// A LAYER SWITCH MUST NOT BE CHARGED TO THE LINK.
//
// Changing simulcast layer costs a decoder reconfigure plus a wait for the new layer's
// keyframe. That is a real gap in presented frames with ZERO packets lost. Charging it as
// a freeze made the governor punish the stream for the cost of its own decision, and the
// punishment was another switch.
//
// Measured on production (Valko, 2026-09-11, zero loss): the top rung arrived at t=10.98s,
// was demoted 0.43s later, and did not come back for 21.8s. One second of a sharp face,
// then twenty of a blurry one.
// ---------------------------------------------------------------------------
test("the gap across a decoded-size change is not charged as a freeze", () => {
  const SRC = readFileSync(new URL("../src/react/avatar-video-surface.ts", import.meta.url), "utf8");
  // The reset must be driven by a SIZE change, and must sit on the same branch as the
  // bfcache resume, which is the same class of event: real, local, not the network.
  assert.match(SRC, /const sizeKey = `\$\{video\?\.videoWidth \?\? 0\}x\$\{video\?\.videoHeight \?\? 0\}`/);
  assert.match(SRC, /const layerSwitched =\s*previous\.lastSizeKey !== null && sizeKey !== previous\.lastSizeKey/);
  assert.match(SRC, /previous\.resumePending \|\| layerSwitched\s*\n?\s*\? 0/);
  // And the very first frame must NOT count as a switch, or every session would start by
  // discarding a baseline it never had.
  assert.match(SRC, /previous\.lastSizeKey !== null &&/);
});

test("the climb back after a switch-induced demote is bounded", () => {
  // Pinning the cost so the saving is legible: one opening-probation failure books
  // failures=1, and the climb back is dwellBase * 2^1 plus the clean window.
  const demoted = step(at("opening_high", "high", 0), gap(FLOOR + CFG.probationFreezeMs + 1), 11_410, CFG).governor;
  assert.equal(demoted.cap, "low");
  assert.equal(demoted.failures, 1);
  // Was 8s x 2^1 + 3s = 19s, which is the 21.8s observed on production once the switch
  // and keyframe are added. Now 3s x 2^1 + 3s.
  assert.equal(Math.min(CFG.dwellBaseMs * 2 ** demoted.failures, CFG.dwellMaxMs) + CFG.cleanMs, 9_000);
});
