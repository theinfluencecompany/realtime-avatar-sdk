import {
  VideoTrack,
  useConnectionState,
  useVoiceAssistant,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
// The connection-state ENUM lives in livekit-client (the same-named export in
// @livekit/components-react is the status COMPONENT). `useConnectionState`
// returns this enum, so we compare against it directly — SSOT, no magic strings.
// `TrackEvent` is the SDK's own track-lifecycle enum — we subscribe to its
// Muted/Unmuted/Ended members so a turn-end (the agent stops publishing while
// still subscribed) re-renders the surface; no reinvented event taxonomy.
import { ConnectionState, TrackEvent } from "livekit-client";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
// The native receiver-side de-jitter cushion (RemoteTrack.setPlayoutDelay).
// Lives in ./livekit (no import cycle — livekit.ts never imports this surface).
// This is the SSOT surface for BOTH the text and call paths, so mounting the
// hook HERE is what actually applies the playout delay to the avatar's
// audio+video. Without a call site the cushion is dead code and both tracks run
// the browser's shallow default jitter buffer → stutter + a/v drift on packet
// loss. Keeping the delay equal on both tracks is what holds lip-sync.
import { useAvatarPlayoutDelay } from "./livekit";
import { useAvatarQualityGovernor, type FreezeReadingFn } from "./use-quality-governor";
import { DEFAULT_GOVERNOR_CONFIG, type QualityCap } from "./quality-governor";

/** A network gap longer than this is no longer presented as a frozen live frame. */
export const DEFAULT_AVATAR_FRAME_STALL_MS = 800;

/** Ignore ordinary 15-25fps presentation spacing when scoring a freeze. */
export const AVATAR_FRAME_GAP_FREEZE_FLOOR_MS = 100;

/** How the media is fit into the surface box. Mirrors CSS `object-fit`. */
export type AvatarVideoFit = "contain" | "cover";

export type AvatarVideoSurfaceProps = {
  /**
   * The avatar's idle/ambient clip, natively looped, layered OVER the
   * {@link poster} floor. When a realtime turn is not producing media — including
   * after a session disconnect — the surface rests on this clip. Pass `null` for
   * avatars with no idle clip; the poster floor then shows at rest.
   */
  idleVideoUrl: string | null;
  /**
   * The avatar's PORTRAIT (its face) — the DEEPEST floor, rendered behind the idle
   * clip and the live video whenever provided. It paints IMMEDIATELY on connect
   * (an `<img>` decodes before a `<video>` reaches its first frame) and is the
   * guaranteed no-frames backdrop, so the surface is NEVER a black box while
   * connecting / listening / idle / between turns. With an idle clip it sits behind
   * it; with none it is the resting floor. Pass `null` to fall through to the
   * caller's own branded floor. Rendered with the same fit/box as the video layers
   * so swaps are in place.
   */
  poster?: string | null;
  /**
   * The caller's INTENT to show the live stream — typically "the avatar is
   * actively producing media this turn". The surface still gates this on the
   * LiveKit connection state and a subscribed, PRODUCING video track, so a stale
   * `true` after a drop can never reveal a frozen/black live layer: it falls back
   * to the idle clip in the SAME box. Defaults to `true` (show live whenever a
   * connected, producing track exists).
   */
  live?: boolean;
  /**
   * Enable the subscriber-side fast-down/sticky-up quality governor. It starts on
   * the lower simulcast rung, reacts immediately to an SFU pause or decoded-frame
   * freeze, and only probes the full layer after a clean dwell. Default true.
   */
  adaptiveQuality?: boolean;
  /**
   * Opening bet for the governor when `adaptiveQuality` is on. `"high"` opens on the
   * FULL simulcast layer under probation — sharp from frame 1, no LOW→HIGH layer-walk —
   * and instant-demotes a cold link within one tick; `"low"` is the reactive soft-open.
   * Unset ⇒ the fleet default (`DEFAULT_GOVERNOR_CONFIG.openingCap`, currently `"low"`).
   * `<AvatarCall>` sets this to `"high"` only for rtx6000-pool sessions (see
   * opening-cap-policy.ts); everything else keeps the soft-open.
   */
  openingCap?: QualityCap;
  /** `object-fit` for BOTH layers. Both layers always use the SAME fit + box so
   *  the front (live) fully covers the back (idle) — no peek-through. */
  fit?: AvatarVideoFit;
  /**
   * @deprecated No-op. The surface FILLS its container (`size-full`); the CONSUMER
   * owns the aspect box. Self-pinning a native ratio INSIDE the surface could not
   * survive an indefinite-height ancestor (it collapsed to zero height — the
   * black-screen bug), so aspect ownership moved out to the caller: wrap the
   * surface in a box with a definite size (e.g. `aspect-[9/16]` + a height seed).
   * Accepted for source compatibility; ignored.
   */
  pinNativeAspect?: boolean;
  /** CSS `aspect-ratio` placeholder for the box (a size-jump guard on first paint).
   *  Applied to the fill box when set; the caller's own aspect box still wins. */
  aspectRatio?: string;
  /**
   * @deprecated Retained for source compatibility; the idle↔live handover is a SWAP,
   * not a blend. Both layers show the same body from independent clocks, so any
   * overlap is a double exposure rather than a softening (measured: 31.8% of the
   * picture differs at the median cursor pair). The layers are made to agree at the
   * ANCHOR instead, where a swap is invisible — which is also the falsifiable test:
   * 0 and 500 must look identical. Accepted; ignored.
   */
  crossfadeMs?: number;
  /**
   * Debounce (ms) before dropping BACK to the idle clip once the live layer stops
   * being shown (turn end), so back-to-back turns don't flash the idle clip for a
   * frame between them. Default 700. A disconnect bypasses this and reverts to idle
   * immediately (a dead room is never held). Showing the live layer is always
   * immediate — only the hide is debounced.
   */
  idleReturnDelayMs?: number;
  /**
   * Maximum time without a newly presented decoded frame before the live layer is
   * treated as stalled and immediately replaced by the idle/poster floor. Default 800ms.
   */
  frameStallMs?: number;
  /** Extra className for the box (the layers fill it). */
  className?: string;
  /** Extra inline style for the box. */
  style?: CSSProperties;
  /** Overlay content rendered above both media layers (badges, chrome, scrims). */
  children?: ReactNode;
  /** Surface a small "live · WxH" badge when the live layer is shown. Default true. */
  showLiveBadge?: boolean;
  /** Test id for the box. */
  "data-testid"?: string;
};

/**
 * The avatar video surface: a single box that FILLS its container and renders the
 * looping idle clip and the realtime LiveKit video as two PIXEL-ALIGNED layers,
 * with an anchor-aligned SWAP between them and an automatic fall-back to the idle
 * clip whenever the realtime session is not connected or producing (max-duration
 * end, network drop, agent gone, turn-end mute).
 *
 * ONE BODY, ONE POSE. Only one media layer ever runs: the idle clip is paused while
 * the live layer covers it, and re-enters at its anchor (frame 0) when it takes over.
 * That is what lets the handover be a swap with no blending — see the front-layer and
 * `useIdleWhileResting` notes for the measurements behind it.
 *
 * This is the SSOT for "is the avatar live right now": it reads the LiveKit
 * connection state ({@link useConnectionState}) and the bound avatar track
 * ({@link useVoiceAssistant}) directly, so a caller's stale `live` intent can
 * never leave a frozen/black frame on screen — the surface always reverts to the
 * idle loop in the SAME box. Must be rendered inside a LiveKit `RoomContext`
 * (e.g. under `RealtimeAvatarLiveKitRoom`).
 *
 * LAYOUT CONTRACT: the surface FILLS its container (`size-full`) — it does NOT pin
 * its own aspect. The CONSUMER owns the aspect box: wrap the surface in an element
 * with a DEFINITE size (e.g. `aspect-[9/16]` plus a height seed). Self-pinning a
 * native ratio inside the surface (`h-full w-auto`) collapsed to zero height
 * against an indefinite-height (flex) ancestor — the black-screen bug — so that
 * ownership moved out. Both media layers are `absolute inset-0` over the filled box
 * and share the SAME `object-fit`, so the front layer fully covers the back with no
 * sliver.
 */
export function AvatarVideoSurface(props: AvatarVideoSurfaceProps): ReactElement {
  const {
    idleVideoUrl,
    poster = null,
    live = true,
    adaptiveQuality = true,
    openingCap,
    fit = "contain",
    aspectRatio,
    idleReturnDelayMs = 700,
    frameStallMs = DEFAULT_AVATAR_FRAME_STALL_MS,
    className,
    style,
    children,
    showLiveBadge = true,
  } = props;
  // `pinNativeAspect` is a no-op (the consumer owns the aspect box now); it is
  // intentionally not destructured.
  const testId = props["data-testid"];

  const { videoTrack, audioTrack } = useVoiceAssistant();
  // Apply the native de-jitter cushion to BOTH avatar tracks (equal delay keeps
  // them lip-locked). This is the only runtime call site — it re-applies
  // whenever either track appears/changes (the hook keys on the MediaStreamTrack).
  useAvatarPlayoutDelay(videoTrack, audioTrack);
  const connectionState = useConnectionState();
  const connected = connectionState === ConnectionState.Connected;

  // Is the live track eligible to produce frames? A subscribed-but-MUTED
  // publication (the agent finished
  // its turn and stopped publishing while the room stays connected) is NOT
  // producing — its last decoded frame is frozen on screen — so we fall back to
  // the idle loop. `useLiveTrackProducing` reads the underlying MediaStreamTrack's
  // liveness reactively off the SDK's own TrackEvent.Muted/Unmuted/Ended events,
  // so a mute re-renders the surface (a plain read in render would be stale —
  // `useVoiceAssistant` does not re-render on mute). It is also false when the
  // track is unsubscribed/undefined (publication.track gone) or the agent
  // participant left (videoTrack itself becomes undefined).
  const trackProducing = useLiveTrackProducing(videoTrack);
  const liveWrapRef = useRef<HTMLDivElement | null>(null);
  // A MediaStreamTrack can remain live+unmuted while the network/decoder is stuck on
  // its last frame. Observe actual presented frames so that condition falls back to
  // the idle/poster floor instead of displaying a frozen face indefinitely.
  const frameFlow = useLiveFrameFlow(
    liveWrapRef,
    trackProducing,
    videoTrack?.publication?.track,
    frameStallMs,
  );
  // Referentially STABLE across renders (memoized on the only field the surface
  // overrides). The adapter keys its effect on config IDENTITY and re-inits the
  // governor when it changes — a fresh object each render would wipe the governor's
  // learned state (re-actuating the opening cap) on every re-render.
  const governorConfig = useMemo(
    () => ({
      ...DEFAULT_GOVERNOR_CONFIG,
      openingCap: openingCap ?? DEFAULT_GOVERNOR_CONFIG.openingCap,
    }),
    [openingCap],
  );
  useAvatarQualityGovernor({
    // Keep the governor alive across presentation-intent changes; resetting it on
    // every turn would re-apply LOW and a normal short turn could never earn HIGH.
    enabled: adaptiveQuality,
    freezeReading: frameFlow.freezeReading,
    config: governorConfig,
  });
  // Is the room genuinely GONE (disconnected)? A dead room is never held — it
  // reverts to the idle floor IMMEDIATELY, bypassing the turn-end debounce.
  const liveWanted = live && connected && trackProducing && frameFlow.flowing;
  const networkStalled = trackProducing && frameFlow.seenFrame && !frameFlow.flowing;

  // SHOW the live layer when wanted; otherwise debounce the hide so back-to-back
  // turns don't flash idle between them — UNLESS the room disconnected, which
  // reverts immediately (no frozen frame on a dead room). This is a plain
  // debounced reflection of `liveWanted` with ONE state + ONE effect — NOT an
  // opacity latch that can stick visible-but-frozen or sized-but-invisible: if
  // `liveWanted` stays false the layer always lands hidden.
  const showLive = useDebouncedHide(
    liveWanted,
    connected && !networkStalled ? idleReturnDelayMs : 0,
  );

  // The box fills its parent; an optional `aspectRatio` only seeds a size-jump
  // guard until the caller's own aspect box (which it now owns) takes over. The
  // live track's published dimensions are read for the badge label only.
  const liveDims = videoTrack?.publication?.dimensions ?? null;
  const idleVideoRef = useRef<HTMLVideoElement | null>(null);
  const boxAspect = aspectRatio ?? null;

  // ONE BODY, ONE POSE. The idle clip runs ONLY while it is the visible layer, and
  // it re-enters at the ANCHOR every time it takes over. See `useIdleWhileResting`.
  useIdleWhileResting(idleVideoRef, idleVideoUrl, showLive);
  useLiveResumeOnProducing(liveWrapRef, trackProducing);

  const fitClass = fit === "cover" ? AVATAR_VIDEO_FIT_COVER : AVATAR_VIDEO_FIT_CONTAIN;
  const liveLabel =
    showLive && liveDims && liveDims.width > 0 && liveDims.height > 0
      ? `${liveDims.width}×${liveDims.height}`
      : null;

  // Which back layers to render (pure decision, unit-tested in the spec). The
  // poster is the DEEPEST floor and renders whenever it exists — it is the
  // no-frames backdrop the user sees IMMEDIATELY on connect (before any frame)
  // and the guaranteed face behind every other layer, so the surface is never a
  // black box. The idle clip (if any) layers OVER the poster, and the live layer
  // over both. With NO idle clip the poster is the resting floor between turns.
  const layers = resolveSurfaceLayers({ idleVideoUrl, poster });
  // Both back layers (poster + idle) use the SAME object-fit + box as the FRONT
  // live layer, so the front fully covers them and nothing peeks out beside it.
  // (An earlier version forced the back to object-COVER while live — but the front
  // uses `fitClass` (object-contain by default), so a 9:16 frame letterboxed in a
  // wider box while the cover-filled back bled through those side bands = the
  // visible "two layers" seam. Matching fits removes it; the bands, if any, show
  // the neutral box bg. In the call path (fit="cover") both already cover — no-op.)
  const backFitClass = fitClass;
  // The poster floor (deepest layer). Always behind the idle clip and the live
  // video, so the avatar's FACE shows the instant the surface mounts and stays as
  // the backdrop whenever nothing is painting frames — connecting, listening,
  // idle, between turns — even before the idle clip has loaded its first frame.
  const posterLayer = layers.showPoster
    ? createElement("img", {
        key: "poster",
        src: poster as string,
        alt: "",
        "aria-hidden": true,
        className: joinClass(AVATAR_VIDEO_LAYER, backFitClass),
        "data-testid": "avatar-poster",
      })
    : null;
  // The idle clip layer, rendered OVER the poster when an idle clip exists.
  const idleLayer = layers.showIdleVideo
    ? createElement("video", {
        key: "idle",
        ref: idleVideoRef,
        src: idleVideoUrl as string,
        muted: true,
        // NATIVE loop, not a scripted boomerang. These clips are generated i2v from
        // the portrait with a matched head and tail, so the wrap closes on its own —
        // measured on the shipped roster, every frame of a clip's last 0.1s differs
        // from its frame 0 on 0.0% of the picture. Boomerang existed for clips that
        // did NOT close, and it costs what the render platform retired it for:
        // ambient motion played BACKWARDS (a breath un-inhaling) is an uncanny tell.
        loop: true,
        playsInline: true,
        autoPlay: true,
        preload: "auto",
        className: joinClass(AVATAR_VIDEO_LAYER, backFitClass),
        "data-testid": "avatar-idle-video",
      })
    : null;

  // Front layer: the realtime LiveKit video, SWAPPED (not blended) over the idle clip.
  //
  // WHY NO CROSSFADE. Both layers show the SAME character's body from INDEPENDENT
  // clocks: the idle clip runs the browser's decode cursor, the live track runs the
  // renderer's. Nothing synchronises them, so at a fade the two poses are unrelated —
  // sampling jung-woo's idle clip at random cursor pairs, 31.8% of the picture differs
  // at the median and 42.5% at p90, with only 6.2% of pairs close enough to pass for
  // one body. A blend of two poses IS a double exposure; the fade duration only sets
  // how long it stays legible. So the layers are swapped instantly and the ghost has
  // nowhere to live. `crossfadeMs` stays in the API but is IGNORED — with the layers
  // agreeing at the swap it would be a no-op either way, which is exactly the
  // falsifiable test: 0ms and 500ms must look identical.
  //
  // WHY THAT DOES NOT STUTTER. `useIdleWhileResting` re-enters the idle clip at its
  // ANCHOR — frame 0, the shared i2v still every clip is generated from and the pose
  // the renderer's body plays back to. The decoder holds the last live frame until the
  // idle layer paints, so the handover is anchor→anchor: nothing to fade, nothing to
  // jump. A network stall is the one case the two cannot be made to agree, and there
  // holding the frozen live frame (the `idleReturnDelayMs` debounce above) is the
  // honest answer — a brief hold reads as the network, a snap reads as a fault.
  const frontLayer = createElement(
    "div",
    {
      key: "live",
      ref: liveWrapRef,
      className: joinClass(AVATAR_VIDEO_LIVE_WRAP, showLive ? undefined : "pointer-events-none"),
      style: {
        opacity: showLive ? 1 : 0,
        transitionDuration: "0ms",
      },
      "data-testid": "avatar-live-layer",
      "aria-hidden": !showLive,
    },
    videoTrack
      ? createElement(VideoTrack, {
          trackRef: videoTrack,
          className: joinClass(AVATAR_VIDEO_LAYER, fitClass),
          playsInline: true,
          autoPlay: true,
          muted: true,
          "aria-label": "Realtime avatar video",
        })
      : null,
  );

  const badge =
    showLiveBadge && showLive
      ? createElement(
          "span",
          { key: "badge", className: AVATAR_VIDEO_BADGE },
          createElement("span", { key: "dot", className: AVATAR_VIDEO_BADGE_DOT, "aria-hidden": true }),
          liveLabel ? `live · ${liveLabel}` : "live",
        )
      : null;

  // The box owns its own sizing: it ALWAYS fills its parent (`size-full`); when an
  // aspect is pinned, `aspect-ratio` constrains it within that fill so the box is a
  // stable 9:16 (etc.) shape with a DEFINITE height — it never collapses to zero
  // height the way a `h-full w-auto` box does against a content-driven (flex)
  // parent. The caller's `className` is applied LAST so it can still override.
  return createElement(
    "div",
    {
      className: joinClass(AVATAR_VIDEO_BOX, className),
      style: boxAspect ? { aspectRatio: boxAspect, ...style } : style,
      "data-testid": testId,
    },
    // Deepest → shallowest: poster floor (the always-present face), the idle clip
    // over it, then the live video. The poster guarantees the surface is never a
    // black box before/between turns; the idle clip and live render layer over it.
    posterLayer,
    idleLayer,
    frontLayer,
    badge,
    children,
  );
}

/** Which back (non-live) layers the surface renders, deepest first. */
export type SurfaceLayers = {
  /** Render the poster `<img>` — the deepest floor, the always-present face. */
  showPoster: boolean;
  /** Render the idle clip `<video>`, layered OVER the poster. */
  showIdleVideo: boolean;
};

/**
 * Pure decision for the surface's back layers, extracted so the "never a black
 * box" guarantee is unit-testable without a DOM/LiveKit room.
 *
 * The POSTER (the avatar's portrait/face) is the deepest floor and renders
 * whenever a `poster` URL is provided — independent of whether an idle clip
 * exists. This is the fix for the call-mode black box: the portrait paints
 * IMMEDIATELY on connect (an `<img>` decodes faster than a `<video>` reaches its
 * first frame) and stays as the backdrop whenever nothing is producing frames
 * (connecting / listening / idle / between turns). The idle clip, when present,
 * renders OVER the poster (and the live video over both), so an avatar WITH an
 * idle clip is unchanged at rest while an avatar with ONLY a portrait shows the
 * face instead of black.
 */
export function resolveSurfaceLayers(input: {
  idleVideoUrl: string | null;
  poster: string | null;
}): SurfaceLayers {
  return {
    showPoster: Boolean(input.poster),
    showIdleVideo: Boolean(input.idleVideoUrl),
  };
}

/**
 * Pure test: is this avatar video track actively producing frames right now?
 *
 * False — i.e. "live ended, fall back to the idle loop" — for EVERY live-end
 * signal:
 *  - `videoTrack` undefined: no track at all (agent participant left / never
 *    published / `useVoiceAssistant` dropped it).
 *  - `publication.track` undefined: the track is unsubscribed (frames stopped).
 *  - the underlying MediaStreamTrack is not LIVE/enabled/unmuted: the agent
 *    finished its turn and the decoder's last frame is frozen on screen.
 *
 * We read the underlying `MediaStreamTrack`'s MEDIA-level liveness as the SINGLE
 * signal — `readyState === "live" && enabled && !muted` — never the SDK
 * publication's `isMuted` flag. That flag is STALE: the avatar worker publishes the
 * camera track in a muted publication state and never emits TrackUnmuted, so
 * `publication.isMuted` reads true for the whole turn even while real frames flow
 * (a live probe caught the `<video>`'s MediaStreamTrack at readyState="live",
 * !muted, advancing currentTime, yet publication.isMuted=true). The MediaStreamTrack
 * does not lie — it mutes at turn-end and unmutes at turn-start — so it is the
 * correct frame-flow signal on its own. The reactive re-render is wired by
 * {@link useLiveTrackProducing}.
 */
export function isLiveTrackProducing(
  videoTrack: TrackReferenceOrPlaceholder | undefined,
): boolean {
  const mst = videoTrack?.publication?.track?.mediaStreamTrack;
  return mst != null && mst.readyState === "live" && mst.enabled && !mst.muted;
}

/**
 * The COARSE producing gate the React Native (Android) surface twin passes to
 * {@link useLiveTrackProducing} in place of {@link isLiveTrackProducing}.
 *
 * On Android #446 mounts the live `<VideoTrack>` (a below-window SurfaceView) ONLY
 * while it's producing, so this predicate is the upstream switch that decides
 * whether the video shows at all — and the strict {@link isLiveTrackProducing}
 * reads it false there. react-native-webrtc's REMOTE `MediaStreamTrack` does not
 * drive the browser-shaped micro-signals that predicate depends on: `enabled` is a
 * LOCAL playback toggle (not frame flow), and a remote track's `muted` can read
 * `true` for an entire producing turn (or never emit `unmute`). So on a real
 * Android device the strict test returned false while frames flowed and the avatar
 * froze on its poster ("voice only / static image").
 *
 * We therefore gate on the one fact react-native-webrtc reports reliably: a
 * subscribed remote track whose underlying `MediaStreamTrack` has not ENDED. The
 * trade-off is that a turn-end no longer crossfades back to the idle clip on
 * Android (the live layer stays up between turns) — an acceptable price for the
 * video actually appearing. The room's connection state still unmounts the layer on
 * disconnect, and the track's `ended` event (wired in {@link useLiveTrackProducing})
 * still tears it down. iOS keeps {@link isLiveTrackProducing}: its in-tree UIView
 * and DOM-shaped track behave like the web, where the strict signal works today.
 *
 * Pure + DOM-free (reads only `mediaStreamTrack.readyState`), so it lives here with
 * its web twin and is unit-tested in the shared suite rather than the RN module.
 */
export function isNativeLiveTrackSubscribed(
  videoTrack: TrackReferenceOrPlaceholder | undefined,
): boolean {
  const mst = videoTrack?.publication?.track?.mediaStreamTrack;
  return mst != null && mst.readyState !== "ended";
}

/**
 * Reactive {@link isLiveTrackProducing}: returns whether the avatar's live video
 * is producing frames, and re-renders the surface when that changes.
 *
 * `useVoiceAssistant` re-renders when the track APPEARS/DISAPPEARS, but NOT when a
 * present track merely mutes — so a plain read in render would be stale and leave
 * the frozen last frame up after a turn ends. We subscribe to the publication's
 * own lifecycle events — the SDK's `TrackEvent.Muted`/`Unmuted` (turn end/start)
 * and `Ended` (track torn down) — PLUS the underlying MediaStreamTrack's
 * mute/unmute/ended (which fire even when the publication's mute flag is stale),
 * and recompute on each, so a turn-end crossfades back to the idle loop
 * immediately. Unconditional (safe with no track) and re-subscribes whenever the
 * underlying publication/track changes.
 *
 * Exported (not just the pure {@link isLiveTrackProducing}) because it is
 * DOM-free — publication events + MediaStreamTrack events exist on React Native's
 * WebRTC shim too — so the react-native surface twin reuses THIS hook (the event
 * wiring never drifts between platforms) but may pass its OWN `isProducing`
 * predicate: react-native-webrtc's remote track does not drive the browser-shaped
 * `enabled`/`muted` flags {@link isLiveTrackProducing} reads, so Android supplies a
 * coarser subscribed-and-not-ended test (see the RN surface twin). Defaults to
 * {@link isLiveTrackProducing} so every web caller is unchanged.
 */
export function useLiveTrackProducing(
  videoTrack: TrackReferenceOrPlaceholder | undefined,
  isProducing: (videoTrack: TrackReferenceOrPlaceholder | undefined) => boolean = isLiveTrackProducing,
): boolean {
  const publication = videoTrack?.publication;
  const [producing, setProducing] = useState(() => isProducing(videoTrack));
  useEffect(() => {
    // No publication (track gone / placeholder) → not producing.
    if (!publication) {
      setProducing(false);
      return;
    }
    const sync = () => setProducing(isProducing(videoTrack));
    sync();
    publication.on(TrackEvent.Muted, sync);
    publication.on(TrackEvent.Unmuted, sync);
    publication.on(TrackEvent.Ended, sync);
    // We derive "producing" from the underlying MediaStreamTrack's liveness, so
    // recompute when the media track itself ends/mutes/unmutes — these fire even
    // when the publication's mute flag is stale.
    const mst = publication.track?.mediaStreamTrack;
    mst?.addEventListener("ended", sync);
    mst?.addEventListener("mute", sync);
    mst?.addEventListener("unmute", sync);
    return () => {
      publication.off(TrackEvent.Muted, sync);
      publication.off(TrackEvent.Unmuted, sync);
      publication.off(TrackEvent.Ended, sync);
      mst?.removeEventListener("ended", sync);
      mst?.removeEventListener("mute", sync);
      mst?.removeEventListener("unmute", sync);
    };
    // Depend on the track object too, so a late publication.track attach (LiveKit
    // mounts it on a later commit than the publication) rebinds + recomputes.
    // `isProducing` is a module-level fn (stable), listed for exhaustive-deps.
  }, [publication, videoTrack?.publication?.track, isProducing]);
  return producing;
}

export type FrameFlowSnapshot = {
  trackProducing: boolean;
  seenFrame: boolean;
  lastFrameAtMs: number | null;
  nowMs: number;
  stallAfterMs?: number;
};

function normalizeFrameStallMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_AVATAR_FRAME_STALL_MS;
  return Math.max(100, Math.min(10_000, value as number));
}

