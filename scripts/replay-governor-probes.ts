// Replay recorded inbound-rtp probe traces through the PURE governor reducer, shipped
// predicate vs the sender-stall fence, and count what each would have done.
//
//   node --experimental-transform-types scripts/replay-governor-probes.ts [probes.json]
//
// Importable: `libs/client/test/governor-replay-corpus.test.ts` drives `replayCorpus` on the
// checked-in fixture (libs/client/test/fixtures/probes-2026-09-11.json) and pins the counts.
//
// WHAT THE CORPUS IS AND IS NOT. 250 ms getStats samples: t, w, h, fps, framesDecoded (fd),
// freezeCount (fz), totalFreezesDuration (fzd, s), packetsLost (pl). It does NOT carry the
// rVFC presented-frame clock (the governor's PRIMARY input), NACKs, the SFU pause edge,
// jitter-buffer counters or the governor's own setVideoQuality calls. So the replay is a
// LOWER BOUND on what the shipped governor saw and a DIRECTION proof for the fence, not a
// measurement of the production effect:
//   - stats freeze  = exact: fzd delta over the 1 s tick (Chrome's own freeze detector).
//   - rVFC freeze   = estimated from decode gaps: a 250 ms bucket with 0 decoded frames is a
//                     gap of at least 250 ms; consecutive empty buckets add up. Lower bound on
//                     the presented gap (paint can lag decode); blind to gaps under a bucket.
//   - transport     = packetsLost delta; NACKs unknown (treated as 0, the fenced arm's most
//                     permissive reading, so the fenced arm is an UPPER bound on refusals).
//   - paused, jitterRising, connectionQuality = unknown (false / "unknown").
//   - a width change in the trace is treated as a layer switch and the gap straddling it is
//     not charged (the 0.11.4 rule), in all arms.
// The shipped reducer reproduces only 9 of the 18 rung step-downs observed in these calls;
// the other 9 fired on evidence the corpus does not contain (see the trace hook, onTrace).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_GOVERNOR_CONFIG as CFG,
  initGovernor,
  resolveLowCapQuality,
  step,
  type Governor,
  type GovernorConfig,
  type GovernorSignal,
} from "../libs/client/src/react/quality-governor.ts";

export type Sample = { t: number; w: number; h: number; fps: number; fd: number; fz: number; fzd: number; pl: number };
export type Probe = { id: string; tCallIso: string; samples: Sample[] };

const FLOOR_MS = 100; // AVATAR_FRAME_GAP_FREEZE_FLOOR_MS
const freezeFromGap = (gapMs: number): number => (gapMs <= FLOOR_MS ? 0 : gapMs - FLOOR_MS);
const LADDER = [0, 1, 2];

/**
 * The 0.11.5 reducer expressed as a config of the current one: the fence off, no recovery
 * tolerance, no lowUnhealthy decay. The one non-configurable difference is the deleted bare
 * `!jitterRising` clause in isHealthy, which this corpus cannot exercise (jitter unknown).
 */
export const SHIPPED_0_11_5_CFG: GovernorConfig = {
  ...CFG,
  linkEvidence: "optional",
  healthyFreezeToleranceMs: 0,
  lowUnhealthyWindowMs: Number.POSITIVE_INFINITY,
};

/** The fence alone, on the 0.11.5 recovery rules. */
export const FENCED_ONLY_CFG: GovernorConfig = { ...SHIPPED_0_11_5_CFG, linkEvidence: "required" };

export type Arm = "shipped" | "fenced" | "tolerance";
const ARM_CFG: Record<Arm, GovernorConfig> = {
  shipped: SHIPPED_0_11_5_CFG,
  fenced: FENCED_ONLY_CFG,
  tolerance: CFG,
};

export type Tick = { t: number; statsFreezeMs: number; rvfcFreezeMs: number; lost: number; width: number; switched: boolean };

export function ticksOf(samples: Sample[]): Tick[] {
  const ticks: Tick[] = [];
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
  }
  return ticks;
}

