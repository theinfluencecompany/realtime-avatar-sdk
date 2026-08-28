/**
 * The adaptive playout-delay controller — the closed loop behind
 * `useAvatarAdaptivePlayoutDelay`.
 *
 * The flat {@link DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS} cushion exists for loss
 * robustness (measured at ~5% loss it takes the stream from ~11fps with
 * multi-second freezes to a steady 25fps) — but it bills every viewer 0.5s of
 * felt reply latency on every turn, clean network or not. This controller keeps
 * the cushion where the network needs it and reclaims it where it doesn't:
 *
 *   target = clamp(floor + jitterGain·EWMA(jitter) + lossGain·EWMA(loss),
 *                  floor, ceiling)
 *
 * with three deliberate asymmetries, each a lesson already paid for:
 *
 * 1. **It OPENS at the ceiling** (the incumbent 0.5s) and only ever descends in
 *    steady state. The open-small-then-ramp variant shipped, failed twice (the
 *    rVFC ramp trigger is throttled on an opacity:0-mounted element, stranding
 *    the shallow buffer), and was removed in 2262e4c7b. This loop never opens
 *    shallow and never depends on rVFC — its clock is a plain interval over
 *    `RTCRtpReceiver.getStats()`.
 * 2. **Grow fast, shrink slow.** A loss burst must deepen the buffer within a
 *    couple of ticks (freezes are the cardinal sin); a clean stretch earns
 *    latency back over tens of seconds. In the continuous-render model the
 *    session is long, so there is plenty of steady state to reclaim in.
 * 3. **Hysteresis.** The hint is only re-applied when the smoothed target moved
 *    by more than `hysteresisSeconds` — a receiver being re-hinted every second
 *    with ±5ms wiggle re-anchors its buffer for nothing.
 *
 * Pure by construction: no react, no livekit, no DOM — a plain state machine
 * over numbers, imported directly by the node test runner. The hook that feeds
 * it stats lives in `use-adaptive-playout.ts`.
 */

/** One tick's network observation, already reduced to the two axes that matter. */
export interface AdaptivePlayoutSample {
  /** RTP jitter in SECONDS (`inbound-rtp.jitter`), worst of the avatar's receivers. */
  jitterSeconds: number;
  /** Fraction of packets lost over the tick (0..1), worst of the avatar's receivers. */
  lossFraction: number;
}

export interface AdaptivePlayoutOptions {
  /** The clean-network resting depth. Default 0.15s — the design's floor. */
  floorSeconds?: number;
  /** The lossy-network depth AND the opening value. Default 0.5s (the incumbent flat cushion). */
  ceilingSeconds?: number;
  /** Seconds of buffer per second of RTP jitter. Default 4 (25ms jitter ⇒ +100ms). */
  jitterGain?: number;
  /** Seconds of buffer per unit loss fraction. Default 5 (5% loss ⇒ +250ms ⇒ near ceiling). */
  lossGain?: number;
  /** EWMA blend when the demand RISES. Default 0.6 — most of a burst lands in 2 ticks. */
  growAlpha?: number;
  /** EWMA blend when the demand FALLS. Default 0.08 — ~9-tick half-life, latency earned back slowly. */
  shrinkAlpha?: number;
  /** Minimum movement before the hint is re-applied. Default 0.05s (the design's 50ms). */
  hysteresisSeconds?: number;
}

const DEFAULTS: Required<AdaptivePlayoutOptions> = {
  floorSeconds: 0.15,
  ceilingSeconds: 0.5,
  jitterGain: 4,
  lossGain: 5,
  growAlpha: 0.6,
  shrinkAlpha: 0.08,
  hysteresisSeconds: 0.05,
};

export interface AdaptivePlayoutDecision {
  /** The depth the receivers should sit at, seconds. Always within [floor, ceiling]. */
  targetSeconds: number;
  /** True when the caller should re-apply the hint (movement cleared the hysteresis). */
  changed: boolean;
}

export class AdaptivePlayoutController {
  private readonly opts: Required<AdaptivePlayoutOptions>;
  private smoothed: number;
  private applied: number;

