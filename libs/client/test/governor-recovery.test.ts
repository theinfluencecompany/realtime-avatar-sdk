import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  LOW_CAP_STEP_AFTER_UNHEALTHY,
  initGovernor,
  resolveLowCapQuality,
  step,
  type Governor,
  type GovernorConfig,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";

// ---------------------------------------------------------------------------
// RECOVERY WAS BROKEN. 0.11.5's isHealthy required freezeMsInWindow === 0, so any presented
// gap over the 100 ms floor reset the 3 s clean window while being far too small to demote.
// Measured on the 2026-09-11 probes: low-rung dwell 10-46 s against a designed 12 s + 3 s,
// 4 of 7 calls never recovered. Replayed with a 124 ms gap every 2 s: never re-raises in
// 58 s, ends with lowUnhealthy 29, which then ARMS THE BOTTOM RUNG for the next demote.
//
// Three rules fix it, all recovery-side (no demote decision changes; see the kill-switch
// test for that proof):
//   1. healthy = charged freeze within ONE FRAME INTERVAL of the slowest rung (67 ms at 15 fps)
//   2. a jitter flicker alone is not unhealthy (the consumer app's own playout hint moves jb_ms)
//   3. lowUnhealthy decays on TIME: two ticks must land inside lowUnhealthyWindowMs
// ---------------------------------------------------------------------------

/** 0.11.5 expressed as a config of the current reducer. */
const SHIPPED: GovernorConfig = {
  ...CFG,
  linkEvidence: "optional",
  healthyFreezeToleranceMs: 0,
  lowUnhealthyWindowMs: Number.POSITIVE_INFINITY,
};

const CLEAN: GovernorSignal = {
  paused: false,
  freezeMsInWindow: 0,
  jitterRising: false,
  connectionQuality: "excellent",
  inhibited: false,
};
const cleanPipe = { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 0 };
const lossy = (n: number) => ({ packetsLostInWindow: n, nacksInWindow: 0, framesDroppedInWindow: 0 });
const at = (
  state: Governor["state"], cap: Governor["cap"], failures = 0, enteredAtMs = 0, lowUnhealthy = 0,
): Governor => ({ state, cap, failures, enteredAtMs, healthySinceMs: null, lowUnhealthy });

/** The 58 s timeline: a committed demote at t=0, then a 124 ms gap (24 ms charged) plus one
 *  lost packet every 2 s; every other tick clean. */
const smallGapEvery2s = (cfg: GovernorConfig) => {
  const linkFreeze: GovernorSignal = { ...CLEAN, freezeMsInWindow: 500, transport: lossy(3) };
  let g = step(at("cap_high_stable", "high"), linkFreeze, 0, cfg).governor;
  assert.equal(g.state, "cap_low_sticky");
  assert.equal(g.failures, 0, "a committed demote books no failure");
  let raisedAtMs: number | null = null;
  for (let t = 1_000; t <= 58_000; t += 1_000) {
    const s: GovernorSignal = t % 2_000 === 0
      ? { ...CLEAN, freezeMsInWindow: 24, transport: lossy(1) }
      : { ...CLEAN, transport: cleanPipe };
    const r = step(g, s, t, cfg);
    g = r.governor;
    if (r.action?.setCap === "high" && raisedAtMs === null) raisedAtMs = t;
  }
  return { g, raisedAtMs };
};

test("the healthy band: a 124 ms gap with one lost packet every 2 s re-raises within 9 s and ends clean", () => {
  const { g, raisedAtMs } = smallGapEvery2s(CFG);
  assert.ok(raisedAtMs !== null && raisedAtMs <= 9_000, `re-raised at ${raisedAtMs} ms`);
  assert.equal(g.state, "cap_high_stable");
  assert.equal(g.lowUnhealthy, 0);
  assert.equal(CFG.healthyFreezeToleranceMs, 67, "one frame interval at 15 fps, the slowest declared rung");
  assert.ok(CFG.healthyFreezeToleranceMs < CFG.probationFreezeMs, "the band can never mask a demote");
});

test("...which is exactly what the shipped reducer could not do (never re-raised, lowUnhealthy 29)", () => {
  const { g, raisedAtMs } = smallGapEvery2s(SHIPPED);
  assert.equal(raisedAtMs, null);
  assert.equal(g.lowUnhealthy, 29);
  assert.equal(resolveLowCapQuality([0, 1, 2], g.lowUnhealthy), 0, "and the next demote would have gone to the bottom rung");
});

