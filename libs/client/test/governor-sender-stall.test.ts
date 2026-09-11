import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  LOW_CAP_STEP_AFTER_UNHEALTHY,
  isFreezeChargeable,
  LOCAL_STARVATION_DROPPED_FRAMES,
  resolveLowCapQuality,
  step,
  transportFromInboundRows,
  type Governor,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";

// ---------------------------------------------------------------------------
// A SENDER STALL IS NOT A LINK FREEZE.
//
// The governor's freeze feed is a gap in presented frames. On the rtx6000 pool with two
// sessions on one GPU the WORKER produces those gaps (per-chunk render median 351 ms vs
// 60 ms solo, "Frame capture was behind schedule", PUBLISH gap warnings), with packetsLost
// = 0 in every probe on 2026-09-11. A smaller simulcast rung does not make a stalled
// renderer faster; it only makes the picture smaller and then costs a layer switch on the
// way back. The receiver can tell the two apart from the RTP sequence space: a link that
// drops packets leaves sequence gaps (packetsLost, NACKs); a sender that pauses leaves none.
//
// These tests pin the fence. Every existing governor test is untouched because a signal
// WITHOUT transport evidence is charged exactly as before.
// ---------------------------------------------------------------------------

const CLEAN: GovernorSignal = {
  paused: false,
  freezeMsInWindow: 0,
  jitterRising: false,
  connectionQuality: "excellent",
  inhibited: false,
};
const cleanPipe = { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 0 };
const at = (
  state: Governor["state"], cap: Governor["cap"], failures = 0, enteredAtMs = 0, lowUnhealthy = 0,
): Governor => ({ state, cap, failures, enteredAtMs, healthySinceMs: null, lowUnhealthy });

/** A 600 ms presented gap: 500 ms over the floor, far past both freeze bars. */
const senderStall: GovernorSignal = { ...CLEAN, freezeMsInWindow: 500, transport: cleanPipe };
const linkFreezeLoss: GovernorSignal = {
  ...CLEAN, freezeMsInWindow: 500, transport: { packetsLostInWindow: 1, nacksInWindow: 0, framesDroppedInWindow: 0 },
};
const linkFreezeNack: GovernorSignal = {
  ...CLEAN, freezeMsInWindow: 500, transport: { packetsLostInWindow: 0, nacksInWindow: 1, framesDroppedInWindow: 0 },
};
const unknownTransport: GovernorSignal = { ...CLEAN, freezeMsInWindow: 500 };

test("the chargeability predicate: paused or any sequence gap charges; a clean pipe does not; unknown charges", () => {
  assert.equal(isFreezeChargeable(senderStall), false);
  assert.equal(isFreezeChargeable(linkFreezeLoss), true);
  assert.equal(isFreezeChargeable(linkFreezeNack), true);
  assert.equal(isFreezeChargeable(unknownTransport), true, "no counters read = today's behaviour");
  assert.equal(isFreezeChargeable({ ...senderStall, paused: true }), true, "the SFU has already ruled");
});

test("a sender stall does not demote an UNPROVEN high (probing_up / opening_high)", () => {
  for (const state of ["probing_up", "opening_high"] as const) {
    const { governor, action } = step(at(state, "high"), senderStall, 5_000, CFG);
    assert.equal(action, undefined, `${state}: no cap action on a clean pipe`);
    assert.equal(governor.cap, "high");
    assert.equal(governor.failures, 0, "and no failure is booked, so no dwell backoff is earned");
  }
});

test("a sender stall does not demote a COMMITTED high either", () => {
  const { governor, action } = step(at("cap_high_stable", "high"), senderStall, 60_000, CFG);
  assert.equal(action, undefined);
  assert.equal(governor.state, "cap_high_stable");
});

test("the same gap WITH a sequence gap still demotes, on both bars", () => {
  for (const s of [linkFreezeLoss, linkFreezeNack]) {
    const probing = step(at("probing_up", "high"), s, 5_000, CFG);
    assert.equal(probing.action?.setCap, "low");
    assert.equal(probing.governor.failures, 1);
    const committed = step(at("cap_high_stable", "high"), s, 60_000, CFG);
    assert.equal(committed.action?.setCap, "low");
    assert.equal(committed.governor.failures, 0, "a proven high that loses records no failure (unchanged)");
  }
});

