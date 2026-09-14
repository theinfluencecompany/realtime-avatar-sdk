import { Track, VideoQuality, type RemoteTrackPublication } from "livekit-client";
import { resolveLowCapQuality } from "./quality-governor";
import {
  initNetworkQuality,
  readNetworkVideoSample,
  stepNetworkQuality,
  type NetworkQualityStatus,
} from "./network-quality";

/** One controller per subscribed receiver. The caller owns React teardown. */
export function bindNetworkQuality(
  publication: RemoteTrackPublication,
  inhibited: () => boolean,
  notify: (status: NetworkQualityStatus) => void,
  tickMs: number,
): () => void {
  let disposed = false;
  let running = false;
  let state = initNetworkQuality(performance.now());
  const apply = () => {
    const qualities = (publication.trackInfo?.layers ?? []).map((l) => l.quality as number);
    const cap = state.cap === "high" ? VideoQuality.HIGH :
      resolveLowCapQuality(qualities, state.cap === "floor" ? 2 : 0) as VideoQuality;
    try { publication.setVideoQuality(cap); } catch { /* A detached track must not end the call. */ }
  };
  const emit = (status: NetworkQualityStatus) => {
    try { notify(status); } catch { /* An app callback must not break adaptation. */ }
  };
  apply();
  emit("unknown");
  const tick = async () => {
    if (disposed || running) return;
    running = true;
    try {
      const track = publication.track;
      const stats = await track?.getRTCStatsReport?.();
      if (disposed || publication.track !== track) return;
      const prior = state;
      state = stepNetworkQuality(state, readNetworkVideoSample(stats), performance.now(), {
        paused: track?.streamState === Track.StreamState.Paused,
        inhibited: document.hidden || publication.isMuted || inhibited(),
      });
      if (state.cap !== prior.cap) apply();
      if (state.status !== prior.status) emit(state.status);
    } catch {
      // Break continuity on a failed read; missing data cannot buy recovery or a warning.
      if (!disposed) state = { ...state, sample: null, packetWindow: [], badMs: 0, postDowngradeBadMs: 0, cleanMs: 0, reducedBadMs: 0 };
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, tickMs);
  return () => {
    disposed = true;
    clearInterval(timer);
    emit("unknown");
  };
}
