import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  initGovernor,
  step,
  type Governor,
  type GovernorConfig,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";
import {
  DEFAULT_GOVERNOR_CONFIG as LEGACY_DEFAULTS,
  initGovernor as legacyInit,
  step as legacyStep,
  type LegacySignal,
} from "./fixtures/governor-0-11-5.ts";
import { ticksOf, type Probe } from "../../../scripts/replay-governor-probes.ts";

// ---------------------------------------------------------------------------
// THE KILL SWITCH IS A FULL REVERT, NOT A PARTIAL ONE.
//
// `linkEvidence: "optional"` is documented as restoring 0.11.5 so the fence can be turned
// off from app config without a release. The first prototype reverted only the CHARGING
// predicate: the 67 ms healthy band and the deleted bare `!jitterRising` clause stayed live,
// so "optional" was a reducer that had never shipped and the switch could not answer the
// question it exists for ("is the new code doing this?").
//
// This test compares the live reducer under "optional" against a FROZEN VERBATIM COPY of the
// 0.11.5 reducer (fixtures/governor-0-11-5.ts, extracted from origin/main 2a878ba), field by
// field, tick by tick, on synthetic timelines and on the recorded probe corpus. Expressing
// 0.11.5 as a config of the current reducer would prove nothing — it inherits by construction
// whatever the current reducer does that 0.11.5 did not.
// ---------------------------------------------------------------------------

const OPTIONAL: GovernorConfig = { ...CFG, linkEvidence: "optional" };
const cleanPipe = { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 0 };
const lossy = { packetsLostInWindow: 4, nacksInWindow: 1, framesDroppedInWindow: 0 };
const base: GovernorSignal = { paused: false, freezeMsInWindow: 0, jitterRising: false, connectionQuality: "excellent", inhibited: false };

type Snapshot = { governor: Governor; action: string };
const run = (timeline: GovernorSignal[], cfg: GovernorConfig, openingCap: "high" | "low"): Snapshot[] => {
  let g = initGovernor(0, openingCap, cfg);
  return timeline.map((s, i) => {
    const r = step(g, s, (i + 1) * 1_000, cfg);
    g = r.governor;
    return { governor: g, action: r.action?.setCap ?? "-" };
  });
};
/** The same timeline through the frozen 0.11.5 reducer. Transport is DELETED, because the
 *  field did not exist there; that is the point of the comparison. */
const runLegacy = (timeline: GovernorSignal[], openingCap: "high" | "low"): Snapshot[] => {
  let g = legacyInit(0, openingCap);
  return timeline.map(({ transport: _t, ...s }, i) => {
    const r = legacyStep(g, s satisfies LegacySignal, (i + 1) * 1_000, CFG);
    g = r.governor;
    return { governor: g, action: r.action?.setCap ?? "-" };
  });
};
const withoutTransport = (timeline: GovernorSignal[]): GovernorSignal[] =>
  timeline.map(({ transport: _t, ...rest }) => rest);

/** Deterministic synthetic timelines with transport on every tick. */
const timelines: Record<string, GovernorSignal[]> = {
  senderStallsEvery10s: Array.from({ length: 120 }, (_, i) => ({
    ...base, freezeMsInWindow: (i + 1) % 10 === 0 ? 200 + 60 * (i % 5) : 0, transport: cleanPipe,
  })),
  lossyLink: Array.from({ length: 60 }, (_, i) => ({
    ...base, freezeMsInWindow: i % 3 === 0 ? 300 : 0, transport: lossy,
  })),
  smallGapsAndJitter: Array.from({ length: 90 }, (_, i) => ({
    ...base,
    freezeMsInWindow: i % 2 === 0 ? 24 : 0,
    jitterRising: i % 7 === 0,
    transport: i % 4 === 0 ? { ...cleanPipe, packetsLostInWindow: 1 } : cleanPipe,
  })),
  // Inside the healthy band on every tick, with jitter rising in long RUNS: the three
  // behaviours the switch must also revert (the band, the bare jitter clause, and the
  // delay-only demote) all live here.
  bandAndJitterRuns: Array.from({ length: 90 }, (_, i) => ({
    ...base,
    freezeMsInWindow: i % 2 === 0 ? 40 : 0,
    jitterRising: i % 20 < 8,
    transport: cleanPipe,
  })),
  firstFrameWaitThenClean: Array.from({ length: 40 }, (_, i) => ({
    ...base, freezeMsInWindow: i < 9 ? Math.max(0, (i + 1) * 1_000 - 1_000) : 0, transport: cleanPipe,
  })),
  mixed: Array.from({ length: 200 }, (_, i) => ({
    ...base,
    paused: i === 57,
    freezeMsInWindow: [0, 0, 0, 120, 0, 0, 500, 0, 30, 0, 0, 0, 0, 260][i % 14],
    jitterRising: i % 11 === 0,
    connectionQuality: i % 50 === 25 ? "poor" : "good",
    transport: i % 3 === 0 ? lossy : cleanPipe,
  })),
  inhibitedBursts: Array.from({ length: 60 }, (_, i) => ({
    ...base,
    inhibited: i % 9 === 3,
    freezeMsInWindow: i % 5 === 0 ? 90 : 0,
    jitterRising: i % 6 < 4,
    transport: i % 2 === 0 ? cleanPipe : lossy,
  })),
};

