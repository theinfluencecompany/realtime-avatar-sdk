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
  /** TRANSPORT EVIDENCE for the trailing tick, from the receiver's inbound-rtp counters.
   *
   *  A freeze is a gap in PRESENTED frames. Three things produce one: the link dropped or
   *  delayed packets, the SENDER never produced the frames (a render stall on the GPU
   *  worker), or the local paint fell behind. Only the first is something a smaller rung
   *  can fix. The two are told apart by the RTP sequence space: a link that loses packets
   *  leaves sequence gaps (packetsLost, and the NACKs the receiver sends to fill them); a
   *  sender that pauses leaves none. So a freeze tick with ZERO loss and ZERO NACKs is
   *  sender-shaped and is not charged as a link freeze (see `isFreezeChargeable`).
   *
   *  `undefined` = the hook could not read the counters this tick (no getStats, or no
   *  baseline yet). Unknown keeps today's behaviour: the freeze is charged. This is what
   *  keeps every existing trace test byte-identical and Safari-without-stats unchanged.
   *
   *  Measured shape of the defect this addresses (prod rtx6000 pool, 2026-09-11): two
   *  calls on one GPU showed per-chunk render medians of 351 ms against 60 ms solo, and
   *  the client demoted 584x1024 -> 360x630 -> 180x316 within a minute with packetsLost
   *  = 0 in every probe. The smaller rung did not shorten a single stall. */
  transport?: {
    /** inbound-rtp packetsLost delta since the previous tick (clamped at 0). */
    packetsLostInWindow: number;
    /** inbound-rtp nackCount delta since the previous tick (clamped at 0; 0 where the
     *  browser does not report nackCount, so packetsLost alone still corroborates). */
    nacksInWindow: number;
    /** inbound-rtp framesDropped delta since the previous tick (clamped at 0). Frames that
     *  ARRIVED and were dropped before decode or missed their display deadline: the one
     *  failure a smaller rung can fix that the sequence space cannot see (a starving
     *  client on a clean pipe, the case 0.11.2 #71 built the floor for). */
    framesDroppedInWindow: number;
  };
}

/**
 * Dropped frames in one tick that mean the DECODER, not the link, is behind.
 *
 * HONEST PROVENANCE: this number is a judgement, not a measurement. The 2026-09-11 probe
 * corpus carries no framesDropped column at all (the replay hardcodes it to 0, which is the
 * fence's most permissive reading), so nothing in this repo has ever observed the constant
 * bite. It is kept rather than removed because removing it removes the ONLY path by which a
 * starving client on a clean pipe can still reach its floor — the case 0.11.2 #71 built the
 * floor for — and that case is real even though this corpus does not contain it.
 *
 * The reasoning behind 2: framesDropped counts frames that ARRIVED and then missed their
 * deadline. At the 15-25 fps the deployed rungs declare, one drop in a one-second tick is
 * 4-7 % of that tick's frames, which is the ordinary noise of a late frame at a layer edge;
 * two is a deficit the decoder is not recovering from inside the tick. What would change it:
 * a corpus with framesDropped sampled on calls that were and were not visibly stuttering.
 * Until then the conservative direction is the one taken here — a HIGHER bar refuses more
 * freezes, and refusing is the behaviour this whole file is arguing for.
 */
export const LOCAL_STARVATION_DROPPED_FRAMES = 2;

/** The inbound-rtp VIDEO rows of one getStats report, narrowed to the counters the
 *  transport fence reads. Structural, so a test can hand in plain objects. */
export interface InboundRtpLike {
  kind?: string;
  packetsLost?: number;
  nackCount?: number;
  framesDropped?: number;
}

/** Cumulative inbound-rtp totals at the previous read of ONE binding. */
export interface TransportCursor {
  lost: number;
  nack: number;
  dropped: number;
}

/** Everything one binding's transport reader remembers between ticks. */
export interface TransportReadState {
  /** Cumulative totals at the previous COUNTED read; null before the first one. */
  cursor: TransportCursor | null;
  /** Wall-clock ms of the first read on this binding: the clock the join window runs on.
   *  Null until that first read, so the state can be built without a clock. */
  firstReadAtMs: number | null;
  /** True once ANY inbound-rtp video row has been seen on this binding. */
  sawRow: boolean;
}

/** A fresh reader for a new binding (reconnect, track replacement). */
export const initialTransportRead = (): TransportReadState => ({
  cursor: null,
  firstReadAtMs: null,
  sawRow: false,
});

/**
 * How long "no inbound-rtp row yet" may be read as a CLEAN pipe rather than as an unreadable
 * one. Bounded because the two are indistinguishable from one report: a subscription whose
 * first frame has not landed and a runtime that never reports inbound-rtp at all look exactly
 * the same. The first is over in seconds; the second lasts the whole call, and treating it as
 * clean forever would fence every freeze on that runtime permanently — a silent, unfixable
 * "the governor stopped working here".
 *
 * 30 s covers the measured first-frame spread on the rtx6000 pool with margin (2.4 s to 28 s
 * on prod, 2026-09-09/11). Past it the reading degrades to UNKNOWN, which is 0.11.5: the
 * freeze is charged. The failure direction is deliberate — an unreadable runtime falls back to
 * the behaviour that shipped, never to a new one.
 */
