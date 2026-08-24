// ---------------------------------------------------------------------------
// quality-governor — the PURE core of the adaptive video-quality mechanism
// (ZERO React, ZERO vendor imports). Table/trace-tested exactly like grace-window
// and the session-lifecycle classifiers. The hook (use-quality-governor.ts) wires
// this onto a 1s tick + LiveKit events + getStats + the player's rVFC freeze feed,
// and is the ONLY place `publication.setVideoQuality` is called.
//
// WHY A PURE REDUCER: the anti-flap logic (the video-quality design doc)
// must be provable WITHOUT a live network. `step()` is deterministic —
// (state, signal, nowMs) → (state, action?) — so a whole congestion episode is a
// replayable trace and every constant lives in one GovernorConfig. The design
// separation (the video-layering design doc): mechanism here, actuation in the
// hook, policy in the player.
//
// CAP SEMANTICS drive the shape: setVideoQuality(LOW) HARD-CAPS (down is
// authoritative + instant); setVideoQuality(HIGH) only RAISES the cap and lets BWE
// choose up to it (up is PERMISSION, not delivery — must be observed on probation).
// ---------------------------------------------------------------------------

/** The subscriber-cap levels we drive (map to LiveKit VideoQuality LOW/HIGH). */
export type QualityCap = "low" | "high";

/** The governor's finite states (the video-quality design doc). */
export type GovernorState =
  | "opening" // cap=low, session start — a SHORT dwell, then eligible (no failure evidence yet)
  | "opening_high" // cap=high, session start — sharp from t=0, judged on the PROBATION bar

  | "cap_low_sticky" // cap=low, in post-downgrade dwell — up-probe forbidden
  | "cap_low_eligible" // cap=low, dwell satisfied — watching for a clean window
  | "probing_up" // just raised cap to high — on probation, watching if BWE holds it
  | "cap_high_stable"; // cap=high, committed (a BWE self-dip here is fine, not a flap)

/**
 * One normalized input the hook feeds each tick. The hook translates ALL of
 * {TrackStreamStateChanged, ConnectionQualityChanged, getStats, rVFC freeze} into
 * this shape, so the core never sees a vendor type.
 */
export interface GovernorSignal {
  /** SFU congestion controller paused the track since the last tick — Tier-0, the
   *  single most trustworthy downgrade trigger (server already confirmed congestion). */
  paused: boolean;
  /** Frozen milliseconds observed in the trailing freeze window W (max of inbound-rtp
   *  delta and the rVFC-derived gap — Safari coverage). */
  freezeMsInWindow: number;
  /** jitterBufferDelay is trending up — the earliest LEADING pre-freeze sign. */
  jitterRising: boolean;
  /** LiveKit ConnectionQuality — a LAGGING corroborator only (jitter/RTT are disabled
   *  in its score + known false-Poor bugs). Blocks up-probes; never a sole trigger. */
  connectionQuality: "excellent" | "good" | "poor" | "lost" | "unknown";
  /** The tab is hidden / track muted / freezes correlate with local CPU not network —
   *  the false-positive fence (our own Dia-freeze lesson). When true the machine is
   *  frozen: no signal is trusted, no transition fires. */
  inhibited: boolean;
}

/** The side effect the hook must apply after a step (absent = leave the cap alone). */
export interface GovernorAction {
  setCap: QualityCap;
}