// The recorded corpus as well, so the identity holds on real traces.
const probes: Probe[] = JSON.parse(
  readFileSync(new URL("./fixtures/probes-2026-09-11.json", import.meta.url), "utf8"),
);
for (const p of probes) {
  timelines[`probe:${p.id.slice(-13)}`] = ticksOf(p.samples).map((tk) => ({
    ...base,
    connectionQuality: "unknown",
    freezeMsInWindow: Math.max(tk.statsFreezeMs, tk.rvfcFreezeMs),
    transport: { packetsLostInWindow: tk.lost, nacksInWindow: 0, framesDroppedInWindow: 0 },
  }));
}

test("the frozen reference carries the 0.11.5 defaults this reducer still ships", () => {
  for (const key of Object.keys(LEGACY_DEFAULTS) as (keyof typeof LEGACY_DEFAULTS)[]) {
    assert.equal(CFG[key], LEGACY_DEFAULTS[key], `default ${key} drifted from 0.11.5`);
  }
});

test("linkEvidence: optional is BYTE-IDENTICAL to the frozen 0.11.5 reducer", () => {
  let ticks = 0;
  for (const [name, timeline] of Object.entries(timelines)) {
    for (const opening of ["high", "low"] as const) {
      assert.deepEqual(run(timeline, OPTIONAL, opening), runLegacy(timeline, opening), `${name} / opening ${opening}`);
      // ...and deleting transport changes nothing under the switch, which is what makes the
      // claim "the unknown-transport branch IS the 0.11.5 predicate" true.
      assert.deepEqual(
        run(withoutTransport(timeline), OPTIONAL, opening),
        runLegacy(timeline, opening),
        `${name} / opening ${opening} / transport deleted`,
      );
      ticks += timeline.length * 2;
    }
  }
  assert.ok(ticks > 3_000, `${ticks} ticks compared`);
});

test("the kill switch really switches: on a sender-stall timeline the two arms differ", () => {
  const t = timelines.senderStallsEvery10s;
  const fenced = run(t, CFG, "high").filter((s) => s.action === "low").length;
  const off = run(t, OPTIONAL, "high").filter((s) => s.action === "low").length;
  assert.equal(fenced, 0);
  assert.ok(off >= 5, `kill switch off demotes ${off} times`);
});

test("the band and the jitter clause are part of the switch, not separate knobs", () => {
  // Under "required" a 40 ms charged gap is inside the healthy band and a jitter flicker
  // alone is not unhealthy; under "optional" neither is true, which is 0.11.5.
  const eligible: Governor = { state: "cap_low_eligible", cap: "low", failures: 1, lowUnhealthy: 0, enteredAtMs: 0, healthySinceMs: 0 };
  const smallGap: GovernorSignal = { ...base, freezeMsInWindow: 40, transport: lossy };
  const flicker: GovernorSignal = { ...base, jitterRising: true, transport: lossy };
  assert.equal(step(eligible, smallGap, 1_000, CFG).governor.healthySinceMs, 0, "inside the band");
  assert.equal(step(eligible, smallGap, 1_000, OPTIONAL).governor.healthySinceMs, null, "0.11.5 required exactly 0");
  assert.equal(step(eligible, flicker, 1_000, CFG).governor.healthySinceMs, 0, "a jitter flicker alone is healthy");
  assert.equal(step(eligible, flicker, 1_000, OPTIONAL).governor.healthySinceMs, null, "0.11.5 restarted the window");
  // The switch does not add fields to the state either: a 0.11.5 governor has five.
  const legacyShape = step(eligible, smallGap, 1_000, OPTIONAL).governor;
  assert.deepEqual(Object.keys(legacyShape).sort(), ["cap", "enteredAtMs", "failures", "healthySinceMs", "lowUnhealthy", "state"]);
});

test("healthyFreezeToleranceMs and lowUnhealthyWindowMs never change a demote decision", () => {
  // Property: from ANY cap-high state, the cap action is a function of (signal, fence, bars)
  // only. Sweep the two knobs against a grid of signals and states.
  const knobs: GovernorConfig[] = [
    CFG,
    { ...CFG, healthyFreezeToleranceMs: 0, lowUnhealthyWindowMs: Number.POSITIVE_INFINITY },
    { ...CFG, healthyFreezeToleranceMs: 99, lowUnhealthyWindowMs: 1 },
  ];
  const states: Governor[] = (["opening_high", "probing_up", "cap_high_stable"] as const).map((state) => ({
    state, cap: "high", failures: 1, lowUnhealthy: 1, enteredAtMs: 0, healthySinceMs: null,
  }));
  const freezes = [0, 50, 67, 68, 99, 100, 149, 150, 500];
  const transports = [undefined, cleanPipe, lossy];
  let compared = 0;
  for (const g of states) for (const f of freezes) for (const tr of transports) for (const paused of [false, true]) for (const jitterRising of [false, true]) {
    const s: GovernorSignal = { ...base, freezeMsInWindow: f, paused, jitterRising, ...(tr ? { transport: tr } : {}) };
    const actions = knobs.map((cfg) => step(g, s, 5_000, cfg).action?.setCap ?? "-");
    assert.ok(actions.every((a) => a === actions[0]), `state ${g.state} freeze ${f} paused ${paused} jitter ${jitterRising}: ${actions.join(",")}`);
    compared += 1;
  }
  assert.ok(compared > 300);
  // And on the corpus the FIRST demote of every probe lands on the same tick (later ones
  // may legitimately shift because the knobs change WHEN the cap comes back up).
  for (const [name, timeline] of Object.entries(timelines)) {
    if (!name.startsWith("probe:")) continue;
    const first = knobs.map((cfg) => run(withoutTransport(timeline), cfg, "high").findIndex((s) => s.action === "low"));
    assert.ok(first.every((i) => i === first[0]), `${name}: first demote tick ${first.join(",")}`);
  }
});