test("jitter rising ALONE on the low cap is healthy; jitter rising with a charged freeze is not", () => {
  const eligible: Governor = { ...at("cap_low_eligible", "low", 1, 0), healthySinceMs: 0 };
  const flicker = step(eligible, { ...CLEAN, jitterRising: true, transport: cleanPipe }, 1_000, CFG).governor;
  assert.equal(flicker.healthySinceMs, 0, "the clean window survives a jitter flicker");
  assert.equal(flicker.lowUnhealthy, 0);
  const corroborated = step(eligible, { ...CLEAN, jitterRising: true, freezeMsInWindow: 30, transport: lossy(1) }, 1_000, CFG).governor;
  assert.equal(corroborated.healthySinceMs, null);
  assert.equal(corroborated.lowUnhealthy, 1);
  // Unknown transport keeps the same clause shape: a jitter flicker with a 30 ms freeze is unhealthy.
  const unknown = step(eligible, { ...CLEAN, jitterRising: true, freezeMsInWindow: 30 }, 1_000, CFG).governor;
  assert.equal(unknown.lowUnhealthy, 1);
});

test("a charged freeze inside the band is healthy on the low cap; one past it is not", () => {
  const eligible: Governor = { ...at("cap_low_eligible", "low", 1, 0), healthySinceMs: 0 };
  const inside = step(eligible, { ...CLEAN, freezeMsInWindow: CFG.healthyFreezeToleranceMs, transport: lossy(1) }, 1_000, CFG).governor;
  assert.equal(inside.lowUnhealthy, 0);
  const past = step(eligible, { ...CLEAN, freezeMsInWindow: CFG.healthyFreezeToleranceMs + 1, transport: lossy(1) }, 1_000, CFG).governor;
  assert.equal(past.lowUnhealthy, 1);
});

test("lowUnhealthy decays on time: two link-charged ticks 15 s apart arm the MIDDLE rung, 4 s apart the BOTTOM", () => {
  const unhealthy: GovernorSignal = { ...CLEAN, freezeMsInWindow: 500, transport: lossy(2) };
  const eligible: Governor = { ...at("cap_low_eligible", "low", 1, 0), healthySinceMs: 0 };
  const walk = (secondAtMs: number): number => {
    let g = step(eligible, unhealthy, 1_000, CFG).governor;
    assert.equal(g.lowUnhealthy, 1);
    for (let t = 2_000; t < secondAtMs; t += 1_000) g = step(g, { ...CLEAN, transport: cleanPipe }, t, CFG).governor;
    // The clean run may have probed up; judge the SECOND unhealthy tick from the low cap again.
    g = { ...g, state: "cap_low_eligible", cap: "low", healthySinceMs: secondAtMs - 1_000 };
    return step(g, unhealthy, secondAtMs, CFG).governor.lowUnhealthy;
  };
  assert.equal(CFG.lowUnhealthyWindowMs, 10_000, "one probation cycle still counts as recent");
  assert.equal(walk(16_000), 1, "15 s apart: the first tick has expired");
  assert.equal(resolveLowCapQuality([0, 1, 2], walk(16_000)), 1);
  assert.equal(walk(5_000), LOW_CAP_STEP_AFTER_UNHEALTHY, "4 s apart: both inside the window");
  assert.equal(resolveLowCapQuality([0, 1, 2], walk(5_000)), 0);
});

test("the decay applies on cap_low_sticky too, and a surviving probe still resets the count", () => {
  const unhealthy: GovernorSignal = { ...CLEAN, freezeMsInWindow: 500, transport: lossy(2) };
  let g = at("cap_low_sticky", "low", 1, 0);
  g = step(g, unhealthy, 1_000, CFG).governor;
  g = step(g, unhealthy, 12_000, CFG).governor;
  assert.equal(g.lowUnhealthy, 1, "11 s apart on the sticky state: restarted, not accumulated");
  const survived = step(at("probing_up", "high", 1, 0, 2), { ...CLEAN, transport: cleanPipe }, CFG.probeMs, CFG).governor;
  assert.equal(survived.lowUnhealthy, 0);
  assert.equal(survived.lowUnhealthyAtMs, undefined);
});

test("the SFU pause still demotes on both bars with a clean pipe and zero freeze", () => {
  const paused: GovernorSignal = { ...CLEAN, paused: true, transport: cleanPipe };
  assert.equal(step(at("probing_up", "high"), paused, 5_000, CFG).action?.setCap, "low");
  assert.equal(step(at("opening_high", "high"), paused, 5_000, CFG).action?.setCap, "low");
  assert.equal(step(at("cap_high_stable", "high"), paused, 5_000, CFG).action?.setCap, "low");
});

