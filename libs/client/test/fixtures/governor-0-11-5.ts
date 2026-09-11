// ---------------------------------------------------------------------------
// FROZEN REFERENCE: the 0.11.5 quality governor, VERBATIM.
//
// Extracted from `git show origin/main:libs/client/src/react/quality-governor.ts` at
// 2a878ba, the commit published as v0.11.5. Regenerate/verify with that command: lines
// 100-130 (the defaults) and 180-389 (the state, the predicates and `step`) of that file are
// reproduced below without a character changed. Nothing else from it is used: the
// jitter-buffer trend helpers and `resolveLowCapQuality` are pure functions this reference
// never calls, and the types above restate the 0.11.5 shapes it needs.
//
// WHY IT IS CHECKED IN. `GovernorConfig.linkEvidence: "optional"` is documented as the kill
// switch that restores 0.11.5. A claim like that is only worth what proves it, and the only
// honest proof is running the two reducers side by side over the same traces and comparing
// EVERY field of the resulting state plus the action, tick by tick. Expressing "0.11.5" as a
// config of the current reducer (which is what the first prototype did) proves nothing: it
// silently inherits whatever the current reducer does that 0.11.5 did not.
//
// DO NOT EDIT to make a test pass. If the current reducer diverges from this file under
// `linkEvidence: "optional"`, the kill switch is broken, not this file.
// ---------------------------------------------------------------------------

/** The 0.11.5 GovernorSignal: no `transport` field existed. */
export interface LegacySignal {
  paused: boolean;
  freezeMsInWindow: number;
  jitterRising: boolean;
  connectionQuality: "excellent" | "good" | "poor" | "lost" | "unknown";
  inhibited: boolean;
}

/** The 0.11.5 GovernorConfig fields. The current GovernorConfig is a superset, so the live
 *  DEFAULT_GOVERNOR_CONFIG can be passed straight in and the shared numbers are compared. */
export interface LegacyConfig {
  openingCap: "low" | "high";
  downgradeFreezeMs: number;
  probationFreezeMs: number;
  openingDwellMs: number;
  dwellBaseMs: number;
  dwellMaxMs: number;
  cleanMs: number;
  probeMs: number;
  healthyResetMs: number;
}

type QualityCap = "low" | "high";
type GovernorSignal = LegacySignal;
type GovernorConfig = LegacyConfig;
type GovernorState =
  | "opening"
  | "opening_high"
  | "cap_low_sticky"
  | "cap_low_eligible"
  | "probing_up"
  | "cap_high_stable";
interface GovernorAction {
  setCap: QualityCap;
}

// ── verbatim from 0.11.5 lines 100-130 (the defaults) ───────────────────────
export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  openingCap: "low",
  downgradeFreezeMs: 150,
  probationFreezeMs: 100,
  openingDwellMs: 2_000,
  // HOW LONG THE PICTURE STAYS SOFT AFTER A DEMOTE. Swept against this reducer, 300 s per
  // run, five link profiles, scored as switches / percent of time on the top rung / worst
  // single spell on the low cap:
  //
  //   profile                      8s x 2^n max 120s   flat 3s        3s x 2^n max 12s
  //   a spurious blip, link fine    2 /  94% /  19s    2 /  98% / 6s   2 /  97% /  9s
  //   ordinary jitter, /30s        20 /  61% /  19s   20 /  80% / 6s  20 /  79% /  9s
  //   flaky, /10s                   9 /   7% / 123s   59 /  40% / 6s  31 /  25% / 15s
  //   genuinely bad, 600ms /5s      9 /   4% / 123s   59 /  20% / 8s  31 /  11% / 18s
  //
  // Two things that table says. First, the old `dwellMaxMs` of 120 s was the real damage:
  // a link that is merely flaky could sit soft for TWO MINUTES, which is far worse than
  // the churn the backoff exists to prevent. Second, removing the backoff entirely (flat
  // 3 s) buys the last few points of quality at 59 switches instead of 31, and a switch is
  // a decoder reconfigure plus a keyframe wait, measured at about 1.3 s of dead air on a
  // weak link. So the shape is kept and only the numbers move: start lower, cap far lower.
  //
  // This depends on not charging a layer switch to the link (see the size-change reset in
  // avatar-video-surface). Probing more often is only safe once a failed probe cannot
  // trigger the next demotion by itself.
  dwellBaseMs: 3_000,
  dwellMaxMs: 12_000,
  cleanMs: 3_000,
  probeMs: 10_000,
  healthyResetMs: 120_000,
};

