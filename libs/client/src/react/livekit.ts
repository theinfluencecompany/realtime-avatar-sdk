import {
  AudioTrack,
  ConnectionState,
  ConnectionStateToast,
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  VideoTrack,
  useChat,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useStartAudio,
  useTrackToggle,
  useTranscriptions,
  useVoiceAssistant,
  type LiveKitRoomProps,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { DisconnectReason, RemoteTrack, Room, Track } from "livekit-client";
import { confirmMicTrackEnded } from "./mic-single-flight";
import { RealtimeAvatarCapacityError } from "../errors";
import type { RealtimeAvatarClient, RealtimeAvatarRequestOptions } from "../client";
import type { LiveKitSessionGrant, LiveKitSessionRequest } from "../livekit-grant";
import type {
  CapacityBusyResponse,
  LiveKitSessionReleaseReason,
  LLMProvider,
} from "realtime-avatar-contracts";
export type { SendTextOptions } from "livekit-client";
// Raw transport primitives, surfaced through the SDK so adopters (e.g. the admin
// Benchmark console that joins N rooms imperatively to measure fps) never take a
// second, drifting dependency on livekit-client — this SDK already owns its version.
export { Room, RoomEvent } from "livekit-client";
export type { RemoteTrack, RemoteAudioTrack, RemoteVideoTrack } from "livekit-client";
// Re-export the LiveKit disconnect reason enum so adopters classify a room
// disconnect (max-duration end vs. network drop vs. agent gone) against the
// SDK's own type — no reinvented disconnect taxonomy. `Track` is re-exported so
// adopters can name track sources (e.g. Track.Source.Microphone for
// useTrackToggle) without a direct livekit-client dependency.
export { DisconnectReason, Track };

export {
  AudioTrack,
  ConnectionState,
  ConnectionStateToast,
  LiveKitRoom,
  RoomAudioRenderer,
  // Native LiveKit primitives for the canonical voice-call wiring: StartAudio
  // unblocks remote audio playback under the browser autoplay policy (replaces a
  // hand-rolled room.startAudio() retry), and TrackToggle/useTrackToggle is the
  // single source of truth for publishing + muting the local mic (replaces a
  // hand-rolled setMicrophoneEnabled effect that raced on reconnect).
  StartAudio,
  TrackToggle,
  VideoTrack,
  useChat,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useStartAudio,
  useTrackToggle,
  useTranscriptions,
  useVoiceAssistant,
};

/**
 * One room transcription entry as surfaced by {@link useTranscriptions} — a LiveKit `TextStreamData`
 * carrying the spoken `text` plus `participantInfo.identity` (WHO spoke) and `streamInfo`.
 */
export type CallTranscriptSegment = ReturnType<typeof useTranscriptions>[number];

/**
 * A live call's transcript, split by who spoke — so BOTH sides are first-class, not just the agent's.
 * See {@link useCallTranscript}.
 */
export type CallTranscript = {
  /**
   * The USER's spoken lines (their server-STT). Already on the wire — the worker's room input path
   * publishes user input transcriptions to the room, attributed to the user participant — but
   * previously only reachable by hand-filtering {@link useTranscriptions}. Empty until the user speaks.
   */
  user: CallTranscriptSegment[];
  /** The AGENT/character's spoken lines (every room transcription that isn't the local user's). */
  agent: CallTranscriptSegment[];
};

/**
 * Split room transcription entries into the user's vs the agent's, by participant identity.
 *
 * In an avatar call the browser user is the LOCAL participant and the character is a remote (agent)
 * participant, so a segment authored by the local identity is the user's and everything else is the
 * agent's. Splitting on the identity carried by each `TextStreamData` is exact (no id-scheme or
 * ordering heuristic). When the local identity isn't known yet (pre-connect) nothing is attributed to
 * the user — safer than a false positive. Pure + exported so it's unit-testable without a live room.
 */
export function splitCallTranscript(
  all: CallTranscriptSegment[],
  localIdentity: string | null | undefined,
): CallTranscript {
  if (!localIdentity) return { user: [], agent: all };
  const user: CallTranscriptSegment[] = [];
  const agent: CallTranscriptSegment[] = [];
  for (const segment of all) {
    if (segment.participantInfo.identity === localIdentity) user.push(segment);
    else agent.push(segment);
  }
  return { user, agent };
}

/**
 * The live call transcript, split into the user's and the agent's spoken lines.
 *
 * The user's side was always published to the room by the worker, but only the agent's was
 * conveniently exposed (via {@link useVoiceAssistant}); this surfaces BOTH so adopters can build a
 * two-sided call recap / caption history. Both arrays are empty before anyone speaks. Must be called
 * inside a LiveKit room context (e.g. under {@link RealtimeAvatarLiveKitRoom}).
 */
export function useCallTranscript(): CallTranscript {
  const all = useTranscriptions();
  const { localParticipant } = useLocalParticipant();
  return splitCallTranscript(all, localParticipant?.identity);
}

/**
 * In-room companion to {@link useMicLease}: fires the lease's PRECISE release the
 * moment this call's local microphone MediaStreamTrack actually reaches `ended`
 * (the true hardware-release signal) — not merely on React unmount. Pass the
 * `token` returned by `useMicLease`.
 *
 * Why it exists: `Room.disconnect()` stops the local track on a NON-awaited path
 * (livekit-client 2.19.2), so after a call's React teardown the browser keeps the
 * capture device for a beat. Handing the tab-global mic lease to the next call at
 * unmount can therefore let a rapid redial's getUserMedia collide with the still-
 * closing device. This hook holds the lease across that gap and releases it on the
 * track's own `ended` event; `useMicLease` carries a timeout backstop so a track
 * that never emits `ended` can't wedge the lease. MUST be rendered inside the room
 * (needs `useLocalParticipant`), e.g. under {@link RealtimeAvatarLiveKitRoom}.
 */
export function useReleaseMicLeaseOnTrackEnded(token: symbol): void {
  const { localParticipant } = useLocalParticipant();
  useEffect(() => {
    if (!localParticipant) return;
    const cleanups: Array<() => void> = [];
    // Attach to the raw MediaStreamTrack `ended` of every local audio publication —
    // that is the signal the OS mic actually closed. `microphoneTrack` covers the
    // live one; iterating audio publications also catches a republished track.
    const watch = (raw: MediaStreamTrack | undefined | null): void => {
      if (!raw) return;
      // Already ended by the time we observed it (a fast stop) → confirm immediately.
      if (raw.readyState === "ended") {
        confirmMicTrackEnded(token);
        return;
      }
      const onEnded = (): void => confirmMicTrackEnded(token);
      raw.addEventListener("ended", onEnded);
      cleanups.push(() => raw.removeEventListener("ended", onEnded));
    };
    for (const pub of localParticipant.audioTrackPublications.values()) {
      watch(pub.track?.mediaStreamTrack);
    }
    return () => {
      for (const c of cleanups) c();
    };
    // Re-subscribe when the participant or its set of audio publications changes
    // (a text→speak re-publish mints a new MediaStreamTrack to watch).
  }, [localParticipant, token, localParticipant?.audioTrackPublications.size]);
}

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
 * 0.5s is applied via the native {@link RemoteTrack.setPlayoutDelay}, which sets
 * the receiver's `playoutDelayHint` — the same Chromium jitter-buffer knob the
 * old hand-rolled `jitterBufferTarget` reached into (the spec renamed
 * playoutDelayHint→jitterBufferTarget; both influence the same buffer depth),
 * but typed and SDK-owned so there is no cast or feature-probe. The hint is NOT
 * free at the open: the receiver holds the FIRST video frame toward the target
 * (~250-450ms of measured TTFF), a deliberate cost paid once for the freeze-free
 * steady state above. The open-small-then-ramp variant that tried to dodge that
 * cost was shipped, failed twice (the rVFC ramp trigger is throttled on the
 * opacity:0-mounted element, stranding the shallow buffer), and was deliberately
 * removed in 2262e4c7b — do not re-propose it. No-op on browsers that don't
 * support the hint (the SDK warns and moves on).
 */
export const DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS = 0.5;

/**
 * Sets the avatar AUDIO and VIDEO tracks' native playout delay so the stream has
 * a real de-jitter / loss-recovery cushion for smooth, freeze-free playback.
 *
 * Both tracks are kept at the SAME delay so the two streams stay lip-synced
 * (WebRTC syncs the pair to the LARGER of the two receivers' hints; an unequal
 * video-only buffer would make the lips lag the audio). Pass the `videoTrack`
 * and `audioTrack` from {@link useVoiceAssistant}. A `RemoteTrack` is required —
 * placeholders/local tracks lack `setPlayoutDelay` and are skipped.
 */
export function useAvatarPlayoutDelay(
  videoTrack: TrackReferenceOrPlaceholder | undefined,
  audioTrack: TrackReferenceOrPlaceholder | undefined,
  delaySeconds: number = DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS,
): void {
  const videoMediaTrack = videoTrack?.publication?.track;
  const audioMediaTrack = audioTrack?.publication?.track;
  useEffect(() => {
    applyAvatarPlayoutDelay(videoMediaTrack, audioMediaTrack, delaySeconds);
  }, [videoMediaTrack, audioMediaTrack, delaySeconds]);
}

/** A track that can take a native playout-delay hint (a subscribed RemoteTrack). */
type PlayoutDelayTarget = Pick<RemoteTrack, "setPlayoutDelay">;

/**
 * Apply the SAME native playout delay to the avatar's audio + video tracks
 * (kept equal so the a/v sync stays lip-locked). The delay is floored at 0 so a
 * negative input can never throw, and only subscribed `RemoteTrack`s take the
 * hint — placeholders / not-yet-subscribed tracks are skipped. Pure + exported
 * so the clamp and the both-tracks-equal invariant are unit-testable without a
 * DOM (the hook is a thin effect wrapper around this).
 */
export function applyAvatarPlayoutDelay(
  videoTrack: unknown,
  audioTrack: unknown,
  delaySeconds: number = DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS,
): void {
  const delay = Math.max(0, delaySeconds);
  playoutDelayTarget(videoTrack)?.setPlayoutDelay(delay);
  playoutDelayTarget(audioTrack)?.setPlayoutDelay(delay);
}

/**
 * Narrow an unknown track to one that accepts a playout-delay hint. Duck-typed
 * on the `setPlayoutDelay` method rather than `instanceof RemoteTrack`: a
 * placeholder/local track lacks the method (skipped), and it keeps the apply
 * helper unit-testable with a plain fake.
 */
function playoutDelayTarget(track: unknown): PlayoutDelayTarget | undefined {
  const candidate = track as { setPlayoutDelay?: unknown } | null | undefined;
  return typeof candidate?.setPlayoutDelay === "function"
    ? (candidate as PlayoutDelayTarget)
    : undefined;
}

export type LiveKitAvatarGrantStatus = "idle" | "requesting" | "ready" | "busy" | "failed";
export type LiveKitConnectionStatus = ReturnType<typeof useConnectionState>;

/**
 * A clean, adopter-facing discriminated capacity signal derived from the raw
 * grant {@link LiveKitAvatarGrantStatus}. The point is that a transient capacity
 * wait ("all GPU slots busy, queued behind N others, auto-retrying") is NOT an
 * error — it is a normal, self-healing waiting state. Only a genuinely failed
 * grant maps to `error`. Adopters should render `queued`/`connecting` calmly
 * (spinner + queue position) and reserve error UI for the `error` variant.
 *
 * - `idle`      — no active session requested.
 * - `connecting`— a grant fetch is in flight (no prior queue placement).
 * - `queued`    — all slots are busy; the client holds a queue ticket and is
 *                 auto-retrying. Carries the raw {@link CapacityBusyResponse}
 *                 (queue position/size, recommended retry delay). NOT an error.
 * - `active`    — a grant is held; the room can connect.
 * - `error`     — the grant request genuinely failed (not capacity-related).
 */
export type LiveKitCapacityState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "queued"; busy: CapacityBusyResponse }
  | { kind: "active"; grant: LiveKitSessionGrant }
  | { kind: "error"; error: Error };