export const TRANSPORT_CLEAN_ASSUMPTION_MS = 30_000;

/**
 * Translate one getStats report's inbound-rtp rows into the tick's transport evidence.
 *
 * Provenance rules, in order:
 *  1. NO inbound-rtp video row AND none has ever been seen AND we are still inside
 *     `joinWindowMs` of the first read: a receiver that has received nothing has lost
 *     nothing. This is the join-time first-frame wait (the worker's primary cache load,
 *     1-21 s on the rtx6000 pool), which a smaller rung cannot shorten. Reads as a clean
 *     pipe; the cursor is untouched.
 *  2. NO row in any other case — past the join window, or after rows have been seen and then
 *     stopped (a receiver torn down mid-call): UNKNOWN. Nothing is being claimed about a pipe
 *     that cannot be read, so the reducer charges the freeze exactly as 0.11.5 did.
 *  3. A row exists but `packetsLost` is not a number: the runtime does not expose the
 *     sequence space (Safari / RN without counters). UNKNOWN, same as above. The cursor is
 *     untouched, and the row is remembered so rule 1 can never apply again.
 *  4. A row with `packetsLost` (nackCount / framesDropped default to 0 where absent):
 *     the FIRST read of a binding only stores the baseline and reports a clean window.
 *     The totals of a fresh RTCRtpReceiver start at zero, but a REBIND onto a receiver
 *     that already carried traffic does not, and charging its lifetime loss to one tick
 *     would demote every reconnect. Nothing is lost by waiting: the first-frame wait is
 *     charged only past the 1000 ms grace, i.e. from the second tick on. Later reads
 *     report positive deltas against the cursor.
 */
export const transportFromInboundRows = (
  rows: readonly InboundRtpLike[],
  state: TransportReadState,
  nowMs: number,
  joinWindowMs: number = TRANSPORT_CLEAN_ASSUMPTION_MS,
): { transport: GovernorSignal["transport"]; state: TransportReadState } => {
  const clean = { packetsLostInWindow: 0, nacksInWindow: 0, framesDroppedInWindow: 0 };
  const firstReadAtMs = state.firstReadAtMs ?? nowMs;
  const video = rows.filter((r) => r.kind === undefined || r.kind === "video");
  if (video.length === 0) {
    const joining = !state.sawRow && nowMs - firstReadAtMs <= joinWindowMs;
    return { transport: joining ? clean : undefined, state: { ...state, firstReadAtMs } };
  }
  const seen: TransportReadState = { ...state, firstReadAtMs, sawRow: true };
  const counted = video.filter((r) => typeof r.packetsLost === "number");
  if (counted.length === 0) return { transport: undefined, state: seen };
  const totals: TransportCursor = { lost: 0, nack: 0, dropped: 0 };
  for (const r of counted) {
    totals.lost += r.packetsLost ?? 0;
    totals.nack += r.nackCount ?? 0;
    totals.dropped += r.framesDropped ?? 0;
  }
  if (seen.cursor === null) return { transport: clean, state: { ...seen, cursor: totals } };
  return {
    transport: {
      packetsLostInWindow: Math.max(0, totals.lost - seen.cursor.lost),
      nacksInWindow: Math.max(0, totals.nack - seen.cursor.nack),
      framesDroppedInWindow: Math.max(0, totals.dropped - seen.cursor.dropped),
    },
    state: { ...seen, cursor: totals },
  };
};

/**
 * The SFU pause as the hook can present it at TICK TIME: the subscribed track's stream state
 * (the values of LiveKit's `Track.StreamState`, translated at the adapter so the core stays
 * vendor-free), plus whether a Paused EVENT landed since the previous tick.
 */
export type PauseLevel = "active" | "paused" | "unknown";

/**
 * Is this tick paused?
 *
 * READ THE LEVEL, NOT THE EDGE. `TrackStreamStateChanged` fires once when the SFU's
 * congestion controller pauses the track and once when it resumes. The hook latched that
 * event and consumed it after one tick, so from tick 2 of a pause that is STILL IN FORCE the
 * signal read clean: a paused sender loses no packets, so the transport fence charges
 * nothing, every tick is healthy, and the governor walks its clean window and PROBES UP into
 * a track the SFU has already refused to forward.
 *
 * The event is kept as a fast path rather than dropped, because it is the only evidence of a
 * pause that both started and ended between two ticks, and an "unknown" level (no track bound
 * yet, a runtime without the getter) must degrade to the old behaviour rather than to
 * "never paused".
 */
export const pausedForTick = (level: PauseLevel, edgeSinceLastTick: boolean): boolean =>
  level === "paused" || edgeSinceLastTick;

/** The side effect the hook must apply after a step (absent = leave the cap alone). */
export interface GovernorAction {
  setCap: QualityCap;
}