/** Pure decoded-frame liveness decision used by the live watchdog. */
export function isFrameFlowingAt(snapshot: FrameFlowSnapshot): boolean {
  const stallAfterMs = normalizeFrameStallMs(snapshot.stallAfterMs);
  return (
    snapshot.trackProducing &&
    snapshot.seenFrame &&
    snapshot.lastFrameAtMs !== null &&
    snapshot.nowMs - snapshot.lastFrameAtMs <= stallAfterMs
  );
}

/** Convert a presented-frame gap into a governor freeze signal. */
export function freezeMsFromFrameGap(gapMs: number): number {
  if (!Number.isFinite(gapMs) || gapMs <= AVATAR_FRAME_GAP_FREEZE_FLOOR_MS) return 0;
  return gapMs;
}

export type FrameFreezeInhibitSnapshot = {
  hidden: boolean;
  resumePending: boolean;
  trackProducing: boolean;
  seenFrame: boolean;
  lastFrameAtMs: number | null;
};

/** Hidden/suspended playback gaps are local scheduling, not network congestion. */
export function isFrameFreezeInhibited(snapshot: FrameFreezeInhibitSnapshot): boolean {
  return (
    snapshot.hidden ||
    snapshot.resumePending ||
    !snapshot.trackProducing ||
    !snapshot.seenFrame ||
    snapshot.lastFrameAtMs === null
  );
}