export type LiveKitAvatarGrantState = {
  status: LiveKitAvatarGrantStatus;
  grant: LiveKitSessionGrant | null;
  busy: CapacityBusyResponse | null;
  error: Error | null;
  /**
   * Discriminated capacity signal — prefer this over `status` in UI: it
   * separates a normal capacity wait (`queued`) from a real failure (`error`).
   */
  capacity: LiveKitCapacityState;
  refresh: () => void;
  clear: () => void;
  /**
   * Eagerly release the CURRENTLY-HELD session's capacity lease (best-effort,
   * fire-and-forget). Wire this to the LiveKit room's terminal `Disconnected`
   * event so a session that ends for good frees its GPU slot immediately instead
   * of lingering until the worker reconcile. A no-op when no grant is held.
   * Releasing on a supersede (reconnect) and on unmount/tab-close is automatic.
   */
  release: (reason?: LiveKitSessionReleaseReason) => void;
};

/**
 * What a release should free, given the two things this hook can hold. A request
 * holds AT MOST one at a time: a landed grant (`heldSessionId`) OR a still-queued
 * ticket (`queueTicketId`, no session yet). The session takes priority (a grant
 * landing clears the ticket ref) but the QUEUE-TICKET branch is the crux of the
 * infinite-queue-growth fix: a queued request has no session, so release-by-
 * sessionId is a NO-OP and the orphaned ticket lingered for its TTL, sat at the
 * front of strict-FIFO, and starved the free slots. Pure + exported so the
 * supersede/unmount/pagehide release decision is unit-testable without a DOM.
 */
