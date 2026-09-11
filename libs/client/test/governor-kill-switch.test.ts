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
import { ticksOf, type Probe } from "../../../scripts/replay-governor-probes.ts";

// ---------------------------------------------------------------------------
// THE KILL SWITCH IS BYTE-IDENTICAL TO "NO EVIDENCE". `linkEvidence: "optional"` must make
// the reducer ignore transport exactly as it ignores a signal that never carried any. The
// unknown-transport branch is 0.11.5 by construction, so this pins that the switch has one
// meaning and that the two recovery knobs never touch a demote decision.
// ---------------------------------------------------------------------------

const OPTIONAL: GovernorConfig = { ...CFG, linkEvidence: "optional" };
const cleanPipe = { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 0 };
const lossy = { packetsLostInWindow: 4, nacksInWindow: 1, framesDroppedInWindow: 0 };
const base: GovernorSignal = { paused: false, freezeMsInWindow: 0, jitterRising: false, connectionQuality: "excellent", inhibited: false };

type Snapshot = { state: Governor["state"]; cap: Governor["cap"]; action: string; failures: number; lowUnhealthy: number };
const run = (timeline: GovernorSignal[], cfg: GovernorConfig, openingCap: "high" | "low", tickMs = 1_000): Snapshot[] => {
  let g = initGovernor(0, openingCap, cfg);
  return timeline.map((s, i) => {
    const r = step(g, s, (i + 1) * tickMs, cfg);
    g = r.governor;
    return { state: g.state, cap: g.cap, action: r.action?.setCap ?? "-", failures: g.failures, lowUnhealthy: g.lowUnhealthy };
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

test("linkEvidence: optional == transport deleted, on every timeline and both openings", () => {
  for (const [name, timeline] of Object.entries(timelines)) {
    for (const opening of ["high", "low"] as const) {
      assert.deepEqual(
        run(timeline, OPTIONAL, opening),
        run(withoutTransport(timeline), CFG, opening),
        `${name} / opening ${opening}`,
      );
    }
  }
});

test("the kill switch really switches: on a sender-stall timeline the two arms differ", () => {
  const t = timelines.senderStallsEvery10s;
  const fenced = run(t, CFG, "high").filter((s) => s.action === "low").length;
  const off = run(t, OPTIONAL, "high").filter((s) => s.action === "low").length;
  assert.equal(fenced, 0);
  assert.ok(off >= 5, `kill switch off demotes ${off} times`);
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