test("the band can never mask the probation bar, and a bad number is clamped rather than thrown", () => {
  // initGovernor used to throw a RangeError here, and the hook's catch then ran the call with
  // NO governor at all — see governor-config-clamp.test.ts for the whole argument and for the
  // clamp's own tests. What matters here is that the invariant itself still holds.
  assert.doesNotThrow(() => initGovernor(0, "low", { ...CFG, healthyFreezeToleranceMs: CFG.probationFreezeMs }));
  const masked: GovernorConfig = { ...CFG, healthyFreezeToleranceMs: CFG.probationFreezeMs + 50 };
  const atBar: GovernorSignal = { ...CLEAN, freezeMsInWindow: CFG.probationFreezeMs, transport: lossy(1) };
  assert.equal(step(at("probing_up", "high"), atBar, 1_000, masked).action?.setCap, "low");
  assert.equal(initGovernor(0, "high").state, "opening_high", "the two-argument form still works");
});

// ---------------------------------------------------------------------------
// THE EVIDENCE MUST DECAY AT THE DEMOTE THAT CONSUMES IT.
//
// `lowUnhealthy` is not bookkeeping: the hook hands it straight to `resolveLowCapQuality`,
// so it is what CHOOSES the rung the demote lands on. The time decay only ran when the next
// unhealthy tick arrived, which is the one moment the count is about to grow anyway. At the
// moment it is actually SPENT — the demote — a pair of ticks from an episode 18 s earlier
// still selected the bottom rung, exactly as 0.11.5 did. Decaying on read fixes the half of
// the rule that was doing nothing.
// ---------------------------------------------------------------------------
test("a demote 18 s after the last unhealthy tick lands on the middle rung, not the bottom", () => {
  const unhealthy: GovernorSignal = { ...CLEAN, freezeMsInWindow: 500, transport: lossy(2) };
  const clean: GovernorSignal = { ...CLEAN, transport: cleanPipe };
  // Two unhealthy ticks on the low cap, then a long clean run that walks dwell → eligible →
  // probe, and a demote during the probation that follows.
  let g: Governor = at("cap_low_sticky", "low", 2, 0);
  g = step(g, unhealthy, 1_000, CFG).governor;
  g = step(g, unhealthy, 2_000, CFG).governor;
  assert.equal(g.lowUnhealthy, LOW_CAP_STEP_AFTER_UNHEALTHY, "the pair is on record");
  let raisedAtMs: number | null = null;
  for (let t = 3_000; t <= 19_000; t += 1_000) {
    const r = step(g, clean, t, CFG);
    g = r.governor;
    if (r.action?.setCap === "high" && raisedAtMs === null) raisedAtMs = t;
  }
  assert.ok(raisedAtMs !== null, "the clean run re-raised the cap");
  assert.equal(g.state, "probing_up", "still unproven, so the pair has not been reset by a commit");
  assert.equal(g.cap, "high");
  const demote = step(g, unhealthy, 20_000, CFG);
  assert.equal(demote.action?.setCap, "low");
  assert.equal(
    demote.governor.lowUnhealthy,
    0,
    "18 s is far outside lowUnhealthyWindowMs: that evidence is not about this episode",
  );
  assert.equal(resolveLowCapQuality([0, 1, 2], demote.governor.lowUnhealthy), 1, "so the demote lands on the middle rung");
  // 0.11.5 (and the first prototype) spent the stale pair and went to the bottom.
  const stale = step(g, unhealthy, 20_000, SHIPPED);
  assert.equal(stale.governor.lowUnhealthy, LOW_CAP_STEP_AFTER_UNHEALTHY);
  assert.equal(resolveLowCapQuality([0, 1, 2], stale.governor.lowUnhealthy), 0);
});

test("a demote inside the window still spends the evidence it was given", () => {
  const unhealthy: GovernorSignal = { ...CLEAN, freezeMsInWindow: 500, transport: lossy(2) };
  let g: Governor = at("cap_low_sticky", "low", 1, 0);
  g = step(g, unhealthy, 1_000, CFG).governor;
  g = step(g, unhealthy, 2_000, CFG).governor;
  // Straight back to a high cap (a rebind, or a probe we did not simulate) and a demote 4 s
  // later: the pair is still this episode's, so the bottom rung stays reachable.
  const onHigh: Governor = { ...g, state: "cap_high_stable", cap: "high", enteredAtMs: 2_000 };
  const demote = step(onHigh, unhealthy, 6_000, CFG);
  assert.equal(demote.action?.setCap, "low");
  assert.equal(demote.governor.lowUnhealthy, LOW_CAP_STEP_AFTER_UNHEALTHY);
  assert.equal(resolveLowCapQuality([0, 1, 2], demote.governor.lowUnhealthy), 0);
});