type LiveFrameFlow = {
  flowing: boolean;
  seenFrame: boolean;
  freezeReading: FreezeReadingFn;
};

/**
 * Watch the actual `<video>` presentation clock. Track mute/end events do not fire
 * for every network or decoder stall, so MediaStreamTrack liveness alone can leave
 * the last decoded frame visible forever.
 */
function useLiveFrameFlow(
  wrapRef: { current: HTMLDivElement | null },
  trackProducing: boolean,
  trackIdentity: unknown,
  stallAfterMs: number,
): LiveFrameFlow {
  const boundedStallMs = normalizeFrameStallMs(stallAfterMs);
  const [flowing, setFlowing] = useState(false);
  const [seenFrame, setSeenFrame] = useState(false);
  const flowingRef = useRef(false);
  const sampleRef = useRef<{
    seenFrame: boolean;
    lastFrameAtMs: number | null;
    maxGapMs: number;
    resumePending: boolean;
  }>({
    seenFrame: false,
    lastFrameAtMs: null,
    maxGapMs: 0,
    resumePending: false,
  });

  useEffect(() => {
    sampleRef.current = {
      seenFrame: false,
      lastFrameAtMs: null,
      maxGapMs: 0,
      resumePending: document.visibilityState !== "visible",
    };
    flowingRef.current = false;
    setSeenFrame(false);
    setFlowing(false);
    if (!trackProducing) return;

    const wrap = wrapRef.current;
    if (!wrap) return;
    let video: HTMLVideoElement | null = null;
    let frameCallbackId: number | null = null;
    let callbackGeneration = 0;
    let lastCurrentTime = -1;

    const markFrame = (): void => {
      const previous = sampleRef.current;
      const now = Date.now();
      const firstFrame = !previous.seenFrame;
      sampleRef.current = {
        seenFrame: true,
        lastFrameAtMs: now,
        // A hidden tab/bfcache resume is a local scheduling gap, not network
        // congestion. The first fresh frame becomes the new baseline.
        maxGapMs: previous.resumePending
          ? 0
          : Math.max(
              previous.maxGapMs,
              previous.lastFrameAtMs === null ? 0 : now - previous.lastFrameAtMs,
            ),
        resumePending: false,
      };
      if (firstFrame) setSeenFrame(true);
      if (!flowingRef.current) {
        flowingRef.current = true;
        setFlowing(true);
      }
    };

    const cancelFrameCallback = (): void => {
      if (video && frameCallbackId !== null && video.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(frameCallbackId);
      }
      frameCallbackId = null;
    };

    const bind = (next: HTMLVideoElement | null): void => {
      cancelFrameCallback();
      callbackGeneration += 1;
      video = next;
      lastCurrentTime = next?.currentTime ?? -1;
      if (!next?.requestVideoFrameCallback) return;
      const generation = callbackGeneration;
      const onFrame: VideoFrameRequestCallback = () => {
        if (generation !== callbackGeneration || !video) return;
        markFrame();
        frameCallbackId = video.requestVideoFrameCallback(onFrame);
      };
      frameCallbackId = next.requestVideoFrameCallback(onFrame);
    };

    const stopObserving = observeVideoElement(wrap, bind);
    const inhibitUntilFreshFrame = (): void => {
      sampleRef.current.resumePending = true;
      sampleRef.current.maxGapMs = 0;
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") inhibitUntilFreshFrame();
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) inhibitUntilFreshFrame();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    const pollEveryMs = Math.max(100, Math.min(250, Math.floor(boundedStallMs / 2)));
    const interval = window.setInterval(() => {
      // Poll currentTime even when rVFC exists: Chromium can throttle rVFC while
      // the live layer is opacity:0, and waiting exclusively for that callback
      // would create a first-frame deadlock (hidden until flowing, never flowing).
      if (video && video.currentTime > lastCurrentTime + 0.001) {
        lastCurrentTime = video.currentTime;
        markFrame();
      }
      const nextFlowing = isFrameFlowingAt({
        trackProducing: true,
        seenFrame: sampleRef.current.seenFrame,
        lastFrameAtMs: sampleRef.current.lastFrameAtMs,
        nowMs: Date.now(),
        stallAfterMs: boundedStallMs,
      });
      if (flowingRef.current !== nextFlowing) {
        flowingRef.current = nextFlowing;
        setFlowing(nextFlowing);
      }
    }, pollEveryMs);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      stopObserving();
      cancelFrameCallback();
    };
  // A full reconnect can replace the RemoteTrack while both publications remain
  // `live`. Reset the presentation clock so a new track whose currentTime starts at
  // zero is never compared with the retired track's larger timestamp.
  }, [wrapRef, trackProducing, trackIdentity, boundedStallMs]);

  const freezeReading = useCallback<FreezeReadingFn>(() => {
    const sample = sampleRef.current;
    const lastFrameAtMs = sample.lastFrameAtMs;
    const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
    const inhibited = isFrameFreezeInhibited({
      hidden,
      resumePending: sample.resumePending,
      trackProducing,
      seenFrame: sample.seenFrame,
      lastFrameAtMs,
    });
    if (inhibited || lastFrameAtMs === null) {
      sample.maxGapMs = 0;
      return { freezeMsInWindow: 0, inhibited: true };
    }
    const ongoingGapMs = Math.max(0, Date.now() - lastFrameAtMs);
    const freezeMsInWindow = freezeMsFromFrameGap(Math.max(sample.maxGapMs, ongoingGapMs));
    // Consume recovered gaps once sampled; an ongoing stall remains observable via age.
    sample.maxGapMs = 0;
    return { freezeMsInWindow, inhibited: false };
  }, [trackProducing]);

  return { flowing, seenFrame, freezeReading };
}