export type ReleaseTarget =
  | { kind: "none" }
  | { kind: "session"; sessionId: string }
  | { kind: "ticket"; queueTicketId: string };

export function resolveReleaseTarget(
  heldSessionId: string | null,
  queueTicketId: string | null,
): ReleaseTarget {
  if (heldSessionId) return { kind: "session", sessionId: heldSessionId };
  if (queueTicketId) return { kind: "ticket", queueTicketId };
  return { kind: "none" };
}

/** Maps the raw grant status into the adopter-facing discriminated capacity signal. */
export function capacityStateFromGrant(
  state: Pick<LiveKitAvatarGrantState, "status" | "grant" | "busy" | "error">,
): LiveKitCapacityState {
  switch (state.status) {
    case "busy":
      if (state.busy) return { kind: "queued", busy: state.busy };
      // A busy status with no payload is degenerate; treat it as connecting
      // (about to auto-retry) rather than inventing an error.
      return { kind: "connecting" };
    case "failed":
      return { kind: "error", error: state.error ?? new Error("Realtime session request failed") };
    case "ready":
      return state.grant ? { kind: "active", grant: state.grant } : { kind: "connecting" };
    case "requesting":
      return { kind: "connecting" };
    case "idle":
    default:
      return { kind: "idle" };
  }
}

