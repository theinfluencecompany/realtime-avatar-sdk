/**
 * The CONNECT surface (client half) — one component that puts a live character on screen.
 *
 * WHY THIS EXISTS. The lower-level surface is deliberately LiveKit-first: the app owns the
 * room, mounts the lifecycle bridge, maps a nine-arm phase union to its own copy, and wires
 * the video surface. That is the right shape for a team that wants to own media policy, and
 * it is far too much surface for a team that wants a character on screen. Worse, it makes
 * the transport part of the integration contract: an app that names `RealtimeAvatarLiveKitRoom`
 * and `SessionLifecycleRoomBridge` is coupled to WebRTC-via-LiveKit forever.
 *
 * `<AvatarCall>` closes that hole. It mounts the room, the bridge, and the video surface, and
 * reports a FIVE-arm status that says nothing about how the pixels arrive. Swapping the
 * transport underneath is then our problem, not the integrator's.
 *
 * Everything the lower-level API offers is still exported and still supported — this is
 * additive. Reach for it when you genuinely need to own the room.
 */
import { createElement, useEffect, useRef, type ReactNode } from "react";
import { AvatarVideoSurface, type AvatarVideoFit } from "./avatar-video-surface";
import { RealtimeAvatarLiveKitRoom } from "./livekit";
import { SessionLifecycleRoomBridge } from "./session-lifecycle";
import { useRealtimeSession, type RealtimeSessionApi } from "./use-realtime-session";
import type { RealtimeAvatarClient } from "../client";

/**
 * What the app renders a banner for. Deliberately NOT the internal phase union: those arms
 * name connection mechanics, and an integrator should never write `case "reconnectable"`.
 */
export type AvatarCallStatus =
  /** Getting the character ready. */
  | "connecting"
  /** Every slot is busy; we are holding a place in line. Not an error. */
  | "waiting"
  /** She is there. */
  | "live"
  /** A blip; recovering automatically. */
  | "recovering"
  /** Over. `onEnded` already told you why. */
  | "ended";

/** Why a call ended — the only vocabulary an end screen needs. */
export type AvatarCallEndReason =
  | "user_ended"
  | "session_cap"
  | "idle"
  | "disconnected"
  | "out_of_credits"
  | "agent_ended"
  | "failed";

export type AvatarCallHandle = {
  status: AvatarCallStatus;
  /** Place in line while `status === "waiting"`, else null. */
  queuePosition: number | null;
  /** Seconds until the hard cap, or null before the clock lands. */
  secondsRemaining: number | null;
  /** Say something to her. Optional `steer` shapes THIS reply only (tool results go here). */
  say: (text: string, options?: { steer?: string }) => Promise<void>;
  /** Speak one exact line, verbatim, then end. For goodbyes and disclosures. */
  sayAndEnd: (text: string) => void;
  /** The user is still here — postpones the idle disconnect. */
  keepAlive: () => void;
  /** End now. */
  end: () => void;
};

export type AvatarCallProps = {
  client: RealtimeAvatarClient;
  /** Which character. */
  avatarId: string;
  /** `voice` is audio-only and cheaper; `avatar` (default) is the full call. */
  mode?: "avatar" | "voice";
  /** Listen to the user's microphone. Default true. */
  listen?: boolean;
  /** A looping clip shown before she is live and whenever the stream is not producing. */
  idleVideoUrl?: string | null;
  /** A still shown before the idle clip is playable. */
  poster?: string | null;
  fit?: AvatarVideoFit;
  className?: string;
  /** Your remaining balance in ms, if you want `onLowBalance`. */
  balanceMs?: number;

  onStatusChange?: (status: AvatarCallStatus) => void;
  onEnded?: (event: { reason: AvatarCallEndReason }) => void;
  /** She is nearly out of time — write her goodbye and pass it to `sayAndEnd`. */
  onEnding?: (event: { secondsLeft: number; call: AvatarCallHandle }) => void;
  /** The user went quiet. */
  onQuiet?: (event: { secondsLeft: number }) => void;
  /** Balance running low. */
  onLowBalance?: (event: { secondsLeft: number }) => void;

  /** Overlay your own UI on the video; receives the same handle as `useAvatarCall`. */
  children?: (call: AvatarCallHandle) => ReactNode;
};