export interface GovernorConfig {
  /** Where the cap OPENS. "low" (default): the shipped posture — first impression is
   *  never a freeze, at the cost of a visible soft start (openingDwellMs + cleanMs
   *  before the first up-probe, plus the LOW→HIGH rung switch's decoder-reconfigure
   *  keyframe pop). "high": first impression is never a RAMP — the session opens at
   *  the top rung already under the STRICT probation bar (probationFreezeMs, paused
   *  = instant), so a link that cannot afford it is demoted within one tick of
   *  evidence and then follows the normal ladder with a failure on record. Pick
   *  "high" for surfaces where the opening softness reads as a defect (the canary
   *  demo comparison, 2026-08-13) and the link population skews capable. */
  openingCap: QualityCap; // "low"
  /** Frozen-ms in window W that forces an immediate downgrade from a stable cap. */
  downgradeFreezeMs: number; // 150
  /** Stricter frozen-ms bar DURING probation — kill a bad upgrade fast. */
  probationFreezeMs: number; // 100
  /** Hold at low at SESSION START before an up-probe is considered. Separate from
   *  dwellBaseMs because the opening carries no failure evidence — the 8s recovery
   *  dwell was being served to every fresh call, and prod measurement
   *  (call_connect_profile, 2026-08-05) showed the cost: median 14s at the small
   *  rung before first upgrade, 56% of 30s windows never upgrading at all. Opening
   *  low is kept (first impression is never a freeze); paying the POST-FAILURE
   *  penalty before any failure is not. */
  openingDwellMs: number; // 2_000
  /** Base minimum hold at low before an up-probe is considered (grows on failure). */
  dwellBaseMs: number; // 8_000  (≈ Meet's <10s server-simulcast recovery)
  /** Cap on the exponential dwell backoff — never pin low permanently. */
  dwellMaxMs: number; // 120_000
  /** Continuously-healthy window required before raising the cap. 3s: still well above
   *  the sub-second downgrade reaction (the asymmetry that prevents flap), but short
   *  enough that a clean link reaches the probe at ~5s from session start
   *  (openingDwellMs + cleanMs) instead of 13s under the old 8s+5s posture. */
  cleanMs: number; // 3_000
  /** Probation length after raising the cap before committing to high. */
  probeMs: number; // 10_000  (≈ Meet full-recovery window)
  /** Sustained-healthy-at-low duration that resets the failure count (link improved). */
  healthyResetMs: number; // 120_000
}

/** The grounded defaults (Meet <10s recovery + GCC +5%/−15% step asymmetry). */
export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  openingCap: "low",
  downgradeFreezeMs: 150,
  probationFreezeMs: 100,
  openingDwellMs: 2_000,
  dwellBaseMs: 8_000,
  dwellMaxMs: 120_000,
  cleanMs: 3_000,
  probeMs: 10_000,
  healthyResetMs: 120_000,
};

/** Minimum interval-average jitter-buffer increase treated as a real trend. */
export const JITTER_BUFFER_RISE_THRESHOLD_MS = 25;

export type JitterBufferTotals = {
  delaySeconds: number;
  emittedCount: number;
};

export type JitterBufferTrendState = JitterBufferTotals & {
  intervalAverageMs: number | null;
};

/**
 * Compare cumulative WebRTC jitter-buffer counters using interval averages.
 * Cumulative averages react too slowly on long calls; counter deltas expose a
 * newly worsening receive buffer without mistaking the intentional 500ms playout
 * target for congestion.
 */
export function stepJitterBufferTrend(
  previous: JitterBufferTrendState | null,
  current: JitterBufferTotals,
  riseThresholdMs: number = JITTER_BUFFER_RISE_THRESHOLD_MS,
): { state: JitterBufferTrendState; rising: boolean } {
  const baseline: JitterBufferTrendState = { ...current, intervalAverageMs: null };
  if (
    previous === null ||
    !Number.isFinite(current.delaySeconds) ||
    !Number.isFinite(current.emittedCount) ||
    current.delaySeconds < previous.delaySeconds ||
    current.emittedCount <= previous.emittedCount
  ) {
    return { state: baseline, rising: false };
  }

  const intervalAverageMs =
    ((current.delaySeconds - previous.delaySeconds) * 1000) /
    (current.emittedCount - previous.emittedCount);
  const threshold = Number.isFinite(riseThresholdMs) ? Math.max(0, riseThresholdMs) : 0;
  const rising =
    previous.intervalAverageMs !== null &&
    intervalAverageMs > previous.intervalAverageMs + threshold;
  return {
    state: { ...current, intervalAverageMs },
    rising,
  };
}

/** The full reducer state (immutable; `step` returns a new object on change). */
export interface Governor {
  state: GovernorState;
  cap: QualityCap;
  /** Consecutive failed up-probes — drives the exponential dwell backoff. */
  failures: number;
  /** Wall-clock ms the current state was entered (for dwell/clean/probe timing). */
  enteredAtMs: number;
  /** Wall-clock ms of the last healthy tick in the current low period (clean-window
   *  accumulation); null until the first healthy tick after entering low. */
  healthySinceMs: number | null;
}