/**
 * Reflect `wanted` with an immediate rise and a DEBOUNCED fall: it goes true the
 * instant `wanted` does, and goes false only after `delayMs` of continuous false
 * (so back-to-back turns don't flash the idle clip between them). A fresh `wanted`
 * before the delay elapses cancels the pending hide. Pass `delayMs = 0` to hide
 * immediately (e.g. on a disconnect, where a dead room must never be held). This
 * can never stick: if `wanted` stays false the timer always fires and it lands
 * false — there is no latch.
 */
// Exported so the react-native surface twin reuses the SAME show-immediately /
// hide-debounced reflection (timers are plain globals on RN — no DOM coupling),
// keeping the back-to-back-turn no-flash behavior identical across platforms.
export function useDebouncedHide(wanted: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(wanted);
  useEffect(() => {
    if (wanted) {
      setShown(true);
      return;
    }
    if (delayMs <= 0) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(false), delayMs);
    return () => window.clearTimeout(timer);
  }, [wanted, delayMs]);
  return shown;
}

/**
 * The idle clip runs ONLY while it is the layer being shown, and re-enters at the
 * ANCHOR every time it takes over.
 *
 * Both halves are load-bearing, and the old behaviour had neither.
 *
 * PAUSE WHILE COVERED. The idle clip used to play for the entire call underneath an
 * opaque live layer — invisible, still decoding, and (the part that mattered) still
 * ADVANCING. By the time the live layer stepped aside, its cursor sat wherever a
 * free-running clock had carried it, which is unrelated to the pose the renderer just
 * left. That is the whole ghost: two clocks, one body. A paused layer cannot drift.
 *
 * RE-ENTER AT THE ANCHOR. Frame 0 is the shared i2v still every clip of an avatar is
 * generated from, and the renderer's body plays back to that same pose (it runs its
 * clips to completion). So seeking to 0 before the handover is what makes the swap
 * anchor→anchor — the one position where the two layers agree by construction, and
 * therefore the one place a swap is invisible without any blending.
 *
 * The decoder holds the last live frame while this runs, so the seek+play happens
 * BEHIND a still picture and the viewer sees one continuous body.
 */
