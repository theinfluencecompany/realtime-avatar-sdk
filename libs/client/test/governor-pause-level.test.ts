import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  initGovernor,
  pausedForTick,
  step,
  type GovernorAction,
  type GovernorSignal,
  type PauseLevel,
} from "../src/react/quality-governor.ts";

// ---------------------------------------------------------------------------
// THE SFU PAUSE IS A LEVEL, NOT AN EDGE.
//
// `TrackStreamStateChanged` fires ONCE when the SFU's congestion controller pauses the
// track, and again when it resumes. The hook latched that single event into a flag and
// CONSUMED it at the next tick, so a pause that is still in force reads as clean from tick
// 2 onward: the transport fence charges nothing (a paused sender loses no packets), every
// remaining tick is healthy, and the governor walks the clean window to completion and
// PROBES UP into a track the SFU has already refused to forward.
//
// Replayed below: with the edge semantics a held pause reaches `setCap high` at 5 s. Reading
// the level at tick time (`track.streamState === Paused`) cannot do that, because the pause
// is still true on every tick it is true.
// ---------------------------------------------------------------------------

const CLEAN: GovernorSignal = {
  paused: false,
  freezeMsInWindow: 0,
  jitterRising: false,
  connectionQuality: "excellent",
  inhibited: false,
};
const cleanPipe = { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 0 };

/** How the shipped hook read the pause: the latched event only (use-quality-governor 0.11.5
 *  + the prototype, `pausedSinceTick` set in the handler and cleared after every step). */
const edgeOnly = (_level: PauseLevel, edgeSinceLastTick: boolean): boolean => edgeSinceLastTick;

type Run = { actions: { tMs: number; setCap: GovernorAction["setCap"] }[] };

/** Eight ticks of a HELD pause: the SFU paused before tick 1 and never resumed, so the event
 *  fires exactly once and the level is "paused" on every tick. */
const heldPause = (
  read: (level: PauseLevel, edge: boolean) => boolean,
  openingCap: "low" | "high",
): Run => {
  let g = initGovernor(0, openingCap, CFG);
  const actions: Run["actions"] = [];
  for (let i = 1; i <= 8; i++) {
    const tMs = i * 1_000;
    const s: GovernorSignal = { ...CLEAN, paused: read("paused", i === 1), transport: cleanPipe };
    const r = step(g, s, tMs, CFG);
    g = r.governor;
    if (r.action) actions.push({ tMs, setCap: r.action.setCap });
  }
  return { actions };
};

test("a HELD pause never probes up, and still demotes on tick 1", () => {
  // The demote: an unproven high is killed by the pause on the very first tick, exactly as
  // before. Reading the level cannot delay a down decision; the edge is still true there.
  const demoting = heldPause(pausedForTick, "high");
  assert.deepEqual(demoting.actions, [{ tMs: 1_000, setCap: "low" }]);

  // The probe: eight ticks of a pause that is still in force must never raise the cap.
  const held = heldPause(pausedForTick, "low");
  assert.deepEqual(held.actions, [], "a paused track is never eligible for a cap raise");
});

test("...which is exactly what the edge semantics did: setCap high at 5 s into a paused track", () => {
  const shipped = heldPause(edgeOnly, "low");
  assert.deepEqual(
    shipped.actions,
    [{ tMs: 5_000, setCap: "high" }],
    "openingDwellMs 2 s + cleanMs 3 s of a pause the reducer was told had ended",
  );
  // And the same timeline from a HIGH opening: the edge demotes once and then the pause is
  // invisible, so the machine treats the rest of the outage as a healthy low cap.
  assert.deepEqual(heldPause(edgeOnly, "high").actions, [{ tMs: 1_000, setCap: "low" }]);
});

test("the level wins, and the event stays a fast path for a pause that came and went", () => {
  assert.equal(pausedForTick("paused", false), true, "the level alone is enough");
  assert.equal(pausedForTick("paused", true), true);
  // A pause that started AND ended between two ticks left no level to read, only the event.
  // It is still the SFU ruling on this link, so it is still charged.
  assert.equal(pausedForTick("active", true), true);
  assert.equal(pausedForTick("active", false), false);
  // A runtime that exposes no stream state (no track bound yet, RN without the getter)
  // degrades to exactly the old behaviour rather than to "never paused".
  assert.equal(pausedForTick("unknown", true), true);
  assert.equal(pausedForTick("unknown", false), false);
});

test("a pause that genuinely ends releases the governor on the next tick", () => {
  // The level must not latch either: the whole point is that it tracks the SFU.
  let g = initGovernor(0, "low", CFG);
  const actions: Run["actions"] = [];
  for (let i = 1; i <= 12; i++) {
    const tMs = i * 1_000;
    const level: PauseLevel = i <= 3 ? "paused" : "active";
    // Only the PAUSE event sets the edge; a resume sets the level back to active.
    const s: GovernorSignal = { ...CLEAN, paused: pausedForTick(level, i === 1), transport: cleanPipe };
    const r = step(g, s, tMs, CFG);
    g = r.governor;
    if (r.action) actions.push({ tMs, setCap: r.action.setCap });
  }
  // Tick 3 is the last paused tick; the opening dwell is already satisfied, so tick 4 starts
  // the clean window and the probe fires cleanMs later.
  assert.deepEqual(actions, [{ tMs: 7_000, setCap: "high" }]);
});
