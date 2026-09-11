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
import {
  DEFAULT_GOVERNOR_CONFIG,
  initGovernor,
  resolveGovernorConfig,
  resolveLowCapQuality,
  step,
  type Governor,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";

// ---------------------------------------------------------------------------
// THE SETTLE NEEDS A CLOCK, AND THE KILL SWITCH HAS TO REACH IT.
//
// The startup settle exempts the decoder warm-up: the gaps around the first few presented
// frames say nothing about the link. Bounding it by FRAME COUNT alone made the exemption
// unbounded in TIME — a binding that presents four frames and then dies reads as a perfect
// link forever, which is strictly worse than the opening demote the settle exists to remove.
// Warm-up is bounded in both: five frames AND a gap no longer than the first-frame grace.
// ---------------------------------------------------------------------------

const opening = (frames: number, startMs = 10_000, stepMs = 120): { sample: FrameSample; nowMs: number } => {
  let sample = initialFrameSample(startMs, false);
  let now = startMs;
  for (let i = 0; i < frames; i++) {
    now += stepMs;
    sample = nextFrameSample(sample, now, "584x1024");
  }
  return { sample, nowMs: now };
};

const env = { hidden: false, trackProducing: true };

test("a stall inside the settle is exempt only while it is warm-up sized", () => {
  const { sample, nowMs } = opening(AVATAR_SETTLE_FRAMES - 1);
  assert.ok(sample.framesSeen < AVATAR_SETTLE_FRAMES, "precondition: still settling");

  const brief = readFreezeFromSample(sample, nowMs + AVATAR_SETTLE_MAX_GAP_MS - 1, env);
  assert.equal(brief.reading.freezeMsInWindow, 0, "warm-up sized gap stays exempt");

  // The failing scenario: four frames, then the binding stops. Frame count never advances,
  // so a frames-only settle exempts this for the rest of the call.
  const stalled = readFreezeFromSample(sample, nowMs + 5_000, env);
  assert.equal(
    stalled.reading.freezeMsInWindow,
    5_000 - FLOOR,
    "a 5 s stall is charged even though the binding never left the settle",
  );
  assert.equal(stalled.reading.inhibited, false);
});

test("the settle exemption cannot outlive the call", () => {
  const { sample, nowMs } = opening(1);
  for (const elapsed of [15_000, 60_000, 300_000]) {
    const read = readFreezeFromSample(sample, nowMs + elapsed, env);
    assert.equal(read.reading.freezeMsInWindow, elapsed - FLOOR, `charged at +${elapsed} ms`);
  }
});

test("a recorded warm-up gap is exempt, a recorded stall is not", () => {
  const { sample, nowMs } = opening(2);
  const quick = nextFrameSample(sample, nowMs + 300, "584x1024");
  assert.equal(quick.maxGapMs, 0, "warm-up sized recorded gap stays exempt");

  const slow = nextFrameSample(sample, nowMs + 4_000, "584x1024");
  assert.equal(slow.maxGapMs, 4_000, "a 4 s recorded gap survives the settle");
});

test("linkEvidence optional reaches the settle, so the switch is a real revert", () => {
  const legacy = { settleFrames: 0 };
  const { sample, nowMs } = opening(2);

  const governed = readFreezeFromSample(sample, nowMs + 800, env);
  assert.equal(governed.reading.freezeMsInWindow, 0, "settled by default");

  const reverted = readFreezeFromSample(sample, nowMs + 800, env, legacy);
  assert.equal(reverted.reading.freezeMsInWindow, 800 - FLOOR, "0.11.5 charges the same gap");

  const recorded = nextFrameSample(sample, nowMs + 800, "584x1024", legacy);
  assert.equal(recorded.maxGapMs, 800, "and records it, as 0.11.5 did");
});

// ---------------------------------------------------------------------------
// A HELD PAUSE IS ONE EVENT, NOT ONE PER TICK.
//
// Reading the SFU pause as a LEVEL (rather than an edge that is lost after one tick) is
// what keeps a paused track from probing up. But `lowUnhealthy` is not bookkeeping: it is
// what CHOOSES the rung a demote lands on, and a pause says nothing about which rung the
// subscriber should sit on. Counting one per paused tick made a 40 s pause select the
// bottom rung on the next demote.
// ---------------------------------------------------------------------------

const cfg = resolveGovernorConfig(DEFAULT_GOVERNOR_CONFIG);
/** A three-rung ladder as the hook hands it over: LiveKit VideoQuality enum values. */
const RUNGS = [0, 1, 2] as const;
const [BOTTOM, MIDDLE] = RUNGS;
/** Link evidence, so a freeze is chargeable. Without it the fence refuses to charge the tick
 *  at all, which is the whole point of the prototype and not what these tests are about. */
const LOSSY = { packetsLostInWindow: 4, nacksInWindow: 2, framesDroppedInWindow: 0 };

const signal = (over: Partial<GovernorSignal> = {}): GovernorSignal => ({
  freezeMsInWindow: 0,
  inhibited: false,
  paused: false,
  jitterRising: false,
  connectionQuality: "excellent",
  ...over,
});

/** The governor sitting on the low cap, which is where `lowUnhealthy` is gathered. Built
 *  directly rather than walked into, so these tests pin the counting rule and nothing else. */
const lowSticky = (atMs: number): Governor => ({
  ...initGovernor(atMs),
  state: "cap_low_sticky",
  cap: "low",
  enteredAtMs: atMs,
});

const run = (g: Governor, ticks: Array<{ atMs: number; signal: GovernorSignal }>): Governor => {
  let governor = g;
  for (const tick of ticks) governor = step(governor, tick.signal, tick.atMs, cfg).governor;
  return governor;
};

test("a held pause does not walk lowUnhealthy toward the bottom rung", () => {
  // Sit on the low cap, then hold the pause for 40 s.
  const held = run(
    lowSticky(1_000),
    Array.from({ length: 40 }, (_, i) => ({ atMs: 2_000 + i * 1_000, signal: signal({ paused: true }) })),
  );
  assert.ok(
    held.lowUnhealthy <= 1,
    `a held pause counts once, got lowUnhealthy ${held.lowUnhealthy}`,
  );
  assert.equal(
    resolveLowCapQuality(RUNGS, held.lowUnhealthy),
    MIDDLE,
    "so the next demote still selects the middle rung",
  );
});

test("real low-rung evidence still walks to the bottom rung", () => {
  const unhealthy = run(lowSticky(1_000), [
    { atMs: 2_000, signal: signal({ freezeMsInWindow: 400, transport: LOSSY }) },
    { atMs: 3_000, signal: signal({ freezeMsInWindow: 400, transport: LOSSY }) },
  ]);
  assert.ok(unhealthy.lowUnhealthy >= 2, "charged freeze on the low rung still counts");
  assert.equal(resolveLowCapQuality(RUNGS, unhealthy.lowUnhealthy), BOTTOM);
});

test("a held pause still refuses to probe up", () => {
  let g = initGovernor(0);
  const ticks = Array.from({ length: 8 }, (_, i) => ({
    atMs: 1_000 + i * 1_000,
    signal: signal({ paused: true }),
  }));
  g = run(g, ticks);
  assert.equal(g.cap, "low", "the level read keeps the cap down for the whole pause");
});
