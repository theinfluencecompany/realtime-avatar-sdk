"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  lifecycleServerFrameSchema,
  RTA_CLOSING_TURN_ATTR,
  RTA_TURN_ID_ATTR,
  RTA_TURN_INSTRUCTIONS_ATTR,
  type LLMProvider,
  type SessionEndReasonLabel,
} from "realtime-avatar-contracts";
import {
  useSessionLifecycle,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  type SessionLifecycleApi,
  type SessionLifecyclePhase,
  type UseSessionLifecycleInput,
} from "./session-lifecycle";
import {
  approachingEndFrom,
  creditsLowFrom,
  endsAtFrom,
  mapTurnState,
  nextGraceWindow,
  resolveEndReason,
  sessionRemainingMsFrom,
  type ApproachingEndReason,
  type EndReason,
  type GraceWindowState,
  type SessionClocks,
  type TurnState,
} from "./grace-window";
import { nextBehaviorSnapshot, type BehaviorSnapshot } from "./behavior-snapshot";
import type { SendTextOptions } from "./livekit";

export type {
  ApproachingEndReason,
  EndReason,
  GraceWindowState,
  SessionClocks,
  TurnState,
} from "./grace-window";

// ---------------------------------------------------------------------------
// Developer-controlled defaults. EVERY one is overridable on the hook input — the
// purpose of the SDK is to hand the app the levers, never bury a timeout as a server
// constant. These are only the SAFE FLOORS used when the app omits a knob.
// (idleSeconds / idleWarnLeadSeconds reuse the inner DEFAULT_IDLE_* via the inner hook.)
// ---------------------------------------------------------------------------
/** How early `onApproachingEnd` fires before the hard cap (room to compose the goodbye). */
export const DEFAULT_APPROACHING_END_LEAD_SECONDS = 45;
/** How early the grace window opens before the cap (fits LLM excuse + send RTT + TTS + playout). */
export const DEFAULT_GRACE_WINDOW_LEAD_SECONDS = 12;
/** Client mirror of the worker's hard grace ceiling — how long a closing line may run past the cap. */
export const DEFAULT_GRACE_CEILING_SECONDS = 10;
/** Surface "low on minutes" at ~5 min of the app-supplied credit balance. */
export const DEFAULT_CREDITS_LOW_LEAD_SECONDS = 300;

export type ClosingTurnResult =
  | { ok: true; turnId: string }
  | { ok: false; reason: "window_closed" | "not_connected" | "already_spent" };

export type ExtendResult = { ok: boolean };

// the moment-callback payloads
export type ApproachingEndEvent = { secondsLeft: number; reason: ApproachingEndReason; threshold: number };
export type GraceWindowOpenEvent = { reason: ApproachingEndReason; deadlineAt: number; msLeft: number };
export type GraceWindowClosedEvent = { reason: ApproachingEndReason; delivered: boolean };
export type IdleWarningEvent = { secondsLeft: number };
export type CreditsLowEvent = { secondsLeft: number };
export type TurnTimeoutEvent = { turnId: string | null };
export type ReconnectingEvent = { attempt: number };
export type EndedEvent = { reason: EndReason };

export type RealtimeSessionMedia = {
  video: "live" | "stalled" | "connecting";
  audio: "flowing" | "silent";
};

// `BehaviorSnapshot` + its `nextBehaviorSnapshot` derivation live in the leaf
// `./behavior-snapshot` module (the SSOT both this hook and `useSessionLifecycle` share).
// Re-exported here so the long-standing `BehaviorSnapshot` import path is unchanged.
export type { BehaviorSnapshot };

/** The worker's verdict on a gesture request (every request is answered or times out). */
export type ClipResult = { requestId: string; accepted: boolean; reason: string };

/**
 * The `useRealtimeSession` input. ADDITIVE over {@link UseSessionLifecycleInput}
 * (whose `client`/`session`/`active`/`idleSeconds`/`idleWarnLeadSeconds`/reconnect
 * knobs are reused VERBATIM — see the "Timeouts & budgets" group). The new fields
 * are the credit passthrough, the 5 moment callbacks, and the lead-second knobs.
 *
 * DESIGN PRINCIPLE — maximum developer control: every timeout/budget is a knob with a
 * safe default. Client-owned clocks (idle + every lead) are set freely; the hard cap
 * is a REQUEST (`maxSessionSeconds`, bounded by the platform max + server-enforced for
 * billing/GPU safety). The app wires only the NARRATIVE callbacks + copy.
 */