function useIdleWhileResting(
  videoRef: { current: HTMLVideoElement | null },
  idleVideoUrl: string | null,
  showLive: boolean,
): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !idleVideoUrl) return;
    applyIdleRest(video, showLive);
  }, [videoRef, idleVideoUrl, showLive]);
}

/** The minimum an idle layer must expose for {@link applyIdleRest} (test seam). */
export type RestableVideoElement = {
  paused: boolean;
  currentTime: number;
  play: () => Promise<void> | void;
  pause: () => void;
};

/**
 * The decision half of {@link useIdleWhileResting}, exported so the two rules it
 * enforces are testable without a DOM or a React tree:
 *
 *     covered → paused (and left where it is — nothing is watching it)
 *     resting → seeked to the ANCHOR (frame 0), then playing
 *
 * The seek is skipped when already at 0: re-seeking a PLAYING element would stutter it
 * once per commit, which is the defect this function exists to remove, not cause.
 */
export function applyIdleRest(video: RestableVideoElement, showLive: boolean): void {
  if (showLive) {
    // Covered: stop the clock. Nothing to see, nothing to decode, nothing to drift.
    video.pause();
    return;
  }
  // Taking over: enter at the anchor, then run.
  if (video.currentTime !== 0) video.currentTime = 0;
  if (video.paused) void Promise.resolve(video.play()).catch(() => {});
}

