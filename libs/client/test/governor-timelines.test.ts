import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  initGovernor,
  step,
  type GovernorConfig,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";
import { firstFrameWaitFreezeMs } from "../src/react/frame-recovery.ts";

// ---------------------------------------------------------------------------
// WHOLE-CALL TIMELINES through the pure reducer: the shapes the 2026-09-11 forensics found,
// each run under the current defaults and under 0.11.5-as-config. What must move (clean-pipe
// sender stalls, the first-frame wait) and what must NOT (loss, the SFU pause, a late-landing
// outage) are pinned side by side.
// ---------------------------------------------------------------------------

const SHIPPED: GovernorConfig = {
  ...CFG, linkEvidence: "optional", healthyFreezeToleranceMs: 0, lowUnhealthyWindowMs: Number.POSITIVE_INFINITY,
};
const base: GovernorSignal = { paused: false, freezeMsInWindow: 0, jitterRising: false, connectionQuality: "excellent", inhibited: false };
const cleanPipe = { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 0 };
const lossy = (n: number) => ({ packetsLostInWindow: n, nacksInWindow: 0, framesDroppedInWindow: 0 });

type Run = { actions: { tMs: number; setCap: "low" | "high" }[]; final: ReturnType<typeof initGovernor> };
const run = (timeline: GovernorSignal[], cfg: GovernorConfig, openingCap: "high" | "low" = "high"): Run => {
  let g = initGovernor(0, openingCap, cfg);
  const actions: Run["actions"] = [];
  timeline.forEach((s, i) => {
    const tMs = (i + 1) * 1_000;
    const r = step(g, s, tMs, cfg);
    g = r.governor;
    if (r.action) actions.push({ tMs, setCap: r.action.setCap });
  });
  return { actions, final: g };
};
const demotes = (r: Run) => r.actions.filter((a) => a.setCap === "low");
const stripTransport = (t: GovernorSignal[]) => t.map(({ transport: _x, ...s }) => s);

// T6: the #67 regression. A HIGH opening on a 10 % loss link must still be demoted at the
// first tick past the first-frame grace, with a failure on record.
test("#67 still holds: a starved HIGH opening (loss on every tick) demotes at tick 2 with failures = 1", () => {
  const firstFrameAtMs = 3_000;
  const timeline: GovernorSignal[] = Array.from({ length: 6 }, (_, i) => {
    const tMs = (i + 1) * 1_000;
    return { ...base, freezeMsInWindow: tMs < firstFrameAtMs ? firstFrameWaitFreezeMs(tMs) : 0, transport: lossy(12) };
  });
  const r = run(timeline, CFG);
  assert.deepEqual(r.actions[0], { tMs: 2_000, setCap: "low" }, "tick 1 is inside the 1000 ms grace; tick 2 books 1000 ms");
  assert.equal(r.final.failures, 1);
});

// T9a
test("a 9.5 s first-frame wait on a clean pipe commits the HIGH opening at 10 s with no failure", () => {
  const timeline: GovernorSignal[] = Array.from({ length: 12 }, (_, i) => {
    const tMs = (i + 1) * 1_000;
    return { ...base, freezeMsInWindow: tMs <= 9_500 ? firstFrameWaitFreezeMs(tMs) : 0, transport: cleanPipe };
  });
  const r = run(timeline, CFG);
  assert.deepEqual(r.actions, []);
  assert.equal(r.final.state, "cap_high_stable");
  assert.equal(r.final.failures, 0);
  // The same opening under 0.11.5: demoted at 2 s, failures 1, and a climb back to pay for.
  const shipped = run(stripTransport(timeline), SHIPPED);
  assert.deepEqual(shipped.actions[0], { tMs: 2_000, setCap: "low" });
  assert.equal(shipped.final.failures, 1);
});

// T9b
test("a 300-540 ms sender gap every 10 s for 120 s on a clean pipe produces zero cap actions (shipped: 5-10)", () => {
  const gaps = [300, 420, 540, 360, 480]; // presented gap, ms
  const timeline: GovernorSignal[] = Array.from({ length: 120 }, (_, i) => ({
    ...base,
    freezeMsInWindow: (i + 1) % 10 === 0 ? gaps[((i + 1) / 10) % gaps.length] - 100 : 0,
    transport: cleanPipe,
  }));
  const fenced = run(timeline, CFG);
  assert.deepEqual(fenced.actions, []);
  assert.equal(fenced.final.state, "cap_high_stable");
  const shipped = demotes(run(stripTransport(timeline), SHIPPED)).length;
  assert.ok(shipped >= 5 && shipped <= 10, `shipped demoted ${shipped} times`);
});

// T9c
test("a 10 % loss link (loss on every tick, 300 ms freezes) demotes within one tick of the bar", () => {
  const timeline: GovernorSignal[] = Array.from({ length: 5 }, () => ({ ...base, freezeMsInWindow: 300, transport: lossy(9) }));
  for (const opening of ["high", "low"] as const) {
    const r = run(timeline, CFG, opening);
    if (opening === "high") assert.deepEqual(r.actions[0], { tMs: 1_000, setCap: "low" });
    else assert.equal(r.final.cap, "low", "a low opening stays low");
  }
  // From a committed high the looser bar applies, and 300 ms clears it on the first tick.
  const committed = step(
    { state: "cap_high_stable", cap: "high", failures: 0, lowUnhealthy: 0, enteredAtMs: 0, healthySinceMs: null },
    timeline[0], 1_000, CFG,
  );
  assert.equal(committed.action?.setCap, "low");
});

// T9d
test("an outage whose loss counters land one tick late demotes at most 1 s after the shipped reducer", () => {
  // The freeze is seen in tick 3; the receiver's packetsLost catches up in tick 4.
  const timeline: GovernorSignal[] = [
    { ...base, transport: cleanPipe },
    { ...base, transport: cleanPipe },
    { ...base, freezeMsInWindow: 600, transport: cleanPipe },
    { ...base, freezeMsInWindow: 600, transport: lossy(40) },
    { ...base, freezeMsInWindow: 600, transport: lossy(40) },
  ];
  const fenced = demotes(run(timeline, CFG))[0];
  const shipped = demotes(run(stripTransport(timeline), SHIPPED))[0];
  assert.equal(shipped.tMs, 3_000);
  assert.equal(fenced.tMs, 4_000);
  assert.ok(fenced.tMs - shipped.tMs <= 1_000);
});

// T9e
test("transport unknown on every one of these timelines is identical to the fence being off", () => {
  const make = (): GovernorSignal[][] => [
    Array.from({ length: 120 }, (_, i) => ({ ...base, freezeMsInWindow: (i + 1) % 10 === 0 ? 400 : 0, transport: cleanPipe })),
    Array.from({ length: 30 }, () => ({ ...base, freezeMsInWindow: 300, transport: lossy(9) })),
    Array.from({ length: 12 }, (_, i) => ({ ...base, freezeMsInWindow: firstFrameWaitFreezeMs((i + 1) * 1_000), transport: cleanPipe })),
  ];
  const OFF: GovernorConfig = { ...CFG, linkEvidence: "optional" };
  for (const t of make()) {
    assert.deepEqual(run(stripTransport(t), CFG), run(t, OFF));
  }
});
