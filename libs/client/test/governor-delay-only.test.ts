import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  initGovernor,
  step,
  type Governor,
  type GovernorConfig,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";

// ---------------------------------------------------------------------------
// DELAY-ONLY CONGESTION: THE CLASS THE FENCE CANNOT SEE.
//
// The transport fence reads the RTP sequence space, and a link that degrades by DELAY alone
// leaves no mark there: a bloated buffer or a shaped uplink delivers every packet, late. No
// loss, no NACKs, no framesDropped, and the SFU may never pause us. Under the fence such a
// link would ride out the whole call on the top rung while the picture stutters, which is a
// real regression against 0.11.5 (where any freeze demoted).
//
// The bounded path back: jitterBufferDelay rising for N CONSECUTIVE ticks WHILE presented
// frames are actually being missed. Both halves are load-bearing.
//   - jitter alone is not enough: the app's own adaptive playout hint moves the jitter-buffer
//     average, so a flicker must never demote (that is the 2026-09-11 recovery bug).
//   - a gap alone is not enough: that is the sender stall the fence exists to refuse.
//   - N = 3 (`jitterRisingTicksToDemote`) is the deliberate trade. One tick is a flicker; at
//     1 s ticks, three consecutive rises with gaps every tick is ~3 s of sustained
//     degradation before the cap moves, against 0.11.5's one tick and against the fence's
//     never. It is a DELAY, not a refusal.
// The freeze read here is the RAW presented gap, not the link-charged one: a delay-only link
// is by definition not chargeable, so charging it would make the clause dead code.
// ---------------------------------------------------------------------------

const base: GovernorSignal = {
  paused: false,
  freezeMsInWindow: 0,
  jitterRising: false,
  connectionQuality: "excellent",
  inhibited: false,
};
const cleanPipe = { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 0 };
/** A delayed-but-complete link: frames arrive late, nothing is lost, the SFU says nothing. */
const delayed = (gapMs: number): GovernorSignal => ({ ...base, jitterRising: true, freezeMsInWindow: gapMs, transport: cleanPipe });

const committed = (): Governor => ({ state: "cap_high_stable", cap: "high", failures: 0, lowUnhealthy: 0, enteredAtMs: 0, healthySinceMs: null });

const drive = (timeline: GovernorSignal[], cfg: GovernorConfig = CFG): { tMs: number; setCap: string }[] => {
  let g = committed();
  const actions: { tMs: number; setCap: string }[] = [];
  timeline.forEach((s, i) => {
    const tMs = (i + 1) * 1_000;
    const r = step(g, s, tMs, cfg);
    g = r.governor;
    if (r.action) actions.push({ tMs, setCap: r.action.setCap });
  });
  return actions;
};

test("N is a named constant and defaults to 3", () => {
  assert.equal(CFG.jitterRisingTicksToDemote, 3);
});

test("two consecutive rising ticks do NOT demote; the third does", () => {
  assert.deepEqual(drive([delayed(40), delayed(40)]), [], "two ticks is not a trend");
  assert.deepEqual(drive([delayed(40), delayed(40), delayed(40)]), [{ tMs: 3_000, setCap: "low" }]);
});

test("a single spike does not demote, and a run that breaks restarts the count", () => {
  assert.deepEqual(drive([delayed(500), base, delayed(500), base, delayed(500), base]), [], "isolated spikes");
  // Two rises, a clean tick, then two more: still no three in a row.
  assert.deepEqual(drive([delayed(40), delayed(40), { ...base, transport: cleanPipe }, delayed(40), delayed(40)]), []);
});

test("rising jitter WITHOUT a presented gap never demotes, however long it runs", () => {
  // the consumer app's own adaptive playout hint walks the jitter-buffer average up for minutes.
  const noGap = Array.from({ length: 60 }, () => ({ ...base, jitterRising: true, transport: cleanPipe }));
  assert.deepEqual(drive(noGap), []);
});