/**
 * Watch a wrapper for its `<video>` descendant and (re)bind to it the INSTANT it
 * attaches — and unbind on detach — via a `MutationObserver`. LiveKit's
 * `<VideoTrack>` mounts the `<video>` on a DIFFERENT commit than when the track
 * publication first becomes defined, so a one-shot `querySelector` at effect-run
 * time routinely misses the element and arms nothing. The observer closes that
 * race: `onBind(video)` fires for the current element (synchronously if already
 * present) and again whenever the bound element changes, with `null` when the
 * `<video>` leaves the tree. Returns a disposer that stops observing.
 *
 * `MutationObserver` is assumed present (every browser that runs LiveKit has it);
 * in a non-DOM/SSR context where it is missing we bind the current element once
 * and skip observation.
 */
function observeVideoElement(
  wrap: HTMLElement,
  onBind: (video: HTMLVideoElement | null) => void,
): () => void {
  let current: HTMLVideoElement | null = wrap.querySelector("video");
  onBind(current);
  if (typeof MutationObserver !== "function") {
    return () => onBind(null);
  }
  const observer = new MutationObserver(() => {
    const next = wrap.querySelector("video");
    if (next === current) return;
    current = next;
    onBind(next);
  });
  observer.observe(wrap, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    onBind(null);
  };
}