test("the SFU pause stays authoritative even on a clean pipe", () => {
  const { action } = step(at("cap_high_stable", "high"), { ...CLEAN, paused: true, transport: cleanPipe }, 60_000, CFG);
  assert.equal(action?.setCap, "low");
});

test("unknown transport is charged exactly as before, so no existing trace changes", () => {
  const probing = step(at("probing_up", "high"), unknownTransport, 5_000, CFG);
  assert.equal(probing.action?.setCap, "low");
  assert.equal(probing.governor.failures, 1);
});

test("jitter rising plus a sender-shaped gap is not the committed-bar demote", () => {
  // isDowngrade's third clause (jitterRising && freeze > 0) reads the CHARGED freeze; a
  // stalled sender bursting after its gap can nudge the interval average up, which is
  // not congestion.
  const s: GovernorSignal = { ...CLEAN, freezeMsInWindow: 30, jitterRising: true, transport: cleanPipe };
  const { action } = step(at("cap_high_stable", "high"), s, 60_000, CFG);
  assert.equal(action, undefined);
});

test("the first-frame wait passes through the fence: a warming worker is not a starved link", () => {
  // #67's case, a HIGH opening on a 900 kbit / 10 % loss link, arrives with loss > 0 and
  // still demotes. A worker that takes 2.4 s to publish its first frame on a clean pipe
  // (measured on prod, #74) no longer books failures = 1 before the link carried anything.
  const wait1500ms = 500; // firstFrameWaitFreezeMs(1_500) with the 1 s grace
  const warming = step(at("opening_high", "high"), { ...CLEAN, freezeMsInWindow: wait1500ms, transport: cleanPipe }, 2_000, CFG);
  assert.equal(warming.action, undefined);
  assert.equal(warming.governor.failures, 0);
  const starved = step(at("opening_high", "high"), { ...CLEAN, freezeMsInWindow: wait1500ms, transport: { packetsLostInWindow: 12, nacksInWindow: 9, framesDroppedInWindow: 0 } }, 2_000, CFG);
  assert.equal(starved.action?.setCap, "low");
  assert.equal(starved.governor.failures, 1);
});

test("sender stalls on the low rung do not walk the cap to the bottom rung", () => {
  // `lowUnhealthy` is the walk to 180x316. It must be earned by the link.
  let g = at("cap_low_sticky", "low", 1, 0);
  for (let i = 0; i < LOW_CAP_STEP_AFTER_UNHEALTHY + 2; i++) {
    g = step(g, senderStall, 1_000 * (i + 1), CFG).governor;
  }
  assert.equal(g.lowUnhealthy, 0, "no low-rung evidence from a clean pipe");
  assert.equal(resolveLowCapQuality([0, 1, 2], g.lowUnhealthy), 1, "so the cap stays on the middle rung");
  // And the link-evidenced walk is unchanged.
  let h = at("cap_low_sticky", "low", 1, 0);
  for (let i = 0; i < LOW_CAP_STEP_AFTER_UNHEALTHY; i++) {
    h = step(h, linkFreezeLoss, 1_000 * (i + 1), CFG).governor;
  }
  assert.equal(resolveLowCapQuality([0, 1, 2], h.lowUnhealthy), 0);
});

test("a sender stall does not restart the clean window, so the climb back is not deferred by the worker", () => {
  const eligible: Governor = { ...at("cap_low_eligible", "low", 1, 0), healthySinceMs: 0 };
  const mid = step(eligible, senderStall, 2_000, CFG).governor;
  assert.equal(mid.healthySinceMs, 0, "the clean window survives a sender-shaped gap");
  const probe = step(mid, { ...CLEAN, transport: cleanPipe }, CFG.cleanMs, CFG);
  assert.equal(probe.action?.setCap, "high", "and the probe fires on schedule");
});

test("a high opening on a clean pipe with a slow worker commits at probeMs instead of falling", () => {
  // 0.11.5 arithmetic for the same opening: demote at the first tick past the 1 s grace,
  // failures = 1, dwell 6 s, clean 3 s, then a probe, then a layer switch. Here: nothing.
  let g = at("opening_high", "high", 0, 0);
  const ticks = [1_000, 2_000, 3_000]; // worker publishes its first frame at ~2.4 s
  const waits = [0, 1_000, 0]; // firstFrameWaitFreezeMs(2_000) = 1_000 at the 2 s tick
  ticks.forEach((t, i) => { g = step(g, { ...CLEAN, freezeMsInWindow: waits[i], transport: cleanPipe }, t, CFG).governor; });
  assert.equal(g.state, "opening_high");
  const committed = step(g, { ...CLEAN, transport: cleanPipe }, CFG.probeMs, CFG).governor;
  assert.equal(committed.state, "cap_high_stable");
});