export type UseLiveKitAvatarGrantInput<
  TLlmProvider extends LLMProvider = LLMProvider,
> = {
  client: RealtimeAvatarClient<TLlmProvider>;
  session: LiveKitSessionRequest<TLlmProvider> | null | undefined;
  active?: boolean;
  autoRetryBusy?: boolean;
  requestOptions?: RealtimeAvatarRequestOptions;
  /**
   * Optional LiveKit host URL (`wss://…`) to pre-warm (DNS + TCP + TLS) while
   * the grant POST is in flight — the only way to cover a browser's FIRST-ever
   * call, before any landed grant has persisted a host hint. ADVISORY ONLY:
   * the room always connects to the freshly-granted `livekit_url`, never this
   * value, so a wrong hint costs one wasted HEAD request and nothing else.
   */
  serverUrlHint?: string;
};

// A STABLE per-browser id, shared across every tab via localStorage. Sent as the
// queue ticket key so N tabs of one browser dedupe to ONE queue slot: the
// platform keys a ticket by the client-supplied id, so the same id from every
// tab/retry/avatar-switch maps to the same place in line (the queue counts
// distinct browsers, not tabs or requests). Degrades gracefully to a per-runtime
// random id where localStorage is unavailable (SSR / privacy mode) — never throws.
let cachedClientId: string | null = null;
function randomClientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
function stableClientId(): string {
  if (cachedClientId) return cachedClientId;
  try {
    const key = "rta.client_id";
    const existing = globalThis.localStorage?.getItem(key) ?? null;
    if (existing) return (cachedClientId = existing);
    const fresh = randomClientId();
    globalThis.localStorage?.setItem(key, fresh);
    return (cachedClientId = fresh);
  } catch {
    return (cachedClientId = randomClientId());
  }
}

// Pre-grant connection warm. The grant POST spends hundreds of ms in flight
// before the room learns its livekit_url; a TOKEN-LESS Room.prepareConnection
// reduces to a bare HEAD fetch whose artifact is BROWSER network-stack state
// (DNS cache + TCP + TLS session for the host) — Room-instance-independent, so
// it shaves 1-3 RTTs off the later wss signal handshake to the SAME primary
// host a fresh room dials first (regionUrl is undefined pre-connect). It must
// STAY token-less: a token routes prepareConnection into the cloud region
// branch, which 401s pre-grant and skips the HEAD entirely — strictly worse.

/**
 * One-shot per-URL warm latch. The grant fetch effect re-runs every ~750ms
 * while queued (version bumps) and again on avatar switches — without the
 * latch each re-run would HEAD-spam LiveKit Cloud. Only ws(s)/http(s) URLs
 * pass: the hint may come from localStorage, and a corrupted value must never
 * reach the network. `prepare` is injected so the latch + validation are
 * unit-testable without constructing a Room.
 */
export function createConnectionWarmer(
  prepare: (url: string) => void,
): (url: string | null | undefined) => void {
  const warmed = new Set<string>();
  return (url) => {
    const valid = validWarmUrl(url);
    if (!valid || warmed.has(valid)) return;
    warmed.add(valid);
    prepare(valid);
  };
}