/**
 * One governor tick, as the hook saw and decided it. Emitted to `onTrace` when a caller
 * asks for it; the reducer never reads it.
 *
 * Why it exists: the only visible trace of a demote in production is the decoded width
 * changing, and a receiver-side stats corpus (8 probe calls, 2026-09-11) could not
 * reproduce 11 of 18 observed demotes from inbound-rtp alone: decode steady at 25 fps,
 * zero Chrome freezes, zero loss. The predicate that fired is not recoverable after the
 * fact without the signal the reducer actually received. `tickLateMs` and
 * `framesDecodedInWindow` ride along so a presented-frame gap can be classified as link
 * (loss/NACK/pause), sender (decode stalled, no loss) or local (decode advanced, the tick
 * itself was late) from one record.
 */
export interface GovernorTraceEvent {
  /** Wall-clock ms of the tick. */
  tMs: number;
  /** How late the tick fired relative to its schedule: a proxy for a main-thread stall. */
  tickLateMs: number;
  /** inbound-rtp framesDecoded delta since the previous tick; undefined when unreadable. */
  framesDecodedInWindow?: number;
  signal: GovernorSignal;
  /** The two inputs of `signal.freezeMsInWindow` (= max of both): the surface's presented-
   *  frame reading and the Chrome totalFreezesDuration delta. Which one carried the freeze
   *  is the first question a demote investigation asks. */
  rvfcFreezeMs: number;
  statsFreezeMs: number;
  /** Decoded "WxH" the receiver reported this tick (null when unreadable): the rung. */
  sizeKey: string | null;
  /** Whether the tick's freeze was charged to the link (see `isFreezeChargeable`). */
  chargeable: boolean;
  /** The freeze the reducer actually judged (0 when not chargeable and the fence is on). */
  chargedFreezeMs: number;
  before: Pick<Governor, "state" | "cap" | "failures" | "lowUnhealthy">;
  after: Pick<Governor, "state" | "cap" | "failures" | "lowUnhealthy">;
  action?: GovernorAction;
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
  dwellBaseMs: number; // 3_000  (was 8_000; see the sweep on DEFAULT_GOVERNOR_CONFIG)
  /** Cap on the exponential dwell backoff — never pin low permanently. */
  dwellMaxMs: number; // 12_000  (was 120_000, which let a flaky link sit soft for 2 min)
  /** Continuously-healthy window required before raising the cap. 3s: still well above
   *  the sub-second downgrade reaction (the asymmetry that prevents flap), but short
   *  enough that a clean link reaches the probe at ~5s from session start
   *  (openingDwellMs + cleanMs) instead of 13s under the old 8s+5s posture. */
  cleanMs: number; // 3_000
  /** Probation length after raising the cap before committing to high. */
  probeMs: number; // 10_000  (≈ Meet full-recovery window)
  /** Sustained-healthy-at-low duration that resets the failure count (link improved). */
  healthyResetMs: number; // 120_000
  /** THE KILL SWITCH, and it is a FULL revert.
   *
   *  "required" (default): everything this file learned on 2026-09-11 is live — the transport
   *  fence (`isFreezeChargeable`), the healthy band, the jitter clause, the lowUnhealthy
   *  decay and the delay-only demote path.
   *
   *  "optional": the reducer is 0.11.5, byte for byte — every freeze charged regardless of
   *  transport, `freezeMsInWindow === 0` required for health, a bare `!jitterRising` clause,
   *  no decay and no delay-only path. Not "the fence off with the new recovery rules still
   *  running": that would be a reducer that never shipped, and a switch whose OFF position is
   *  a third behaviour cannot answer the question it exists for. Proven by running the live
   *  reducer against a frozen verbatim copy of 0.11.5 over a trace corpus
   *  (test/fixtures/governor-0-11-5.ts, governor-kill-switch.test.ts).
   *
   *  Exists so the whole change can be turned off from app config without a release. */
  linkEvidence: "required" | "optional"; // "required"
  /** A tick is HEALTHY while its link-charged freeze is within this many ms.
   *
   *  67 = one frame interval at 15 fps, the slowest declared rung on the three-layer ladder
   *  (the 180x316 layer). NOTE WHAT THIS IS MEASURED AGAINST: the surface has already
   *  subtracted `AVATAR_FRAME_GAP_FREEZE_FLOOR_MS` (100) before the reading reaches here, so
   *  a 67 ms charged freeze is a 167 ms PRESENTED gap — two frame intervals at 15 fps, or
   *  three at 20. The band forgives ordinary presentation spacing on the lowest rung so the
   *  climb back happens inside the designed dwell + clean window. 0.11.5 demanded exactly 0
   *  and measured 10-46 s of low-rung dwell against a designed 15 s (2026-09-11).
   *
   *  MUST stay below `probationFreezeMs` or one tick could be "healthy" and "a demote" at
   *  once. An out-of-range value is CLAMPED, never thrown (see `healthyToleranceMs`). */
  healthyFreezeToleranceMs: number; // 67
  /** Two link-charged unhealthy ticks on the low cap arm the BOTTOM rung
   *  (LOW_CAP_STEP_AFTER_UNHEALTHY) only if they land within this window of each other, and
   *  the pair must still be inside it at the demote that SPENDS it (`decayLowUnhealthy`).
   *  10 s = probeMs, so one failed probation cycle still counts as "recent"; a decoder that
   *  drops one frame every 15 s stays on the middle rung, which is the intended floor
   *  behaviour. 0.11.5 counted any two ticks anywhere in the call. */
  lowUnhealthyWindowMs: number; // 10_000
  /** Consecutive ticks of RISING jitter (each with a presented gap) that demote a high cap
   *  even though the sequence space is clean. See `isDelayOnlyCongestion` for the whole
   *  argument; 3 is the deliberate trade between 0.11.5's one tick and the fence's never. */
  jitterRisingTicksToDemote: number; // 3
}