function statusFor(session: RealtimeSessionApi): AvatarCallStatus {
  switch (session.phase.kind) {
    case "queued":
      return "waiting";
    case "live":
    case "idle-warning":
      return "live";
    case "reconnectable":
      return "recovering";
    case "ended":
      return "ended";
    default:
      // idle / requesting / connecting — all "we are getting her ready".
      return "connecting";
  }
}

function handleFor(session: RealtimeSessionApi): AvatarCallHandle {
  const remainingMs = session.clocks.sessionRemainingMs;
  return {
    status: statusFor(session),
    queuePosition: session.phase.kind === "queued" ? (session.phase.busy.queue_position ?? null) : null,
    secondsRemaining: remainingMs === null ? null : Math.max(0, Math.round(remainingMs / 1000)),
    say: (text, options) => session.sendTurn(text, options?.steer ? { instructions: options.steer } : undefined),
    sayAndEnd: (text) => {
      session.sendClosingTurn(text);
    },
    keepAlive: session.stayConnected,
    end: () => session.end("user_ended"),
  };
}

/**
 * The connect-level hook, for apps that want their own layout around the video. Returns the
 * same handle `<AvatarCall>` hands its children, plus the element to render.
 */
export function useAvatarCall(props: AvatarCallProps): { call: AvatarCallHandle; view: ReactNode } {
  // `onEnding` hands the app a live handle so it can write a goodbye and speak it. That
  // handle is derived from the very session these callbacks are passed into, so it can only
  // be reached through a ref — a direct reference would be a self-referential initializer.
  const sessionRef = useRef<RealtimeSessionApi | null>(null);

  const session = useRealtimeSession({
    client: props.client,
    session: { avatarId: props.avatarId, mode: props.mode ?? "avatar", sttMode: props.listen === false ? "off" : "server" },
    creditRemainingMs: props.balanceMs,
    onApproachingEnd: props.onEnding
      ? ({ secondsLeft }) => {
          const live = sessionRef.current;
          if (live) props.onEnding?.({ secondsLeft, call: handleFor(live) });
        }
      : undefined,
    onIdleWarning: props.onQuiet ? ({ secondsLeft }) => props.onQuiet?.({ secondsLeft }) : undefined,
    onCreditsLow: props.onLowBalance ? ({ secondsLeft }) => props.onLowBalance?.({ secondsLeft }) : undefined,
    onEnded: props.onEnded ? ({ reason }) => props.onEnded?.({ reason }) : undefined,
  });
  sessionRef.current = session;

  const call = handleFor(session);

  // Fire only on a real transition: several internal phases collapse onto one status, so a
  // per-render call would spam the app with duplicates it would have to dedupe itself.
  const lastStatusRef = useRef<AvatarCallStatus | null>(null);
  const onStatusChange = props.onStatusChange;
  useEffect(() => {
    if (lastStatusRef.current === call.status) return;
    lastStatusRef.current = call.status;
    onStatusChange?.(call.status);
  }, [call.status, onStatusChange]);

  const view = createElement(
    RealtimeAvatarLiveKitRoom,
    {
      grant: session.grant,
      audio: props.listen !== false,
      onConnected: session.onConnected,
      onDisconnected: session.onDisconnected,
      onError: session.onConnectionError,
    },
    createElement(SessionLifecycleRoomBridge, { key: "bridge", lifecycle: session }),
    createElement(
      AvatarVideoSurface,
      {
        key: "surface",
        idleVideoUrl: props.idleVideoUrl ?? null,
        poster: props.poster ?? null,
        fit: props.fit ?? "cover",
        className: props.className,
      },
      props.children ? props.children(call) : null,
    ),
  );

  return { call, view };
}

/** One component: a live character on screen. */
export function AvatarCall(props: AvatarCallProps): ReactNode {
  const { call, view } = useAvatarCall(props);
  void call;
  return view;
}