/** Accepts only ws(s)/http(s) URLs — anything else (corrupt storage) is dropped. */
function validWarmUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "wss:" || protocol === "ws:" || protocol === "https:" || protocol === "http:"
      ? value
      : null;
  } catch {
    return null;
  }
}

// ONE lazily-created Room shared by every warm, constructed strictly inside
// the (browser-only) fetch effect — `new Room()` touches navigator paths, so
// it must never run at module scope (this SDK is SSR-imported). It is never
// connect()ed and NEVER passed to LiveKitRoom as a `room` prop: useLiveKitRoom
// IGNORES `options` for a passed room, which would silently drop the
// adaptiveStream/dynacast hard-defaults (the single-layer freeze defense in
// {@link RealtimeAvatarLiveKitRoom}). prepareConnection swallows every failure
// internally (CSP/CORS/dead host → one logger warn), so fire-and-forget is
// safe. Pinned livekit-client 2.19.2: on any bump, re-verify the token-less
// path still performs the HEAD and still swallows all errors.
let warmRoom: Room | null = null;
const warmLiveKitHost = createConnectionWarmer((url) => {
  try {
    warmRoom ??= new Room();
    void warmRoom.prepareConnection(url);
  } catch {
    // The warm is ADVISORY — a runtime whose WebRTC globals aren't installed yet
    // (React Native before registerGlobals()) must never break the grant path.
  }
});

// Last-seen granted LiveKit host, persisted so a REPEAT visit can warm before
// its first grant lands (a first-ever visit stays unwarmed by design —
// `serverUrlHint` is the only cover). Same degrade-gracefully shape as
// {@link stableClientId}: namespaced key, try/catch around every access,
// in-memory module fallback where localStorage is unavailable (SSR / privacy
// mode; Safari private mode throws on setItem) — never throws. ADVISORY ONLY —
// no connect-path code reads it — so staleness self-heals: a rotated host
// costs one wasted HEAD and is overwritten as soon as the next grant lands.
const LIVEKIT_URL_HINT_KEY = "rta.livekit_url_hint";
let cachedUrlHint: string | null = null;
export function readLiveKitUrlHint(): string | null {
  try {
    return validWarmUrl(globalThis.localStorage?.getItem(LIVEKIT_URL_HINT_KEY)) ?? cachedUrlHint;
  } catch {
    return cachedUrlHint;
  }
}
export function writeLiveKitUrlHint(url: string): void {
  if (!validWarmUrl(url)) return;
  cachedUrlHint = url;
  try {
    globalThis.localStorage?.setItem(LIVEKIT_URL_HINT_KEY, url);
  } catch {
    // Best-effort — the module fallback still covers this page-load.
  }
}

/**
 * Requests a Realtime Avatar LiveKit grant, then lets LiveKit's own React
 * components own the room connection, tracks, agent state, and media controls.
 */
export function useLiveKitAvatarGrant<
  TLlmProvider extends LLMProvider = LLMProvider,
