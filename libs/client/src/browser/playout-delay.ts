/**
 * Receiver-side playout delay (SECONDS) for the avatar media tracks.
 *
 * The avatar is published from a GPU datacenter and reaches viewers over the
 * public internet, where a few percent of packet loss is normal. A shallow
 * receiver buffer stalls (freezes) on every loss while it waits for a
 * retransmit; a deeper buffer recovers the lost packets BEFORE playout, so the
 * viewer sees smooth 25fps instead of freezing. Measured at ~5% loss this took
 * the stream from ~11fps with multi-second freezes to a steady 25fps with zero
 * freezes.
 *
 * 0.5s is applied via the native `RemoteTrack.setPlayoutDelay`, which sets the
 * receiver's `playoutDelayHint` — the same Chromium jitter-buffer knob the old
 * hand-rolled `jitterBufferTarget` reached into (the spec renamed
 * playoutDelayHint→jitterBufferTarget; both influence the same buffer depth),
 * but typed and SDK-owned so there is no cast or feature-probe. The hint is NOT
 * free at the open: the receiver holds the FIRST video frame toward the target
 * (~250-450ms of measured TTFF), a deliberate cost paid once for the freeze-free
 * steady state above. The open-small-then-ramp variant that tried to dodge that
 * cost was shipped, failed twice (the rVFC ramp trigger is throttled on the
 * opacity:0-mounted element, stranding the shallow buffer), and was deliberately
 * removed in 2262e4c7b — do not re-propose it. No-op on browsers that don't
 * support the hint (the SDK warns and moves on).
 *
 * This lives in the browser folder, not the React one, because the React
 * surface applies it for you and a vanilla page has to do it itself. Until this
 * file existed the helper was only reachable through `realtime-avatar/react`,
 * so every plain-DOM adopter — every one of this repo's own demos included —
 * ran with the browser's default shallow buffer and froze on every lost packet.
 * Structural like its siblings: no `livekit-client` import, no version pin.
 */

export const DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS = 0.5;

/**
 * A track that can take a native playout-delay hint — livekit-client's subscribed
 * `RemoteTrack`. Duck-typed on the method rather than `instanceof`, so a
 * placeholder or local track is skipped and the helper is testable with a fake.
 */
export interface PlayoutDelayTarget {
  setPlayoutDelay(delayInSeconds: number): void;
}

/**
 * Apply the receiver playout delay to ONE subscribed track.
 *
 * Call it for every track `RoomEvent.TrackSubscribed` hands you, audio and video
 * alike, before or after `attach()` — WebRTC syncs the pair to the LARGER hint,
 * so applying it to one stream and not the other lets the lips lag the voice.
 * Returns `true` when the hint was applied and `false` when the object cannot take
 * one (a local track, a placeholder, a not-yet-subscribed publication), so a
 * caller can log the miss without a try/catch. The delay is floored at 0 so a
 * negative input can never throw.
 */
export function applyPlayoutDelay(
  track: unknown,
  delaySeconds: number = DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS,
): boolean {
  const target = playoutDelayTarget(track);
  if (!target) return false;
  target.setPlayoutDelay(Math.max(0, delaySeconds));
  return true;
}

/**
 * Apply the SAME native playout delay to the avatar's audio + video tracks
 * (kept equal so the a/v sync stays lip-locked). Pure and exported so the clamp
 * and the both-tracks-equal invariant are unit-testable without a DOM; the React
 * hook `useAvatarPlayoutDelay` is a thin effect wrapper around this.
 */
export function applyAvatarPlayoutDelay(
  videoTrack: unknown,
  audioTrack: unknown,
  delaySeconds: number = DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS,
): void {
  const delay = Math.max(0, delaySeconds);
  applyPlayoutDelay(videoTrack, delay);
  applyPlayoutDelay(audioTrack, delay);
}

function playoutDelayTarget(track: unknown): PlayoutDelayTarget | undefined {
  const candidate = track as { setPlayoutDelay?: unknown } | null | undefined;
  return typeof candidate?.setPlayoutDelay === "function"
    ? (candidate as PlayoutDelayTarget)
    : undefined;
}
