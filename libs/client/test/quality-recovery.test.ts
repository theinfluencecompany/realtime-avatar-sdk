import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG,
  initGovernor,
  step,
  type Governor,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";

const healthy: GovernorSignal = {
  paused: false,
  freezeMsInWindow: 0,
  jitterRising: false,
  connectionQuality: "excellent",
  inhibited: false,
};

function recover(governor: Governor, from: number, until: number): {
  governor: Governor; raisedAt: number | null;
} {
  for (let now = from; now <= until; now += 1_000) {
    const result = step(governor, healthy, now);
    governor = result.governor;
    if (result.action?.setCap === "high") return { governor, raisedAt: now };
  }
  return { governor, raisedAt: null };
}

test("a failed high opening recovers after the base hold, including its clean window", () => {
  const dropped = step(initGovernor(0, "high"), { ...healthy, paused: true }, 1_000);
  assert.deepEqual(dropped.action, { setCap: "low" });
  assert.equal(dropped.governor.failures, 1);
  const result = recover(dropped.governor, 2_000, 25_000);
  assert.equal(result.raisedAt, 9_000, "one failure should cost 8s, not 16s + another 3s");
  assert.equal(result.governor.state, "probing_up");
});

test("repeated failed probes retain exponential backoff and the 120s ceiling", () => {
  let governor = initGovernor(0, "high");
  let now = 1_000;
  for (const hold of [8_000, 16_000, 32_000, 64_000, 120_000, 120_000]) {
    governor = step(governor, { ...healthy, freezeMsInWindow: 120 }, now).governor;
    assert.equal(governor.cap, "low");
    const recovered = recover(governor, now + 1_000, now + hold + 10_000);
    assert.equal(recovered.raisedAt, now + hold);
    governor = recovered.governor;
    now = recovered.raisedAt! + 1_000;
  }
});

test("congestion near the end of the hold requires a new full clean window", () => {
  let governor = step(initGovernor(0, "high"), { ...healthy, paused: true }, 1_000).governor;
  governor = recover(governor, 2_000, 7_000).governor;
  governor = step(governor, { ...healthy, jitterRising: true }, 8_000).governor;
  const result = recover(governor, 9_000, 20_000);
  assert.equal(result.raisedAt, 12_000);
});

test("hidden or locally stalled time is not a healthy recovery window", () => {
  let governor = step(initGovernor(0, "high"), { ...healthy, paused: true }, 1_000).governor;
  governor = recover(governor, 2_000, 4_000).governor;
  const hidden = step(governor, { ...healthy, inhibited: true }, 5_000);
  assert.equal(hidden.action, undefined);
  assert.equal(hidden.governor.cap, "low");
  const result = recover(hidden.governor, 60_000, 65_000);
  assert.equal(result.raisedAt, 63_000);
});

test("poor quality never becomes permission to upgrade", () => {
  let governor = step(initGovernor(0, "high"), { ...healthy, paused: true }, 1_000).governor;
  for (let now = 2_000; now < 200_000; now += 1_000) {
    const result = step(governor, { ...healthy, connectionQuality: "poor" }, now);
    assert.equal(result.action, undefined);
    assert.equal(result.governor.cap, "low");
    governor = result.governor;
  }
});

test("clean high openings and the default low-opening policy remain unchanged", () => {
  let high = initGovernor(0, "high");
  for (let now = 1_000; now <= 30_000; now += 1_000) {
    const result = step(high, healthy, now);
    assert.equal(result.action, undefined);
    high = result.governor;
  }
  assert.equal(high.state, "cap_high_stable");
  assert.equal(DEFAULT_GOVERNOR_CONFIG.openingCap, "low");
  assert.equal(recover(initGovernor(0), 1_000, 10_000).raisedAt, 5_000);
});