>(input: UseLiveKitAvatarGrantInput<TLlmProvider>): LiveKitAvatarGrantState {
  const { client, session, active = true, autoRetryBusy = false, requestOptions, serverUrlHint } = input;
  const [version, setVersion] = useState(0);
  const queueTicketRef = useRef<string | null>(null);
  // Stable per-browser id, used as the DEFAULT queue ticket key so every tab of
  // this browser dedupes to ONE queue slot (see {@link stableClientId}).
  const clientIdRef = useRef(stableClientId());
  // The session_id of the grant we currently HOLD a capacity lease for. Every
  // held lease must be released exactly once — when a fresh grant supersedes it,
  // when the room disconnects for good, or when the UI tears down / the tab
  // closes — or it leaks (holds a GPU slot, grows the queue) until its TTL. A
  // ref (not state) so releasing never triggers a render and the latest value is
  // visible to the pagehide listener and cleanup without re-subscribing.
  const heldSessionRef = useRef<string | null>(null);
  // Release whatever capacity this hook is holding (best-effort, fire-and-forget)
  // and forget it, so a supersede + a disconnect + a pagehide free it once. The
  // WHAT-to-release decision is the pure {@link resolveReleaseTarget} (a session
  // lease frees by session id; a queued ticket frees by ticket id) so it is
  // unit-testable; this closure just clears the matching ref and fires the call.
  const releaseHeld = useCallback(
    (reason: LiveKitSessionReleaseReason, viaBeacon: boolean): void => {
      const target = resolveReleaseTarget(heldSessionRef.current, queueTicketRef.current);
      if (target.kind === "none") return;
      if (target.kind === "session") {
        heldSessionRef.current = null;
        if (viaBeacon && client.releaseLiveKitSessionBeacon(target.sessionId, reason)) return;
        void client.releaseLiveKitSession(target.sessionId, reason);
        return;
      }
      queueTicketRef.current = null;
      if (viaBeacon && client.releaseLiveKitQueueTicketBeacon(target.queueTicketId, reason)) return;
      void client.releaseLiveKitQueueTicket(target.queueTicketId, reason);
    },
    [client],
  );
  // Key the fetch on the session's STRUCTURE, not its object identity, so a
  // re-render with a fresh-but-equal session object does not re-mint a room +
  // dispatch + token (each POST burns a real GPU slot until its TTL).
  const sessionKey = useMemo(() => (session ? stableStringify(session) : null), [session]);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // Read through a ref (like sessionRef) so a changed hint can never re-fire the
  // fetch effect — the hint is advisory pre-warm input, not request identity, and
  // re-running the effect on it would release + re-mint the held grant.
  const serverUrlHintRef = useRef(serverUrlHint);
  serverUrlHintRef.current = serverUrlHint;
  const prevKeyRef = useRef<string | null>(null);
  const [state, setState] = useState<Omit<LiveKitAvatarGrantState, "refresh" | "clear" | "capacity" | "release">>({
    status: "idle",
    grant: null,
    busy: null,
    error: null,
  });
  // The latest committed state, read inside the fetch effect WITHOUT making it an
  // effect dependency — so the auto-retry (which only bumps `version`) does not
  // re-fire the effect, yet the effect can still see whether we are mid-queue.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Tab visibility gates queue presence: a HIDDEN tab stops refreshing its ticket
  // so its place decays by TTL (switching away frees the slot), and becoming
  // visible resumes polling to re-acquire. Together with the shared client id,
  // this makes tab-switching cost ONE slot, not N, and free it promptly.
  const [tabVisible, setTabVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = (): void => setTabVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const current = sessionRef.current;
    if (!active || !current || !sessionKey) {
      // Going inactive (mode/avatar switch, no session) abandons whatever capacity
      // we hold — a held session OR a queued ticket. Release it FIRST (releaseHeld
      // reads queueTicketRef to free a queued ticket), THEN clear the ref. Nulling
      // before releasing would strand a queued ticket until its TTL.
      releaseHeld("unmount", false);
      queueTicketRef.current = null;
      prevKeyRef.current = sessionKey;
      setState({ status: "idle", grant: null, busy: null, error: null });
      return;
    }
    if (prevKeyRef.current !== sessionKey) {
      // The logical session changed (avatar/voice switch) — the prior grant is
      // abandoned. Release its lease NOW rather than waiting for the new grant to
      // land (which may itself QUEUE, leaving the old slot held behind it). This
      // only runs on a real key change, never on a `version`-bump retry, so a
      // queued auto-retry never releases the ticket it is waiting on.
      releaseHeld("superseded", false);
      queueTicketRef.current = current.queueTicketId ?? null;
      prevKeyRef.current = sessionKey;
    }
    // Always carry a queue ticket id, defaulting to the stable per-browser client
    // id, so every tab / retry / avatar-switch of this browser maps to the SAME
    // place in line (the platform keys the ticket by the client-supplied id):
    // N tabs → 1 slot, and switching never mints a second place.
    const request = {
      ...current,
      queueTicketId: current.queueTicketId ?? queueTicketRef.current ?? clientIdRef.current,
    };

    let cancelled = false;
    // A queued auto-retry must NOT flip the UI back to "requesting" (which reads
    // as "connecting"/no-queue and makes the calm queued badge + banner flash on
    // every ~750ms tick). When we are already holding a queue ticket and showing
    // a busy/queued state, leave that state in place WHILE the next attempt is in
    // flight — the queued identity stays stable across the whole retry loop. Only
    // a genuinely fresh request (no queue placement yet) shows "requesting".
    const prior = stateRef.current;
    const retryingQueued = prior.status === "busy" && prior.busy !== null;
    if (!retryingQueued) {
      // A genuinely fresh request is the one moment worth pre-warming the
      // LiveKit signal host: the grant POST is about to spend hundreds of ms in
      // flight, so the token-less HEAD hides the wss handshake's DNS+TLS RTTs
      // under it for free (different origin than the POST — no contention).
      // Gated HERE so the ~750ms queued auto-retries never re-fire it; the
      // per-URL latch inside the warmer covers avatar-switch re-requests.
      warmLiveKitHost(serverUrlHintRef.current ?? readLiveKitUrlHint());
      setState({ status: "requesting", grant: null, busy: null, error: null });
    }
    void client
      .createLiveKitSessionOrBusy(request, requestOptions)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "busy") {
          queueTicketRef.current = result.busy.queue_ticket_id ?? queueTicketRef.current;
          // Commit the fresh busy snapshot so the auto-retry effect (keyed on
          // `state.busy`) reschedules the next tick. Referential STABILITY for the
          // UI is provided one level up by the value-memoized `capacity` signal —
          // an unchanged queue position yields the SAME `capacity` object even
          // though `state.busy` is a new reference, so the queued badge/banner
          // update in place across the retry loop without remounting.
          setState({ status: "busy", grant: null, busy: result.busy, error: null });
          return;
        }
        queueTicketRef.current = null;
        // A fresh grant supersedes any prior held lease (this is the re-mint that
        // a tab-switch-driven reconnect triggers). Release the OLD session before
        // adopting the new one so the reconnect swaps slots instead of stacking a
        // second zombie reservation onto the queue.
        if (heldSessionRef.current && heldSessionRef.current !== result.grant.session_id) {
          releaseHeld("superseded", false);
        }
        heldSessionRef.current = result.grant.session_id;
        // Remember the landed LiveKit host so the NEXT page-load can pre-warm
        // DNS+TLS to it while its own grant POST is in flight. The room still
        // connects to THIS grant's livekit_url exclusively (below, via
        // RealtimeAvatarLiveKitRoom) — the hint never feeds the connect path.
        writeLiveKitUrlHint(result.grant.livekit_url);
        setState({ status: "ready", grant: result.grant, busy: null, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "failed",
          grant: null,
          busy: null,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [active, client, sessionKey, requestOptions, version, releaseHeld]);

  // Release the held lease on the way out so a tab-close / navigate-away frees
  // the GPU slot immediately. `pagehide` is the reliable unload signal (it fires
  // for bfcache navigations and real closes where `beforeunload`/unmount effects
  // are unreliable); a `fetch` is cancelled by the unloading document, so we use
  // `sendBeacon` here. The React unmount cleanup covers SPA route changes (where
  // the page is NOT unloading and a normal release fetch completes).
  useEffect(() => {
    // `pagehide` exists only in browsers. React Native aliases `window` to a bare
    // global with NO event target, so feature-detect the listener — native apps
    // have no page unload anyway; the unmount cleanup below is their release path.
    const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function";
    const onPageHide = (): void => releaseHeld("page_hide", true);
    if (canListen) window.addEventListener("pagehide", onPageHide);
    return () => {
      if (canListen) window.removeEventListener("pagehide", onPageHide);
      releaseHeld("unmount", false);
    };
  }, [releaseHeld]);

  const refresh = useCallback(() => setVersion((current) => current + 1), []);
  const clear = useCallback(() => {
    // Release whatever we hold (held session OR queued ticket) FIRST — releaseHeld
    // reads queueTicketRef to free a queued ticket — THEN clear the ref. Nulling
    // before releasing would strand a queued ticket until its TTL. Releasing here
    // (not just on unmount) lets an adopter explicitly drop the held slot, e.g. on
    // an End-call tap, without waiting for the TTL.
    releaseHeld("manual", false);
    queueTicketRef.current = null;
    setState({ status: "idle", grant: null, busy: null, error: null });
  }, [releaseHeld]);
  const release = useCallback(
    (reason: LiveKitSessionReleaseReason = "disconnected") => releaseHeld(reason, false),
    [releaseHeld],
  );

  useEffect(() => {
    // Refresh the queue place ONLY while the tab is visible — a hidden tab stops
    // polling so its ticket decays (switch-away frees the slot); re-showing re-runs
    // this effect and resumes.
    if (!autoRetryBusy || !active || !tabVisible || state.status !== "busy" || !state.busy) return;
    const retryMs = Math.max(state.busy.recommended_retry_ms, 250);
    const timer = window.setTimeout(refresh, retryMs);
    return () => window.clearTimeout(timer);
  }, [active, autoRetryBusy, tabVisible, refresh, state.busy, state.status]);

  // Memoize the discriminated capacity signal BY VALUE: its reference only
  // changes when the meaningful capacity (kind + queue position + size + grant /
  // error identity) changes — NOT on every retry tick. A queued retry that comes
  // back with the same position therefore yields the SAME `capacity` object, so
  // adopters' `useMemo`s keyed on it (and React's element diffing) see no change
  // and the queued badge/banner update in place instead of remounting.
  const capacityRef = useRef<LiveKitCapacityState | null>(null);
  const capacity = useMemo(() => {
    const next = capacityStateFromGrant(state);
    const prev = capacityRef.current;
    if (prev && sameCapacityState(prev, next)) return prev;
    capacityRef.current = next;
    return next;
  }, [state]);

  return useMemo(
    () => ({ ...state, capacity, refresh, clear, release }),
    [state, capacity, refresh, clear, release],
  );
}

/** Structural equality for the capacity signal so its reference can stay stable. */
function sameCapacityState(a: LiveKitCapacityState, b: LiveKitCapacityState): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "queued": {
      // Compare the queue placement BY VALUE (not the `busy` reference, which is
      // a fresh object on every retry tick) so an unchanged position yields a
      // stable `capacity` reference and the queued badge/banner update in place.
      const next = (b as Extract<LiveKitCapacityState, { kind: "queued" }>).busy;
      return (
        a.busy.queue_position === next.queue_position &&
        a.busy.queue_size === next.queue_size &&
        a.busy.recommended_retry_ms === next.recommended_retry_ms
      );
    }
    case "active":
      return a.grant === (b as Extract<LiveKitCapacityState, { kind: "active" }>).grant;
    case "error":
      return a.error === (b as Extract<LiveKitCapacityState, { kind: "error" }>).error;
    default:
      // "idle" and "connecting" carry no payload — same kind means equal.
      return true;
  }
}

