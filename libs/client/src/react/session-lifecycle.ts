"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionError,
  ConnectionErrorReason,
  DisconnectReason,
  RoomEvent,
} from "livekit-client";
import {
  useChat,
  useConnectionState,
  useLiveKitAvatarGrant,
  useRoomContext,
  useTranscriptions,
  useVoiceAssistant,
  type LiveKitCapacityState,
  type LiveKitConnectionStatus,
  type SendTextOptions,
  type UseLiveKitAvatarGrantInput,
} from "./livekit";
import type { RealtimeAvatarClient } from "../client";
import type { LiveKitSessionGrant, LiveKitSessionRequest } from "../livekit-grant";
import {
  RTA_LIFECYCLE_TOPIC,
  lifecycleServerFrameSchema,
  type CapacityBusyResponse,
  type LLMProvider,
} from "realtime-avatar-contracts";
import { nextBehaviorSnapshot, type BehaviorSnapshot } from "./behavior-snapshot";

// ---------------------------------------------------------------------------
// Pure recovery classifiers (LIFTED unchanged from the studio's
// use-session-recovery.ts so the recover-vs-end table lives next to capacity in
// the SDK, vendor-neutral and unit-tested). Both the text path and the call path
// route through these — one source of truth for recover-vs-end across surfaces.
//
// These are PURE LOGIC only: no React, no UI, no user-facing copy. Adopters map
// the resulting phase to their own copy/i18n (mirrors how capacityStateFromGrant
// returns a structured signal and the app owns the banner text).
// ---------------------------------------------------------------------------

/**
 * Classify a LiveKit {@link DisconnectReason} into a recovery phase.
 *
 * The recover-vs-end table is load-bearing — see the unit tests:
 * - `CLIENT_INITIATED` → `ignore`: WE tore it down (mode/avatar switch). Never a
 *   recovery; the caller resets.
 * - `DUPLICATE_IDENTITY` / `PARTICIPANT_REMOVED` / `ROOM_DELETED` /
 *   `SERVER_SHUTDOWN` → `ended`: the session was deliberately ended elsewhere
 *   (another tab joined, the participant was kicked, the room was deleted, the
 *   server is draining). Re-minting would just race the same outcome, so we park
 *   on an explicit Reconnect tap.
 * - Everything else → `reconnecting` (auto-retry). This INCLUDES `ROOM_CLOSED`:
 *   the ~120s idle-token-expiry wedge closes the room with ROOM_CLOSED, and a
 *   fresh grant (new room + token) recovers it. Also SIGNAL_CLOSE,
 *   CONNECTION_TIMEOUT, MEDIA_FAILURE, STATE_MISMATCH, JOIN_FAILURE, MIGRATION,
 *   AGENT_ERROR, UNKNOWN_REASON, and `undefined`.
 */
export function phaseForReason(reason: DisconnectReason | undefined): "ended" | "reconnecting" | "ignore" {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return "ignore";
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.SERVER_SHUTDOWN:
    case DisconnectReason.DUPLICATE_IDENTITY:
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "ended";
    default:
      // ROOM_CLOSED (idle-token-expiry wedge), SIGNAL_CLOSE, CONNECTION_TIMEOUT,
      // MEDIA_FAILURE, STATE_MISMATCH, JOIN_FAILURE, MIGRATION, AGENT_ERROR,
      // UNKNOWN_REASON, undefined.
      return "reconnecting";
  }
}

/**
 * The effect a {@link DisconnectReason} has on a session, given whether the room
 * was ever connected. Pure (no React) so the load-bearing recover-vs-end table is
 * unit-testable without rendering the hook. Used 1:1 by the hook below.
 *
 * - `reset`: CLIENT_INITIATED — WE tore the room down (mode/avatar switch); clear
 *   any banner and stay connected.
 * - `end`: a deliberate server/peer end; show the ended banner and release once.
 * - `reconnect`: a recoverable drop (incl. a JOIN_FAILURE before the first
 *   connection and ROOM_CLOSED after one); start the auto-retry.
 *
 * `everConnected` remains in the signature for source compatibility and for
 * callers that record the distinction, but it must not suppress a real initial
 * transport failure. Expected pre-connect teardown is identified by the explicit
 * CLIENT_INITIATED reason instead.
 */
export function disconnectAction(
  reason: DisconnectReason | undefined,
  _everConnected: boolean,
): "noop" | "reset" | "end" | "reconnect" {
  const phase = phaseForReason(reason);
  if (phase === "ignore") return "reset";
  if (phase === "ended") return "end";
  return "reconnect";
}

/**
 * True only for LiveKit connection failures where a fresh token/room attempt can
 * recover. Media-device and autoplay errors are deliberately excluded so a denied
 * microphone does not burn through session grants. Cancelled/leave errors are also
 * excluded because React/LiveKit emits them during client-owned teardown.
 */
export function isRecoverableConnectionError(error: unknown): boolean {
  if (!(error instanceof ConnectionError)) return false;
  switch (error.reason) {
    case ConnectionErrorReason.ServerUnreachable:
    case ConnectionErrorReason.InternalError:
    case ConnectionErrorReason.Timeout:
    case ConnectionErrorReason.WebSocket:
      return true;
    default:
      return false;
  }
}

/**
 * Whether a re-queued turn should replay onto a freshly-(re)connected room. Pure
 * so the "replay exactly once, keyed on the NEW session_id" guard is testable.
 *
 * Replays only when ALL hold:
 * - the connect was a RECOVERY (we were reconnecting), not a first connect;
 * - there is a pending turn to replay;
 * - the fresh grant has a session_id;
 * - that session_id hasn't already replayed (a flapping reconnect that re-fires
 *   onConnected for the SAME session must not double-send).
 */
export function shouldReplayPendingTurn(args: {
  wasReconnecting: boolean;
  hasPendingTurn: boolean;
  sessionId: string | null | undefined;
  lastReplayedSessionId: string | null | undefined;
}): boolean {
  const { wasReconnecting, hasPendingTurn, sessionId, lastReplayedSessionId } = args;
  if (!wasReconnecting || !hasPendingTurn || !sessionId) return false;
  return lastReplayedSessionId !== sessionId;
}

// Auto-reconnect backoff for transient drops (DEFAULT). Short and capped: a
// network blip (or an idle-token expiry that the server resolves by recycling the
// room) should recover within a couple of seconds; we don't hammer the grant
// route. The last delay is reused for any attempt past the array's length, up to
// the give-up cap. Configurable via `reconnectBackoffMs` on useSessionLifecycle.
export const RECONNECT_BACKOFF_MS = [800, 2_000, 4_000];
// Auto-reconnect is bounded (DEFAULT): after this many failed attempts we stop and
// park on the manual Reconnect button (the failed `reconnectable{reconnecting:false}`),
// freeing the held lease once rather than re-minting forever against a wedge the
// backoff can't clear. Configurable via `maxReconnectAttempts`.
export const MAX_RECONNECT_ATTEMPTS = 4;

