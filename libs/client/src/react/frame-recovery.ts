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