/** The initial governor. Default opening: cap=low — first impression is NEVER a
 *  freeze, with only the short opening dwell. `openingCap: "high"` inverts the bet:
 *  first impression is never a RAMP, under the strict probation bar from t=0. */
export const initGovernor = (nowMs: number, openingCap: QualityCap = "low"): Governor => ({
  state: openingCap === "high" ? "opening_high" : "opening",
  cap: openingCap,
  failures: 0,
  enteredAtMs: nowMs,
  healthySinceMs: null,
});

/** A signal is a downgrade trigger from a stable/high cap (docs §2 Fix 3). */
const isDowngrade = (s: GovernorSignal, cfg: GovernorConfig): boolean =>
  s.paused ||
  s.freezeMsInWindow >= cfg.downgradeFreezeMs ||
  (s.jitterRising && s.freezeMsInWindow > 0);

/** A signal fails an in-flight probation (stricter bar — kill a bad upgrade fast). */
const isProbationFail = (s: GovernorSignal, cfg: GovernorConfig): boolean =>
  s.paused || s.freezeMsInWindow >= cfg.probationFreezeMs;

/** "Healthy right now": no freeze, no pause, jitter not rising, quality not poor/lost. */
const isHealthy = (s: GovernorSignal): boolean =>
  !s.paused &&
  s.freezeMsInWindow === 0 &&
  !s.jitterRising &&
  s.connectionQuality !== "poor" &&
  s.connectionQuality !== "lost";

/** The exponential dwell for the current failure count, capped. */
const dwellMs = (failures: number, cfg: GovernorConfig): number =>
  Math.min(cfg.dwellBaseMs * 2 ** failures, cfg.dwellMaxMs);

const enter = (g: Governor, state: GovernorState, cap: QualityCap, nowMs: number): Governor => ({
  ...g,
  state,
  cap,
  enteredAtMs: nowMs,
  healthySinceMs: null,
});

/**
 * Advance the governor one tick. PURE: no clock, no I/O — `nowMs` is injected and the
 * only output is the next state plus an optional cap action for the hook to apply.
 *
 * Ordering is deliberate: the false-positive fence first (inhibited freezes the
 * machine), then the authoritative instant downgrade (from any non-low state), then
 * the per-state up-path. Down is checked before up in every state, so a link that is
 * simultaneously "dwell elapsed" and "freezing" always falls, never rises.
 */