export type RetryStep =
  | { kind: "retry"; delayMs: number; attempt: number }
  | { kind: "give-up" };

/**
 * The reconnect policy: the backoff schedule + the give-up bound. Both are CLIENT-
 * UX-tier knobs (not infra), so they are configurable on the hook with the audited
 * defaults above. A non-positive / empty override falls back to the default.
 */
export type ReconnectPolicy = { backoffMs: number[]; maxAttempts: number };

/** Validate + clamp a reconnect policy, falling back to the audited defaults. */
export function resolveReconnectPolicy(override?: Partial<ReconnectPolicy>): ReconnectPolicy {
  const backoff = override?.backoffMs?.filter((ms) => Number.isFinite(ms) && ms > 0) ?? [];
  const backoffMs = backoff.length > 0 ? backoff : RECONNECT_BACKOFF_MS;
  const max = override?.maxAttempts;
  const maxAttempts = typeof max === "number" && Number.isFinite(max) && max > 0
    ? Math.floor(max)
    : MAX_RECONNECT_ATTEMPTS;
  return { backoffMs, maxAttempts };
}

/**
 * The next auto-reconnect step given the number of attempts already made and the
 * (optional) policy. Pure so the backoff schedule AND the give-up bound are unit-
 * testable. The backoff array is clamped to its last entry; once `maxAttempts` is
 * reached we give up (→ terminal failed `reconnectable`, lease released once,
 * manual retry resets). Omitting `policy` uses the audited defaults (back-compat).
 */
export function retryStep(attempt: number, policy: ReconnectPolicy = resolveReconnectPolicy()): RetryStep {
  if (attempt >= policy.maxAttempts) return { kind: "give-up" };
  const delayMs = policy.backoffMs[Math.min(attempt, policy.backoffMs.length - 1)];
  return { kind: "retry", delayMs, attempt: attempt + 1 };
}

// ---------------------------------------------------------------------------
// The single session-lifecycle STATE MACHINE (SSOT). One canonical phase enum,
// the union of three orthogonal concerns that previously lived in three layers:
// grant capacity, idle reaping, and drop recovery. Structured data ONLY — no
// copy; adopters render it.
// ---------------------------------------------------------------------------

/**
 * Why a session reached the terminal {@link SessionLifecyclePhase} `ended` arm.
 * OPTIONAL on the phase (back-compat: a bare `{ kind: "ended" }` still type-checks
 * and renders), so adopters can disambiguate the end without forking the union:
 * - `idle`: the CLIENT-AUTHORITATIVE idle clock expired and the SDK ended the
 *   session itself (released the lease + left the room → the worker's disconnect release
 *   frees the GPU). This is the reason the idle-warning countdown is now TRUE.
 * - `disconnected`: a deliberate server/peer end or an exhausted auto-reconnect.
 * - `error`: a grant failure surfaced as a terminal phase (no lease, no retry).
 */
export type SessionEndReason = "idle" | "disconnected" | "error";

export type SessionLifecyclePhase =
  // no session requested.
  | { kind: "idle" }
  // grant fetch in flight, no queue placement yet.
  | { kind: "requesting" }
  // all slots busy, holding a ticket, auto-retrying. NOT an error.
  | { kind: "queued"; busy: CapacityBusyResponse }
  // grant held, room socket connecting, agent not yet present.
  | { kind: "connecting"; grant: LiveKitSessionGrant }
  // connected + agent present + activity fresh.
  | { kind: "live" }
  // within the warn window of the CLIENT-ENFORCED idle end (PREEMPTIVE). The
  // countdown is TRUE: at zero the SDK ends the session itself (→ `ended{idle}`).
  | { kind: "idle-warning"; secondsRemaining: number; deadlineAt: number }
  // dropped (REACTIVE): auto-backoff (reconnecting) OR parked on a manual tap
  // (!reconnecting = failed/give-up). `attempt` is the DOM test contract.
  | {
      kind: "reconnectable";
      reconnecting: boolean;
      attempt: number;
      /** Native LiveKit recovery keeps the same grant; fresh-grant recovery re-mints. */
      strategy: "in-place" | "fresh-grant";
    }
  // terminal: deliberate end, idle expiry, OR give-up; lease released. `reason` is
  // OPTIONAL so a bare `{ kind: "ended" }` stays valid (no union fork).
  | { kind: "ended"; reason?: SessionEndReason };

export type SessionLifecyclePhaseKind = SessionLifecyclePhase["kind"];

/**
 * The idle sub-state, derived purely from the CLIENT-AUTHORITATIVE idle clock.
 * Pure (no React, mirrors {@link capacityStateFromGrant}) so the countdown math
 * and the warn-window threshold are unit-testable without a DOM.
 *
 * IDLE OWNERSHIP (load-bearing): the CLIENT is the sole reap authority. The worker
 * present-idle reap is DISABLED (`idle_timeout_seconds=0` in the worker settings —
 * reaping a PRESENT human on turn-silence broke recovery), so the server NEVER
 * ends an idle-but-present session. This clock is therefore not a "mirror" of a
 * server reap that fires; it is the ENFORCER. When it expires the hook ends the
 * session itself (see {@link idleExpired} + the idle-enforcement effect): release
 * the lease + leave the room, and the worker's disconnect release frees
 * the GPU. The countdown the `idle-warning` arm carries is TRUE — at zero it ends.
 *
 * - `inactive`: not connected, or no agent bound yet — there is no idle clock to
 *   run (only a connected room with a bound agent can go idle-silent).
 * - `live`: connected + agent present + activity is still fresh (outside the warn
 *   window).
 * - `idle-warning`: connected + agent present + within `warnAtMs` of the end.
 *   `secondsRemaining` is the ceil of the time left so the countdown reads in
 *   whole seconds and never shows a stale 0 before the cut.
 */
export function idlePhaseFor(args: {
  connected: boolean;
  agentPresent: boolean;
  msSinceActivity: number;
  idleTimeoutMs: number;
  warnAtMs: number;
}): { kind: "inactive" } | { kind: "live" } | { kind: "idle-warning"; secondsRemaining: number } {
  const { connected, agentPresent, msSinceActivity, idleTimeoutMs, warnAtMs } = args;
  // No idle clock unless the room is live AND the agent is bound — only a
  // connected session with a present agent can fall idle-silent.
  if (!connected || !agentPresent || idleTimeoutMs <= 0) return { kind: "inactive" };
  const remainingMs = idleTimeoutMs - msSinceActivity;
  if (remainingMs > warnAtMs) return { kind: "live" };
  // Clamp to 0 so a passed-deadline tick (the end is imminent) still renders a
  // sane "0s" instead of a negative countdown.
  const secondsRemaining = Math.max(0, Math.ceil(remainingMs / 1000));
  return { kind: "idle-warning", secondsRemaining };
}

