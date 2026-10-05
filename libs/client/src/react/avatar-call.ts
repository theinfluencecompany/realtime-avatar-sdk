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
import { createElement, Fragment, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { AvatarVideoSurface, type AvatarVideoFit } from "./avatar-video-surface";
import { RealtimeAvatarLiveKitRoom } from "./livekit";
import { SessionLifecycleRoomBridge, type SessionLifecycleRoomBridgeProps } from "./session-lifecycle";
import { useRealtimeSession, type RealtimeSessionApi } from "./use-realtime-session";
import type { CallAudioPlayback, CallMicrophone, CallMicrophoneProblem } from "./call-media";
import type { AvatarSessionClient } from "../session-client";

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

/**
 * The user's microphone: `off` | `pending` | `on` | `muted`, or `blocked` / `unavailable` with
 * the cause (`reason`), what the browser said (`message`) and what to do about it (`hint`).
 */
export type AvatarCallMicrophone = CallMicrophone;
/** The microphone states that carry a problem — what `onMicrophoneProblem` receives. */
export type AvatarCallMicrophoneProblem = CallMicrophoneProblem;
/** Whether her audio can play: `unknown` before the room connects, `allowed`, or `blocked`. */
export type AvatarCallAudio = CallAudioPlayback;

export type AvatarCallHandle = {
  status: AvatarCallStatus;
  /** Can she hear the user? A `blocked` or `unavailable` microphone means she cannot. */
  microphone: AvatarCallMicrophone;
  /** Can the user hear her? `blocked` means silent until `startAudio()` runs in a gesture. */
  audio: AvatarCallAudio;
  /**
   * Unblock her audio. Call it from a click or tap handler; outside one the browser refuses.
   * Never rejects: resolves whether playback is allowed afterwards.
   */
  startAudio: () => Promise<boolean>;
  /**
   * Mute (`false`) or unmute (`true`) the user's microphone. Never rejects. While waiting or
   * connecting it records the choice and nothing is captured; a mute made then is kept when the
   * call goes live. After `end()` it does nothing.
   */
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  /** Ask for the microphone again, after the user fixed what `microphone.hint` names. */
  retryMicrophone: () => Promise<void>;
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

export type AvatarCallProps = Pick<SessionLifecycleRoomBridgeProps, "onConnectionDetailsChange"> & {
  client: AvatarSessionClient;
  /**
   * Which character. Changing it starts a new call, EXCEPT after `end()`: an ended call stays
   * ended until you remount `AvatarCall` (a `key` is the usual way), so no prop change can start
   * a billed call the user hung up on.
   */
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
  /** Adds your classes to the call's box. The box sizes itself inline; to resize it, use `style`. */
  className?: string;
  /** Inline style for the call's box, spread over its own (`height`, `aspectRatio`, …). */
  style?: CSSProperties;
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
  /**
   * The microphone became `blocked` or `unavailable`: she cannot hear the user, though the call
   * is live. Fires once per distinct problem. Show `hint`, then offer `retryMicrophone()`.
   */
  onMicrophoneProblem?: (problem: AvatarCallMicrophoneProblem) => void;
  /**
   * What to show while `audio` is `blocked` (the browser is muting her until a gesture):
   * - `true` (default): a "Tap to turn on sound" button, top-centre over the video.
   * - a function: your own affordance, with your own words; wire it to `call.startAudio()`.
   * - `false`: nothing; draw your own from `call.audio` anywhere.
   * The first two render inside a polite live region, above your overlay.
   */
  audioUnlockPrompt?: boolean | ((call: AvatarCallHandle) => ReactNode);

  /**
   * Overlay your own UI on the video; receives the same handle as `useAvatarCall`. Rendered in a
   * layer above the video and the live badge that fills the call's box, so `position: absolute`
   * places a control against the box and it stays clickable while she is live.
   */
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
    microphone: session.microphone,
    audio: session.audioPlayback,
    startAudio: session.startAudio,
    setMicrophoneEnabled: session.setMicrophoneEnabled,
    retryMicrophone: () => session.setMicrophoneEnabled(true),
  };
}

// Top-centre, above the app's overlay: apps put their own controls (End, mute) along the bottom,
// and a prompt there would sit on top of them.
const UNLOCK_REGION: CSSProperties = {
  position: "absolute",
  top: 16,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 1,
};
const UNLOCK_BUTTON: CSSProperties = {
  padding: "10px 16px",
  border: "none",
  borderRadius: 9999,
  background: "rgb(0 0 0 / 0.7)",
  color: "white",
  font: "inherit",
  fontSize: 14,
  cursor: "pointer",
};

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

  const microphone = call.microphone;
  const problemKey = microphone.status === "blocked" || microphone.status === "unavailable"
    ? `${microphone.status}:${microphone.reason}:${microphone.message}`
    : null;
  const lastProblemRef = useRef<string | null>(null);
  const onMicrophoneProblemRef = useRef(props.onMicrophoneProblem);
  onMicrophoneProblemRef.current = props.onMicrophoneProblem;
  useEffect(() => {
    if (problemKey === lastProblemRef.current) return;
    lastProblemRef.current = problemKey;
    if (microphone.status === "blocked" || microphone.status === "unavailable") onMicrophoneProblemRef.current?.(microphone);
    // `problemKey` is the identity of the problem; the object is re-derived every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemKey]);

  // The region stays mounted so a screen reader announces the button when it appears; a live
  // region inserted together with its content is often not read at all.
  const prompt = props.audioUnlockPrompt ?? true;
  const unlock = prompt === false
    ? null
    : createElement(
        "div",
        { key: "audio-unlock-region", role: "status", "aria-live": "polite", style: UNLOCK_REGION, "data-testid": "avatar-audio-unlock-region" },
        call.audio !== "blocked"
          ? null
          : typeof prompt === "function"
            ? prompt(call)
            : createElement(
                "button",
                { type: "button", style: UNLOCK_BUTTON, onClick: () => { void call.startAudio(); }, "data-testid": "avatar-audio-unlock" },
                "Tap to turn on sound",
              ),
      );
  const overlay = props.children ? props.children(call) : null;

  const view = createElement(
    RealtimeAvatarLiveKitRoom,
    {
      grant: session.grant,
      // LiveKit captures the microphone on connect from this value, so a mute chosen while
      // waiting is honoured rather than overridden when the call goes live.
      audio: props.listen !== false && !session.microphoneMuted,
      onConnected: session.onConnected,
      onDisconnected: session.onDisconnected,
      onError: session.onConnectionError,
    },
    createElement(SessionLifecycleRoomBridge, {
      key: "bridge",
      lifecycle: session,
      microphone: props.listen !== false,
      onConnectionDetailsChange: props.onConnectionDetailsChange,
    }),
    createElement(
      AvatarVideoSurface,
      {
        key: "surface",
        idleVideoUrl: props.idleVideoUrl ?? null,
        poster: props.poster ?? null,
        fit: props.fit ?? "cover",
        className: props.className,
        style: props.style,
      },
      overlay === null && unlock === null ? null : createElement(Fragment, null, overlay, unlock),
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