export const step = (
  g: Governor,
  s: GovernorSignal,
  nowMs: number,
  cfg: GovernorConfig = DEFAULT_GOVERNOR_CONFIG,
): { governor: Governor; action?: GovernorAction } => {
  // FALSE-POSITIVE FENCE: hidden tab / muted / local-CPU freeze — trust nothing, do
  // nothing (a downgrade can't fix a decode/paint bottleneck; our Dia-freeze lesson).
  if (s.inhibited) {
    return { governor: g };
  }

  // AUTHORITATIVE INSTANT DOWNGRADE from any non-low cap. Paused is 0ms-bar; freeze
  // uses the (stricter) probation bar while probing OR during the high opening —
  // both are unproven bets, so both are judged hard and lose fast.
  const onProbation = g.state === "probing_up" || g.state === "opening_high";
  const downgradeNow = onProbation ? isProbationFail(s, cfg) : isDowngrade(s, cfg);
  if (g.cap === "high" && downgradeNow) {
    const failed = onProbation; // losing an unproven high counts as a failure
    return {
      governor: {
        ...enter(g, "cap_low_sticky", "low", nowMs),
        failures: failed ? g.failures + 1 : g.failures,
      },
      action: { setCap: "low" },
    };
  }

  switch (g.state) {
    case "opening_high": {
      // The high opening is a probation that started at t=0: survive probeMs healthy
      // and the sharp start is committed; any failure was already caught above by the
      // instant-downgrade gate (probation bar), which sent us to cap_low_sticky with
      // a failure on record. No action on commit — the cap is already high.
      if (nowMs - g.enteredAtMs >= cfg.probeMs && isHealthy(s)) {
        return { governor: enter(g, "cap_high_stable", "high", nowMs) };
      }
      return { governor: g };
    }

    case "opening": {
      // Session start: low cap, but only the SHORT dwell. There is no failure to back
      // off from yet, and every ms here is the small rung on a link that may be fine.
      if (nowMs - g.enteredAtMs >= cfg.openingDwellMs && isHealthy(s)) {
        return { governor: { ...enter(g, "cap_low_eligible", "low", nowMs), healthySinceMs: nowMs } };
      }
      return { governor: g };
    }

    case "cap_low_sticky": {
      // Reset the failure count if the link has been genuinely healthy for a long
      // window (network changed / improved) — prevents permanent low-pinning.
      const healthy = isHealthy(s);
      const healthySince = healthy ? (g.healthySinceMs ?? nowMs) : null;
      const resetFailures =
        healthy && healthySince !== null && nowMs - healthySince >= cfg.healthyResetMs;
      const dwellDone = nowMs - g.enteredAtMs >= dwellMs(g.failures, cfg);
      if (dwellDone && healthy) {
        return {
          governor: {
            ...enter(g, "cap_low_eligible", "low", nowMs),
            failures: resetFailures ? 0 : g.failures,
            healthySinceMs: nowMs,
          },
        };
      }
      return {
        governor: {
          ...g,
          healthySinceMs: healthySince,
          failures: resetFailures ? 0 : g.failures,
        },
      };
    }

    case "cap_low_eligible": {
      // Raise the cap only after a continuously-healthy clean window. A single
      // unhealthy tick restarts the clean accumulation. poor/lost block via
      // isHealthy; "unknown" deliberately does NOT — LiveKit's quality score is a
      // lagging corroborator this file already refuses to trust as a sole trigger,
      // and on many prod sessions the event simply never fires, so treating a
      // MISSING reading as a block pinned those calls to the small rung for the
      // whole 30s connect window (measured: part of the 56% never-upgraded cohort).
      if (!isHealthy(s)) {
        return { governor: { ...g, healthySinceMs: null } };
      }
      const cleanSince = g.healthySinceMs ?? nowMs;
      if (nowMs - cleanSince >= cfg.cleanMs) {
        // UP-PROBE: raise the cap (permission, not delivery) and start probation.
        return {
          governor: enter(g, "probing_up", "high", nowMs),
          action: { setCap: "high" },
        };
      }
      return { governor: { ...g, healthySinceMs: cleanSince } };
    }

    case "probing_up": {
      // Survived the probation window with no pause/freeze → commit to high.
      if (nowMs - g.enteredAtMs >= cfg.probeMs) {
        return { governor: { ...enter(g, "cap_high_stable", "high", nowMs), failures: 0 } };
      }
      return { governor: g };
    }

    case "cap_high_stable":
      // Steady at high; a BWE self-dip is fine. Downgrade already handled above.
      return { governor: g };

    default:
      return { governor: g };
  }
};

/** Map the governor cap to the LiveKit VideoQuality enum value the hook passes to
 *  setVideoQuality. Kept here so the core owns the LOW/HIGH↔cap contract. */
export const capToVideoQuality = (cap: QualityCap): "low" | "high" => cap;

/**
 * Resolve the VideoQuality value the "low" cap should pin, from the publisher's
 * DECLARED layer qualities (trackInfo.layers[].quality — LiveKit protocol enum,
 * LOW=0 / MEDIUM=1 / HIGH=2): ONE RUNG BELOW the top declared layer.
 *
 * Why derived, not hardcoded: layer LABELS depend on the publisher engine, not the
 * layer count. The Python 1.1.9 engine labels its 2-layer ladder [LOW=small,
 * MEDIUM=full] — so the historical hardcoded MEDIUM cap ALLOWED the full layer and
 * the governor was silently inert (field-read + verified live 2026-07-09: a LOW cap
 * pins the small 360×540 rung; MEDIUM never bites). One-below-top gives LOW on that
 * ladder and MEDIUM on a future 3-layer ladder — preserving the "never pin the
 * starved bottom rung of a deep ladder" intent, while a cap stays a CEILING (the
 * SFU's BWE still serves below it when even this overshoots).
 *
 * Unknown or single-layer ladder ⇒ MEDIUM (=1, the historical value; with one layer
 * no subscriber cap can bite anyway, so this only matters as a safe default).
 */
export const resolveLowCapQuality = (declaredLayerQualities: readonly number[]): number => {
  const sorted = [...declaredLayerQualities].sort((a, b) => a - b);
  return sorted.length >= 2 ? sorted[sorted.length - 2] : 1;
};