/**
 * Whether the CLIENT-AUTHORITATIVE idle clock has reached zero — the moment the
 * SDK must END the session itself (there is no server reap to wait for). Pure so
 * the "expire → end" decision is table-tested without a DOM, exactly like
 * {@link idlePhaseFor} (it shares the same gating: a clock only runs while
 * connected + agent present + a positive idle timeout).
 *
 * Returns true only when ALL hold:
 * - the room is connected and the agent is present (a clock is running);
 * - a positive idle timeout is configured;
 * - the time since the last activity has met or passed the idle timeout.
 */
export function idleExpired(args: {
  connected: boolean;
  agentPresent: boolean;
  msSinceActivity: number;
  idleTimeoutMs: number;
}): boolean {
  const { connected, agentPresent, msSinceActivity, idleTimeoutMs } = args;
  if (!connected || !agentPresent || idleTimeoutMs <= 0) return false;
  return msSinceActivity >= idleTimeoutMs;
}

/**
 * The recovery sub-state, the bridge between the pure recovery classifiers above
 * and the unified phase. Kept as a small explicit union so the reducer below can
 * compose it without re-deriving the recover-vs-end table.
 */
export type RecoveryState =
  | { kind: "connected" }
  // LiveKit is recovering the existing PeerConnection. This state is visible in
  // the UI but MUST NOT arm the fresh-grant retry timer.
  | { kind: "in-place-reconnecting" }
  // A fresh-grant request/room connect is already in flight. It stays visible but
  // MUST NOT schedule another refresh until that attempt actually fails.
  | { kind: "refreshing"; attempt: number }
  // The prior attempt failed and is waiting for the next bounded backoff.
  | { kind: "reconnecting"; attempt: number }
  | { kind: "failed" }
  // `reason` carries the terminal cause onto the `ended` phase: `idle` when the
  // CLIENT-AUTHORITATIVE idle clock ended the session, else `disconnected` (a
  // deliberate server/peer end). Defaults to `disconnected` for back-compat.
  | { kind: "ended"; reason?: SessionEndReason };

/** Only terminal room recovery is allowed to schedule a fresh grant. */
export function needsFreshGrant(
  recovery: RecoveryState,
): recovery is Extract<RecoveryState, { kind: "reconnecting" }> {
  return recovery.kind === "reconnecting";
}

/**
 * Assemble the full {@link SessionLifecyclePhase} from the three orthogonal
 * inputs (capacity, recovery, idle) plus the room connection facts. Pure + DOM-
 * free so the ENTIRE state-machine resolution is table-tested exactly like the
 * recovery classifiers.
 *
 * Precedence (load-bearing):
 * 1. Recovery is REACTIVE — a real drop owns the phase until it heals, so it wins
 *    over capacity/idle (`reconnectable` / `ended`). The exception: a recovery
 *    that has reconnected (back to `connected`) yields to capacity/idle below.
 * 2. Capacity is the pre-connect gate — `idle` / `requesting` / `queued`.
 * 3. Once a grant is held (`active`), the room is `connecting` until the agent is
 *    present and the room is connected.
 * 4. Connected + agent present → idle clock decides `live` vs `idle-warning`.
 */
export function lifecyclePhaseFrom(args: {
  capacity: LiveKitCapacityState;
  recovery: RecoveryState;
  idle: { kind: "inactive" } | { kind: "live" } | { kind: "idle-warning"; secondsRemaining: number; deadlineAt: number };
  connected: boolean;
  agentPresent: boolean;
}): SessionLifecyclePhase {
  const { capacity, recovery, idle, connected, agentPresent } = args;

  // 1) A live recovery owns the phase (REACTIVE) — never let a transient
  // capacity/idle reading paper over a real drop.
  if (recovery.kind === "in-place-reconnecting") {
    return { kind: "reconnectable", reconnecting: true, attempt: 0, strategy: "in-place" };
  }
  if (recovery.kind === "refreshing" || recovery.kind === "reconnecting") {
    return {
      kind: "reconnectable",
      reconnecting: true,
      attempt: recovery.attempt,
      strategy: "fresh-grant",
    };
  }
  if (recovery.kind === "failed") {
    return {
      kind: "reconnectable",
      reconnecting: false,
      attempt: MAX_RECONNECT_ATTEMPTS,
      strategy: "fresh-grant",
    };
  }
  if (recovery.kind === "ended") {
    // Pass the terminal cause through so adopters can disambiguate (idle expiry
    // vs. a deliberate server/peer end) without forking the phase union.
    return recovery.reason ? { kind: "ended", reason: recovery.reason } : { kind: "ended" };
  }

  // 2) Pre-connect capacity gate.
  switch (capacity.kind) {
    case "idle":
      return { kind: "idle" };
    case "connecting":
      return { kind: "requesting" };
    case "queued":
      return { kind: "queued", busy: capacity.busy };
    case "error":
      // A genuine grant failure is surfaced by adopters via `capacity.error`
      // (kept on the grant state). For the lifecycle phase it reads as `ended`
      // with reason `error`: there is no held lease and no auto-retry in flight.
      return { kind: "ended", reason: "error" };
    case "active": {
      // 3) Grant held; the room connects to it. Until the socket is connected AND
      // the agent has joined, we are `connecting`.
      if (!connected || !agentPresent) {
        return { kind: "connecting", grant: capacity.grant };
      }
      // 4) Connected + agent present → the idle clock decides.
      if (idle.kind === "idle-warning") {
        return { kind: "idle-warning", secondsRemaining: idle.secondsRemaining, deadlineAt: idle.deadlineAt };
      }
      return { kind: "live" };
    }
    default:
      return { kind: "idle" };
  }
}

/**
 * Whether an in-room voice signal counts as ORGANIC ACTIVITY that should reset the
 * CLIENT-AUTHORITATIVE idle clock. Pure (no React) so the IDLE×CALL invariant is
 * table-tested without rendering the bridge — exactly like {@link idleExpired}.
 *
 * The IDLE×CALL fix: a voice call has no per-turn text send to reset the idle clock,
 * so without an activity signal an ACTIVE call is falsely reaped at the client idle
 * end. We count as activity ONLY:
 *  - the agent ACTIVELY producing — `speaking` or `thinking` (a real reply in flight);
 *  - a fresh transcript segment — `transcriptionCount` grew (someone actually spoke:
 *    the user's STT transcript, or the agent's synced transcript).
 *
 * The resting `listening` state is DELIBERATELY excluded: a silent call (the agent
 * idles in `listening`, nobody speaks, no new transcript) must still reap at the idle
 * end. `connecting`/`initializing`/`disconnected` are not activity either.
 */