  constructor(options: AdaptivePlayoutOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    // Open AT the ceiling — the incumbent cushion — and earn latency back from there.
    this.smoothed = this.opts.ceilingSeconds;
    this.applied = this.opts.ceilingSeconds;
  }

  /** The currently applied depth (what the receivers were last hinted to). */
  get appliedSeconds(): number {
    return this.applied;
  }

  update(sample: AdaptivePlayoutSample): AdaptivePlayoutDecision {
    const { floorSeconds, ceilingSeconds, jitterGain, lossGain } = this.opts;
    const jitter = Number.isFinite(sample.jitterSeconds) ? Math.max(0, sample.jitterSeconds) : 0;
    const loss = Number.isFinite(sample.lossFraction)
      ? Math.min(1, Math.max(0, sample.lossFraction))
      : 0;
    const demand = Math.min(
      ceilingSeconds,
      Math.max(floorSeconds, floorSeconds + jitterGain * jitter + lossGain * loss),
    );
    const alpha = demand > this.smoothed ? this.opts.growAlpha : this.opts.shrinkAlpha;
    this.smoothed += alpha * (demand - this.smoothed);
    const hysteresis = this.opts.hysteresisSeconds;
    const clamped = Math.min(ceilingSeconds, Math.max(floorSeconds, this.smoothed));
    // SNAP TO THE BOUNDS. An EWMA approaches its target asymptotically, so a plain
    // hysteresis gate leaves `applied` stranded one band ABOVE the floor forever —
    // measured 0.176s against a 0.15s floor, i.e. ~26ms of the reclaim quietly
    // forfeited, which is most of the way to not being worth shipping. Within one
    // band of a bound the target IS the bound; the anti-chatter gate then applies
    // only in the interior, where there is somewhere to chatter to.
    const target =
      clamped - floorSeconds <= hysteresis
        ? floorSeconds
        : ceilingSeconds - clamped <= hysteresis
          ? ceilingSeconds
          : clamped;
    if (target === this.applied) return { targetSeconds: this.applied, changed: false };
    const atBound = target === floorSeconds || target === ceilingSeconds;
    if (!atBound && Math.abs(target - this.applied) <= hysteresis) {
      return { targetSeconds: this.applied, changed: false };
    }
    this.applied = target;
    return { targetSeconds: this.applied, changed: true };
  }
}

/**
 * Cumulative counters from one receiver's previous `inbound-rtp` report, kept by
 * the caller so loss can be computed as a PER-TICK delta (the stats counters are
 * cumulative for the whole session — a session-long ratio would never recover
 * from one bad patch).
 */
export interface InboundRtpCursor {
  packetsLost: number;
  packetsReceived: number;
}

export interface InboundRtpReading {
  sample: AdaptivePlayoutSample;
  cursor: InboundRtpCursor;
}

/**
 * Reduce one receiver's `getStats()` report to this tick's {@link AdaptivePlayoutSample}.
 * Takes the report as a plain iterable of stat dicts so tests need no RTCStatsReport.
 * Returns undefined when the report carries no `inbound-rtp` entry (nothing decodable
 * yet) — the caller should skip the tick rather than feed a fabricated zero.
 *
 * Counter resets (a receiver restart makes cumulative counters go BACKWARD) read as
 * a zero-loss tick, never a negative one.
 */
export function readInboundRtp(
  reports: Iterable<Record<string, unknown>>,
  previous?: InboundRtpCursor,
): InboundRtpReading | undefined {
  for (const report of reports) {
    if (report["type"] !== "inbound-rtp") continue;
    const jitterSeconds = typeof report["jitter"] === "number" ? report["jitter"] : 0;
    const packetsLost = typeof report["packetsLost"] === "number" ? report["packetsLost"] : 0;
    const packetsReceived =
      typeof report["packetsReceived"] === "number" ? report["packetsReceived"] : 0;
    const dLost = Math.max(0, packetsLost - (previous?.packetsLost ?? packetsLost));
    const dReceived = Math.max(0, packetsReceived - (previous?.packetsReceived ?? packetsReceived));
    const denominator = dLost + dReceived;
    return {
      sample: {
        jitterSeconds,
        lossFraction: denominator > 0 ? dLost / denominator : 0,
      },
      cursor: { packetsLost, packetsReceived },
    };
  }
  return undefined;
}
