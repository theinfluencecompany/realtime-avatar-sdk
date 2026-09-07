/**
 * After a stall, isolated frames must not keep revealing a frozen live layer.
 * Require half a second of sustained progress before leaving the idle layer.
 * A new track still shows its very first frame immediately.
 */
export class FrameRecovery {
  private lastFrameAtMs: number | null = null;
  private stableSinceMs: number | null = null;
  ready = true;

  constructor(private readonly stallAfterMs: number) {}

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