export function isCallActivity(args: {
  assistantState: string;
  transcriptionCount: number;
  prevTranscriptionCount: number;
}): boolean {
  const { assistantState, transcriptionCount, prevTranscriptionCount } = args;
  if (assistantState === "speaking" || assistantState === "thinking") return true;
  return transcriptionCount > prevTranscriptionCount;
}

// ---------------------------------------------------------------------------
// The composed hook. Wraps useLiveKitAvatarGrant (capacity/lease, UNCHANGED)
// with the idle clock + lifted recovery, returning the unified phase + actions.
// Called ABOVE the LiveKit room (where the grant lives); the in-room facts
// (connection state, agent presence) are fed in via the event sinks.
// PURE STATE + ACTIONS — no UI.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLIENT-UX-tier configurable defaults (audited; aligned with docs/SDK_SESSION_API.md).
// These are the values the APP can tune — they govern the client-owned UX clocks,
// NOT the server infra invariants (join / reservation / stale / token / room-
// departure stay server config and are NEVER exposed here).
// ---------------------------------------------------------------------------

/**
 * The CLIENT-OWNED idle budget (seconds): how long "quiet" before the client-
 * enforced idle end. This is the AUTHORITY for the reap decision (the worker reap
 * is off). Falls back to the grant's `idle_timeout_seconds` if the app omits it,
 * then to this default. Matches docs/SDK_SESSION_API.md (`idleSeconds = 120`).
 */
export const DEFAULT_IDLE_SECONDS = 120;
/**
 * How early the `idle-warning` phase fires before the idle end (seconds). Replaces
 * the legacy `min(30s, idle/3)` magic; clamped so the lead is always < the idle
 * budget. Matches docs/SDK_SESSION_API.md (`idleWarnLeadSeconds = 20`).
 */
export const DEFAULT_IDLE_WARN_LEAD_SECONDS = 20;
/**
 * The per-turn "no response" watchdog (seconds). The SDK owns this as the SINGLE
 * source for the turn timeout so adopters (the studio controller) thread ONE knob
 * instead of hardcoding a second literal. Matches docs/SDK_SESSION_API.md
 * (`turnTimeoutSeconds = 20`).
 */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 20;

export type UseSessionLifecycleInput<T extends LLMProvider = LLMProvider> = {
  client: RealtimeAvatarClient<T>;
  session: LiveKitSessionRequest<T> | null | undefined;
  active?: boolean;
  /**
   * The CLIENT-OWNED idle budget (seconds) — the authority for the client-enforced
   * idle end. Falls back to the grant's `idle_timeout_seconds`, then
   * {@link DEFAULT_IDLE_SECONDS}. Validated positive (a non-positive value falls
   * back).
   */
  idleSeconds?: number;
  /**
   * How early the `idle-warning` phase fires before the idle end (seconds). Default
   * {@link DEFAULT_IDLE_WARN_LEAD_SECONDS}; clamped so the lead is always strictly
   * less than the idle budget.
   */
  idleWarnLeadSeconds?: number;
  /**
   * @deprecated Use {@link idleWarnLeadSeconds}. The legacy ms warn-window override;
   * still honored (clamped to the idle budget) for back-compat. `idleWarnLeadSeconds`
   * wins when both are set.
   */
  warnBeforeMs?: number;
  /** Auto-reconnect backoff schedule (ms). Default {@link RECONNECT_BACKOFF_MS}. */
  reconnectBackoffMs?: number[];
  /** Auto-reconnect give-up bound. Default {@link MAX_RECONNECT_ATTEMPTS}. */
  maxReconnectAttempts?: number;
  /** Forwarded to {@link useLiveKitAvatarGrant}. Defaults true (queue auto-retry). */
  autoRetryBusy?: boolean;
  requestOptions?: UseLiveKitAvatarGrantInput<T>["requestOptions"];
  /**
   * Opt-in tap for the avatar's live nonverbal behavior (multi-clip choreography). Fires
   * ONLY on a real change of {@link BehaviorSnapshot}, via the SAME `nextBehaviorSnapshot`
   * derivation {@link useRealtimeSession} uses for its `behavior` state — one source of truth.
   *
   * Omit it and the SDK never subscribes to behavior frames (zero overhead). Treat the
   * snapshot as DEBUG/admin signal: `clipId` is an internal render-clip id, not a
   * product-facing value — gate any UI that shows it (e.g. behind an admin flag).
   */
  onBehaviorChange?: (snapshot: BehaviorSnapshot) => void;
};

export type SessionLifecycleApi = {
  phase: SessionLifecyclePhase;
  /** The held grant for RealtimeAvatarLiveKitRoom (null until connecting+). */
  grant: LiveKitSessionGrant | null;
  /** The underlying capacity signal (queue position/size, error) — unchanged. */
  capacity: LiveKitCapacityState;
  /** The DOM recovery contract: auto-reconnect attempts since the last connect. */
  attempt: number;

  // --- Idle lifecycle (CLIENT-AUTHORITATIVE: the SDK enforces the end) ---
  /**
   * ms until the CLIENT-ENFORCED idle end, or null when not connected/live. Drives
   * the countdown — and it is TRUE: at zero the SDK ends the session (`ended{idle}`).
   * This is the consumer's leverageable window (read it to act in-character before
   * the line closes; `stayConnected()` to extend; or let it run out).
   */
  timeToDisconnectMs: number | null;
  /**
   * EXTEND the session: reset the CLIENT idle clock (the load-bearing effect that
   * postpones the client-enforced end). idle-warning → live. Idempotent,
   * fire-and-forget, no-op if not connected.
   */
  stayConnected: () => void;
  /**
   * Mark organic activity (text-turn start, mic unmute, inbound transcription) —
   * resets the CLIENT idle clock (postpones the client-enforced end).
   */
  markActivity: () => void;

  // --- Recovery ---
  /** Manual reconnect (the Reconnect button): resets the attempt budget and re-mints. */
  reconnect: () => void;

  // --- Room event sinks (wire 1:1 to RealtimeAvatarLiveKitRoom / an in-room bridge) ---
  onConnected: () => void;
  onDisconnected: (reason?: DisconnectReason) => void;
  /**
   * Wire to the room's onError callback. Only retryable LiveKit transport errors
   * enter recovery; media-device/autoplay/client-cancel errors remain UI errors.
   */
  onConnectionError: (error: Error) => void;
  /**
   * Wire to onConnectionStateChange so LiveKit's IN-PLACE reconnect
   * (signalReconnecting → reconnecting → connected) flips the phase too — fixes
   * the "invisible mid-flight reconnect" gap on the text path.
   */
  onConnectionStateChange: (state: LiveKitConnectionStatus) => void;
  /** Feed the bound-agent signal (useVoiceAssistant().agent presence) from in-room. */
  setAgentPresent: (present: boolean) => void;
  /**
   * Register the in-room room-leave handle (room.disconnect). The in-room bridge
   * supplies it because the Room lives below this hook. This is what makes idle
   * CLIENT-AUTHORITATIVE: when the idle clock expires the hook calls this to LEAVE
   * the room, which (with the worker's disconnect release) ends the worker
   * session and frees the GPU — no leaked session, no waiting on a server reap that
   * never fires. Pass null to unregister.
   */
  registerLeaveRoom: (leave: (() => void) | null) => void;

  /** Reset to idle (mode/avatar change). */
  reset: () => void;
};