/** The grounded defaults (Meet <10s recovery + GCC +5%/−15% step asymmetry). */
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
  linkEvidence: "required",
  healthyFreezeToleranceMs: 67,
  lowUnhealthyWindowMs: 10_000,
  jitterRisingTicksToDemote: 3,
};

/**
 * Every GovernorConfig field, by name. The hook value-memoises its config on exactly these
 * keys (a caller re-rendering with a fresh object must not re-init the governor), so a
 * field missing here is a field the hook silently DROPS. The type below refuses to compile
 * when a config field is added without listing it; `governor-config-memo.test.ts` pins the
 * same fact at runtime against DEFAULT_GOVERNOR_CONFIG.
 */
export const GOVERNOR_CONFIG_MEMO_KEYS = [
  "openingCap",
  "downgradeFreezeMs",
  "probationFreezeMs",
  "openingDwellMs",
  "dwellBaseMs",
  "dwellMaxMs",
  "cleanMs",
  "probeMs",
  "healthyResetMs",
  "linkEvidence",
  "healthyFreezeToleranceMs",
  "lowUnhealthyWindowMs",
  "jitterRisingTicksToDemote",
] as const satisfies readonly (keyof GovernorConfig)[];

type UnlistedGovernorConfigKey = Exclude<keyof GovernorConfig, (typeof GOVERNOR_CONFIG_MEMO_KEYS)[number]>;
// A compile error here means a GovernorConfig field was added without a memo key.
const _everyGovernorConfigKeyIsListed: [UnlistedGovernorConfigKey] extends [never] ? true : never = true;
void _everyGovernorConfigKeyIsListed;

const assignDefined = <K extends keyof GovernorConfig>(
  target: GovernorConfig,
  source: Partial<GovernorConfig>,
  key: K,
): void => {
  const value = source[key];
  if (value !== undefined) target[key] = value;
};

/**
 * The healthy band, clamped into the only range in which it means anything: at or above the
 * probation bar it would make one tick "healthy" and "a demote" at the same time, and below
 * zero it is not a duration.
 *
 * WHY CLAMPED AND NOT REFUSED. `initGovernor` used to throw a RangeError on an out-of-range
 * band, and the hook's fail-open path caught that by unsubscribing BEFORE it ever applied a
 * cap — so a one-line typo in app config produced the worst reachable outcome: the call
 * opened at the TOP rung with no governor at all, on every link, with no way down. A
 * misconfiguration must never be worse than no configuration. Clamping keeps the invariant
 * the throw was defending while keeping the governor running, and it holds for hand-built
 * configs that never passed through `resolveGovernorConfig`.
 */
export const clampHealthyToleranceMs = (rawMs: number, probationFreezeMs: number): number => {
  const bar = Number.isFinite(probationFreezeMs) ? probationFreezeMs : DEFAULT_GOVERNOR_CONFIG.probationFreezeMs;
  const raw = Number.isFinite(rawMs) ? rawMs : 0;
  return Math.max(0, Math.min(raw, bar - 1));
};

/** Logged once per module instance: the hook resolves its config on every render, and a
 *  warning on every render of every call is noise nobody reads. */
let warnedAboutToleranceClamp = false;

/** A fresh GovernorConfig: the defaults with every DEFINED override applied, by value, with
 *  the healthy band clamped to the range it can actually be applied in. Only the listed
 *  fields survive, so an unknown or `undefined` property can neither leak in nor erase a
 *  default. */