/** Media events that mark frames RESUMING on a `<video>` element. */
const LIVE_RESUME_EVENTS = ["canplay", "playing", "loadeddata"] as const;

/** A `<video>` narrowed to the members the live-playback keeper touches. */
export type PlayableVideoElement = {
  paused: boolean;
  play: () => Promise<void> | void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

/** Controls a live `<video>`'s continuous playback across turns (the freeze fix). */
export type LivePlaybackKeeper = {
  /** Bind (or rebind) the element to keep playing; pass `null` on detach. */
  bind: (video: PlayableVideoElement | null) => void;
  /** Re-check playback after a tab/page resume. */
  resume: () => void;
  /** Stop keeping the element alive and drop its listeners. */
  dispose: () => void;
};

/**
 * Pure, DOM-decoupled controller that keeps a live `<video>` PLAYING — the core of
 * the progressive-freeze fix, extracted so it is unit-testable with a fake `<video>`
 * (no React/DOM).
 *
 * The worker's idle keep-alive (on by default) publishes
 * frames from session start, so the remote MediaStreamTrack normally never goes
 * quiet between turns — but the flow still stalls/mutes whenever that loop is
 * absent or interrupted (keep-alive disabled, worker restart, transient network
 * loss). Browsers commonly PAUSE a remote `<video>` whose source track has
 * stalled/muted and do NOT auto-resume it when frames return — so without
 * intervention the live element is parked on its last decoded frame and later
 * frames never paint (the freeze the user sees accumulating turn over turn).
 *
 * On bind it re-issues `play()` if the element is paused, and it re-issues `play()`
 * again on every `canplay`/`playing`/`loadeddata` (frame flow resuming) — so a
 * browser-paused element restarts the instant the next turn's frames arrive. It
 * NEVER pauses the element (only resumes), so it can never itself cause a freeze.
 */
export function createLivePlaybackKeeper(): LivePlaybackKeeper {
  let bound: PlayableVideoElement | null = null;
  let disposed = false;

  const resume = (): void => {
    if (disposed) return;
    const el = bound;
    if (el && el.paused) {
      // play() may reject (autoplay policy / interrupted); swallow — the next
      // resume event re-tries, and the element is muted+playsInline so policy
      // rejections are not expected for this stream.
      void Promise.resolve(el.play()).catch(() => {});
    }
  };

  const unbindListeners = (el: PlayableVideoElement | null): void => {
    if (!el) return;
    for (const type of LIVE_RESUME_EVENTS) el.removeEventListener(type, resume);
  };

  const bind = (video: PlayableVideoElement | null): void => {
    if (disposed || video === bound) return;
    unbindListeners(bound);
    bound = video;
    if (!video) return;
    for (const type of LIVE_RESUME_EVENTS) video.addEventListener(type, resume);
    // Resume immediately on (re)bind: the track is already producing this turn.
    resume();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unbindListeners(bound);
    bound = null;
  };

  return { bind, resume, dispose };
}

/**
 * Keep the LIVE LiveKit `<video>` PLAYING across turns — the progressive-freeze fix.
 *
 * Drives {@link createLivePlaybackKeeper} over the live element, binding/rebinding
 * it through {@link observeVideoElement} so a late `<video>` attach (LiveKit mounts
 * it on a later commit than the track becoming defined) is still kept alive.
 * Re-runs when `producing` flips true at a new turn-start, so the single live track
 * plays continuously across ALL turns instead of freezing on the first turn-end.
 * No-op while not producing (between turns / no track) — there is nothing to
 * resume, and the next turn re-runs this effect.
 */
function useLiveResumeOnProducing(
  wrapRef: { current: HTMLDivElement | null },
  producing: boolean,
): void {
  useEffect(() => {
    if (!producing) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const keeper = createLivePlaybackKeeper();
    const stopObserving = observeVideoElement(wrap, (video) => keeper.bind(video));
    const onVisible = (): void => {
      if (document.visibilityState === "visible") keeper.resume();
    };
    const onPageShow = (): void => keeper.resume();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      stopObserving();
      keeper.dispose();
    };
  }, [wrapRef, producing]);
}

