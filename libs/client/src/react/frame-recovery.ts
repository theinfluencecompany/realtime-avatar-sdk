/**
 * After a stall, isolated frames must not keep revealing a frozen live layer.
 * Require half a second of sustained progress before leaving the idle layer.
 * A new track still shows its very first frame immediately.
 *
 * `stallAfterMs` is mutable so the surface can hand it the CURRENT stall
 * threshold (see {@link StallEscalation}): the self-detected gap in `frame()`
 * must agree with the watchdog's, or a gap the watchdog holds through would
 * still force a recovery dwell here.
 */
export class FrameRecovery {
  private lastFrameAtMs: number | null = null;
  private stableSinceMs: number | null = null;
  ready = true;

  constructor(public stallAfterMs: number) {}

  stall(): void {
    this.ready = false;
    this.stableSinceMs = null;
  }

  frame(nowMs: number): boolean {
    const gapMs = this.lastFrameAtMs === null ? 0 : nowMs - this.lastFrameAtMs;
    // Also detect a gap here: a busy/background tab can delay the watchdog tick.
    if (this.lastFrameAtMs !== null && gapMs > this.stallAfterMs) this.stall();
    if (!this.ready) {
      // Allow the 250ms currentTime polling fallback (plus scheduling jitter)
      // when Chromium suppresses frame callbacks behind the opaque idle layer.
      if (this.stableSinceMs === null || gapMs > Math.min(350, this.stallAfterMs)) {
        this.stableSinceMs = nowMs;
      }
      this.ready = nowMs - this.stableSinceMs >= 500;
    }
    this.lastFrameAtMs = nowMs;
    return this.ready;
  }
}

/**
 * A first keyframe on a healthy link lands well inside this (measured ~200–500 ms after
 * the track binds on the rtx6000 pool); waiting longer is a freeze the frame clock
 * cannot see, because there is no frame to be late against.
 */
export const AVATAR_FIRST_FRAME_GRACE_MS = 1_000;

/**
 * Freeze-ms attributed to a track that has been producing for `waitedMs` without a
 * single presented frame.
 *
 * Why this exists. A HIGH simulcast opening (`openingCap: "high"`) on a starved link is
 * a black hole: the SFU keeps forwarding the layer the cap allows, the browser keeps
 * asking for keyframes that never land intact, and nothing decodes for as long as the
 * cap stays up — measured on prod through a 900 kbit / 10 % loss link (2026-09-09):
 * 20–30 s with ONE frame decoded and 76–115 PLIs. The governor's probation bar would
 * demote that within a tick, but its freeze feed was inhibited until a first frame
 * existed, so the one opening that most needed a demotion could never get one. The
 * wait for the first frame, past the grace, IS the freeze.
 */
export function firstFrameWaitFreezeMs(waitedMs: number): number {
  if (!Number.isFinite(waitedMs) || waitedMs <= AVATAR_FIRST_FRAME_GRACE_MS) return 0;
  return waitedMs - AVATAR_FIRST_FRAME_GRACE_MS;
}

/**
 * Presented frames the surface lets pass before it starts booking inter-frame gaps as
 * freeze evidence. 5 is Chrome's own minimum rendered-frame count before its
 * `totalFreezesDuration` detector scores anything, so the rVFC path and the getStats path
 * (the two inputs of the governor's `max()`) now agree about the opening.
 *
 * Why: nine of the twelve demotes caught on the wire on 2026-09-11 were OPENING demotes.
 * The gaps between the first few presented frames (decoder warm-up, the jitter buffer
 * filling behind frame 1, the first keyframe's own size) were charged to the link and
 * demoted a HIGH opening 0.5-1.5 s after its first frame with zero packets lost. Stated
 * cost: gaps between frames 1-5 are exempt regardless of loss, which delays #67's lossy
 * demote by at most five frame gaps (bounded; the stats path still charges after Chrome's
 * own 5-frame threshold, and the first-frame WAIT is still charged past the grace).
 */
export const AVATAR_SETTLE_FRAMES = 5;

/** The surface's presented-frame ledger for ONE track binding. */
export interface FrameSample {
  seenFrame: boolean;
  lastFrameAtMs: number | null;
  /** Longest inter-frame gap since the governor last read the sample (raw ms; the floor is
   *  subtracted in `freezeReading`). */
  maxGapMs: number;
  /** A hidden-tab / bfcache resume is pending: the next frame is a new baseline. */
  resumePending: boolean;
  /** When the track began producing (this binding): the clock the first-frame wait runs on. */
  producingSinceMs: number | null;
  /** Decoded size of the previous frame, as "WxH". A CHANGE here means the SFU moved us to a
   *  different simulcast layer, which costs a decoder reconfigure and a wait for that layer's
   *  keyframe. See `nextFrameSample` for why that gap must not be charged to the link. */
  lastSizeKey: string | null;
  /** Presented frames counted on this binding; gaps are exempt until AVATAR_SETTLE_FRAMES. */
  framesSeen: number;
}

/** The ledger for a fresh binding. `hidden` = the document is not visible right now. */
export const initialFrameSample = (producingSinceMs: number | null, hidden: boolean): FrameSample => ({
  seenFrame: false,
  lastFrameAtMs: null,
  maxGapMs: 0,
  resumePending: hidden,
  producingSinceMs,
  lastSizeKey: null,
  framesSeen: 0,
});