export const resolveGovernorConfig = (overrides: Partial<GovernorConfig> = {}): GovernorConfig => {
  const resolved: GovernorConfig = { ...DEFAULT_GOVERNOR_CONFIG };
  for (const key of GOVERNOR_CONFIG_MEMO_KEYS) assignDefined(resolved, overrides, key);
  const clamped = clampHealthyToleranceMs(resolved.healthyFreezeToleranceMs, resolved.probationFreezeMs);
  if (clamped !== resolved.healthyFreezeToleranceMs) {
    if (!warnedAboutToleranceClamp && typeof console !== "undefined") {
      warnedAboutToleranceClamp = true;
      console.warn(
        `[realtime-avatar] governor config: healthyFreezeToleranceMs ${resolved.healthyFreezeToleranceMs} is outside ` +
          `[0, probationFreezeMs) and was clamped to ${clamped}. The healthy band must stay below the probation bar.`,
      );
    }
    // The RESOLVED config carries the value that will actually be applied, so telemetry and
    // the hook's memo agree with the reducer.
    resolved.healthyFreezeToleranceMs = clamped;
  }
  return resolved;
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
  /** Wall-clock ms of the most recent unhealthy tick counted in `lowUnhealthy`. Absent when
   *  none has been counted since the last reset. The count only ACCUMULATES while the next
   *  unhealthy tick lands within `lowUnhealthyWindowMs` of this; otherwise it restarts at 1
   *  (see `bumpLowUnhealthy`). Optional rather than nullable so a Governor literal without
   *  it (every pre-existing trace test) is a valid "no recent evidence" state. */
  lowUnhealthyAtMs?: number;
  /** Consecutive ticks on which `jitterRising` held, for the delay-only demote path (see
   *  `isDelayOnlyCongestion`). Absent until the first such tick, and never present at all in
   *  legacy mode (`linkEvidence: "optional"`), so a 0.11.5 state stays a 0.11.5 state. */
  jitterRisingTicks?: number;
  /** Wall-clock ms the current state was entered (for dwell/clean/probe timing). */
  enteredAtMs: number;
  /** Wall-clock ms of the last healthy tick in the current low period (clean-window
   *  accumulation); null until the first healthy tick after entering low. */
  healthySinceMs: number | null;
}

/** The initial governor. Default opening: cap=low — first impression is NEVER a
 *  freeze, with only the short opening dwell. `openingCap: "high"` inverts the bet:
 *  first impression is never a RAMP, under the strict probation bar from t=0. */
export const initGovernor = (
  nowMs: number,
  openingCap: QualityCap = "low",
  // Accepted so the signature reads like the rest of the module and so a future startup
  // concern has a home. TOTAL BY CONSTRUCTION: this function cannot throw for any input.
  // The one startup invariant it used to enforce (the healthy band below the probation bar)
  // is now enforced where the band is READ, by clamping — see `healthyToleranceMs`. A
  // governor that refuses to exist is strictly worse than one running on a clamped number:
  // the hook's fail-open path caught the throw by leaving the call with no governor at all.
  _cfg: GovernorConfig = DEFAULT_GOVERNOR_CONFIG,
): Governor => ({
  state: openingCap === "high" ? "opening_high" : "opening",
  cap: openingCap,
  failures: 0,
  lowUnhealthy: 0,
  enteredAtMs: nowMs,
  healthySinceMs: null,
});

/**
 * Is the reducer in 0.11.5 mode? ONE predicate, read by every behaviour this change added, so
 * "the kill switch restores 0.11.5" is a property of the code rather than a promise in a
 * comment. Adding a behaviour without consulting this is the bug finding 2 caught.
 */
const isLegacyGovernor = (cfg: GovernorConfig): boolean => cfg.linkEvidence === "optional";

/** The healthy band the reducer APPLIES: 0 in legacy mode, otherwise the configured band
 *  clamped below the probation bar (see `clampHealthyToleranceMs`). */
export const healthyToleranceMs = (cfg: GovernorConfig): number =>
  isLegacyGovernor(cfg) ? 0 : clampHealthyToleranceMs(cfg.healthyFreezeToleranceMs, cfg.probationFreezeMs);

/**
 * Can this tick's freeze be charged to the LINK?
 *
 * Yes when the SFU paused us (it has already ruled), when transport evidence is
 * unknown (today's behaviour, unchanged), or when the sequence space shows the link
 * dropped something. No when the counters were read and show a clean pipe: the frames
 * were never sent, and a demote cannot make a stalled sender faster. It only makes
 * the picture smaller and then costs a layer switch on the way back.
 */
export const isFreezeChargeable = (s: GovernorSignal): boolean =>
  s.paused ||
  s.transport === undefined ||
  s.transport.packetsLostInWindow > 0 ||
  s.transport.nacksInWindow > 0 ||
  s.transport.framesDroppedInWindow >= LOCAL_STARVATION_DROPPED_FRAMES;

/** The freeze the governor actually reasons about: zero for a sender-shaped stall, the
 *  whole reading when the fence is switched off (`linkEvidence: "optional"`). */
export const chargedFreezeMs = (s: GovernorSignal, cfg: GovernorConfig): number =>
  isLegacyGovernor(cfg) || isFreezeChargeable(s) ? s.freezeMsInWindow : 0;

