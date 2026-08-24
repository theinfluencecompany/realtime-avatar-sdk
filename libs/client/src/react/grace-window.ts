// ---------------------------------------------------------------------------
// grace-window — the PURE core of the graceful-end mechanism (ZERO React, ZERO
// vendor imports). Table-tested exactly like the pure classifiers in
// session-lifecycle.ts. The hook (use-realtime-session.ts) wires these onto the
// existing 1s lifecycle tick + the inbound `rta.lifecycle` frames.
//
// The crux primitive is the GRACE WINDOW: when the SERVER cap is near, the client
// gets a bounded window to send ONE closing turn, and the SDK + worker jointly
// guarantee it is spoken before the hard close. The three clocks
// (session/idle/credit) and the approaching-end/credits-low edge detectors live
// here too so the whole time/budget surface is unit-testable without a DOM.
// ---------------------------------------------------------------------------

import type {
  ApproachingEndReason,
  SessionEndReasonLabel,
} from "realtime-avatar-contracts";
import type { SessionEndReason } from "./session-lifecycle";

export type { ApproachingEndReason } from "realtime-avatar-contracts";

/**
 * The terminal, LABELED end reason surfaced to the app via `onEnded`. This is the
 * contracts {@link SessionEndReasonLabel} (a superset of the client-internal
 * {@link SessionEndReason}) — the worker stamps the precise label on its `ended`
 * frame; {@link resolveEndReason} falls back to mapping the internal reason when no
 * frame arrived (an old worker), so the app always gets a usable reason.
 */
export type EndReason = SessionEndReasonLabel;

/**
 * The three DISTINCT session clocks — never conflated, each with its own authority:
 * - `sessionRemainingMs`: to the hard cap. SERVER-MIRRORED off the worker
 *   `session_clock` frame (a client-only timer drifts across the cold-start gap and
 *   would cut the goodbye mid-syllable). `null` until the frame lands ("unknown").
 * - `idleRemainingMs`: to the CLIENT-AUTHORITATIVE idle end (alias of the lifecycle
 *   `timeToDisconnectMs`; the SDK enforces this one).
 * - `creditRemainingMs`: an app-supplied passthrough — the SDK never fetches or
 *   decides billing, it only surfaces the balance + fires `onCreditsLow`.
 */
export type SessionClocks = {
  sessionRemainingMs: number | null;
  idleRemainingMs: number | null;
  creditRemainingMs: number | null;
};

/**
 * The grace-window state machine. Drives the guaranteed closing line:
 * - `closed`: no end imminent.
 * - `open`: the SOFT end is reached — send the ONE closing turn NOW. `deadlineAt`
 *   is the hard cap (`endsAt`); past it an unused window is `spent{false}`.
 * - `delivering`: the closing turn is in flight / being spoken. `deadlineAt` is the
 *   worker's hard ceiling (`endsAt + graceCeilingMs`); past it → `spent{false}`.
 * - `spent`: terminal — `delivered:true` on the worker `closing_turn_done` frame,
 *   `delivered:false` if a deadline passed first (the line was cut / never sent).
 */
export type GraceWindowState =
  | { kind: "closed" }
  | { kind: "open"; reason: ApproachingEndReason; deadlineAt: number; msLeft: number }
  | { kind: "delivering"; turnId: string; deadlineAt: number }
  | { kind: "spent"; delivered: boolean };

/** The live turn micro-state, mapped from `useVoiceAssistant().state`. */
export type TurnState = "listening" | "thinking" | "speaking" | "quiet";

/**
 * Map the LiveKit voice-assistant state onto the 4-value turn micro-state. Only the
 * three "doing something" states pass through; everything else
 * (`initializing`/`connecting`/`disconnected`/`idle`/unknown) reads as `quiet`.
 */
export function mapTurnState(assistantState: string | null | undefined): TurnState {
  switch (assistantState) {
    case "listening":
    case "thinking":
    case "speaking":
      return assistantState;
    default:
      return "quiet";
  }
}

/**
 * Wall-clock cap deadline, or null when the `session_clock` frame hasn't arrived.
 * `endsAt = started_at_unix_ms + max_session_seconds*1000`. A reconnect re-publishes
 * the SAME `started_at_unix_ms`, so the cap never resets under a blip.
 */
export function endsAtFrom(args: {
  serverStartedAtUnixMs: number | null;
  maxSessionSeconds: number | null;
}): number | null {
  const { serverStartedAtUnixMs, maxSessionSeconds } = args;
  if (serverStartedAtUnixMs == null || !maxSessionSeconds) return null;
  return serverStartedAtUnixMs + maxSessionSeconds * 1000;
}

/**
 * ms until the hard cap, server-mirrored. `null` (honest "unknown") until the
 * `session_clock` frame lands; clamped at 0 once the cap passes.
 */
