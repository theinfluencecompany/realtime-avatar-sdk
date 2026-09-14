import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  healthyToleranceMs,
  initGovernor,
  resolveGovernorConfig,
  step,
  type GovernorConfig,
  type GovernorSignal,
} from "../src/react/quality-governor.ts";

// ---------------------------------------------------------------------------
// A MISCONFIGURATION MUST NEVER BE WORSE THAN NO CONFIGURATION.
//
// `initGovernor` used to THROW a RangeError when `healthyFreezeToleranceMs` reached the
// probation bar, and the hook's fail-open path caught it by unsubscribing and returning
// BEFORE `applyCap` ever ran. The result of a one-line typo in app config was therefore the
// worst outcome available: the call opened at the TOP rung with no governor at all, on every
// link, with no way back down. A governor that cannot be trusted with a bad number is a
// governor that must not be given one — so the number is clamped, once, where it is read.
//
// The invariant the throw was protecting is real and is kept: the healthy band must stay
// BELOW the probation bar, or one tick could be "healthy" and "a demote" at the same time.
// Clamping enforces it for every config, including hand-built ones that never went through
// `resolveGovernorConfig`.
// ---------------------------------------------------------------------------

const CLEAN: GovernorSignal = {
  paused: false,
  freezeMsInWindow: 0,
  jitterRising: false,
  connectionQuality: "excellent",
  inhibited: false,
};
const lossy = { packetsLostInWindow: 3, nacksInWindow: 1, framesDroppedInWindow: 0 };

test("an out-of-range tolerance is clamped below the probation bar, never thrown", () => {
  for (const raw of [CFG.probationFreezeMs, CFG.probationFreezeMs + 1, 10_000, Number.POSITIVE_INFINITY]) {
    const cfg: GovernorConfig = { ...CFG, healthyFreezeToleranceMs: raw };
    assert.doesNotThrow(() => initGovernor(0, "high", cfg), `tolerance ${raw}`);
    assert.ok(healthyToleranceMs(cfg) < cfg.probationFreezeMs, `tolerance ${raw} still masks the bar`);
  }
  // Negative and non-numeric readings collapse to "no band", which is 0.11.5's bar.
  assert.equal(healthyToleranceMs({ ...CFG, healthyFreezeToleranceMs: -50 }), 0);
  assert.equal(healthyToleranceMs({ ...CFG, healthyFreezeToleranceMs: Number.NaN }), 0);
  assert.equal(healthyToleranceMs(CFG), CFG.healthyFreezeToleranceMs, "an in-range band is untouched");
});

test("an out-of-range config still GOVERNS: it demotes and it recovers", () => {
  const cfg = resolveGovernorConfig({ healthyFreezeToleranceMs: 10_000 });
  assert.equal(
    cfg.healthyFreezeToleranceMs,
    CFG.probationFreezeMs - 1,
    "the resolved config carries the value that will actually be applied",
  );
  // A demote at the probation bar still fires: the band cannot swallow it.
  const atBar: GovernorSignal = { ...CLEAN, freezeMsInWindow: cfg.probationFreezeMs, transport: lossy };
  const g = initGovernor(0, "high", cfg);
  const demoted = step(g, atBar, 1_000, cfg);
  assert.equal(demoted.action?.setCap, "low");
  assert.equal(demoted.governor.cap, "low");
  // And the climb back still happens: dwell, clean window, probe.
  let h = demoted.governor;
  let raisedAtMs: number | null = null;
  for (let t = 2_000; t <= 30_000; t += 1_000) {
    const r = step(h, { ...CLEAN, transport: { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 0 } }, t, cfg);
    h = r.governor;
    if (r.action?.setCap === "high" && raisedAtMs === null) raisedAtMs = t;
  }
  assert.ok(raisedAtMs !== null && raisedAtMs <= 12_000, `re-raised at ${raisedAtMs} ms`);
});

test("resolveGovernorConfig warns about the clamp, once per module instance", async () => {
  // A FRESH module instance: the once-flag is module state, and the tests above have already
  // spent this file's. The query string is what makes node's ESM cache treat it as new.
  // The specifier is held in a variable so it stays a runtime value: `?query` is how node's
  // ESM cache is asked for a second instance, and it is not a path the type checker resolves.
  const freshSpecifier: string = "../src/react/quality-governor.ts?clamp-warn-once";
  const fresh: typeof import("../src/react/quality-governor.ts") = await import(freshSpecifier);
  const original = console.warn;
  const seen: unknown[][] = [];
  console.warn = (...args: unknown[]) => { seen.push(args); };
  try {
    fresh.resolveGovernorConfig({ healthyFreezeToleranceMs: 500 });
    fresh.resolveGovernorConfig({ healthyFreezeToleranceMs: 900 });
    fresh.resolveGovernorConfig(); // the ordinary path never logs
  } finally {
    console.warn = original;
  }
  assert.equal(seen.length, 1, "a per-render hook must not log on every render");
  assert.match(String(seen[0]?.[0]), /healthyFreezeToleranceMs/);
});

test("the kill switch overrides the band regardless of what the caller set", () => {
  assert.equal(healthyToleranceMs({ ...CFG, linkEvidence: "optional", healthyFreezeToleranceMs: 67 }), 0);
});