/**
 * DELAY-ONLY CONGESTION: the one failure class the transport fence cannot see.
 *
 * A link that degrades by DELAY alone — a bloated buffer, a shaped uplink — delivers every
 * packet, late. No loss, no NACKs, no framesDropped, and the SFU may never pause us, so
 * `isFreezeChargeable` refuses every one of its freezes and a governor with only the fence
 * would ride out the whole call on the top rung while the picture stutters. That is a real
 * regression against 0.11.5, where any freeze demoted.
 *
 * The bounded path back, and why each half is load-bearing:
 *  - `jitterRisingTicks >= N`: a RUN, not a flicker. The app's own adaptive playout hint
 *    moves the jitter-buffer interval average, so a single rise must never demote — that is
 *    the recovery bug measured on 2026-09-11.
 *  - `freezeMsInWindow > 0`: frames are actually being missed. Rising jitter with a perfect
 *    presentation clock is a buffer doing its job.
 *  - the RAW freeze, not the charged one: this class is by definition not chargeable, so
 *    reading the charged value would make the clause dead code.
 *
 * THE TRADE, stated plainly: at 1 s ticks this costs about N seconds of stutter before the
 * cap moves, against 0.11.5's one tick. It is a DELAY, not a refusal, and it is the price of
 * refusing the sender-stall demotes that make up 12 of 12 wire-captured rung changes.
 */
const isDelayOnlyCongestion = (g: Governor, s: GovernorSignal, cfg: GovernorConfig): boolean =>
  !isLegacyGovernor(cfg) &&
  (g.jitterRisingTicks ?? 0) >= cfg.jitterRisingTicksToDemote &&
  s.freezeMsInWindow > 0;

/** Advance the consecutive-rising-jitter run. Returns the SAME governor when the count does
 *  not move, so a call without jitter never grows the state object (and legacy mode, which
 *  never calls this, keeps the exact 0.11.5 shape). */
const stepJitterRun = (g: Governor, rising: boolean): Governor => {
  const next = rising ? (g.jitterRisingTicks ?? 0) + 1 : 0;
  return next === (g.jitterRisingTicks ?? 0) ? g : { ...g, jitterRisingTicks: next };
};

/** A signal is a downgrade trigger from a stable/high cap (docs §2 Fix 3). */
const isDowngrade = (s: GovernorSignal, cfg: GovernorConfig): boolean =>
  s.paused ||
  chargedFreezeMs(s, cfg) >= cfg.downgradeFreezeMs ||
  (s.jitterRising && chargedFreezeMs(s, cfg) > 0);

/** A signal fails an in-flight probation (stricter bar — kill a bad upgrade fast). */
const isProbationFail = (s: GovernorSignal, cfg: GovernorConfig): boolean =>
  s.paused || chargedFreezeMs(s, cfg) >= cfg.probationFreezeMs;

/**
 * "Healthy right now": the SFU has not paused the track, the LINK-CHARGED freeze is inside
 * the band (67 ms charged = a 167 ms presented gap, because the surface has already
 * subtracted the 100 ms floor), jitter is not rising WHILE a charged freeze exists, and the
 * avatar participant's quality is not poor/lost.
 *
 * Two deliberate departures from 0.11.5, BOTH reverted by `linkEvidence: "optional"`.
 * First, the band (`healthyFreezeToleranceMs`)
 * replaces `=== 0`: a 124 ms presented gap on the 15 fps rung was resetting the 3 s clean
 * window forever while never being large enough to demote, so the cap could not come back
 * (measured: 4 of 7 probe calls never recovered). Second, the bare `!jitterRising` clause is
 * gone: the app's own adaptive playout hint moves the jitter-buffer average, and a jitter
 * flicker alone must not restart the clean window or walk `lowUnhealthy`. Jitter still
 * corroborates a demote through `isDowngrade`. A sender-shaped stall is not unhealthy LINK
 * evidence either, so it neither restarts the clean window nor counts toward `lowUnhealthy`
 * (the walk to the bottom rung must be earned by the link, not by the worker's render queue).
 */
const isHealthy = (s: GovernorSignal, cfg: GovernorConfig): boolean => {
  const charged = chargedFreezeMs(s, cfg);
  // BOTH departures are gated on the same kill switch as the fence. Leaving them live under
  // `linkEvidence: "optional"` made the OFF position a third behaviour that never shipped.
  const jitterUnhealthy = isLegacyGovernor(cfg) ? s.jitterRising : s.jitterRising && charged > 0;
  return (
    !s.paused &&
    charged <= healthyToleranceMs(cfg) &&
    !jitterUnhealthy &&
    s.connectionQuality !== "poor" &&
    s.connectionQuality !== "lost"
  );
};

/** The exponential dwell for the current failure count, capped. */
const dwellMs = (failures: number, cfg: GovernorConfig): number =>
  Math.min(cfg.dwellBaseMs * 2 ** failures, cfg.dwellMaxMs);

/** Count one more unhealthy tick on the low cap, decaying on TIME: the count accumulates
 *  only while consecutive unhealthy ticks land within `lowUnhealthyWindowMs` of each other,
 *  otherwise it restarts at 1. This is what stops a stale tick from an earlier episode from
 *  arming the bottom rung on the next demote (0.11.5 replay: lowUnhealthy 29 after 58 s of
 *  a 124 ms gap every 2 s, then straight to 180x316). */