export type ArmResult = {
  demotes: number;
  toBottom: number;
  probes: number;
  highPct: number;
  /** Tick indices at which a demote fired. */
  demoteTicks: number[];
  /** packetsLost in the demoting tick's window, per demote. */
  demoteLost: number[];
  events: string[];
};

export function runArm(ticks: Tick[], arm: Arm, openingCap: "high" | "low" = "high"): ArmResult {
  const cfg = ARM_CFG[arm];
  let g: Governor = initGovernor(0, openingCap, cfg);
  let demotes = 0; let toBottom = 0; let probes = 0; let highTicks = 0;
  const demoteTicks: number[] = []; const demoteLost: number[] = [];
  const events: string[] = [];
  ticks.forEach((tk, i) => {
    const s: GovernorSignal = {
      paused: false,
      freezeMsInWindow: Math.max(tk.statsFreezeMs, tk.rvfcFreezeMs),
      jitterRising: false,
      connectionQuality: "unknown",
      inhibited: false,
      // The shipped arm never saw transport evidence; it is deleted, not zeroed.
      ...(arm === "shipped" ? {} : { transport: { packetsLostInWindow: tk.lost, nacksInWindow: 0, framesDroppedInWindow: 0 } }),
    };
    const { governor, action } = step(g, s, tk.t * 1000, cfg);
    g = governor;
    if (action?.setCap === "low") {
      demotes += 1;
      demoteTicks.push(i);
      demoteLost.push(tk.lost);
      const rung = resolveLowCapQuality(LADDER, g.lowUnhealthy);
      if (rung === 0) toBottom += 1;
      events.push(`${tk.t.toFixed(1)}s demote->${rung === 0 ? "BOTTOM" : "mid"} (freeze ${Math.round(s.freezeMsInWindow)}ms, lost ${tk.lost})`);
    } else if (action?.setCap === "high") {
      probes += 1;
      events.push(`${tk.t.toFixed(1)}s probe HIGH`);
    }
    if (g.cap === "high") highTicks += 1;
  });
  return { demotes, toBottom, probes, highPct: Math.round((100 * highTicks) / ticks.length), demoteTicks, demoteLost, events };
}

export type ProbeReplay = {
  id: string;
  ticks: number;
  packetsLostTotal: number;
  chromeFreezes: number;
  observedWidthChanges: string[];
  arms: Record<Arm, ArmResult>;
};

export function replayCorpus(probes: readonly Probe[]): ProbeReplay[] {
  return probes.map((p) => {
    const ticks = ticksOf(p.samples);
    const observedWidthChanges = p.samples
      .map((s, k) => (k > 0 && s.w !== p.samples[k - 1].w ? `${s.t.toFixed(1)}s ${p.samples[k - 1].w}->${s.w}` : null))
      .filter((x): x is string => x !== null);
    return {
      id: p.id,
      ticks: ticks.length,
      packetsLostTotal: p.samples.at(-1)?.pl ?? 0,
      chromeFreezes: p.samples.at(-1)?.fz ?? 0,
      observedWidthChanges,
      arms: {
        shipped: runArm(ticks, "shipped"),
        fenced: runArm(ticks, "fenced"),
        tolerance: runArm(ticks, "tolerance"),
      },
    };
  });
}

export function loadProbes(file: string): Probe[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected an array of probes`);
  return parsed.filter((p): p is Probe => typeof p === "object" && p !== null && "samples" in p && "id" in p);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const file = process.argv[2] ?? "/tmp/governor-traces/probes.json";
  for (const r of replayCorpus(loadProbes(file))) {
    console.log(`\n== ${r.id}  (${r.ticks} ticks, packetsLost total ${r.packetsLostTotal}, Chrome freezes ${r.chromeFreezes})`);
    console.log(`   observed width changes: ${r.observedWidthChanges.join(", ") || "none"}`);
    for (const arm of ["shipped", "fenced", "tolerance"] as const) {
      const a = r.arms[arm];
      console.log(`   ${arm.padEnd(9)} demotes=${a.demotes} toBottom=${a.toBottom} probes=${a.probes} capHigh=${a.highPct}%  ${a.events.slice(0, 6).join(" | ")}`);
    }
  }
}
