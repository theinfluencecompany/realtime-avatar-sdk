import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameRecovery } from "../src/react/frame-recovery.ts";

test("a new track presents its first frame without a recovery delay", () => {
  const recovery = new FrameRecovery(800);
  assert.equal(recovery.frame(10_000), true);
  assert.equal(recovery.frame(10_040), true);
});

test("isolated frames and short bursts never lift a stall", () => {
  const recovery = new FrameRecovery(800);
  recovery.frame(0);
  recovery.stall();
  for (let burst = 1; burst <= 5; burst++) {
    for (let offset = 0; offset < 180; offset += 40) {
      assert.equal(recovery.frame(burst * 1_400 + offset), false);
    }
    // A timer waiting 500ms without another frame cannot make recovery ready.
    assert.equal(recovery.ready, false);
  }
});

test("sustained 25fps progress returns to live within 520ms", () => {
  const recovery = new FrameRecovery(800);
  recovery.frame(0);
  recovery.stall();
  for (let offset = 0; offset < 520; offset += 40) {
    assert.equal(recovery.frame(2_000 + offset), false);
  }
  assert.equal(recovery.frame(2_520), true);
});

test("a new gap restarts the clean recovery window", () => {
  const recovery = new FrameRecovery(800);
  recovery.frame(0);
  recovery.stall();
  for (const time of [1_000, 1_100, 1_200, 1_600, 1_700, 1_800, 1_900, 2_000]) {
    assert.equal(recovery.frame(time), false);
  }
  assert.equal(recovery.frame(2_100), true);
});

test("a delayed watchdog or same-track mute cannot bypass recovery", () => {
  const recovery = new FrameRecovery(800);
  recovery.frame(0);
  // No stall() tick: the browser was suspended or the observing effect rebound.
  assert.equal(recovery.frame(1_300), false);
  assert.equal(recovery.frame(1_340), false);
  assert.equal(recovery.frame(2_600), false);
});

test("hidden-layer currentTime polling can recover despite scheduling jitter", () => {
  const recovery = new FrameRecovery(800);
  recovery.frame(0);
  recovery.stall();
  assert.equal(recovery.frame(2_000), false);
  assert.equal(recovery.frame(2_260), false);
  assert.equal(recovery.frame(2_520), true);
});

test("normal frame spacing and gaps below the watchdog preserve live", () => {
  const recovery = new FrameRecovery(800);
  for (const time of [0, 67, 134, 400, 800, 1_600]) {
    assert.equal(recovery.frame(time), true);
  }
  recovery.stall();
  assert.equal(recovery.frame(1_640), false);
});