/**
 * Is this tick evidence about the LOW RUNG, or just an unhealthy tick?
 *
 * `lowUnhealthy` is not a health counter: `resolveLowCapQuality` reads it to pick WHICH rung
 * the next demote lands on, so only evidence about the rung belongs in it. An SFU pause is
 * the server telling us it has stopped forwarding this track; it says nothing about whether
 * the subscriber should sit on a smaller one, and no rung the client picks will un-pause it.
 *
 * Reading the pause as a LEVEL (so a held pause cannot probe up while it is held) turned the
 * counter into a stopwatch: one count per paused tick, so a 4 s pause selected the bottom rung
 * on the next demote and a 40 s pause reached 39. The level read is right; counting it was not.
 * Legacy mode keeps 0.11.5's arithmetic, pause included, so the kill switch stays a true revert.
 */
const countsAsLowRungEvidence = (s: GovernorSignal, cfg: GovernorConfig): boolean =>
  isLegacyGovernor(cfg) || !s.paused;

const bumpLowUnhealthy = (g: Governor, nowMs: number, cfg: GovernorConfig): Pick<Governor, "lowUnhealthy" | "lowUnhealthyAtMs"> => {
  // 0.11.5 had no clock here at all, and no field to put one in.
  if (isLegacyGovernor(cfg)) return { lowUnhealthy: g.lowUnhealthy + 1 };
  const recent = typeof g.lowUnhealthyAtMs === "number" && nowMs - g.lowUnhealthyAtMs <= cfg.lowUnhealthyWindowMs;
  return { lowUnhealthy: recent ? g.lowUnhealthy + 1 : 1, lowUnhealthyAtMs: nowMs };
};

/**
 * The low-rung evidence carried INTO a demote, decayed on the way.
 *
 * `lowUnhealthy` is not bookkeeping: the hook hands it to `resolveLowCapQuality`, so it is
 * what CHOOSES the rung a demote lands on. Decaying it only when the next unhealthy tick
 * arrives left the decay doing nothing at the one moment the count is SPENT — a pair of ticks
 * from an episode 18 s earlier still selected the bottom rung, exactly as 0.11.5 did. The
 * same window governs both ends.
 */
const decayLowUnhealthy = (g: Governor, nowMs: number, cfg: GovernorConfig): Pick<Governor, "lowUnhealthy" | "lowUnhealthyAtMs"> => {
  if (isLegacyGovernor(cfg)) return { lowUnhealthy: g.lowUnhealthy };
  const fresh = typeof g.lowUnhealthyAtMs === "number" && nowMs - g.lowUnhealthyAtMs <= cfg.lowUnhealthyWindowMs;
  return fresh
    ? { lowUnhealthy: g.lowUnhealthy, lowUnhealthyAtMs: g.lowUnhealthyAtMs }
    : clearedLowUnhealthy(cfg);
};

/** `lowUnhealthy` and its clock, cleared together. In legacy mode the clock field is not
 *  introduced at all: a 0.11.5 state has exactly six keys and must keep them. */
const clearedLowUnhealthy = (cfg: GovernorConfig): Pick<Governor, "lowUnhealthy" | "lowUnhealthyAtMs"> =>
  isLegacyGovernor(cfg) ? { lowUnhealthy: 0 } : { lowUnhealthy: 0, lowUnhealthyAtMs: undefined };

/** `lowUnhealthy` carried forward unchanged, with the same legacy shape rule. */
const keepLowUnhealthy = (g: Governor, cfg: GovernorConfig): Pick<Governor, "lowUnhealthy" | "lowUnhealthyAtMs"> =>
  isLegacyGovernor(cfg)
    ? { lowUnhealthy: g.lowUnhealthy }
    : { lowUnhealthy: g.lowUnhealthy, lowUnhealthyAtMs: g.lowUnhealthyAtMs };