export type UseRealtimeSessionInput<T extends LLMProvider = LLMProvider> = UseSessionLifecycleInput<T> & {
  // ── attribution ──
  /** Echoed by the app on its own events; the SDK never inspects it. */
  clientMetadata?: Record<string, unknown>;

  // ── Timeouts & budgets (developer-controlled; safe defaults) ──
  /**
   * Requested hard cap (seconds). Injected into the session request → the platform
   * grant → the worker enforces it. Bounded by the platform max (billing/GPU safety);
   * falls back to the grant's `max_session_seconds`. `idleSeconds`/`idleWarnLeadSeconds`
   * are inherited from {@link UseSessionLifecycleInput} (client-authoritative).
   */
  maxSessionSeconds?: number;
  /** Lead before the cap for `onApproachingEnd`. Default {@link DEFAULT_APPROACHING_END_LEAD_SECONDS}. */
  approachingEndLeadSeconds?: number;
  /** Lead before the cap for the grace window to open. Default {@link DEFAULT_GRACE_WINDOW_LEAD_SECONDS}. */
  graceWindowLeadSeconds?: number;
  /** Client mirror of the worker grace ceiling. Default {@link DEFAULT_GRACE_CEILING_SECONDS}. */
  graceCeilingSeconds?: number;
  /** Lead before the credit balance runs out for `onCreditsLow`. Default {@link DEFAULT_CREDITS_LOW_LEAD_SECONDS}. */
  creditsLowLeadSeconds?: number;
  /** Per-turn "no response" watchdog (seconds). Default {@link DEFAULT_TURN_TIMEOUT_SECONDS}. */
  turnTimeoutSeconds?: number;
  /** App-supplied credit balance (ms) — surfaced on `clocks.creditRemainingMs` + drives `onCreditsLow`. */
  creditRemainingMs?: number | null;

  // ── behavior ──
  /**
   * Auto-hold the idle clock (`stayConnected`) while the grace window is open/delivering
   * so the idle reaper can't preempt the guaranteed closing line. Default true.
   */
  autoStayConnectedDuringGrace?: boolean;

  // ── the 5 user-moments (wire only the NARRATIVE; safe defaults if omitted) ──
  onApproachingEnd?: (e: ApproachingEndEvent) => void;
  onGraceWindowOpen?: (e: GraceWindowOpenEvent) => void;
  onGraceWindowClosed?: (e: GraceWindowClosedEvent) => void;
  onIdleWarning?: (e: IdleWarningEvent) => void;
  onCreditsLow?: (e: CreditsLowEvent) => void;
  onTurnTimeout?: (e: TurnTimeoutEvent) => void;
  onReconnecting?: (e: ReconnectingEvent) => void;
  onReconnected?: () => void;
  onEnded?: (e: EndedEvent) => void;
  /** The avatar's behavior changed (listening/thinking/idle/special clips). */
  onBehaviorChange?: (b: BehaviorSnapshot) => void;
  /** A clip request was answered (also resolved on the performClip promise). */
  onClipResult?: (r: ClipResult) => void;
};

/**
 * The composed realtime-session surface. `phase` is the {@link SessionLifecyclePhase}
 * SSOT VERBATIM (no union fork). Adds the three clocks, the grace window, the live turn
 * micro-state, honest media, and the leverage actions. The in-room sinks
 * (`onLifecycleData`/`registerDataPublisher`/`registerTurnSender`/`setTurnState`/`setMedia`)
 * are filled by {@link SessionLifecycleRoomBridge} — the app just mounts the bridge.
 */
/**
 * The composed realtime-session surface. A strict SUPERSET of {@link SessionLifecycleApi}
 * (so it is a DROP-IN replacement everywhere the inner hook was used — `phase`/`grant`/
 * `capacity`/`stayConnected`/`reconnect`/`timeToDisconnectMs`/the sinks all pass through
 * verbatim), plus the three clocks, the grace window, the live turn micro-state, honest
 * media, and the new leverage actions. The realtime-session sinks
 * (`onLifecycleData`/`registerDataPublisher`/`registerTurnSender`/`setTurnState`/`setMedia`)
 * are filled by {@link SessionLifecycleRoomBridge} — the app just mounts the bridge.
 */