export function sessionRemainingMsFrom(args: {
  serverStartedAtUnixMs: number | null;
  maxSessionSeconds: number | null;
  nowUnixMs: number;
}): number | null {
  const endsAt = endsAtFrom(args);
  if (endsAt == null) return null;
  return Math.max(0, endsAt - args.nowUnixMs);
}

/**
 * Edge-detect the `onApproachingEnd` moment (cap): fires ONCE when the mirrored cap
 * clock first falls at/under the lead (and is still > 0). `alreadyFired` is held by
 * the hook so the moment is a single event, not a per-tick storm. Returns the event
 * payload to fire, or null. Idle's approaching-end is a SEPARATE path (the existing
 * `idle-warning` phase → `onIdleWarning`), so this is cap-only.
 */
export function approachingEndFrom(args: {
  sessionRemainingMs: number | null;
  approachingEndLeadMs: number;
  alreadyFired: boolean;
}): { secondsLeft: number } | null {
  const { sessionRemainingMs, approachingEndLeadMs, alreadyFired } = args;
  if (alreadyFired || sessionRemainingMs == null) return null;
  if (sessionRemainingMs <= approachingEndLeadMs && sessionRemainingMs > 0) {
    return { secondsLeft: Math.ceil(sessionRemainingMs / 1000) };
  }
  return null;
}

/**
 * Edge-detect the `onCreditsLow` moment off the app-supplied credit clock. Same
 * once-only shape as {@link approachingEndFrom}. The SDK never decides billing — it
 * surfaces the balance the app passed and fires this single moment.
 */
export function creditsLowFrom(args: {
  creditRemainingMs: number | null;
  creditsLowLeadMs: number;
  alreadyFired: boolean;
}): { secondsLeft: number } | null {
  const { creditRemainingMs, creditsLowLeadMs, alreadyFired } = args;
  if (alreadyFired || creditRemainingMs == null) return null;
  if (creditRemainingMs <= creditsLowLeadMs && creditRemainingMs > 0) {
    return { secondsLeft: Math.ceil(creditRemainingMs / 1000) };
  }
  return null;
}

/**
 * The grace-window reducer for the TIME-driven transitions (run on the 1s tick):
 * - `closed → open` when the mirrored clock crosses the lead OR the worker `ending`
 *   frame arrives — **the worker frame WINS** (`workerEnding`) so cold-start drift
 *   between the client mirror and the authoritative cap can never miss the window.
 * - `open → spent{false}` once the send deadline (`endsAt`) passes unused.
 * - `delivering → spent{false}` once the hard ceiling (`deadlineAt`) passes (the
 *   worker cut a runaway closing turn).
 * - `open`'s `msLeft` is refreshed each tick; `spent` is terminal.
 *
 * The ACTION-driven transitions (`open → delivering` on `sendClosingTurn`,
 * `delivering → spent{true}` on the `closing_turn_done` frame) are applied by the
 * hook, not here — this reducer only advances time + honors the worker signal.
 */
export function nextGraceWindow(args: {
  prev: GraceWindowState;
  sessionRemainingMs: number | null;
  graceWindowLeadMs: number;
  endsAt: number | null;
  workerEnding: boolean;
  nowMs: number;
}): GraceWindowState {
  const { prev, sessionRemainingMs, graceWindowLeadMs, endsAt, workerEnding, nowMs } = args;

  switch (prev.kind) {
    case "spent":
      return prev; // terminal
    case "closed": {
      const clockCrossed =
        sessionRemainingMs != null &&
        sessionRemainingMs <= graceWindowLeadMs &&
        sessionRemainingMs > 0;
      if ((workerEnding || clockCrossed) && endsAt != null) {
        return { kind: "open", reason: "session_cap", deadlineAt: endsAt, msLeft: Math.max(0, endsAt - nowMs) };
      }
      return prev;
    }
    case "open":
      if (nowMs >= prev.deadlineAt) return { kind: "spent", delivered: false };
      return { ...prev, msLeft: Math.max(0, prev.deadlineAt - nowMs) };
    case "delivering":
      if (nowMs >= prev.deadlineAt) return { kind: "spent", delivered: false };
      return prev;
  }
}

/**
 * Resolve the LABELED terminal reason for `onEnded`. The worker's `ended` frame
 * (`workerLabel`) always wins; absent it (an old worker, or a transport drop before
 * the frame), fall back to mapping the client-internal {@link SessionEndReason}:
 * `idle → idle`, `error → failed`, everything else (incl. `disconnected`/undefined)
 * → `disconnected`. So the app NEVER sees a bare LiveKit DisconnectReason.
 */
export function resolveEndReason(
  workerLabel: SessionEndReasonLabel | null,
  innerReason: SessionEndReason | undefined,
): EndReason {
  if (workerLabel) return workerLabel;
  switch (innerReason) {
    case "idle":
      return "idle";
    case "error":
      return "failed";
    default:
      return "disconnected";
  }
}