const enter = (g: Governor, state: GovernorState, cap: QualityCap, nowMs: number): Governor => ({
  ...g,
  // The jitter run is evidence about the rung we were ON. Carrying it across a transition
  // would let a probation be killed by ticks that predate the probe, so each state judges
  // the link on its own N ticks. The conditional keeps a legacy state exactly six keys wide.
  ...(g.jitterRisingTicks === undefined ? {} : { jitterRisingTicks: 0 }),
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
  g0: Governor,
  s: GovernorSignal,
  nowMs: number,
  cfg: GovernorConfig = DEFAULT_GOVERNOR_CONFIG,
): { governor: Governor; action?: GovernorAction } => {
  const legacy = isLegacyGovernor(cfg);
  // FALSE-POSITIVE FENCE: hidden tab / muted / local-CPU freeze — trust nothing, do
  // nothing (a downgrade can't fix a decode/paint bottleneck; our Dia-freeze lesson).
  // The one thing that does move: a tick carrying no trustworthy signal cannot be part of a
  // CONSECUTIVE run of evidence, so it breaks the jitter run instead of being skipped over
  // (otherwise a hidden tab would splice a run together across minutes of not looking).
  if (s.inhibited) {
    return { governor: legacy ? g0 : stepJitterRun(g0, false) };
  }

  // The ONLY state this tick carries before any decision: the consecutive-jitter run.
  const g = legacy ? g0 : stepJitterRun(g0, s.jitterRising);

  // AUTHORITATIVE INSTANT DOWNGRADE from any non-low cap. Paused is 0ms-bar; freeze
  // uses the (stricter) probation bar while probing OR during the high opening —
  // both are unproven bets, so both are judged hard and lose fast. The delay-only path is
  // the third trigger: no sequence evidence, but a sustained jitter trend with real gaps.
  const onProbation = g.state === "probing_up" || g.state === "opening_high";
  const downgradeNow =
    (onProbation ? isProbationFail(s, cfg) : isDowngrade(s, cfg)) || isDelayOnlyCongestion(g, s, cfg);
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
        // The rung this demote lands on is chosen from `lowUnhealthy`, so stale evidence is
        // dropped HERE, where it is spent, not only where it is added.
        ...decayLowUnhealthy(g, nowMs, cfg),
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
      if (nowMs - g.enteredAtMs >= cfg.probeMs && isHealthy(s, cfg)) {
        return { governor: enter(g, "cap_high_stable", "high", nowMs) };
      }
      return { governor: g };
    }

    case "opening": {
      // Session start: low cap, but only the SHORT dwell. There is no failure to back
      // off from yet, and every ms here is the small rung on a link that may be fine.
      if (nowMs - g.enteredAtMs >= cfg.openingDwellMs && isHealthy(s, cfg)) {
        return { governor: { ...enter(g, "cap_low_eligible", "low", nowMs), healthySinceMs: nowMs } };
      }
      return { governor: g };
    }

    case "cap_low_sticky": {
      // Reset the failure count if the link has been genuinely healthy for a long
      // window (network changed / improved) — prevents permanent low-pinning.
      const healthy = isHealthy(s, cfg);
      const healthySince = healthy ? (g.healthySinceMs ?? nowMs) : null;
      const resetFailures =
        healthy && healthySince !== null && nowMs - healthySince >= cfg.healthyResetMs;
      // Evidence about the LOW rung, gathered while sitting on it (time-decayed).
      const lowEvidence = resetFailures
        ? clearedLowUnhealthy(cfg)
        : healthy || !countsAsLowRungEvidence(s, cfg)
          ? keepLowUnhealthy(g, cfg)
          : bumpLowUnhealthy(g, nowMs, cfg);
      const dwellDone = nowMs - g.enteredAtMs >= dwellMs(g.failures, cfg);
      if (dwellDone && healthy) {
        return {
          governor: {
            ...enter(g, "cap_low_eligible", "low", nowMs),
            failures: resetFailures ? 0 : g.failures,
            ...lowEvidence,
            healthySinceMs: nowMs,
          },
        };
      }
      return {
        governor: {
          ...g,
          healthySinceMs: healthySince,
          failures: resetFailures ? 0 : g.failures,
          ...lowEvidence,
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
      if (!isHealthy(s, cfg)) {
        const evidence = countsAsLowRungEvidence(s, cfg)
          ? bumpLowUnhealthy(g, nowMs, cfg)
          : keepLowUnhealthy(g, cfg);
        return { governor: { ...g, healthySinceMs: null, ...evidence } };
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
          governor: { ...enter(g, "cap_high_stable", "high", nowMs), failures: 0, ...clearedLowUnhealthy(cfg) },
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

/** Map the governor cap to the LiveKit VideoQuality enum value the hook passes to
 *  setVideoQuality. Kept here so the core owns the LOW/HIGH↔cap contract. */
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
/** Two unhealthy ticks on the low rung, not one. A single tick is the ordinary noise the
 *  freeze floor already forgives elsewhere, and the bottom rung is a real quality cost. */
export const LOW_CAP_STEP_AFTER_UNHEALTHY = 2;

export const resolveLowCapQuality = (
  declaredLayerQualities: readonly number[],
  lowUnhealthy = 0,
): number => {
  const sorted = [...declaredLayerQualities].sort((a, b) => a - b);
  if (sorted.length < 2) return 1;
  // FIRST demote: one rung below the top. That is what this function has always
  // returned, and on a TWO-layer ladder it is the bottom rung, which is correct.
  //
  // ONCE THE LOW RUNG HAS ITSELF FAILED: the rung the client can actually afford. On a THREE-layer
  // ladder `length - 2` is the MIDDLE rung, so the bottom was unreachable and a starving
  // client had no floor to fall to. The function never changed; the publisher did. A
  // publish long edge of 1024 crosses livekit's `>= 960` branch into three layers, and
  // this silently went from meaning "the bottom" to meaning "the middle".
  //
  // Measured shape of that: on a 900 kbit / 10 % loss link the client sat on the middle
  // rung and decoded 14 frames in 20 seconds while the app showed its local idle clip,
  // with the affordable bottom rung right there and un-requestable.
  //
  // On a two-layer ladder both branches return the same value, so the fleet default
  // (long edge 768, two layers) is byte-identical to before.
  return lowUnhealthy >= LOW_CAP_STEP_AFTER_UNHEALTHY ? sorted[0] : sorted[sorted.length - 2];
};
