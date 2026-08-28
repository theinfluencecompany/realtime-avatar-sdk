import { useEffect } from "react";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import {
  AdaptivePlayoutController,
  readInboundRtp,
  type AdaptivePlayoutOptions,
  type InboundRtpCursor,
} from "./adaptive-playout";
import { applyAvatarPlayoutDelay } from "./livekit";

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
 */
export function useAvatarAdaptivePlayoutDelay(
  videoTrack: TrackReferenceOrPlaceholder | undefined,
  audioTrack: TrackReferenceOrPlaceholder | undefined,
  enabled: boolean = false,
  options?: AdaptivePlayoutOptions,
): void {
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
    };
  }, [enabled, videoMediaTrack, audioMediaTrack, options]);
}