export type RealtimeSessionApi = SessionLifecycleApi & {
  /** Live turn micro-state, mapped from `useVoiceAssistant().state`. */
  turn: TurnState;
  /** The three DISTINCT clocks (session/idle/credit), never conflated. */
  clocks: SessionClocks;
  /** Wall-clock hard-cap deadline (server-mirrored), or null until the clock frame lands. */
  endsAt: number | null;
  /** The grace-window state machine driving the guaranteed closing line. */
  graceWindow: GraceWindowState;
  /** Honest media liveness from the bound agent's tracks. */
  media: RealtimeSessionMedia;
  /** The inner SSOT surface, for explicit access (it is also spread at top level). */
  lifecycle: SessionLifecycleApi;

  // ── actions (the leverage) ──
  /** Speak ONE final in-character line VERBATIM, then end. Guaranteed delivered before the cut. */
  sendClosingTurn: (text: string, opts?: { instructions?: string }) => ClosingTurnResult;
  /** Ask the worker to wind down + close gracefully now (publishes request_graceful_close). */
  requestGracefulClose: () => void;
  /** Request a billable, guarded cap extension (the app owns who-pays; the worker validates). */
  extend: (req: { addSeconds: number; proof?: string }) => ExtendResult;
  /** Send a normal turn THROUGH the SDK (arms the turn-timeout watchdog + enables retryTurn). */
  sendTurn: (text: string, opts?: { instructions?: string }) => Promise<void>;
  /** Re-send the last turn sent through the SDK (the "no response" recovery). */
  retryTurn: () => void;
  /** End gracefully now (the user tapped End). */
  end: (reason?: EndReason) => void;
  /** The avatar's live nonverbal behavior, or null pre-choreo (see {@link BehaviorSnapshot}). */
  behavior: BehaviorSnapshot | null;
  /**
   * Ask the character to PERFORM a clip by id — a gesture arc plays once (e.g. the
   * gift moment); a `special`-role clip pins for `holdSeconds` (3-20, default 8).
   * Scheduled at the next seamless swap point, never a hard cut. Resolves with the
   * worker's verdict (`accepted:false` + reason on refusal / not connected /
   * timeout) — never rejects, so the app can always fall back to text-only behavior.
   */
  performClip: (clipId: string, opts?: { holdSeconds?: number; timeoutMs?: number }) => Promise<ClipResult>;

  // ── in-room sinks (wired by SessionLifecycleRoomBridge) ──
  /** Inbound `rta.lifecycle` frames (the bridge decodes RoomEvent.DataReceived). */
  onLifecycleData: (frame: unknown) => void;
  /** Publisher for client→worker frames (request_graceful_close / extend). */
  registerDataPublisher: (publish: ((frame: unknown) => void) | null) => void;
  /** The turn sender (the bridge's `useChat().send`) for closing + normal turns. */
  registerTurnSender: (send: ((text: string, opts?: SendTextOptions) => Promise<void>) | null) => void;
  /** Live assistant state → `turn`. */
  setTurnState: (state: string | null | undefined) => void;
  /** Honest media liveness from the bound agent's tracks. */
  setMedia: (media: RealtimeSessionMedia) => void;
};

function positive(value: number | undefined, fallbackSeconds: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallbackSeconds;
}