/**
 * Resolve the CLIENT-OWNED idle budget (ms), the authority for the client-enforced
 * idle end. Precedence (per docs/SDK_SESSION_API.md):
 *   1. a positive `idleSeconds` option (the app's explicit budget) — always wins,
 *      so an adopter runs the client idle UX even if the server disables its own;
 *   2. the grant's `idle_timeout_seconds` when positive (the platform value);
 *   3. {@link DEFAULT_IDLE_SECONDS} otherwise (neither set, or both 0).
 * Returns ms (>0). There is no "0 = no clock" path: idle is now CLIENT-owned, so a
 * client always runs the budget — the audited default is the floor.
 */
export function resolveIdleTimeoutMs(args: {
  idleSecondsOption?: number;
  grantIdleSeconds: number;
}): number {
  const { idleSecondsOption, grantIdleSeconds } = args;
  if (typeof idleSecondsOption === "number" && idleSecondsOption > 0) {
    return Math.floor(idleSecondsOption) * 1000;
  }
  if (grantIdleSeconds > 0) return grantIdleSeconds * 1000;
  return DEFAULT_IDLE_SECONDS * 1000;
}

const DEFAULT_WARN_CAP_MS = 30_000;

/**
 * Resolve the warn window (ms) before the client-enforced idle end. Precedence:
 * a positive `idleWarnLeadSeconds` (the doc-aligned knob) → the legacy
 * `warnBeforeMs` (deprecated) → the default {@link DEFAULT_IDLE_WARN_LEAD_SECONDS}.
 * Always CLAMPED so the lead is strictly less than the idle budget (a lead ≥ the
 * budget would fire the warning the instant the clock starts; we keep at least one
 * whole second of "live" before the warn window opens).
 */
export function resolveWarnBeforeMs(
  idleTimeoutMs: number,
  override?: number,
  idleWarnLeadSeconds?: number,
): number {
  if (idleTimeoutMs <= 0) return 0;
  // Largest legal lead: strictly below the budget (keep ≥1s of pre-warn "live").
  const maxLeadMs = Math.max(0, idleTimeoutMs - 1000);
  let leadMs: number;
  if (typeof idleWarnLeadSeconds === "number" && idleWarnLeadSeconds > 0) {
    leadMs = Math.floor(idleWarnLeadSeconds) * 1000;
  } else if (typeof override === "number" && override > 0) {
    leadMs = override;
  } else {
    leadMs = DEFAULT_IDLE_WARN_LEAD_SECONDS * 1000;
  }
  return Math.min(leadMs, maxLeadMs);
}

