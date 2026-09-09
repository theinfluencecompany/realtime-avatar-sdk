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

// ── StallEscalation: the hold steps up once the link has flapped, and decays on its own ──
import {
  AVATAR_UNSTABLE_LINK_STALLS,
  AVATAR_UNSTABLE_LINK_WINDOW_MS,
  DEFAULT_AVATAR_UNSTABLE_STALL_MS,
  StallEscalation,
} from "../src/react/frame-recovery.ts";

test("a fresh track uses the base threshold", () => {
  const policy = new StallEscalation(2_000);
  assert.equal(policy.thresholdMs(0), 2_000);
  assert.equal(policy.unstable(0), false);
});

test("one stall is not an unstable link", () => {
  const policy = new StallEscalation(2_000);
  policy.recordStall(1_000);
  assert.equal(policy.thresholdMs(1_000), 2_000);
  assert.equal(policy.thresholdMs(5_000), 2_000);
});

test("two stalls inside the window escalate to the unstable hold", () => {
  const policy = new StallEscalation(2_000);
  policy.recordStall(1_000);
  policy.recordStall(6_000);
  assert.equal(AVATAR_UNSTABLE_LINK_STALLS, 2);
  assert.equal(policy.thresholdMs(6_000), DEFAULT_AVATAR_UNSTABLE_STALL_MS);
  assert.equal(policy.unstable(6_000), true);
});

test("escalation decays once the older stall leaves the window", () => {
  const policy = new StallEscalation(2_000);
  policy.recordStall(1_000);
  policy.recordStall(6_000);
  const justInside = 1_000 + AVATAR_UNSTABLE_LINK_WINDOW_MS;
  assert.equal(policy.thresholdMs(justInside), DEFAULT_AVATAR_UNSTABLE_STALL_MS);
  assert.equal(policy.thresholdMs(justInside + 1), 2_000);
});

test("a third stall while escalated keeps the hold up for a fresh window", () => {
  const policy = new StallEscalation(2_000);
  policy.recordStall(1_000);
  policy.recordStall(6_000);
  policy.recordStall(12_000);
  // 1_000 has dropped out, but 6_000 + 12_000 still count.
  assert.equal(policy.thresholdMs(20_000), DEFAULT_AVATAR_UNSTABLE_STALL_MS);
  assert.equal(policy.thresholdMs(21_001), 2_000);
});

test("escalation never lowers a base threshold above the unstable hold", () => {
  const policy = new StallEscalation(6_000);
  policy.recordStall(0);
  policy.recordStall(100);
  assert.equal(policy.thresholdMs(100), 6_000);
});

test("the recovery gap detector follows the threshold it is handed", () => {
  const recovery = new FrameRecovery(2_000);
  recovery.frame(0);
  // A 3s gap trips the base threshold …
  assert.equal(recovery.frame(3_000), false);
  // … but not the escalated one: hand the recovery the escalated threshold first.
  const escalated = new FrameRecovery(2_000);
  escalated.frame(0);
  escalated.stallAfterMs = DEFAULT_AVATAR_UNSTABLE_STALL_MS;
  assert.equal(escalated.frame(3_000), true);
});

// ── first-frame wait: a HIGH opening that never decodes must read as a freeze ──
import { AVATAR_FIRST_FRAME_GRACE_MS, firstFrameWaitFreezeMs } from "../src/react/frame-recovery.ts";

test("a first keyframe inside the grace is not a freeze", () => {
  assert.equal(firstFrameWaitFreezeMs(0), 0);
  assert.equal(firstFrameWaitFreezeMs(400), 0);
  assert.equal(firstFrameWaitFreezeMs(AVATAR_FIRST_FRAME_GRACE_MS), 0);
});

test("waiting past the grace counts every millisecond as frozen", () => {
  assert.equal(firstFrameWaitFreezeMs(AVATAR_FIRST_FRAME_GRACE_MS + 1), 1);
  // Two seconds without a keyframe clears the governor's probation bar (100 ms) many times over.
  assert.ok(firstFrameWaitFreezeMs(2_000) >= 100);
});

test("a nonsense wait is not a freeze", () => {
  assert.equal(firstFrameWaitFreezeMs(Number.NaN), 0);
  assert.equal(firstFrameWaitFreezeMs(-5), 0);
});