export type RealtimeAvatarLiveKitRoomProps = Omit<
  LiveKitRoomProps,
  "serverUrl" | "token" | "connect" | "audio" | "video" | "options"
> & {
  grant: LiveKitSessionGrant | null | undefined;
  connect?: boolean;
  /** Native LiveKit audio publish option. Defaults to server-STT sessions only. */
  audio?: LiveKitRoomProps["audio"];
  /** Native LiveKit video publish option. Defaults to false for avatar calls. */
  video?: LiveKitRoomProps["video"];
  /** Passed directly to LiveKitRoom. */
  options?: LiveKitRoomProps["options"];
  renderRoomAudio?: boolean;
  children?: ReactNode;
};

/** Thin typed bridge from a Realtime Avatar grant into LiveKitRoom. */
export function RealtimeAvatarLiveKitRoom(props: RealtimeAvatarLiveKitRoomProps): ReactElement {
  const {
    grant,
    connect = true,
    audio,
    video = false,
    options,
    renderRoomAudio = true,
    children,
    ...roomProps
  } = props;
  const shouldConnect = Boolean(grant && connect);
  const roomAudio = renderRoomAudio ? createElement(RoomAudioRenderer, { key: "room-audio" }) : null;
  // HARD-DEFAULT adaptiveStream OFF (kept, post-simulcast — the rationale changed but
  // the value did not; the video-layering design doc). adaptiveStream selects the
  // layer by RENDERED ELEMENT SIZE + visibility, which is the WRONG lever for us twice
  // over: (1) a full-screen avatar element always requests the TOP layer, so it fights
  // the congestion-based selection we actually want; (2) we keep the <video> mounted at
  // opacity:0 between turns, and adaptiveStream reads that as invisible → a full
  // server-side PAUSE → the element freezes on its last frame until it un-hides. The
  // congestion adaptation we DO want is owned elsewhere: the SFU's per-subscriber BWE
  // (now that the worker publishes a multi-layer simulcast ladder) plus the SDK's
  // cap-based quality governor ({@link useAvatarQualityGovernor}) — a size-driven lever
  // must not also be pulling. dynacast is publisher-side; enabling it is harmless for
  // this subscriber-only avatar video and avoids wasting layers if an adopter also
  // publishes local video. Spreading `options` last still lets an adopter override both.
  const roomOptions = { adaptiveStream: false, dynacast: true, ...options };
  return createElement(
    LiveKitRoom,
    {
      ...roomProps,
      serverUrl: grant?.livekit_url,
      token: grant?.participant_token,
      connect: shouldConnect,
      audio: audio ?? (grant?.stt_mode === "server"),
      video,
      options: roomOptions,
    },
    createElement(Fragment, null, children, roomAudio),
  );
}

export const capacityErrorFromBusy = (busy: CapacityBusyResponse): RealtimeAvatarCapacityError => {
  return new RealtimeAvatarCapacityError(busy.message, busy);
};

/** Deterministic structural key (sorted keys) so equal-but-new objects match. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}
