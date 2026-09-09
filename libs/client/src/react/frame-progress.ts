// At 15–25fps, WebRTC's native freeze threshold is approximately 190–217ms
// (max(3 * average frame interval, average + 150ms)). The former 100ms JS
// threshold repeatedly penalized ordinary lower-layer cadence and callback jitter.
// Native inbound-RTP freezes and SFU pause events remain independent signals.
export const FRAME_GAP_FREEZE_FLOOR_MS = 200;

export function scoreFrameGap(gapMs: number): number {
  return Number.isFinite(gapMs) && gapMs > FRAME_GAP_FREEZE_FLOOR_MS ? gapMs : 0;
}

/**
 * The main thread can miss callbacks while the video compositor keeps presenting.
 * A multi-frame counter advance makes the completed callback interval ambiguous;
 * it is not evidence of one frozen frame. Inbound RTP freeze stats remain a
 * separate input to the governor, including a real freeze followed by a burst.
 */
export function completedFrameGapMs(
  gapMs: number,
  previousFrames: number | null,
  currentFrames: number | null,
): number {
  if (previousFrames !== null && currentFrames !== null) {
    const advanced = currentFrames - previousFrames;
    if (advanced > 1 || advanced < 0) return 0;
  }
  return gapMs;
}

/** Fresh compositor progress rules out an ongoing media stall at an old JS cursor. */
export function ongoingFrameGapMs(
  gapMs: number,
  previousFrames: number | null,
  currentFrames: number | null,
): number {
  if (previousFrames !== null && currentFrames !== null && currentFrames !== previousFrames) {
    return 0;
  }
  return gapMs;
}

/** Use one counter plane for callbacks and polling; subtract discarded frames. */
export function presentedVideoFrames(video: HTMLVideoElement | null): number | null {
  try {
    const quality = video?.getVideoPlaybackQuality?.();
    if (!quality) return null;
    const count = quality.totalVideoFrames - quality.droppedVideoFrames;
    return Number.isFinite(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}
