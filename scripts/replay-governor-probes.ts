// Replay recorded inbound-rtp probe traces through the PURE governor reducer, shipped
// predicate vs the sender-stall fence, and count what each would have done.
//
//   node --experimental-transform-types scripts/replay-governor-probes.ts /tmp/governor-traces/probes.json
//
// The corpus is 250 ms getStats samples: t, w, h, fps, framesDecoded (fd), freezeCount (fz),
// totalFreezesDuration (fzd, s), packetsLost (pl). It does NOT carry the rVFC presented-frame
// clock, NACKs, the SFU pause edge, jitter-buffer counters or the governor's own actions, so
// the replay is an APPROXIMATION and says so in its output:
//   - stats freeze  = exact: fzd delta over the 1 s tick (Chrome's own freeze detector).
//   - rVFC freeze   = estimated from decode gaps: a 250 ms bucket with 0 decoded frames is a
//                     gap of at least 250 ms; consecutive empty buckets add up. This is a LOWER
//                     bound on the presented gap (paint can lag decode) and cannot see gaps
//                     shorter than a bucket.
//   - transport     = packetsLost delta; NACKs unknown (treated as 0, which is the fenced arm's
//                     most permissive reading, so the fenced arm is an UPPER bound on refusals).
//   - paused, jitterRising, connectionQuality = unknown (false / "unknown").
//   - a width change in the trace is treated as a layer switch and the gap straddling it is
//     not charged (the 0.11.4 rule), in both arms.
import { readFileSync } from "node:fs";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  initGovernor,
  resolveLowCapQuality,
  step,
  type Governor,
  type GovernorSignal,
} from "../libs/client/src/react/quality-governor.ts";

type Sample = { t: number; w: number; h: number; fps: number; fd: number; fz: number; fzd: number; pl: number };
type Probe = { id: string; tCallIso: string; samples: Sample[] };

const FLOOR_MS = 100; // AVATAR_FRAME_GAP_FREEZE_FLOOR_MS
const freezeFromGap = (gapMs: number): number => (gapMs <= FLOOR_MS ? 0 : gapMs - FLOOR_MS);
const LADDER = [0, 1, 2];

const file = process.argv[2] ?? "/tmp/governor-traces/probes.json";
const probes: Probe[] = JSON.parse(readFileSync(file, "utf8"));

type Tick = { t: number; statsFreezeMs: number; rvfcFreezeMs: number; lost: number; width: number; switched: boolean };

function ticksOf(samples: Sample[]): Tick[] {
  const ticks: Tick[] = [];
  let i = 1;
  // walk 1 s windows of four 250 ms buckets
  for (let start = 1; start < samples.length; start += 4) {
    const win = samples.slice(start, Math.min(start + 4, samples.length));
    if (win.length === 0) break;
    const prev = samples[start - 1];
    const last = win[win.length - 1];
    const statsFreezeMs = Math.max(0, (last.fzd - prev.fzd) * 1000);
    const lost = Math.max(0, last.pl - prev.pl);
    const switched = win.some((s, k) => s.w !== (k === 0 ? prev : win[k - 1]).w);
    // decode-gap estimate: longest run of empty buckets ending in this window (incl. carry-in)
    let run = 0; let longest = 0; let p = prev;
    for (const s of win) {
      if (s.fd === p.fd && p.fd > 1) { run += 1; longest = Math.max(longest, run); } else run = 0;
      p = s;
    }
    const rvfcFreezeMs = switched ? 0 : freezeFromGap(longest > 0 ? 250 * longest + 125 : 0);
    ticks.push({ t: last.t, statsFreezeMs: switched ? 0 : statsFreezeMs, rvfcFreezeMs, lost, width: last.w, switched });
    i += 1;
  }
  return ticks;
}

function run(ticks: Tick[], fenced: boolean, openingCap: "high" | "low") {
  let g: Governor = initGovernor(0, openingCap);
  let demotes = 0; let toBottom = 0; let probes = 0; let highTicks = 0;
  const events: string[] = [];
  for (const tk of ticks) {
    const s: GovernorSignal = {
      paused: false,
      freezeMsInWindow: Math.max(tk.statsFreezeMs, tk.rvfcFreezeMs),
      jitterRising: false,
      connectionQuality: "unknown",
      inhibited: false,
      ...(fenced ? { transport: { packetsLostInWindow: tk.lost, nacksInWindow: 0, framesDroppedInWindow: 0 } } : {}),
    };
    const { governor, action } = step(g, s, tk.t * 1000, CFG);
    g = governor;
    if (action?.setCap === "low") {
      demotes += 1;
      const rung = resolveLowCapQuality(LADDER, g.lowUnhealthy);
      if (rung === 0) toBottom += 1;
      events.push(`${tk.t.toFixed(1)}s demote->${rung === 0 ? "BOTTOM" : "mid"} (freeze ${s.freezeMsInWindow}ms, lost ${tk.lost})`);
    } else if (action?.setCap === "high") {
      probes += 1;
      events.push(`${tk.t.toFixed(1)}s probe HIGH`);
    }
    if (g.cap === "high") highTicks += 1;
  }
  return { demotes, toBottom, probes, highPct: Math.round((100 * highTicks) / ticks.length), events };
}

for (const p of probes) {
  const ticks = ticksOf(p.samples);
  const observed = p.samples
    .map((s, k) => (k > 0 && s.w !== p.samples[k - 1].w ? `${s.t.toFixed(1)}s ${p.samples[k - 1].w}->${s.w}` : null))
    .filter(Boolean);
  const chargeable = ticks.filter((t) => Math.max(t.statsFreezeMs, t.rvfcFreezeMs) >= CFG.probationFreezeMs);
  const withLoss = chargeable.filter((t) => t.lost > 0);
  console.log(`\n== ${p.id} @ ${p.tCallIso}  (${ticks.length} ticks, packetsLost total ${p.samples.at(-1)?.pl ?? 0}, Chrome freezes ${p.samples.at(-1)?.fz ?? 0})`);
  console.log(`   observed width changes: ${observed.join(", ") || "none"}`);
  console.log(`   ticks with a replayable freeze >= probation bar: ${chargeable.length}; of those with loss in the same second: ${withLoss.length}`);
  for (const arm of ["shipped", "fenced"] as const) {
    const r = run(ticks, arm === "fenced", "high");
    console.log(`   ${arm.padEnd(7)} demotes=${r.demotes} toBottom=${r.toBottom} probes=${r.probes} capHigh=${r.highPct}%  ${r.events.slice(0, 6).join(" | ")}`);
  }
}
