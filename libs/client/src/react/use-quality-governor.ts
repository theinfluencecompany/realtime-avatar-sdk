// ---------------------------------------------------------------------------
// use-quality-governor — the THIN adapter that wires the pure quality-governor
// core (quality-governor.ts) onto the live LiveKit room. It owns ALL the I/O the
// core refuses to touch: the 1s tick, the event subscriptions
// (TrackStreamStateChanged / ConnectionQualityChanged), the getStats poll, and the
// SINGLE `setVideoQuality` call. It holds NO decision logic — it translates the
// world into the core's GovernorSignal, calls `step`, and applies the returned cap.
//
// SEPARATION OF CONCERNS (the video-layering design doc): the mechanism (this
// hook + the pure core) is the SDK's; the player passes only policy — a bool and a
// freeze-reading getter — and never sees a RemoteTrackPublication or a LiveKit event.
//
// FAIL-OPEN: every read/subscription is wrapped; a governor fault DEGRADES to
// "leave the cap alone" and never throws into the call. The governor can only ever
// make the picture SOFTER (cap low), never break playback.
// ---------------------------------------------------------------------------

import {
  useMaybeRoomContext,
  useVoiceAssistant,
} from "@livekit/components-react";
import {
  ConnectionQuality,
  RoomEvent,
  Track,
  TrackEvent,
  VideoQuality,
  type Participant,
  type RemoteTrackPublication,
} from "livekit-client";
import { useEffect, useMemo, useRef } from "react";

import {
  DEFAULT_GOVERNOR_CONFIG,
  type Governor,
  type GovernorConfig,
  type GovernorSignal,
  type JitterBufferTrendState,
  initGovernor,
  resolveLowCapQuality,
  step,
  stepJitterBufferTrend,
} from "./quality-governor";

/** The player's freeze verdict for the trailing window, in milliseconds. The app
 *  computes this from its rVFC telemetry (call-telemetry `analyzeCallVideo`) and hands
 *  a GETTER so the hook samples on its own tick — the app owns no timing. */
export type FreezeReadingFn = () => {
  /** Frozen ms observed in the trailing window (rVFC-derived; 0 = smooth). */
  freezeMsInWindow: number;
  /** The tab is hidden OR the freeze correlates with local CPU, not the network — the
   *  false-positive fence. When true the governor is frozen (a downgrade can't fix a
   *  decode/paint stall — our Dia-freeze lesson). */
  inhibited: boolean;
};

export interface UseAvatarQualityGovernorInput {
  /** Master switch (product policy — the player's feature flag). Off ⇒ inert, no tick,
   *  no subscriptions, the cap is never touched (byte-identical to today). */
  enabled: boolean;
  /** The player's rVFC freeze reading getter (see FreezeReadingFn). Optional: without
   *  it the governor still reacts to Paused + getStats freezes, just without the
   *  cross-browser rVFC signal. */
  freezeReading?: FreezeReadingFn;
  /** Governor timing overrides (tests / tuning). Defaults are the grounded constants. */
  config?: GovernorConfig;
  /** Poll cadence (ms). Default 1000 — the governor tick. */
  tickMs?: number;
}

const qualityToSignal = (q: ConnectionQuality): GovernorSignal["connectionQuality"] => {
  switch (q) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Poor:
      return "poor";
    case ConnectionQuality.Lost:
      return "lost";
    default:
      return "unknown";
  }
};

/**
 * Drive the adaptive quality governor for the avatar's subscribed video track.
 *
 * Returns nothing the app must act on — it is a pure side-effect hook (like
 * useCallTelemetry). Mount it once inside the call body; it self-tears-down.
 */
