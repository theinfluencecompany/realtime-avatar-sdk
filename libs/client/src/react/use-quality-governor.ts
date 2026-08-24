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
import { useEffect, useRef } from "react";

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
  const { enabled, freezeReading, config = DEFAULT_GOVERNOR_CONFIG, tickMs = 1000 } = input;
  const room = useMaybeRoomContext();
  // The avatar's video publication rides the same voice-assistant participant the
  // rest of the SDK reads; reach its VIDEO track publication for setVideoQuality.
  const { videoTrack } = useVoiceAssistant();

  // Mutable event-fed signals (read by the tick; never trigger React renders).
  const pausedSinceTick = useRef(false);
  const connQuality = useRef<GovernorSignal["connectionQuality"]>("unknown");
  const lastFreezeStat = useRef<{ frozen: number; ts: number } | null>(null);
  const jitterTrend = useRef<JitterBufferTrendState | null>(null);

  useEffect(() => {
    if (!enabled || !room) return;
    const targetPublication = videoTrack?.publication as RemoteTrackPublication | undefined;
    const targetParticipant = videoTrack?.participant;
    pausedSinceTick.current = false;
    lastFreezeStat.current = null;
    jitterTrend.current = null;
    connQuality.current = qualityToSignal(
      targetParticipant?.connectionQuality ?? ConnectionQuality.Unknown,
    );

    // ── event adapters (Tier-0 Paused + Tier-2 ConnectionQuality) ──
    const onStreamState = (
      pub: RemoteTrackPublication,
      streamState: Track.StreamState,
    ): void => {
      if (targetPublication && pub !== targetPublication) return;
      // Paused = the SFU congestion controller acted — the strongest downgrade signal.
      if (streamState === Track.StreamState.Paused) pausedSinceTick.current = true;
    };
    const onQuality = (q: ConnectionQuality, participant: Participant): void => {
      if (targetParticipant && participant.sid !== targetParticipant.sid) return;
      connQuality.current = qualityToSignal(q);
    };

    try {
      room.on(RoomEvent.TrackStreamStateChanged, onStreamState);
      room.on(RoomEvent.ConnectionQualityChanged, onQuality);
    } catch {
      // A binding failure must never break the call — degrade to no governor.
      return;
    }

    let gov: Governor = initGovernor(Date.now());

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
        const prev = lastFreezeStat.current;
        lastFreezeStat.current = { frozen: frozenTotalMs, ts: now };
        const trend = stepJitterBufferTrend(jitterTrend.current, {
          delaySeconds: jitterDelaySeconds,
          emittedCount: jitterEmittedCount,
        });
        jitterTrend.current = trend.state;
        return {
          freezeMs: prev ? Math.max(0, frozenTotalMs - prev.frozen) : 0,
          jitterRising: trend.rising,
        };
      } catch {
        return { freezeMs: 0, jitterRising: false };
      }
    };

    const applyCap = (cap: "low" | "high"): void => {
      try {
        // The governor's "low" cap = ONE RUNG BELOW the top DECLARED layer, derived
        // from the publisher's actual ladder (resolveLowCapQuality — see its doc for
        // why the historical hardcoded MEDIUM was silently inert on the real 2-layer
        // ladder). "high" stays VideoQuality.HIGH: it is the max enum value, so it
        // releases the ceiling regardless of how the ladder is labeled.
        const lowCap = resolveLowCapQuality(
          (targetPublication?.trackInfo?.layers ?? []).map((l) => l.quality as number),
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
        const rvfc = freezeReading?.() ?? { freezeMsInWindow: 0, inhibited: false };
        const statsSignals = await readGetStatsSignals();
        // The effect may have rebound to a new publication while getStats was in
        // flight. Never let a stale tick overwrite the new binding's initial LOW cap.
        if (disposed) return;
        const signal: GovernorSignal = {
          paused: pausedSinceTick.current,
          freezeMsInWindow: Math.max(rvfc.freezeMsInWindow, statsSignals.freezeMs),
          jitterRising: statsSignals.jitterRising,
          connectionQuality: connQuality.current,
          inhibited: rvfc.inhibited,
        };
        pausedSinceTick.current = false; // consume the edge

        const { governor, action } = step(gov, signal, Date.now(), config);
        gov = governor;
        if (action) applyCap(action.setCap);
      } catch {
        // A tick fault must never kill the loop or the call.
      } finally {
        tickRunning = false;
      }
    };

    // ACTUATE the initial sticky-low cap on every (re)bind. A FULL reconnect
    // (RoomEvent.Reconnected) republishes the avatar track at the SFU-default HIGH
    // layer, and the livekit-client SDK does NOT auto-restore a subscriber cap on a
    // full reconnect (only a Resume re-sends it) — so the fresh publication would
    // serve HIGH while the governor model believes low, and a real freeze in the
    // first ~13s dwell wouldn't be corrected (the instant-downgrade branch only
    // fires from cap==='high'). Re-asserting on the new publication matches LiveKit's
    // documented TrackSubscribed-handler pattern; setVideoQuality is idempotent, so
    // this only ever softens the picture, never fights the SFU's own BWE.
    applyCap(gov.cap);

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
    // videoTrack identity changes across turns (publish/unpublish); re-bind then.
  }, [enabled, room, videoTrack, freezeReading, config, tickMs]);
}

// Re-export TrackEvent so a consumer that wants to observe raw track events has it
// without importing livekit-client directly (boundary discipline).
export { TrackEvent };