test("a presented gap WITHOUT rising jitter is still a sender stall, and is still refused", () => {
  const senderStall = Array.from({ length: 60 }, () => ({ ...base, freezeMsInWindow: 500, transport: cleanPipe }));
  assert.deepEqual(drive(senderStall), [], "the fence's whole purpose survives");
});

test("the demote is a delay, not a refusal, and the link then rides the ordinary ladder", () => {
  const actions = drive(Array.from({ length: 40 }, () => delayed(40)));
  assert.deepEqual(actions[0], { tMs: 3_000, setCap: "low" }, "three ticks of evidence, then the cap moves");
  // A delay-only link is INVISIBLE to isHealthy (a clean pipe charges nothing), so the low
  // cap looks healthy and the governor re-probes on schedule. That is the same ladder every
  // other bad link rides, and the failure backoff is what bounds it: each re-probe is killed
  // by three fresh ticks, books a failure, and doubles the dwell before the next one.
  const probes = actions.filter((a) => a.setCap === "high");
  assert.ok(probes.length >= 2, `${probes.length} re-probes in 40 s`);
  const answered = probes
    .map((probe) => actions.find((a) => a.setCap === "low" && a.tMs > probe.tMs))
    .filter((a): a is { tMs: number; setCap: string } => a !== undefined);
  assert.ok(answered.length >= 2, "the probes are answered, not left up");
  for (const [i, answer] of answered.entries()) {
    assert.equal(
      answer.tMs - probes[i].tMs,
      3_000,
      "each probation is judged on its OWN three ticks, never on evidence from the previous rung",
    );
  }
  // The dwell backoff makes the cycle longer every time instead of flapping at a fixed rate.
  const gaps = probes.slice(1).map((p, i) => p.tMs - probes[i].tMs);
  assert.ok(gaps.every((gap, i) => i === 0 || gap >= gaps[i - 1]), `probe spacing ${gaps.join(",")} never tightens`);
});

test("the count is off in legacy mode, where the bare jitter clause already demotes", () => {
  const OPTIONAL: GovernorConfig = { ...CFG, linkEvidence: "optional" };
  // 0.11.5 demotes on the FIRST tick here (jitterRising && freeze > 0 is its own clause), so
  // the new path must not exist there or it would change 0.11.5's timing.
  assert.deepEqual(drive([delayed(40), delayed(40), delayed(40)], OPTIONAL), [{ tMs: 1_000, setCap: "low" }]);
});

test("N is configurable and the reducer honours it", () => {
  const strict: GovernorConfig = { ...CFG, jitterRisingTicksToDemote: 5 };
  assert.deepEqual(drive(Array.from({ length: 4 }, () => delayed(40)), strict), []);
  assert.deepEqual(drive(Array.from({ length: 5 }, () => delayed(40)), strict), [{ tMs: 5_000, setCap: "low" }]);
});

test("the inhibited fence still wins: a hidden tab cannot accumulate the run", () => {
  const hidden = { ...delayed(40), inhibited: true };
  assert.deepEqual(drive([hidden, hidden, hidden, hidden]), [], "no signal is trusted while inhibited");
  // And an inhibited tick in the middle does not extend a run across it.
  assert.deepEqual(drive([delayed(40), delayed(40), hidden, delayed(40)]), []);
});

test("an unproven high is judged by the same run, and records the failure", () => {
  // The probation bar reads the CHARGED freeze, and a delay-only link charges nothing — so
  // the strict bar cannot see this class either. The run is the only path, on probation as
  // on a committed cap, and losing an unproven high still books a failure.
  let g = initGovernor(0, "high", CFG);
  const actions: { tMs: number; setCap: string }[] = [];
  for (let i = 1; i <= 4; i++) {
    const r = step(g, delayed(CFG.probationFreezeMs), i * 1_000, CFG);
    g = r.governor;
    if (r.action) actions.push({ tMs: i * 1_000, setCap: r.action.setCap });
  }
  assert.deepEqual(actions, [{ tMs: 3_000, setCap: "low" }]);
  assert.equal(g.failures, 1, "an unproven high that could not be held is remembered");
  assert.equal(g.state, "cap_low_sticky");
});