export function useAvatarQualityGovernor(input: UseAvatarQualityGovernorInput): void {
  const { enabled, freezeReading, config: policy = DEFAULT_GOVERNOR_CONFIG, tickMs = 1000 } = input;
  const room = useMaybeRoomContext();
  // The avatar's video publication rides the same voice-assistant participant the
  // rest of the SDK reads; reach its VIDEO track publication for setVideoQuality.
  const { videoTrack } = useVoiceAssistant();

  // A transcript render may supply a fresh config/getter or TrackReference for the
  // same subscription. Preserve probation and recovery until policy VALUES or the
  // actual subscription change; an object-identity reset can pin a busy call LOW.
  const { openingCap, downgradeFreezeMs, probationFreezeMs, openingDwellMs,
    dwellBaseMs, dwellMaxMs, cleanMs, probeMs, healthyResetMs } = policy;
  const config = useMemo<GovernorConfig>(() => ({
    openingCap, downgradeFreezeMs, probationFreezeMs, openingDwellMs,
    dwellBaseMs, dwellMaxMs, cleanMs, probeMs, healthyResetMs,
  }), [openingCap, downgradeFreezeMs, probationFreezeMs, openingDwellMs,
    dwellBaseMs, dwellMaxMs, cleanMs, probeMs, healthyResetMs]);
  const freezeReadingRef = useRef(freezeReading);
  freezeReadingRef.current = freezeReading;
  const targetPublication = videoTrack?.publication as RemoteTrackPublication | undefined;
  const targetParticipant = videoTrack?.participant;
  const targetTrack = targetPublication?.track;

  useEffect(() => {
    if (!enabled || !room || !targetPublication || !targetParticipant) return;
    // Binding-local state also fences an old asynchronous getStats read from the
    // replacement track's counters after a reconnect.
    let pausedSinceTick = false;
    let lastFreezeStat: { frozen: number; ts: number } | null = null;
    let jitterTrend: JitterBufferTrendState | null = null;
    let connQuality = qualityToSignal(
      targetParticipant?.connectionQuality ?? ConnectionQuality.Unknown,
    );

    // ── event adapters (Tier-0 Paused + Tier-2 ConnectionQuality) ──
    const onStreamState = (
      pub: RemoteTrackPublication,
      streamState: Track.StreamState,
    ): void => {
      if (pub !== targetPublication) return;
      // Paused = the SFU congestion controller acted — the strongest downgrade signal.
      if (streamState === Track.StreamState.Paused) pausedSinceTick = true;
    };
    const onQuality = (q: ConnectionQuality, participant: Participant): void => {
      if (participant.sid !== targetParticipant.sid) return;
      connQuality = qualityToSignal(q);
    };

    try {
      room.on(RoomEvent.TrackStreamStateChanged, onStreamState);
      room.on(RoomEvent.ConnectionQualityChanged, onQuality);
    } catch {
      // A binding failure must never break the call — degrade to no governor.
      try {
        room.off(RoomEvent.TrackStreamStateChanged, onStreamState);
        room.off(RoomEvent.ConnectionQualityChanged, onQuality);
      } catch { /* teardown swallows */ }
      return;
    }

    let gov: Governor = initGovernor(Date.now(), config.openingCap);

    const readGetStatsSignals = async (): Promise<{
      freezeMs: number;
      jitterRising: boolean;
    }> => {
      // inbound-rtp freezeCount/totalFreezesDuration delta (Chrome). Best-effort; any
      // failure yields 0 (rVFC still covers the freeze via freezeReading).
      try {
        const track = targetPublication?.track;
        const stats = await track?.getRTCStatsReport?.();
        if (!stats) return { freezeMs: 0, jitterRising: false };
        let frozenTotalMs = 0;
        let jitterDelaySeconds = 0;
        let jitterEmittedCount = 0;
        stats.forEach((r: {
          type?: string;
          totalFreezesDuration?: number;
          jitterBufferDelay?: number;
          jitterBufferEmittedCount?: number;
        }) => {
          if (r.type === "inbound-rtp" && typeof r.totalFreezesDuration === "number") {
            frozenTotalMs = r.totalFreezesDuration * 1000; // seconds → ms
          }
          if (
            r.type === "inbound-rtp" &&
            typeof r.jitterBufferDelay === "number" &&
            typeof r.jitterBufferEmittedCount === "number"
          ) {
            jitterDelaySeconds += r.jitterBufferDelay;
            jitterEmittedCount += r.jitterBufferEmittedCount;
          }
        });
        const now = Date.now();
        const prev = lastFreezeStat;
        lastFreezeStat = { frozen: frozenTotalMs, ts: now };
        const trend = stepJitterBufferTrend(jitterTrend, {
          delaySeconds: jitterDelaySeconds,
          emittedCount: jitterEmittedCount,
        });
        jitterTrend = trend.state;
        return {
          freezeMs: prev ? Math.max(0, frozenTotalMs - prev.frozen) : 0,
          jitterRising: trend.rising,
        };
      } catch {
        return { freezeMs: 0, jitterRising: false };
      }
    };

    const applyCap = (cap: "low" | "high", lowUnhealthy = 0): void => {
      try {
        // The governor's "low" cap = ONE RUNG BELOW the top DECLARED layer, derived
        // from the publisher's actual ladder (resolveLowCapQuality — see its doc for
        // why the historical hardcoded MEDIUM was silently inert on the real 2-layer
        // ladder). "high" stays VideoQuality.HIGH: it is the max enum value, so it
        // releases the ceiling regardless of how the ladder is labeled.
        // The floor steps on evidence gathered ON the low rung, never on `failures`.
        // `failures` counts failed attempts to reach HIGH, and a starved opening books one
        // of those before the link has carried anything, so keying the step on it sent the
        // first demote straight to the bottom rung. See Governor.lowUnhealthy.
        const lowCap = resolveLowCapQuality(
          (targetPublication?.trackInfo?.layers ?? []).map((l) => l.quality as number),
          lowUnhealthy,
        ) as unknown as VideoQuality;
        targetPublication?.setVideoQuality?.(cap === "low" ? lowCap : VideoQuality.HIGH);
      } catch {
        // Actuation failure = leave the layer to the SFU; never throw into the call.
      }
    };

    let disposed = false;
    let tickRunning = false;
    const tick = async (): Promise<void> => {
      if (disposed || tickRunning) return;
      tickRunning = true;
      try {
        const rvfc = freezeReadingRef.current?.() ?? { freezeMsInWindow: 0, inhibited: false };
        const statsSignals = await readGetStatsSignals();
        // The effect may have rebound to a new publication while getStats was in
        // flight. Never let a stale tick overwrite the new binding's opening cap.
        if (disposed) return;
        const signal: GovernorSignal = {
          paused: pausedSinceTick,
          freezeMsInWindow: Math.max(rvfc.freezeMsInWindow, statsSignals.freezeMs),
          jitterRising: statsSignals.jitterRising,
          connectionQuality: connQuality,
          inhibited: rvfc.inhibited,
        };
        pausedSinceTick = false; // consume the edge

        const { governor, action } = step(gov, signal, Date.now(), config);
        gov = governor;
        if (action) applyCap(action.setCap, gov.lowUnhealthy);
      } catch {
        // A tick fault must never kill the loop or the call.
      } finally {
        tickRunning = false;
      }
    };

    // Reassert the configured opening cap on a new subscription, including a full
    // reconnect. HIGH is permission for the SFU to send its top layer, still under
    // the governor's strict opening probation and the SFU's bandwidth controller.
    //
    // The low-rung evidence rides along so a rebind mid-call re-asserts the floor the
    // governor has already earned, rather than putting a starving client back on a rung it
    // has already proven it cannot hold.
    applyCap(gov.cap, gov.lowUnhealthy);

    const handle = setInterval(() => void tick(), tickMs);

    return () => {
      disposed = true;
      clearInterval(handle);
      try {
        room.off(RoomEvent.TrackStreamStateChanged, onStreamState);
        room.off(RoomEvent.ConnectionQualityChanged, onQuality);
      } catch {
        /* teardown swallows */
      }
    };
  }, [enabled, room, targetPublication, targetParticipant, targetTrack, config, tickMs]);
}

// Re-export TrackEvent so a consumer that wants to observe raw track events has it
// without importing livekit-client directly (boundary discipline).
export { TrackEvent };