function joinClass(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}

// Tailwind utility strings. The surface ships plain class strings (no styling
// dependency) so adopters using Tailwind get the intended layout; others can
// override via `className`. Both media layers share the same box + fit so the
// front fully covers the back.
//
// The box ALWAYS fills its parent (`size-full`); an `aspect-ratio` (set inline
// when pinned) then constrains that fill to the native ratio. Critically it does
// NOT use `h-full w-auto`, which collapses to zero height against a content-driven
// (flex) parent — the black-screen bug. Every layer is `absolute inset-0 size-full`
// over this definitely-sized box, so the live `<video>` always has real height.
const AVATAR_VIDEO_BOX = "relative size-full overflow-hidden";
const AVATAR_VIDEO_LAYER =
  "absolute inset-0 size-full transform-gpu [image-rendering:auto] [object-position:center_22%]";
const AVATAR_VIDEO_FIT_CONTAIN = "object-contain";
const AVATAR_VIDEO_FIT_COVER = "object-cover";
const AVATAR_VIDEO_LIVE_WRAP =
  "absolute inset-0 z-20 size-full transition-opacity ease-out";
const AVATAR_VIDEO_BADGE =
  "absolute top-2 right-2 z-30 inline-flex items-center gap-1.5 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10px] text-white/85 backdrop-blur-sm";
const AVATAR_VIDEO_BADGE_DOT = "size-1.5 rounded-full bg-emerald-400";
