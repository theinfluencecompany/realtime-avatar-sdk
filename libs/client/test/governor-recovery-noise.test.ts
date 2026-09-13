import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  RECOVERY_FREEZE_NOISE_MS,
  initGovernor,
  step,
  stepNativeFreezeCounter,
  type Governor,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";

const CLEAN: GovernorSignal = {
  paused: false, freezeMsInWindow: 0, jitterRising: false,
  connectionQuality: "excellent", inhibited: false,
};
const eligible: Governor = {
  ...initGovernor(0), state: "cap_low_eligible", healthySinceMs: 0,
};

for (const noise of [1, 4, RECOVERY_FREEZE_NOISE_MS]) {
  test(`${noise}ms callback residue preserves the 3s recovery window with native zero`, () => {
    let governor = eligible;
    for (const now of [1000, 2000, 3000]) {
      const result = step(governor, {
        ...CLEAN, freezeMsInWindow: noise, nativeFreezeMsInWindow: 0,
      }, now);
      assert.equal(result.action?.setCap, now === 3000 ? "high" : undefined);
      assert.equal(result.governor.lowUnhealthy, 0);
      governor = result.governor;
    }
  });
}

for (const [label, signal] of Object.entries({
  "above noise budget": { freezeMsInWindow: RECOVERY_FREEZE_NOISE_MS + 1, nativeFreezeMsInWindow: 0 },
  "missing native stats": { freezeMsInWindow: 1 },
  "native freeze": { freezeMsInWindow: 4, nativeFreezeMsInWindow: 1 },
  "invalid native stats": { freezeMsInWindow: 4, nativeFreezeMsInWindow: NaN },
  "paused track": { freezeMsInWindow: 4, nativeFreezeMsInWindow: 0, paused: true },
  "rising jitter": { freezeMsInWindow: 4, nativeFreezeMsInWindow: 0, jitterRising: true },
  "poor connection": { freezeMsInWindow: 4, nativeFreezeMsInWindow: 0, connectionQuality: "poor" as const },
  "lost connection": { freezeMsInWindow: 4, nativeFreezeMsInWindow: 0, connectionQuality: "lost" as const },
  "invalid estimate": { freezeMsInWindow: NaN, nativeFreezeMsInWindow: 0 },
  "negative estimate": { freezeMsInWindow: -1, nativeFreezeMsInWindow: 0 },
})) {
  test(`${label} still resets recovery`, () => {
    const result = step(eligible, { ...CLEAN, ...signal }, CFG.cleanMs);
    assert.equal(result.action, undefined);
    assert.equal(result.governor.healthySinceMs, null);
    assert.equal(result.governor.lowUnhealthy, 1);
  });
}

test("opening and post-failure dwell are unchanged; micro-noise no longer extends them", () => {
  const noisy = { ...CLEAN, freezeMsInWindow: 4, nativeFreezeMsInWindow: 0 };
  let governor = step(initGovernor(0, "high"), { ...CLEAN, paused: true }, 1000).governor;
  for (let now = 2000; now <= 9000; now += 1000) {
    const result = step(governor, noisy, now);
    assert.equal(result.action, undefined);
    assert.equal(result.governor.lowUnhealthy, 0);
    governor = result.governor;
  }
  assert.equal(step(governor, noisy, 10000).action?.setCap, "high");
  assert.equal(step(initGovernor(0), noisy, 1999).governor.state, "opening");
  assert.equal(step(initGovernor(0), noisy, 2000).governor.state, "cap_low_eligible");
});

test("high-state behavior is identical regardless of native-zero corroboration", () => {
  for (const state of ["opening_high", "probing_up", "cap_high_stable"] as const) {
    for (const freezeMsInWindow of [0, 1, 4, 25, 26, 99, 100, 149, 150, 500]) {
      for (const jitterRising of [false, true]) {
        const governor = { ...initGovernor(0, "high"), state };
        const signal = { ...CLEAN, freezeMsInWindow, jitterRising };
        assert.deepEqual(
          step(governor, { ...signal, nativeFreezeMsInWindow: 0 }, 10000),
          step(governor, signal, 10000),
        );
      }
    }
  }
});

test("native confirmation requires fresh monotonic counters on the same report", () => {
  const sample = { id: "video-1", timestampMs: 1000, totalMs: 100 };
  assert.equal(stepNativeFreezeCounter(null, sample).freezeMs, undefined);
  assert.equal(stepNativeFreezeCounter(sample, { ...sample, timestampMs: 2000 }).freezeMs, 0);
  assert.equal(stepNativeFreezeCounter(sample, {
    ...sample, timestampMs: 2000, totalMs: 104,
  }).freezeMs, 4);
  for (const current of [
    null, sample, { ...sample, timestampMs: 999 },
    { ...sample, timestampMs: 2000, totalMs: 0 },
    { ...sample, timestampMs: 2000, id: "video-2" },
    { ...sample, timestampMs: NaN }, { ...sample, totalMs: NaN },
    { ...sample, totalMs: -1 }, { ...sample, id: "" },
  ]) assert.equal(stepNativeFreezeCounter(sample, current).freezeMs, undefined);
  const missing = stepNativeFreezeCounter(sample, null);
  assert.equal(stepNativeFreezeCounter(missing.state, { ...sample, timestampMs: 3000 }).freezeMs, undefined);
});