/**
 * Book one presented frame. Pure: the surface's `markFrame` hands it the clock and the
 * decoded size and stores the result.
 *
 * A CHANGE OF DECODED SIZE IS A SIMULCAST LAYER SWITCH, and the gap that straddles it is
 * the switch's own cost: the decoder reconfigures and then waits for the new layer's
 * keyframe. Nothing was lost, it simply had not been sent yet.
 *
 * Charging that gap to the link made the governor punish the stream for the cost of its
 * own decision, and the punishment was another switch. Measured on production: the top
 * rung arrived at t=10.98s and was demoted 0.43s later with ZERO packets lost, then took
 * 21.8s to come back (dwellBase 8s x 2^1 for the failure, plus the clean window). From the
 * viewer's side that is one second of a sharp face and then twenty of a blurry one.
 *
 * Treated exactly like a bfcache resume and like the settle window, which are the same
 * class of event: a gap that is real, local, and says nothing about the network. The first
 * frame at the new size becomes the new baseline. The very first frame never counts as a
 * switch (`lastSizeKey === null`), or every session would start by discarding a baseline
 * it never had.
 */
export const nextFrameSample = (previous: FrameSample, nowMs: number, sizeKey: string): FrameSample => {
  const layerSwitched = previous.lastSizeKey !== null && sizeKey !== previous.lastSizeKey;
  const settling = previous.framesSeen < AVATAR_SETTLE_FRAMES;
  return {
    producingSinceMs: previous.producingSinceMs,
    seenFrame: true,
    lastFrameAtMs: nowMs,
    // A hidden tab/bfcache resume, a layer switch and the opening settle are local
    // scheduling gaps, not network congestion. The fresh frame becomes the new baseline.
    maxGapMs:
      previous.resumePending || layerSwitched || settling
        ? 0
        : Math.max(previous.maxGapMs, previous.lastFrameAtMs === null ? 0 : nowMs - previous.lastFrameAtMs),
    resumePending: false,
    lastSizeKey: sizeKey,
    framesSeen: previous.framesSeen + 1,
  };
};

/**
 * Once a link has proven unstable, hold the frozen live frame this long before
 * falling back to the idle floor. Measured on a prod rtx6000 call through a
 * 900 kbit / 150 ms / 10 % loss link (2026-09-09): after the opening, presented-frame
 * gaps cluster at 650–1150 ms with two multi-second outages around simulcast layer
 * switches. Nothing shorter than a few seconds is worth a body swap on such a link.
 */
export const DEFAULT_AVATAR_UNSTABLE_STALL_MS = 4_000;

/** A link is "unstable" while at least this many stalls landed inside the window. */
export const AVATAR_UNSTABLE_LINK_STALLS = 2;

/** Sliding window over which stalls are counted toward {@link AVATAR_UNSTABLE_LINK_STALLS}. */
export const AVATAR_UNSTABLE_LINK_WINDOW_MS = 15_000;

/**
 * Per-track stall-threshold policy: the watchdog's "no frame for this long ⇒ fall
 * back to idle" threshold, escalated while the link is flapping.
 *
 * Why this exists. Every live→idle→live swap is a hard cut between two bodies at
 * unrelated poses (for an avatar whose idle clip IS its source footage, the same
 * motion jumping to another phase — read by users as "it keeps replaying"). A
 * flat threshold turns a lossy link into an oscillator: each gap past the
 * threshold is one swap out and, ~500 ms of frames later, one swap back. Holding
 * the last live frame through short gaps costs a brief freeze — the same thing every
 * video call does under loss — and removes the oscillation entirely for gaps under
 * the threshold. Once two stalls have landed inside a short window the link has
 * shown its hand, and the threshold steps up so the surface converges on "hold the
 * frozen face" instead of "cut to another body every second". It decays on its own:
 * a stall older than the window no longer counts, so a link that heals returns to
 * the base threshold without a reset.
 *
 * Pure and clock-free (the caller passes `nowMs`), so the policy is unit-tested
 * without a DOM or a React tree. One instance per live TRACK — a replacement track
 * starts with a clean slate, like {@link FrameRecovery}.
 */
export class StallEscalation {
  private readonly stallsAtMs: number[] = [];
  readonly unstableMs: number;

  constructor(
    readonly baseMs: number,
    unstableMs: number = DEFAULT_AVATAR_UNSTABLE_STALL_MS,
    readonly windowMs: number = AVATAR_UNSTABLE_LINK_WINDOW_MS,
    readonly stallsToEscalate: number = AVATAR_UNSTABLE_LINK_STALLS,
  ) {
    // Escalation never LOWERS the threshold an adopter configured.
    this.unstableMs = Math.max(baseMs, unstableMs);
  }

  /** Record one stall EPISODE (the moment the live layer is hidden), not one poll tick. */
  recordStall(nowMs: number): void {
    this.prune(nowMs);
    this.stallsAtMs.push(nowMs);
  }

  /** The threshold in force right now. */
  thresholdMs(nowMs: number): number {
    this.prune(nowMs);
    return this.stallsAtMs.length >= this.stallsToEscalate ? this.unstableMs : this.baseMs;
  }

  /** Is the link currently considered unstable (escalated)? */
  unstable(nowMs: number): boolean {
    return this.thresholdMs(nowMs) !== this.baseMs;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.stallsAtMs.length > 0 && this.stallsAtMs[0] < cutoff) this.stallsAtMs.shift();
  }
}
