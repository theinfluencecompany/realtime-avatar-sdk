/**
 * Ping-pong (boomerang) playback for idle/ambient clips.
 *
 * Idle videos are plain image-to-video generations (start frame != end
 * frame), so a hard `loop` visibly jumps at the wrap. Playing forward, then
 * scrubbing back to the start, makes ANY clip loop seamlessly — no seamless
 * A==B generation required. Reverse is done by stepping `currentTime` on a
 * requestAnimationFrame clock because `playbackRate < 0` is unsupported in
 * most browsers.
 */

export type BoomerangPlaybackOptions = {
  /** Reverse-phase speed relative to real time. Default 1 (same pace as forward). */
  reverseRate?: number;
  /** Seconds from each end at which the direction flips. Default 0.05. */
  edgeEpsilonSeconds?: number;
};

export type BoomerangPlayback = {
  /** Stop driving the element (leaves the video itself untouched). */
  stop(): void;
  /** Current loop state, e.g. to hand playback position to a live renderer. */
  position(): { timeSeconds: number; direction: "forward" | "reverse" };
  /** Jump the loop to a position+direction (seamless handback from a live render). */
  alignTo(timeSeconds: number, direction: "forward" | "reverse"): void;
};

/**
 * Drive a `<video>` element in a forward-then-reverse loop. The element should
 * be muted + playsInline (autoplay policies). Idempotent per call; returns a
 * handle whose `stop()` cancels the drive loop. Safe with elements whose
 * metadata has not loaded yet.
 *
 *     const playback = attachBoomerangPlayback(videoEl);
 *     // later: playback.stop();
 */
export function attachBoomerangPlayback(
  video: HTMLVideoElement,
  options: BoomerangPlaybackOptions = {},
): BoomerangPlayback {
  const reverseRate = options.reverseRate ?? 1;
  const edge = options.edgeEpsilonSeconds ?? 0.05;
  let raf: number | null = null;
  let direction: 1 | -1 = 1;
  let last = now();

  const step = (nowMs: number) => {
    raf = requestAnimationFrame(step);
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      last = nowMs;
      return;
    }
    if (direction === 1) {
      // Forward playback is native; just watch for the end to flip direction.
      if (video.paused) void video.play().catch(() => {});
      if (video.currentTime >= duration - edge) {
        direction = -1;
        video.pause();
        last = nowMs;
      }
      return;
    }
    // Reverse: manually rewind currentTime using the wall-clock delta. The
    // delta is clamped so a background-tab pause (rAF suspension) resumes
    // smoothly instead of teleporting.
    const dt = Math.min(0.1, (nowMs - last) / 1000) * reverseRate;
    last = nowMs;
    const next = video.currentTime - dt;
    if (next <= edge) {
      video.currentTime = 0;
      direction = 1;
    } else {
      video.currentTime = next;
    }
  };

  raf = requestAnimationFrame(step);
  return {
    stop() {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    },
    position() {
      return { timeSeconds: video.currentTime, direction: direction === 1 ? "forward" : "reverse" };
    },
    alignTo(timeSeconds: number, nextDirection: "forward" | "reverse") {
      const duration = video.duration;
      const clamped = Number.isFinite(duration) && duration > 0
        ? Math.min(Math.max(timeSeconds, 0), duration - edge)
        : Math.max(timeSeconds, 0);
      video.currentTime = clamped;
      direction = nextDirection === "reverse" ? -1 : 1;
      last = now();
      if (direction === -1) video.pause();
    },
  };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
