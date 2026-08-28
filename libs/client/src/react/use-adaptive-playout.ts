import { useEffect, useState } from "react";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import {
  AdaptivePlayoutController,
  readInboundRtp,
  type AdaptivePlayoutOptions,
  type InboundRtpCursor,
} from "./adaptive-playout";
import { applyAvatarPlayoutDelay, DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS } from "./livekit";

/**
 * The adaptive counterpart to `useAvatarPlayoutDelay` — OPT-IN via `enabled`
 * (default false ⇒ a complete no-op, the incumbent flat cushion untouched).
 *
 * When enabled it runs the {@link AdaptivePlayoutController} closed loop: a 1Hz
 * `RTCRtpReceiver.getStats()` poll over BOTH avatar receivers, the worst
 * jitter/loss of the pair feeding one shared target so audio and video stay on
 * the SAME depth (lip-sync law — WebRTC pairs the streams to the larger of the
 * two hints). The loop opens at the ceiling (the flat cushion already applied by
 * `useAvatarPlayoutDelay`), descends toward the 150ms floor on clean paths, and
 * snaps back up within a couple of ticks when jitter or loss appears.
 *
 * Degrades to the incumbent behavior wherever the substrate is missing: a track
 * without `getStats` on its receiver, a stats report with no `inbound-rtp` yet,
 * or a browser without the playout-delay hint all leave the flat cushion exactly
 * as `useAvatarPlayoutDelay` set it.
 *
 * RETURNS THE APPLIED DEPTH IN SECONDS, and that return value is load-bearing rather
 * than a convenience. Anything a consumer times against the avatar's voice — a caption
 * reveal being the real case — has to be held by the SAME cushion, because the media is
 * buffered and a side channel is not. While the cushion was a flat constant a consumer
 * could hard-code it; the moment it moves, a hard-coded copy desyncs by up to the whole
 * adaptive range. So the value comes back out of the hook, and stays equal to
 * {@link DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS} whenever the loop is disabled or inert —
 * a consumer can read it unconditionally.
 */
export function useAvatarAdaptivePlayoutDelay(
  videoTrack: TrackReferenceOrPlaceholder | undefined,
  audioTrack: TrackReferenceOrPlaceholder | undefined,
  enabled: boolean = false,
  options?: AdaptivePlayoutOptions,
): number {
  const ceiling = options?.ceilingSeconds ?? DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS;
  const [appliedSeconds, setAppliedSeconds] = useState(ceiling);
  const videoMediaTrack = videoTrack?.publication?.track;
  const audioMediaTrack = audioTrack?.publication?.track;
  useEffect(() => {
    if (!enabled || (!videoMediaTrack && !audioMediaTrack)) return;
    const receivers = [videoMediaTrack, audioMediaTrack]
      .map((t) => (t as { receiver?: { getStats?: () => Promise<unknown> } } | undefined)?.receiver)
      .filter(
        (r): r is { getStats: () => Promise<unknown> } => typeof r?.getStats === "function",
      );
    if (receivers.length === 0) return; // no stats lane — the flat cushion stands
    const controller = new AdaptivePlayoutController(options);
    const cursors = new Map<number, InboundRtpCursor>();
    let closed = false;
    let inFlight = false;

    const tick = async () => {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        let worst: { jitterSeconds: number; lossFraction: number } | undefined;
        for (let i = 0; i < receivers.length; i++) {
          const stats = (await receivers[i].getStats()) as {
            values?: () => Iterable<Record<string, unknown>>;
          };
          if (closed || typeof stats?.values !== "function") continue;
          const reading = readInboundRtp(stats.values(), cursors.get(i));
          if (!reading) continue;
          cursors.set(i, reading.cursor);
          worst = {
            jitterSeconds: Math.max(worst?.jitterSeconds ?? 0, reading.sample.jitterSeconds),
            lossFraction: Math.max(worst?.lossFraction ?? 0, reading.sample.lossFraction),
          };
        }
        if (closed || !worst) return; // nothing decodable yet — skip, don't fabricate
        const decision = controller.update(worst);
        if (decision.changed) {
          applyAvatarPlayoutDelay(videoMediaTrack, audioMediaTrack, decision.targetSeconds);
          // Publish the new depth so anything timed against the buffered voice — a
          // caption reveal, a lip-synced overlay — can hold by the SAME amount. Only on
          // a real change, which hysteresis already makes rare, so this re-renders the
          // consumer a handful of times per call rather than once a second.
          setAppliedSeconds(decision.targetSeconds);
        }
      } catch {
        // A stats read failing must never break the call; the last applied depth stands.
      } finally {
        inFlight = false;
      }
    };

    const interval = setInterval(() => void tick(), 1_000);
    return () => {
      closed = true;
      clearInterval(interval);
      // The flat cushion is what the surface re-applies on the next mount, so report the
      // value that will actually be in force rather than the last adaptive one.
      setAppliedSeconds(ceiling);
    };
  }, [enabled, videoMediaTrack, audioMediaTrack, options, ceiling]);

  return appliedSeconds;
}