export function useRealtimeSession<T extends LLMProvider = LLMProvider>(
  input: UseRealtimeSessionInput<T>,
): RealtimeSessionApi {
  const {
    session,
    maxSessionSeconds,
    approachingEndLeadSeconds,
    graceWindowLeadSeconds,
    graceCeilingSeconds,
    creditsLowLeadSeconds,
    turnTimeoutSeconds,
    creditRemainingMs = null,
    autoStayConnectedDuringGrace = true,
    onApproachingEnd,
    onGraceWindowOpen,
    onGraceWindowClosed,
    onIdleWarning,
    onCreditsLow,
    onTurnTimeout,
    onReconnecting,
    onReconnected,
    onEnded,
    onBehaviorChange,
    onClipResult,
    // everything else (client/active/idleSeconds/idleWarnLeadSeconds/reconnect/requestOptions…)
    // flows straight into the inner SSOT hook.
    ...inner
  } = input;

  // Inject the developer-requested cap into the session request (server-enforced,
  // platform-bounded). One source of truth: the request the inner hook mints from.
  const effectiveSession = useMemo(
    () => (session && typeof maxSessionSeconds === "number" ? { ...session, maxSessionSeconds } : session),
    [session, maxSessionSeconds],
  );

  const lifecycle = useSessionLifecycle<T>({ ...(inner as UseSessionLifecycleInput<T>), session: effectiveSession });

  // ── server-mirrored cap clock + worker grace signal (from rta.lifecycle frames) ──
  const [serverClock, setServerClock] = useState<{
    startedAtUnixMs: number;
    maxSessionSeconds: number;
    idleTimeoutSeconds: number;
  } | null>(null);
  const [workerEnding, setWorkerEnding] = useState(false);
  const [graceWindow, setGraceWindow] = useState<GraceWindowState>({ kind: "closed" });
  const [turn, setTurn] = useState<TurnState>("quiet");
  const [media, setMediaState] = useState<RealtimeSessionMedia>({ video: "connecting", audio: "silent" });
  const [behavior, setBehavior] = useState<BehaviorSnapshot | null>(null);
  const lastBehaviorRef = useRef<BehaviorSnapshot | null>(null);
  const lastLabeledEndReasonRef = useRef<SessionEndReasonLabel | null>(null);
  // Pending clip_request acks by request_id (resolved by clip_ack or timeout).
  const pendingClipsRef = useRef<Map<string, { resolve: (r: ClipResult) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());

  // Latch the latest callbacks/knobs in refs so the 1s effect fires them without
  // re-subscribing (which would reset the interval every render).
  const cbRef = useRef({ onApproachingEnd, onGraceWindowOpen, onGraceWindowClosed, onIdleWarning, onCreditsLow, onTurnTimeout, onReconnecting, onReconnected, onEnded, onBehaviorChange, onClipResult });
  cbRef.current = { onApproachingEnd, onGraceWindowOpen, onGraceWindowClosed, onIdleWarning, onCreditsLow, onTurnTimeout, onReconnecting, onReconnected, onEnded, onBehaviorChange, onClipResult };

  const approachingEndLeadMs = positive(approachingEndLeadSeconds, DEFAULT_APPROACHING_END_LEAD_SECONDS) * 1000;
  const graceWindowLeadMs = positive(graceWindowLeadSeconds, DEFAULT_GRACE_WINDOW_LEAD_SECONDS) * 1000;
  const graceCeilingMs = positive(graceCeilingSeconds, DEFAULT_GRACE_CEILING_SECONDS) * 1000;
  const creditsLowLeadMs = positive(creditsLowLeadSeconds, DEFAULT_CREDITS_LOW_LEAD_SECONDS) * 1000;
  const turnTimeoutMs = positive(turnTimeoutSeconds, DEFAULT_TURN_TIMEOUT_SECONDS) * 1000;

  // edge-detect latches + transition memory (refs: read/written by the 1s effect).
  const approachingFiredRef = useRef(false);
  const creditsLowFiredRef = useRef(false);
  const idleWarnFiredRef = useRef(false);
  const endedFiredRef = useRef(false);
  const prevPhaseKindRef = useRef<SessionLifecyclePhase["kind"]>("idle");
  const graceWindowRef = useRef(graceWindow);
  graceWindowRef.current = graceWindow;

  // in-room handles (filled by the bridge).
  const turnSenderRef = useRef<((text: string, opts?: SendTextOptions) => Promise<void>) | null>(null);
  const dataPublisherRef = useRef<((frame: unknown) => void) | null>(null);
  // last turn sent THROUGH the SDK — powers retryTurn + the turn-timeout watchdog.
  const lastTurnRef = useRef<{ text: string; opts?: { instructions?: string }; id: string; sentAt: number } | null>(null);

  // ── clocks (derived; re-tick via clockTick) ──
  const [clockTick, setClockTick] = useState(0);
  const endsAt = endsAtFrom({
    serverStartedAtUnixMs: serverClock?.startedAtUnixMs ?? null,
    maxSessionSeconds: serverClock?.maxSessionSeconds ?? null,
  });
  const sessionRemainingMs = sessionRemainingMsFrom({
    serverStartedAtUnixMs: serverClock?.startedAtUnixMs ?? null,
    maxSessionSeconds: serverClock?.maxSessionSeconds ?? null,
    nowUnixMs: Date.now(),
  });
  const clocks: SessionClocks = {
    sessionRemainingMs,
    idleRemainingMs: lifecycle.timeToDisconnectMs,
    creditRemainingMs,
  };

  const phaseKind = lifecycle.phase.kind;
  const stayConnected = lifecycle.stayConnected;

  // ── id generator (no Math.random in some sandboxes; crypto.randomUUID is fine in the browser) ──
  const newTurnId = useCallback((): string => {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch {
      /* fall through */
    }
    return `t-${Date.now()}-${clockTick}`;
  }, [clockTick]);

  // ── inbound rta.lifecycle frames ──
  const onLifecycleData = useCallback((frame: unknown) => {
    const parsed = lifecycleServerFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    const f = parsed.data;
    switch (f.kind) {
      case "session_clock":
        setServerClock({
          startedAtUnixMs: f.started_at_unix_ms,
          maxSessionSeconds: f.max_session_seconds,
          idleTimeoutSeconds: f.idle_timeout_seconds,
        });
        break;
      case "ending":
        setWorkerEnding(true);
        break;
      case "closing_turn_done":
        setGraceWindow((prev) => {
          if (prev.kind === "delivering" && prev.turnId === f.turn_id) {
            cbRef.current.onGraceWindowClosed?.({ reason: "session_cap", delivered: true });
            return { kind: "spent", delivered: true };
          }
          return prev;
        });
        break;
      case "ended":
        lastLabeledEndReasonRef.current = f.reason;
        break;
      case "behavior_state": {
        const next = nextBehaviorSnapshot(lastBehaviorRef.current, f);
        if (next) {
          lastBehaviorRef.current = next;
          setBehavior(next);
          cbRef.current.onBehaviorChange?.(next);
        }
        break;
      }
      case "clip_ack": {
        const result: ClipResult = { requestId: f.request_id, accepted: f.accepted, reason: f.reason };
        const pending = pendingClipsRef.current.get(f.request_id);
        if (pending) {
          pendingClipsRef.current.delete(f.request_id);
          clearTimeout(pending.timer);
          pending.resolve(result);
        }
        cbRef.current.onClipResult?.(result);
        break;
      }
    }
  }, []);

  const registerDataPublisher = useCallback((publish: ((frame: unknown) => void) | null) => {
    dataPublisherRef.current = publish;
  }, []);
  const registerTurnSender = useCallback((send: ((text: string, opts?: SendTextOptions) => Promise<void>) | null) => {
    turnSenderRef.current = send;
  }, []);
  const setTurnState = useCallback((state: string | null | undefined) => {
    setTurn(mapTurnState(state));
  }, []);
  const setMedia = useCallback((next: RealtimeSessionMedia) => {
    setMediaState((prev) => (prev.video === next.video && prev.audio === next.audio ? prev : next));
  }, []);

  // ── the 1s tick: advance the grace window + fire the time-driven moments ──
  useEffect(() => {
    if (phaseKind === "idle" || phaseKind === "ended") return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const remaining = sessionRemainingMsFrom({
        serverStartedAtUnixMs: serverClock?.startedAtUnixMs ?? null,
        maxSessionSeconds: serverClock?.maxSessionSeconds ?? null,
        nowUnixMs: now,
      });
      const ends = endsAtFrom({
        serverStartedAtUnixMs: serverClock?.startedAtUnixMs ?? null,
        maxSessionSeconds: serverClock?.maxSessionSeconds ?? null,
      });

      // approaching-end (cap) — once.
      const approaching = approachingEndFrom({ sessionRemainingMs: remaining, approachingEndLeadMs, alreadyFired: approachingFiredRef.current });
      if (approaching) {
        approachingFiredRef.current = true;
        cbRef.current.onApproachingEnd?.({ secondsLeft: approaching.secondsLeft, reason: "session_cap", threshold: approachingEndLeadMs / 1000 });
      }
      // credits-low — once.
      const low = creditsLowFrom({ creditRemainingMs, creditsLowLeadMs, alreadyFired: creditsLowFiredRef.current });
      if (low) {
        creditsLowFiredRef.current = true;
        cbRef.current.onCreditsLow?.({ secondsLeft: low.secondsLeft });
      }

      // grace window transitions (time-driven). Fire onGraceWindowOpen on closed→open.
      setGraceWindow((prev) => {
        const next = nextGraceWindow({ prev, sessionRemainingMs: remaining, graceWindowLeadMs, endsAt: ends, workerEnding, nowMs: now });
        if (prev.kind !== "open" && next.kind === "open") {
          cbRef.current.onGraceWindowOpen?.({ reason: next.reason, deadlineAt: next.deadlineAt, msLeft: next.msLeft });
        }
        if (prev.kind !== "spent" && next.kind === "spent" && !next.delivered) {
          cbRef.current.onGraceWindowClosed?.({ reason: "session_cap", delivered: false });
        }
        return next;
      });
      // auto-hold idle so the reaper can't preempt the guaranteed delivery.
      if (autoStayConnectedDuringGrace) {
        const gw = graceWindowRef.current.kind;
        if (gw === "open" || gw === "delivering") stayConnected();
      }

      // per-turn no-response watchdog.
      const turnInfo = lastTurnRef.current;
      if (turnInfo && now - turnInfo.sentAt >= turnTimeoutMs) {
        lastTurnRef.current = null;
        cbRef.current.onTurnTimeout?.({ turnId: turnInfo.id });
      }

      setClockTick((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phaseKind, serverClock, workerEnding, approachingEndLeadMs, graceWindowLeadMs, creditRemainingMs, creditsLowLeadMs, turnTimeoutMs, autoStayConnectedDuringGrace, stayConnected]);

  // ── idle-warning moment: mirror the existing idle-warning phase → onIdleWarning (once per window) ──
  useEffect(() => {
    if (lifecycle.phase.kind === "idle-warning") {
      if (!idleWarnFiredRef.current) {
        idleWarnFiredRef.current = true;
        cbRef.current.onIdleWarning?.({ secondsLeft: lifecycle.phase.secondsRemaining });
      }
    } else {
      idleWarnFiredRef.current = false;
    }
  }, [lifecycle.phase]);

  // ── reconnecting / reconnected moments ──
  useEffect(() => {
    const prev = prevPhaseKindRef.current;
    if (phaseKind === "reconnectable" && prev !== "reconnectable") {
      const attempt = lifecycle.phase.kind === "reconnectable" ? lifecycle.phase.attempt : lifecycle.attempt;
      cbRef.current.onReconnecting?.({ attempt });
    } else if (prev === "reconnectable" && (phaseKind === "live" || phaseKind === "connecting")) {
      cbRef.current.onReconnected?.();
    }
    prevPhaseKindRef.current = phaseKind;
  }, [phaseKind, lifecycle.phase, lifecycle.attempt]);

  // ── ended moment: fire once with the LABELED reason ──
  useEffect(() => {
    if (phaseKind === "ended") {
      if (!endedFiredRef.current) {
        endedFiredRef.current = true;
        const inner = lifecycle.phase.kind === "ended" ? lifecycle.phase.reason : undefined;
        cbRef.current.onEnded?.({ reason: resolveEndReason(lastLabeledEndReasonRef.current, inner) });
      }
    } else {
      endedFiredRef.current = false;
    }
  }, [phaseKind, lifecycle.phase]);

  // ── actions ──
  const sendClosingTurn = useCallback((text: string, opts?: { instructions?: string }): ClosingTurnResult => {
    const trimmed = text.trim();
    const gw = graceWindowRef.current;
    if (gw.kind === "spent") return { ok: false, reason: "already_spent" };
    if (gw.kind !== "open") return { ok: false, reason: "window_closed" };
    const sender = turnSenderRef.current;
    if (!sender || !trimmed) return { ok: false, reason: "not_connected" };
    const turnId = newTurnId();
    const attributes: Record<string, string> = { [RTA_CLOSING_TURN_ATTR]: "1", [RTA_TURN_ID_ATTR]: turnId };
    if (opts?.instructions) attributes[RTA_TURN_INSTRUCTIONS_ATTR] = opts.instructions;
    void sender(trimmed, { attributes }).catch(() => undefined);
    const deadlineAt = (endsAt ?? Date.now()) + graceCeilingMs;
    setGraceWindow({ kind: "delivering", turnId, deadlineAt });
    return { ok: true, turnId };
  }, [endsAt, graceCeilingMs, newTurnId]);

  const requestGracefulClose = useCallback(() => {
    dataPublisherRef.current?.({ kind: "request_graceful_close" });
  }, []);

  const extend = useCallback((req: { addSeconds: number; proof?: string }): ExtendResult => {
    const publish = dataPublisherRef.current;
    if (!publish || !(req.addSeconds > 0)) return { ok: false };
    publish({ kind: "extend", add_seconds: Math.floor(req.addSeconds), ...(req.proof ? { proof: req.proof } : {}) });
    // The worker re-publishes session_clock on success; the cap clock slides + the
    // grace window re-arms. Reset the local edge latches so the moments can re-fire.
    approachingFiredRef.current = false;
    setWorkerEnding(false);
    setGraceWindow({ kind: "closed" });
    return { ok: true };
  }, []);

  const sendTurn = useCallback(async (text: string, opts?: { instructions?: string }): Promise<void> => {
    const trimmed = text.trim();
    const sender = turnSenderRef.current;
    if (!sender || !trimmed) return;
    const turnId = newTurnId();
    lastTurnRef.current = { text: trimmed, opts, id: turnId, sentAt: Date.now() };
    lifecycle.markActivity();
    const attributes = opts?.instructions ? { [RTA_TURN_INSTRUCTIONS_ATTR]: opts.instructions } : undefined;
    await sender(trimmed, attributes ? { attributes } : undefined);
  }, [lifecycle, newTurnId]);

  const retryTurn = useCallback(() => {
    const last = lastTurnRef.current;
    if (!last) return;
    void sendTurn(last.text, last.opts);
  }, [sendTurn]);

  const end = useCallback((reason?: EndReason) => {
    if (reason) lastLabeledEndReasonRef.current = reason;
    requestGracefulClose();
    lifecycle.reset();
  }, [lifecycle, requestGracefulClose]);

  const performClip = useCallback(
    (
      clipId: string,
      opts?: { holdSeconds?: number; timeoutMs?: number },
    ): Promise<ClipResult> => {
      const requestId = newTurnId();
      const publish = dataPublisherRef.current;
      const trimmed = clipId.trim();
      if (!publish || !trimmed) {
        const result = { requestId, accepted: false, reason: "not_connected" };
        cbRef.current.onClipResult?.(result);
        return Promise.resolve(result);
      }
      return new Promise<ClipResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingClipsRef.current.delete(requestId);
          const result = { requestId, accepted: false, reason: "timeout" };
          cbRef.current.onClipResult?.(result);
          resolve(result);
        }, opts?.timeoutMs ?? 5_000);
        pendingClipsRef.current.set(requestId, { resolve, timer });
        publish({
          kind: "clip_request",
          request_id: requestId,
          clip_id: trimmed,
          ...(typeof opts?.holdSeconds === "number" ? { hold_seconds: opts.holdSeconds } : {}),
        });
      });
    },
    [newTurnId],
  );

  // Resolve any in-flight clip promises on unmount (never leave callers hanging).
  useEffect(
    () => () => {
      for (const [requestId, pending] of pendingClipsRef.current) {
        clearTimeout(pending.timer);
        pending.resolve({ requestId, accepted: false, reason: "unmounted" });
      }
      pendingClipsRef.current.clear();
    },
    [],
  );

  // Clear server-clock + grace state on a full reset (mode/avatar switch).
  const reset = useCallback(() => {
    setServerClock(null);
    setWorkerEnding(false);
    setGraceWindow({ kind: "closed" });
    lastLabeledEndReasonRef.current = null;
    approachingFiredRef.current = false;
    creditsLowFiredRef.current = false;
    lastTurnRef.current = null;
    lifecycle.reset();
  }, [lifecycle]);

  return useMemo<RealtimeSessionApi>(
    () => ({
      // Spread the inner SSOT verbatim (phase/grant/capacity/attempt/timeToDisconnectMs/
      // stayConnected/reconnect/markActivity/the sinks) → a true drop-in superset, then
      // add the realtime-session surface. `reset` + `lifecycle` come AFTER so ours win.
      ...lifecycle,
      turn,
      clocks,
      endsAt,
      graceWindow,
      media,
      lifecycle,
      sendClosingTurn,
      requestGracefulClose,
      extend,
      sendTurn,
      retryTurn,
      end,
      behavior,
      performClip,
      onLifecycleData,
      registerDataPublisher,
      registerTurnSender,
      setTurnState,
      setMedia,
      reset,
    }),
    [
      lifecycle, turn, clocks, endsAt, graceWindow, media, sendClosingTurn, requestGracefulClose,
      extend, sendTurn, retryTurn, end, behavior, performClip, onLifecycleData, registerDataPublisher,
      registerTurnSender, setTurnState, setMedia, reset,
    ],
  );
}