// ---------------------------------------------------------------------------
// LOCAL STARVATION IS STILL CHARGEABLE. The fence must not undo 0.11.2 #71 ("a starving
// client falls to a floor"): a client whose decoder cannot keep up drops frames that DID
// arrive. That is the one failure a smaller rung fixes on a clean pipe, and inbound-rtp
// framesDropped is its counter. One drop a second is noise; two is the decoder.
// ---------------------------------------------------------------------------
const starvedClient: GovernorSignal = {
  ...CLEAN, freezeMsInWindow: 500,
  transport: { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: LOCAL_STARVATION_DROPPED_FRAMES },
};
const oneLateFrame: GovernorSignal = {
  ...CLEAN, freezeMsInWindow: 500,
  transport: { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 1 },
};

test("a starving client (clean pipe, frames dropped before decode) is still charged and demotes", () => {
  assert.equal(isFreezeChargeable(starvedClient), true);
  assert.equal(isFreezeChargeable(oneLateFrame), false, "a single late frame is layer-edge noise");
  const { governor, action } = step(at("cap_high_stable", "high"), starvedClient, 5_000, CFG);
  assert.equal(governor.state, "cap_low_sticky");
  assert.deepEqual(action, { setCap: "low" });
});

test("a starving client keeps walking lowUnhealthy toward the bottom rung; a sender stall does not", () => {
  const low = at("cap_low_eligible", "low", 1, 0, 0);
  const afterStarved = step(low, starvedClient, 1_000, CFG).governor;
  assert.equal(afterStarved.lowUnhealthy, 1);
  const afterSender = step(low, senderStall, 1_000, CFG).governor;
  assert.equal(afterSender.lowUnhealthy, 0);
  assert.equal(resolveLowCapQuality([0, 1, 2], LOCAL_STARVATION_DROPPED_FRAMES), 0);
});

// ---------------------------------------------------------------------------
// TRANSPORT PROVENANCE. The fence is only as honest as the hook's reading of the
// counters. Three cases the first prototype got backwards or left implicit, pinned here
// against the pure `transportFromInboundRows` the hook now calls.
// ---------------------------------------------------------------------------
test("a report with NO inbound-rtp video row is a receiver that has received nothing: a clean pipe", () => {
  // The join-time first-frame wait: nothing has arrived, so nothing was lost.
  const { transport, cursor } = transportFromInboundRows([], null);
  assert.deepEqual(transport, cleanPipe);
  assert.equal(cursor, null, "no baseline is stored from an empty report");
  const audioOnly = transportFromInboundRows([{ kind: "audio", packetsLost: 40 }], null);
  assert.deepEqual(audioOnly.transport, cleanPipe, "an audio row is not our pipe");
});

test("a row WITHOUT packetsLost is unknown transport, so the freeze is charged as 0.11.5 did", () => {
  const { transport, cursor } = transportFromInboundRows([{ kind: "video", nackCount: 3 }], null);
  assert.equal(transport, undefined);
  assert.equal(cursor, null);
  assert.equal(isFreezeChargeable({ ...CLEAN, freezeMsInWindow: 500 }), true);
});

test("the first read of a binding is baseline-only; the second yields deltas", () => {
  const first = transportFromInboundRows([{ kind: "video", packetsLost: 120, nackCount: 30, framesDropped: 4 }], null);
  assert.deepEqual(first.transport, cleanPipe, "a rebind onto a receiver with history must not charge its lifetime loss");
  assert.deepEqual(first.cursor, { lost: 120, nack: 30, dropped: 4 });
  const second = transportFromInboundRows([{ kind: "video", packetsLost: 123, nackCount: 30 }], first.cursor);
  assert.deepEqual(second.transport, { packetsLostInWindow: 3, nacksInWindow: 0, framesDroppedInWindow: 0 });
  assert.deepEqual(second.cursor, { lost: 123, nack: 30, dropped: 0 }, "nackCount / framesDropped default to 0 when absent");
  // Counters that go backwards (a receiver reset) never produce a negative window.
  const reset = transportFromInboundRows([{ kind: "video", packetsLost: 0 }], second.cursor);
  assert.deepEqual(reset.transport, cleanPipe);
});
