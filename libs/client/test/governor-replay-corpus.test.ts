import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProbes, replayCorpus, type ProbeReplay } from "../../../scripts/replay-governor-probes.ts";

// ---------------------------------------------------------------------------
// THE 2026-09-11 PROBE CORPUS, replayed through the pure reducer.
//
// Eight instrumented consumer web calls against the production RTX 6000 pool, 250 ms inbound-rtp
// samples (t, w, h, fps, framesDecoded, freezeCount, totalFreezesDuration, packetsLost).
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. The corpus lacks the rVFC presented-frame clock,
// NACKs, the SFU pause edge and the jitter-buffer counters, so the replay is a LOWER BOUND
// on the freeze the shipped governor saw (it reproduces 9 of the 18 observed step-downs) and
// a DIRECTION proof for the fence: every one of the 9 replayable demotes fired in a tick
// with ZERO packets lost, so a rule that refuses to charge a clean pipe removes all of them.
// It is not a measurement of the production effect. Two probes lost 8 and 5 packets over
// their whole run; neither loss coincided with a replayable freeze, so the corpus cannot show
// a demote that the fence keeps (the synthetic timelines in governor-timelines.test.ts do).
// ---------------------------------------------------------------------------

const FIXTURE = fileURLToPath(new URL("./fixtures/probes-2026-09-11.json", import.meta.url));
const replays: ProbeReplay[] = replayCorpus(loadProbes(FIXTURE));
const sum = (arm: "shipped" | "fenced" | "tolerance", key: "demotes" | "toBottom" | "probes") =>
  replays.reduce((n, r) => n + r.arms[arm][key], 0);

test("the fixture is the eight-probe corpus", () => {
  assert.equal(replays.length, 8);
  assert.ok(replays.every((r) => r.ticks >= 45));
});

test("shipped: 9 replayable demotes, every one in a tick with zero packets lost", () => {
  assert.equal(sum("shipped", "demotes"), 9);
  assert.equal(sum("shipped", "toBottom"), 1, "one walk to the bottom rung (probe ...167182 at 46 s)");
  for (const r of replays) {
    for (const lost of r.arms.shipped.demoteLost) assert.equal(lost, 0, `${r.id}: a demote with loss in its window`);
  }
  const perProbe = replays.map((r) => r.arms.shipped.demotes);
  assert.deepEqual(perProbe, [2, 2, 0, 1, 1, 0, 0, 3]);
});

test("fenced (0.11.5 recovery rules + the fence): zero demotes, cap high 100 % of every probe", () => {
  assert.equal(sum("fenced", "demotes"), 0);
  for (const r of replays) assert.equal(r.arms.fenced.highPct, 100, r.id);
});

test("tolerance + decay (the current defaults): zero demotes, cap high 100 % of every probe", () => {
  assert.equal(sum("tolerance", "demotes"), 0);
  assert.equal(sum("tolerance", "toBottom"), 0);
  for (const r of replays) assert.equal(r.arms.tolerance.highPct, 100, r.id);
});

test("the corpus is honest about itself: observed rung changes outnumber the replayable ones", () => {
  // 18 step-downs were observed as width decreases across the 8 calls; the replay finds 9.
  const observedDowns = replays.reduce(
    (n, r) => n + r.observedWidthChanges.filter((c) => { const [a, b] = c.split(" ")[1].split("->").map(Number); return b < a; }).length,
    0,
  );
  assert.ok(observedDowns > sum("shipped", "demotes"), `${observedDowns} observed vs ${sum("shipped", "demotes")} replayable`);
});