export function useSessionLifecycle<T extends LLMProvider = LLMProvider>(
  input: UseSessionLifecycleInput<T>,
): SessionLifecycleApi {
  const {
    client,
    session,
    active = true,
    idleSeconds,
    idleWarnLeadSeconds,
    warnBeforeMs,
    reconnectBackoffMs,
    maxReconnectAttempts,
    autoRetryBusy = true,
    requestOptions,
    onBehaviorChange,
  } = input;

  // Resolve the CLIENT-UX-tier policy once (validated + clamped). The reconnect
  // policy is held in a ref so the auto-retry effect reads the latest without
  // re-subscribing on every option-identity change.
  const reconnectPolicy = useMemo(
    () => resolveReconnectPolicy({ backoffMs: reconnectBackoffMs, maxAttempts: maxReconnectAttempts }),
    [reconnectBackoffMs, maxReconnectAttempts],
  );
  const reconnectPolicyRef = useRef(reconnectPolicy);
  reconnectPolicyRef.current = reconnectPolicy;

  const grantState = useLiveKitAvatarGrant<T>({
    client,
    session,
    active,
    autoRetryBusy,
    requestOptions,
  });
  const capacity = grantState.capacity;

  // --- Recovery sub-machine (mirrors the lifted use-session-recovery hook) ---
  const [recovery, setRecovery] = useState<RecoveryState>({ kind: "connected" });
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  const [attempt, setAttempt] = useState(0);
  const connectedRef = useRef(false);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const manualReconnectPendingRef = useRef(false);
  // Keep the latest grant actions without making the auto-retry effect depend on
  // their identity (they change whenever the grant object changes).
  const refreshRef = useRef(grantState.refresh);
  refreshRef.current = grantState.refresh;
  const releaseRef = useRef(grantState.release);
  releaseRef.current = grantState.release;
  const capacityRef = useRef(capacity);
  capacityRef.current = capacity;
  // Snapshot the capacity signal at refresh dispatch. This distinguishes a stale
  // pre-refresh error render from the result of the new request.
  const refreshBaselineCapacityRef = useRef<LiveKitCapacityState | null>(null);

  // --- Idle clock (CLIENT-AUTHORITATIVE: this clock ENFORCES the end) ---
  // The idle budget is CLIENT-OWNED: the `idleSeconds` option wins, else the grant's
  // `idleTimeoutSeconds` (platform), else the audited default. The worker
  // present-idle reap is OFF, so this client clock is the SOLE reap authority: on
  // expiry the hook ends the session itself (release + leave room →
  // the worker's disconnect release frees the GPU). See the idle-enforcement effect below.
  const idleTimeoutMs = resolveIdleTimeoutMs({
    idleSecondsOption: idleSeconds,
    grantIdleSeconds: grantState.grant?.idle_timeout_seconds ?? 0,
  });
  const warnAtMs = resolveWarnBeforeMs(idleTimeoutMs, warnBeforeMs, idleWarnLeadSeconds);
  const [agentPresent, setAgentPresentState] = useState(false);
  const [connected, setConnected] = useState(false);
  const lastActivityRef = useRef<number>(Date.now());
  // The in-room room-leave handle (room.disconnect), supplied by the bridge. The
  // idle-enforcement effect calls it to actually END the session on idle expiry.
  const leaveRoomRef = useRef<(() => void) | null>(null);
  // A 1s ticker mirror so the countdown re-derives `secondsRemaining` in place.
  const [, setClockTick] = useState(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    connectedRef.current = false;
    manualReconnectPendingRef.current = false;
    refreshBaselineCapacityRef.current = null;
    attemptRef.current = 0;
    setAttempt(0);
    setRecovery({ kind: "connected" });
    setConnected(false);
    setAgentPresentState(false);
    lastActivityRef.current = Date.now();
  }, [clearTimer]);

  // Leaving the session (inactive: mode/avatar switch, no session) clears any
  // recovery banner + idle clock so they can't linger into an unrelated surface.
  useEffect(() => {
    if (!active) reset();
  }, [active, reset]);

  const markActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    // Drop straight out of the warn window on organic activity.
    setClockTick((value) => value + 1);
  }, []);

  const stayConnected = useCallback(() => {
    // No-op if not connected — there is no idle clock to reset.
    if (!connectedRef.current) return;
    // Reset the CLIENT idle clock — the load-bearing effect that postpones the
    // client-enforced end (the SDK owns the reap).
    lastActivityRef.current = Date.now();
    setClockTick((value) => value + 1);
  }, []);

  const setAgentPresent = useCallback((present: boolean) => {
    setAgentPresentState((prev) => {
      // Seed the clock the moment the agent first binds (connecting → live).
      if (present && !prev) lastActivityRef.current = Date.now();
      return present;
    });
  }, []);

  const registerLeaveRoom = useCallback((leave: (() => void) | null) => {
    leaveRoomRef.current = leave;
  }, []);

  // CLIENT-ENFORCED idle end: end the session ourselves on idle expiry (there is
  // no server reap to wait for). Marks the terminal `ended{idle}` phase, frees the
  // held lease ONCE, and LEAVES the room — the worker's disconnect release
  // then ends the worker session and frees the GPU (so no leaked session). Guarded
  // on `connectedRef` so a stale tick after a drop can't re-end. Idempotent: a
  // second call while already ended is a no-op.
  const endIdle = useCallback(() => {
    if (!connectedRef.current) return;
    clearTimer();
    connectedRef.current = false;
    setConnected(false);
    setAgentPresentState(false);
    releaseRef.current("idle_timeout");
    setRecovery({ kind: "ended", reason: "idle" });
    // Leave the room so the worker's disconnect release frees the GPU. Fire-and-forget; the
    // bridge's handle swallows its own errors.
    leaveRoomRef.current?.();
  }, [clearTimer]);

  const onConnected = useCallback(() => {
    clearTimer();
    connectedRef.current = true;
    manualReconnectPendingRef.current = false;
    refreshBaselineCapacityRef.current = null;
    setConnected(true);
    attemptRef.current = 0;
    setAttempt(0);
    setRecovery({ kind: "connected" });
    lastActivityRef.current = Date.now();
  }, [clearTimer]);

  const onDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (!active) return;
      const action = disconnectAction(reason, connectedRef.current);
      if (action === "noop") return;
      if (action === "reset") {
        // Replacing a failed room with a fresh grant disconnects the old room on
        // purpose. That CLIENT_INITIATED event belongs to the swap; resetting here
        // would erase the in-flight recovery state.
        if (recoveryRef.current.kind === "refreshing") return;
        reset();
        return;
      }
      connectedRef.current = false;
      setConnected(false);
      setAgentPresentState(false);
      if (action === "end") {
        // Deliberate end: no auto-retry to supersede-release, so free now.
        manualReconnectPendingRef.current = false;
        refreshBaselineCapacityRef.current = null;
        releaseRef.current("disconnected");
        setRecovery({ kind: "ended" });
        return;
      }
      refreshBaselineCapacityRef.current = null;
      setRecovery({ kind: "reconnecting", attempt: attemptRef.current });
    },
    [active, reset],
  );

  const onConnectionError = useCallback(
    (error: Error) => {
      if (!active || !isRecoverableConnectionError(error)) return;
      connectedRef.current = false;
      setConnected(false);
      setAgentPresentState(false);
      setRecovery((prev) => {
        // Native reconnect owns the current room until LiveKit emits a terminal
        // Disconnected event. Starting a grant refresh here would race it.
        if (prev.kind === "in-place-reconnecting") return prev;
        if (prev.kind === "reconnecting" || prev.kind === "failed" || prev.kind === "ended") return prev;
        refreshBaselineCapacityRef.current = null;
        return { kind: "reconnecting", attempt: attemptRef.current };
      });
    },
    [active],
  );

  // A manual/automatic refresh can fail before a Room exists, so there is no room
  // onError/onDisconnected callback to advance recovery. Wait until capacity has
  // changed from the dispatch baseline, then arm the next backoff exactly once.
  useEffect(() => {
    if (recovery.kind !== "refreshing" || capacity.kind !== "error") return;
    const baseline = refreshBaselineCapacityRef.current;
    if (baseline?.kind === "error" && baseline.error === capacity.error) return;
    refreshBaselineCapacityRef.current = null;
    setRecovery({ kind: "reconnecting", attempt: recovery.attempt });
  }, [capacity, recovery]);

  const onConnectionStateChange = useCallback(
    (state: LiveKitConnectionStatus) => {
      if (!active) return;
      if (state === "connected") {
        // An in-place reconnect healed (or the first connect landed). Treat the
        // same as onConnected: clear the banner, reset the budget.
        onConnected();
        return;
      }
      if (state === "reconnecting" || state === "signalReconnecting") {
        // LiveKit's IN-PLACE reconnect — make it visible without arming the fresh-
        // grant timer. Only flip if we were connected (don't clobber a first join).
        if (connectedRef.current) {
          setConnected(false);
          setRecovery((prev) =>
            prev.kind === "connected" ? { kind: "in-place-reconnecting" } : prev,
          );
        }
      }
      // "connecting" / "disconnected" are owned by onConnected/onDisconnected
      // (which carry the disconnect REASON the classifier needs).
    },
    [active, onConnected],
  );

  // Auto-reconnect for transient drops, with a capped backoff AND a bounded
  // give-up (both decided by the pure `retryStep`). Once the budget is spent we
  // transition to `failed`, free the held lease ONCE, and park on the manual tap.
  useEffect(() => {
    if (!active || !needsFreshGrant(recovery)) return;
    const step = retryStep(attemptRef.current, reconnectPolicyRef.current);
    if (step.kind === "give-up") {
      manualReconnectPendingRef.current = false;
      refreshBaselineCapacityRef.current = null;
      releaseRef.current("disconnected");
      setRecovery({ kind: "failed" });
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      attemptRef.current = step.attempt;
      setAttempt(step.attempt);
      refreshBaselineCapacityRef.current = capacityRef.current;
      // Mark the request in flight BEFORE dispatching it. This removes the old
      // bug where the same state immediately armed another timer after refresh.
      setRecovery({ kind: "refreshing", attempt: step.attempt });
      refreshRef.current();
    }, step.delayMs);
    return clearTimer;
    // `attempt` is in the deps so each scheduled attempt re-runs the effect and
    // the budget advances to the give-up branch instead of stalling after one try.
  }, [recovery.kind, active, attempt, clearTimer]);

  const reconnect = useCallback(() => {
    // Coalesce double taps and never let a manual refresh compete with LiveKit's
    // in-place reconnect. The gate re-opens on connect, terminal end, reset, or
    // bounded give-up.
    if (!active || manualReconnectPendingRef.current || recovery.kind === "in-place-reconnecting") return;
    manualReconnectPendingRef.current = true;
    clearTimer();
    attemptRef.current = 0;
    setAttempt(0);
    // One immediate refresh; it does not arm the backoff while in flight. A real
    // grant/room failure transitions `refreshing` → `reconnecting` and schedules
    // the next bounded attempt.
    refreshBaselineCapacityRef.current = capacityRef.current;
    setRecovery({ kind: "refreshing", attempt: 0 });
    refreshRef.current();
  }, [active, clearTimer, recovery.kind]);

  // The idle clock ticker: run a 1s interval ONLY while connected + agent present.
  // The interval bumps a tick so the phase re-derives `timeToDisconnectMs` / the
  // warn window from the activity ref AND so the idle-enforcement check below runs
  // each second. Latch the latest `endIdle` in a ref so the interval can call it
  // without re-subscribing (which would reset the clock on every render).
  const endIdleRef = useRef(endIdle);
  endIdleRef.current = endIdle;
  useEffect(() => {
    if (!connected || !agentPresent || idleTimeoutMs <= 0 || recovery.kind !== "connected") return;
    const timer = window.setInterval(() => {
      // CLIENT-ENFORCED idle end: when the budget is spent, END the session here
      // (there is no server reap). Checked on the same 1s tick that drives the
      // countdown so the visible "0s" and the actual end coincide.
      if (idleExpired({ connected: true, agentPresent: true, msSinceActivity: Date.now() - lastActivityRef.current, idleTimeoutMs })) {
        endIdleRef.current();
        return;
      }
      setClockTick((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [connected, agentPresent, idleTimeoutMs, recovery.kind]);

  // Time until the CLIENT-ENFORCED idle end, or null when there is no running clock.
  const timeToDisconnectMs =
    connected && agentPresent && idleTimeoutMs > 0 && recovery.kind === "connected"
      ? Math.max(0, idleTimeoutMs - (Date.now() - lastActivityRef.current))
      : null;

  const idle = useMemo<
    { kind: "inactive" } | { kind: "live" } | { kind: "idle-warning"; secondsRemaining: number; deadlineAt: number }
  >(() => {
    const base = idlePhaseFor({
      connected,
      agentPresent,
      msSinceActivity: Date.now() - lastActivityRef.current,
      idleTimeoutMs,
      warnAtMs,
    });
    if (base.kind === "idle-warning") {
      return { ...base, deadlineAt: lastActivityRef.current + idleTimeoutMs };
    }
    return base;
    // timeToDisconnectMs threads the 1s tick in so this recomputes each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, agentPresent, idleTimeoutMs, warnAtMs, timeToDisconnectMs]);

  const phase = useMemo(
    () => lifecyclePhaseFrom({ capacity, recovery, idle, connected, agentPresent }),
    [capacity, recovery, idle, connected, agentPresent],
  );

  // ── Opt-in behavior tap (multi-clip choreography) ──
  // Only when the adopter wires `onBehaviorChange` do we expose an `onLifecycleData` sink,
  // so the room bridge decodes `rta.lifecycle` frames and this hook derives the snapshot
  // through the SAME `nextBehaviorSnapshot` SSOT as useRealtimeSession. Absent the callback
  // the sink is `undefined`, so the bridge never subscribes (zero cost) and useRealtimeSession
  // — which owns its own richer `onLifecycleData` — is untouched. The callback is read via a
  // ref so the sink identity stays stable across renders (only its presence gates the tap).
  const onBehaviorChangeRef = useRef(onBehaviorChange);
  onBehaviorChangeRef.current = onBehaviorChange;
  const lastBehaviorRef = useRef<BehaviorSnapshot | null>(null);
  const behaviorEnabled = Boolean(onBehaviorChange);
  const onLifecycleData = useMemo<((frame: unknown) => void) | undefined>(() => {
    if (!behaviorEnabled) return undefined;
    return (frame: unknown) => {
      const parsed = lifecycleServerFrameSchema.safeParse(frame);
      if (!parsed.success || parsed.data.kind !== "behavior_state") return;
      const next = nextBehaviorSnapshot(lastBehaviorRef.current, parsed.data);
      if (!next) return;
      lastBehaviorRef.current = next;
      onBehaviorChangeRef.current?.(next);
    };
  }, [behaviorEnabled]);

  return useMemo<SessionLifecycleApi & Pick<RealtimeSessionRoomSinks, "onLifecycleData">>(
    () => ({
      phase,
      grant: grantState.grant,
      capacity,
      attempt,
      timeToDisconnectMs,
      stayConnected,
      markActivity,
      reconnect,
      onConnected,
      onDisconnected,
      onConnectionError,
      onConnectionStateChange,
      setAgentPresent,
      registerLeaveRoom,
      reset,
      onLifecycleData,
    }),
    [
      phase,
      grantState.grant,
      capacity,
      attempt,
      timeToDisconnectMs,
      stayConnected,
      markActivity,
      reconnect,
      onConnected,
      onDisconnected,
      onConnectionError,
      onConnectionStateChange,
      setAgentPresent,
      registerLeaveRoom,
      reset,
      onLifecycleData,
    ],
  );
}

// ---------------------------------------------------------------------------
// In-room bridge. The lifecycle hook runs ABOVE RealtimeAvatarLiveKitRoom (it
// owns the grant), but the idle clock needs facts that only exist INSIDE the
// room: the live connection state, the bound agent participant, and the
// room.disconnect handle. This bridge — rendered as a child of
// RealtimeAvatarLiveKitRoom — reads those from the room context and feeds them
// into the hook's sinks. Vendor-neutral plumbing only: no UI, no copy.
// ---------------------------------------------------------------------------

/**
 * The optional realtime-session sinks the bridge ALSO fills when given the richer
 * {@link RealtimeSessionApi} (vs a bare {@link SessionLifecycleApi}). All optional, so
 * mounting the bridge with either surface type-checks — the extra wiring is inert when
 * the sink is absent. This keeps ONE bridge for both `useSessionLifecycle` and
 * `useRealtimeSession`.
 */
export type RealtimeSessionRoomSinks = Partial<{
  /** Inbound `rta.lifecycle` data frames (DataReceived on the lifecycle topic). */
  onLifecycleData: (frame: unknown) => void;
  /** Publisher for client→worker frames (request_graceful_close / extend). */
  registerDataPublisher: (publish: ((frame: unknown) => void) | null) => void;
  /** The turn sender (`useChat().send`) used for closing + normal turns. */
  registerTurnSender: (send: ((text: string, opts?: SendTextOptions) => Promise<void>) | null) => void;
  /** Live assistant state → the `turn` micro-state. */
  setTurnState: (state: string | null | undefined) => void;
  /** Honest media liveness from the bound agent's tracks. */
  setMedia: (media: { video: "live" | "stalled" | "connecting"; audio: "flowing" | "silent" }) => void;
}>;

export type SessionLifecycleRoomBridgeProps = {
  lifecycle: Pick<
    SessionLifecycleApi,
    | "onConnectionStateChange"
    | "setAgentPresent"
    | "registerLeaveRoom"
    | "markActivity"
  > &
    RealtimeSessionRoomSinks;
};

/**
 * Wire the in-room LiveKit facts into a {@link useSessionLifecycle} instance:
 * - `useConnectionState()` → `onConnectionStateChange` (in-place reconnect).
 * - `useVoiceAssistant().agent` presence → `setAgentPresent` (idle clock gate).
 * - `useVoiceAssistant().state` + `useTranscriptions()` → `markActivity` (the
 *   IDLE×CALL fix: a voice call has no per-turn text send to reset the client idle
 *   clock, so without this an ACTIVE call is falsely reaped at the 120s client idle
 *   end. We reset on REAL activity only — the agent actively producing
 *   (`speaking`/`thinking`) or a fresh user transcript (the user spoke) — NOT on the
 *   resting `listening` state, so a genuinely SILENT call still reaps as intended.
 *   On the text path the per-turn send already marks activity; this is harmless +
 *   redundant there, and load-bearing on the call path — one DRY signal for both).
 * - `room.disconnect()` → `registerLeaveRoom` (so the CLIENT-AUTHORITATIVE idle end
 *   actually LEAVES the room → `the worker's disconnect release` frees the GPU).
 *
 * Renders nothing. Mount it once inside RealtimeAvatarLiveKitRoom.
 */
export function SessionLifecycleRoomBridge({ lifecycle }: SessionLifecycleRoomBridgeProps): null {
  const {
    onConnectionStateChange,
    setAgentPresent,
    registerLeaveRoom,
    markActivity,
    onLifecycleData,
    registerDataPublisher,
    registerTurnSender,
    setTurnState,
    setMedia,
  } = lifecycle;
  const connectionState = useConnectionState();
  const assistant = useVoiceAssistant();
  const transcriptions = useTranscriptions();
  const room = useRoomContext();
  const { send } = useChat();
  const agentPresent = Boolean(assistant.agent);
  const assistantState = assistant.state;
  const videoLive = Boolean(assistant.videoTrack);
  const audioLive = Boolean(assistant.audioTrack);
  const transcriptionCount = transcriptions.length;
  // Track the last-seen transcript count so only GROWTH (a NEW segment = someone
  // spoke) counts as activity — a stable transcript array must not keep resetting
  // the clock forever (that would defeat the silent-call reap).
  const prevTranscriptionCountRef = useRef(0);

  useEffect(() => {
    onConnectionStateChange(connectionState);
  }, [connectionState, onConnectionStateChange]);

  useEffect(() => {
    setAgentPresent(agentPresent);
  }, [agentPresent, setAgentPresent]);

  // IDLE×CALL reset (the P0): a voice call has no per-turn text send, so feed the
  // client idle clock from the in-room voice signal — the agent actively producing
  // (speaking/thinking) OR a fresh transcript segment (someone spoke). The pure
  // `isCallActivity` excludes the resting `listening` state so a SILENT call still
  // reaps. One DRY signal for text + call.
  useEffect(() => {
    const active = isCallActivity({
      assistantState,
      transcriptionCount,
      prevTranscriptionCount: prevTranscriptionCountRef.current,
    });
    prevTranscriptionCountRef.current = transcriptionCount;
    if (active) markActivity();
  }, [assistantState, transcriptionCount, markActivity]);

  useEffect(() => {
    // The room-leave handle: disconnect the LiveKit room so the worker's
    // the worker's disconnect release ends its session + frees the GPU. Fire-and-forget;
    // swallow errors (a leave must never throw out of the idle-enforcement path).
    const leave = (): void => {
      void Promise.resolve(room.disconnect()).catch(() => undefined);
    };
    registerLeaveRoom(leave);
    return () => registerLeaveRoom(null);
  }, [room, registerLeaveRoom]);

  // ── realtime-session extras (inert under a bare useSessionLifecycle) ──

  // Inbound rta.lifecycle frames: decode RoomEvent.DataReceived on the lifecycle
  // topic and hand the raw JSON up (the hook validates it against the contract).
  useEffect(() => {
    if (!onLifecycleData) return;
    const decoder = new TextDecoder();
    const handler = (
      payload: Uint8Array,
      _participant?: unknown,
      _kind?: unknown,
      topic?: string,
    ): void => {
      if (topic !== RTA_LIFECYCLE_TOPIC) return;
      try {
        onLifecycleData(JSON.parse(decoder.decode(payload)));
      } catch {
        /* malformed frame — ignore (telemetry must never throw) */
      }
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => {
      room.off(RoomEvent.DataReceived, handler);
    };
  }, [room, onLifecycleData]);

  // Outbound client→worker frames (request_graceful_close / extend) over the same
  // reliable lifecycle topic.
  useEffect(() => {
    if (!registerDataPublisher) return;
    const encoder = new TextEncoder();
    const publish = (frame: unknown): void => {
      try {
        void room.localParticipant
          ?.publishData(encoder.encode(JSON.stringify(frame)), { reliable: true, topic: RTA_LIFECYCLE_TOPIC })
          .catch(() => undefined);
      } catch {
        /* not connected yet — ignore */
      }
    };
    registerDataPublisher(publish);
    return () => registerDataPublisher(null);
  }, [room, registerDataPublisher]);

  // The turn sender (the SDK owns the closing-turn transport so the app needn't wire
  // it): wrap useChat().send to the (text, opts) → Promise<void> sink shape.
  useEffect(() => {
    if (!registerTurnSender) return;
    const sender = (text: string, opts?: SendTextOptions): Promise<void> =>
      Promise.resolve(send(text, opts)).then(() => undefined);
    registerTurnSender(sender);
    return () => registerTurnSender(null);
  }, [send, registerTurnSender]);

  // Live turn micro-state + honest media liveness from the bound agent's tracks.
  useEffect(() => {
    setTurnState?.(assistantState);
  }, [assistantState, setTurnState]);
  useEffect(() => {
    setMedia?.({ video: videoLive ? "live" : "connecting", audio: audioLive ? "flowing" : "silent" });
  }, [videoLive, audioLive, setMedia]);

  return null;
}