// ── verbatim from 0.11.5 lines 180-389 (the reducer) ───────────────────────
export interface Governor {
  state: GovernorState;
  cap: QualityCap;
  /** Consecutive failed up-probes. Drives the exponential dwell backoff.
   *
   *  NOT a signal about the low rung. It counts attempts to reach HIGH that did not
   *  survive, which says nothing about whether the rung below HIGH is holdable. Using it
   *  to pick WHICH rung "low" means was a real regression: see `lowUnhealthy`. */
  failures: number;
  /** Unhealthy ticks observed while ALREADY on the low cap.
   *
   *  This is the only honest evidence that the low rung itself is not affordable, and it
   *  is what steps the cap down to the bottom of the ladder. It exists because `failures`
   *  looked like it would do the job and does not: a starved OPENING reports the wait for
   *  the first frame as a freeze (`firstFrameWaitFreezeMs`), so any session whose first
   *  frame is slower than about a second fails its opening probation and lands on
   *  `failures = 1` before the link has been asked to carry anything. Measured on prod,
   *  first frames ran 2.4 s to 28 s, i.e. essentially every call. Keying the rung step on
   *  `failures` therefore sent the FIRST demote straight to the bottom rung, including on
   *  a call that recorded zero freezes. Reset whenever the cap returns to high. */
  lowUnhealthy: number;
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
  lowUnhealthy: 0,
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
    // Losing an UNPROVEN high counts as a failure; losing a PROVEN one does not.
    //
    // MEASURED, and it is why this stayed as it was. Counting committed downgrades too
    // would make the exponential backoff reachable from the steady-state flap path, which
    // reads like the obvious fix. Swept against the shipped reducer over 300 s across nine
    // gap profiles, it bought nothing and cost real quality: on a 500 ms blip once a
    // minute it produced the SAME number of rung switches (10) while spending 10.7
    // percentage points LESS time on the top rung, because every blip now doubled the
    // dwell before re-probing. On every other profile it was neutral.
    //
    // So the asymmetry is deliberate, not an oversight. If you come back to this, the
    // thing to change is the dwell curve, not the failure predicate.
    const failed = onProbation;
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
      // Evidence about the LOW rung, gathered while sitting on it.
      const lowUnhealthy = healthy ? g.lowUnhealthy : g.lowUnhealthy + 1;
      const dwellDone = nowMs - g.enteredAtMs >= dwellMs(g.failures, cfg);
      if (dwellDone && healthy) {
        return {
          governor: {
            ...enter(g, "cap_low_eligible", "low", nowMs),
            failures: resetFailures ? 0 : g.failures,
            lowUnhealthy: resetFailures ? 0 : lowUnhealthy,
            healthySinceMs: nowMs,
          },
        };
      }
      return {
        governor: {
          ...g,
          healthySinceMs: healthySince,
          failures: resetFailures ? 0 : g.failures,
          lowUnhealthy: resetFailures ? 0 : lowUnhealthy,
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
        return { governor: { ...g, healthySinceMs: null, lowUnhealthy: g.lowUnhealthy + 1 } };
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
        return {
          governor: { ...enter(g, "cap_high_stable", "high", nowMs), failures: 0, lowUnhealthy: 0 },
        };
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
