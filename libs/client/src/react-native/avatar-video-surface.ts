// ---------------------------------------------------------------------------
// AvatarVideoSurface — the REACT NATIVE twin of src/react/avatar-video-surface.
// Same layer model (poster floor → idle clip → live video, crossfaded in ONE
// box), driven by the SAME shared decision logic so "is the avatar live right
// now" can never drift between platforms:
//
//   - resolveSurfaceLayers  (pure)   — which back layers render
//   - useLiveTrackProducing (shared) — MediaStreamTrack-level "producing" signal
//   - useDebouncedHide      (shared) — show-immediately / hide-debounced
//   - useAvatarPlayoutDelay (shared) — the a/v de-jitter cushion (a documented
//     no-op where the platform's receiver lacks the playout-delay hint)
//   - useAvatarQualityGovernor (shared) — stats+events tiers only on native;
//     the rVFC freeze reading is a browser API and intentionally absent here.
//
// iOS-vs-ANDROID differences, by design — and there is EXACTLY ONE, COMPOSITING:
//   - The live layer is @livekit/react-native's <VideoTrack> (a native RTCView).
//     On iOS that RTCView is a UIView, so it composites like any other layer:
//     it crossfades with RN's Animated opacity (native driver) and sits in tree
//     order above the poster/idle floor. ANDROID's RTCView is a SurfaceView on
//     its OWN hardware layer, which breaks both of those assumptions — see
//     `IS_ANDROID` below. That is the whole of it: `IS_ANDROID` gates HOW the
//     live layer is painted, and nothing else. In particular it does NOT gate
//     WHETHER the track counts as producing — see `RN_WEBRTC_IS_PRODUCING`.
//
// NATIVE-vs-WEB differences — these hold on BOTH platforms alike, and the last of
// them is the one that was once mistaken for an iOS-vs-Android difference:
//   - There is no <video> element on native, so the IDLE CLIP is app-injected
//     via `renderIdleVideo` (bring expo-video / react-native-video — the SDK
//     stays player-agnostic instead of hard-depending on one). Without it the
//     poster is the resting floor, exactly like a web avatar with no idle clip.
//   - No requestVideoFrameCallback on native → no frame-flow stall detection;
//     liveness gates on connection state + the MediaStreamTrack producing
//     signal. Those track events fire on RN's WebRTC shim, but on a REMOTE
//     track their mute state is not a frame-flow signal on either platform,
//     which is why the producing predicate here is the coarse RN one.
// ---------------------------------------------------------------------------
import {
  isTrackReference,
  useConnectionState,
  useVoiceAssistant,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import { VideoTrack } from "@livekit/react-native";
import { ConnectionState } from "livekit-client";
import { createElement, useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { Animated, Image, Platform, StyleSheet, Text, View } from "react-native";
import type { ImageResizeMode, StyleProp, ViewStyle } from "react-native";
import {
  isNativeLiveTrackSubscribed,
  resolveSurfaceLayers,
  useDebouncedHide,
  useLiveTrackProducing,
  type AvatarVideoFit,
} from "../react/avatar-video-surface";
import { useAvatarPlayoutDelay } from "../react/livekit";
import { useAvatarAdaptivePlayoutDelay } from "../react/use-adaptive-playout";
import { useAvatarQualityGovernor } from "../react/use-quality-governor";

// COMPOSITING ONLY. `IS_ANDROID` answers "how is the live layer painted?" — never
// "is the track producing?". Those two questions were once answered by this one
// constant; see `RN_WEBRTC_IS_PRODUCING` below for what that cost.
//
// Android's <VideoTrack> renders an RTCView backed by a SurfaceView — a separate
// hardware layer, NOT a normal view in the RN tree. Two SurfaceView facts break the
// DOM-shaped layer model this surface inherits from the web twin, and each on its
// own is enough to make the avatar show as "voice only" on Android:
//   1. Z-ORDER: a remote-video SurfaceView draws in the BACKGROUND, BELOW the RN
//      window (react-native-webrtc's RTCView doc: remote video is zOrder 0 = "the
//      background"; the window's RN views sit above it). So the opaque poster/idle
//      floor — ordinary RN views ON the window — paint OVER the video and hide it.
//      Tree order does NOT lift the video above them the way it does on iOS. The fix
//      is therefore NOT a bigger zOrder (media-overlay/on-top would also cover the
//      call CONTROLS, which are correctly above the video) — it is to HIDE the
//      opaque floor while the live layer shows, so the below-window video shows
//      through. (Consumer requirement: nothing opaque — including the screen's own
//      background — may sit over the surface's rect, or the below-window video stays
//      hidden. Render the surface over a transparent box.)
//   2. ALPHA: a SurfaceView ignores React Native view opacity, so the Animated.View
//      opacity crossfade is a no-op on Android. So we GATE THE LIVE LAYER BY MOUNT
//      (render <VideoTrack> only while `showLive`); unmounting reveals the floor
//      between turns. iOS keeps the mounted-at-opacity-0 crossfade unchanged.
const IS_ANDROID = Platform.OS === "android";
// Documented value for a single remote video "in the background" (react-native-webrtc).
const ANDROID_REMOTE_ZORDER = 0;

// The default "is the avatar's live track producing frames?" predicate for THIS surface.
//
// IT IS NAMED AFTER THE SHIM, NOT THE PLATFORM, AND THAT IS THE POINT. Deciding whether a
// remote track is producing is a react-native-webrtc question; painting the live layer is a
// SurfaceView question. Do not fold this back into `IS_ANDROID` — the previous shape was
// `IS_ANDROID ? isNativeLiveTrackSubscribed : undefined`, which let iOS fall through to the
// strict web predicate, and the reasoning behind that ("iOS's in-tree UIView and DOM-shaped
// track behave like the web") silently carried a COMPOSITING fact over into TRACK SEMANTICS.
// It does not survive contact with a device: both platforms run the same
// react-native-webrtc shim, so the remote track is no more DOM-shaped on one than the other.
// Measured on a physical iPhone, the publication was subscribed and H.264 frames were
// arriving while the strict predicate read false — the live view sat at opacity 0 and the
// avatar froze on its poster. See `isNativeLiveTrackSubscribed` for the full account.
//
// THE PRICE, WHICH IS REAL AND WHICH iOS NOW PAYS TOO. A subscribed-and-not-ended track reads
// producing BETWEEN turns as well as during them, so the live layer STAYS UP at turn end and
// no longer crossfades back to the idle clip. Android has shipped that trade since #446 as
// "an acceptable price for the video actually appearing"; from 0.7.0 it is the behaviour on
// both platforms. If your idle-clip return stopped working, this constant is why — and the
// `isProducing` prop is the way back: pass `isLiveTrackProducing` to restore the strict gate
// on a platform/track combination where you have measured that it works.
//
// A disconnect and a track `ended` still tear the live layer down, on both platforms.
const RN_WEBRTC_IS_PRODUCING = isNativeLiveTrackSubscribed;

/** What the surface hands `renderIdleVideo` — enough to drop in any RN player. */
export type IdleVideoRender = {
  /** The idle clip URL (never null — the callback only runs when one exists). */
  url: string;
  /** Absolute-fill style for the player, matching the other layers' box. */
  style: StyleProp<ViewStyle>;
  /** The surface's fit, as the player's resize semantic ("cover" | "contain"). */
  resizeMode: AvatarVideoFit;
};

export type AvatarVideoSurfaceProps = {
  /**
   * The avatar's idle/ambient clip URL, layered OVER the {@link poster} floor
   * via {@link renderIdleVideo}. Pass `null` for avatars with no idle clip;
   * the poster floor then shows at rest.
   */
  idleVideoUrl: string | null;
  /**
   * Renders the idle clip with the APP's video player (expo-video,
   * react-native-video, …) — native has no built-in <video>, and the SDK does
   * not pick a player for you. Loop it and keep it muted. When omitted, the
   * idle layer is skipped and the poster is the resting floor.
   */
  renderIdleVideo?: (idle: IdleVideoRender) => ReactNode;
  /**
   * The avatar's PORTRAIT (its face) — the DEEPEST floor, behind the idle clip
   * and the live video. It paints immediately and is the guaranteed no-frames
   * backdrop, so the surface is never a black box while connecting / listening
   * / between turns. Pass `null` to fall through to the app's own floor.
   */
  poster?: string | null;
  /**
   * The caller's INTENT to show the live stream. Still gated on the LiveKit
   * connection state and a subscribed, PRODUCING video track, so a stale `true`
   * can never leave a frozen/black live layer up. Default true.
   */
  live?: boolean;
  /**
   * Override "is the avatar's live video track producing frames?".
   *
   * Defaults to {@link isNativeLiveTrackSubscribed} — subscribed and not ended — which is
   * correct on BOTH React Native platforms as of 0.7.0 (see `RN_WEBRTC_IS_PRODUCING`).
   * The escape hatch exists because that default is a judgement about a shim this SDK does
   * not own: it trades the idle-clip return at turn end for the live layer appearing at all,
   * and an app that has MEASURED the strict signal working on its own devices can pass
   * `isLiveTrackProducing` to take the finer gate back. Both predicates are exported from
   * `realtime-avatar/react-native`.
   *
   * Must be REFERENTIALLY STABLE (module-level, or `useCallback`) — it is an effect
   * dependency inside {@link useLiveTrackProducing}, so an inline arrow re-subscribes the
   * track listeners every render.
   */
  isProducing?: (videoTrack: TrackReferenceOrPlaceholder | undefined) => boolean;
  /** Enable the subscriber-side quality governor (stats + SFU-pause tiers). Default true. */
  adaptiveQuality?: boolean;
  /** How media fits the box — mirrors CSS object-fit. Both layers share it. Default "contain". */
  fit?: AvatarVideoFit;
  /** Crossfade duration (ms) between idle and live. Default 500. */
  crossfadeMs?: number;
  /**
   * Debounce (ms) before dropping BACK to the idle/poster floor once the live
   * layer stops, so back-to-back turns don't flash the floor between them.
   * Default 700. A disconnect bypasses this and reverts immediately.
   */
  idleReturnDelayMs?: number;
  /** Style for the box (the layers fill it). The CONSUMER owns the aspect box. */
  style?: StyleProp<ViewStyle>;
  /** Overlay content rendered above both media layers (badges, chrome, scrims). */
  children?: ReactNode;
  /** Surface a small "live · WxH" badge when the live layer is shown. Default true. */
  showLiveBadge?: boolean;
  /**
   * Reclaim the flat 0.5s de-jitter cushion on clean networks — the same opt-in
   * closed loop the web surface takes, sharing the same implementation. Default
   * **false**. The loop is stats-driven (no rVFC), so it behaves identically on
   * iOS and Android; a receiver whose WebRTC shim exposes no `getStats` simply
   * keeps the flat cushion.
   */
  adaptivePlayout?: boolean;
  /**
   * Called with the receiver playout depth (SECONDS) whenever it changes — the flat
   * default while `adaptivePlayout` is off, the live value while it is on.
   *
   * Read this if anything you render is timed against the avatar's VOICE. The media rides
   * the receiver buffer and a side channel (captions, a transcript reveal) does not, so it
   * has to be held by the same amount or it arrives early — and once the depth moves, a
   * hard-coded copy is wrong by however far the loop has descended. Web got this in 0.5.2;
   * shipping `adaptivePlayout` here without it hands a native consumer the latency knob and
   * no way to keep anything in sync with the voice it just un-buffered.
   */
  onPlayoutDelayChange?: (seconds: number) => void;
  /** Test id for the box. */
  testID?: string;
};

/**
 * The native avatar video surface: one box rendering the poster floor, the
 * (app-injected) idle clip, and the realtime LiveKit video as pixel-aligned
 * layers with a crossfade — falling back to the idle/poster floor whenever the
 * realtime session is not connected or producing. Must be rendered inside a
 * LiveKit room context (e.g. under the native `RealtimeAvatarLiveKitRoom`).
 */
export function AvatarVideoSurface(props: AvatarVideoSurfaceProps): ReactElement {
  const {
    idleVideoUrl,
    renderIdleVideo,
    poster = null,
    live = true,
    isProducing = RN_WEBRTC_IS_PRODUCING,
    adaptiveQuality = true,
    fit = "contain",
    crossfadeMs = 500,
    idleReturnDelayMs = 700,
    style,
    children,
    showLiveBadge = true,
    adaptivePlayout = false,
    onPlayoutDelayChange,
    testID,
  } = props;

  const { videoTrack, audioTrack } = useVoiceAssistant();
  // The native de-jitter cushion, same as web: equal playout delay on both
  // tracks keeps lips locked. Where the native receiver lacks the hint the SDK
  // warns and moves on — calling it is always safe.
  useAvatarPlayoutDelay(videoTrack, audioTrack);
  // Opt-in descent from that cushion toward the 150ms floor on clean paths;
  // shared with web, so the two surfaces can never drift on the buffer law.
  const playoutDelaySeconds = useAvatarAdaptivePlayoutDelay(
    videoTrack,
    audioTrack,
    adaptivePlayout,
  );
  // Publish the depth, same contract as web: a native consumer timing a caption against her
  // voice needs the live value, not the constant it used to be safe to assume.
  const onPlayoutDelayChangeRef = useRef(onPlayoutDelayChange);
  onPlayoutDelayChangeRef.current = onPlayoutDelayChange;
  useEffect(() => {
    onPlayoutDelayChangeRef.current?.(playoutDelaySeconds);
  }, [playoutDelaySeconds]);
  const connectionState = useConnectionState();
  const connected = connectionState === ConnectionState.Connected;
  // NO PLATFORM CONDITION HERE, deliberately: react-native-webrtc's remote track behaves
  // the same on both, so both get the coarse gate (`RN_WEBRTC_IS_PRODUCING`, overridable
  // via the `isProducing` prop). The web twin keeps the strict default untouched.
  const trackProducing = useLiveTrackProducing(videoTrack, isProducing);
  useAvatarQualityGovernor({ enabled: adaptiveQuality });

  // No rVFC on native → no frame-flow stall gate; producing + connected is the
  // liveness signal. A disconnect bypasses the idle-return debounce (a dead
  // room is never held on screen), exactly like the web surface.
  const liveWanted = live && connected && trackProducing;
  const showLive = useDebouncedHide(liveWanted, connected ? idleReturnDelayMs : 0);

  // Crossfade with the platform's compositor (native driver): opacity animates
  // on the UI thread, so a busy JS thread can't stall the fade mid-turn.
  const liveOpacity = useRef(new Animated.Value(showLive ? 1 : 0)).current;
  useEffect(() => {
    const animation = Animated.timing(liveOpacity, {
      toValue: showLive ? 1 : 0,
      duration: crossfadeMs,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [showLive, crossfadeMs, liveOpacity]);

  // On Android the live video draws BELOW the window, so an opaque floor over its
  // rect hides it — suppress the poster/idle floor while the live layer is up (it
  // reappears the instant `showLive` drops). iOS composites the video above the
  // floor normally, so the floor stays mounted there (it's simply covered).
  const floorHidden = IS_ANDROID && showLive;
  const layers = resolveSurfaceLayers({
    idleVideoUrl: floorHidden ? null : idleVideoUrl,
    poster: floorHidden ? null : poster,
  });
  const resizeMode: ImageResizeMode = fit === "cover" ? "cover" : "contain";
  const liveDims = videoTrack?.publication?.dimensions ?? null;
  const liveLabel =
    showLive && liveDims && liveDims.width > 0 && liveDims.height > 0
      ? `live · ${liveDims.width}×${liveDims.height}`
      : "live";

  const posterLayer = layers.showPoster
    ? createElement(Image, {
        key: "poster",
        source: { uri: poster as string },
        resizeMode,
        style: styles.layer,
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants" as const,
        testID: "avatar-poster",
      })
    : null;

  const idleLayer =
    layers.showIdleVideo && renderIdleVideo
      ? createElement(
          View,
          { key: "idle", style: styles.layer, pointerEvents: "none" as const, testID: "avatar-idle-video" },
          renderIdleVideo({ url: idleVideoUrl as string, style: styles.layer, resizeMode: fit }),
        )
      : null;

  const liveVideo = isTrackReference(videoTrack)
    ? createElement(VideoTrack, {
        trackRef: videoTrack,
        objectFit: fit,
        style: StyleSheet.absoluteFillObject,
        // Remote avatar video is the background layer on Android (below the window);
        // the floor is hidden while it shows so it isn't occluded. Ignored on iOS.
        ...(IS_ANDROID ? { zOrder: ANDROID_REMOTE_ZORDER } : {}),
      })
    : null;

  // iOS: the live layer stays MOUNTED and fades on opacity (same as web), so a
  // first frame appears under a fade rather than a mount hitch. Android: alpha does
  // nothing on a SurfaceView, so we mount the live layer only while it should show —
  // the idle/poster floor shows through when it's unmounted. Note that under the
  // default `isProducing` the layer is shown for the whole session rather than
  // per-turn, so this fade runs at session start/end, not at every turn boundary.
  const frontLayer = IS_ANDROID
    ? createElement(
        View,
        {
          key: "live",
          style: styles.layer,
          pointerEvents: "none" as const,
          testID: "avatar-live-layer",
        },
        showLive ? liveVideo : null,
      )
    : createElement(
        Animated.View,
        {
          key: "live",
          style: [styles.layer, { opacity: liveOpacity }],
          pointerEvents: "none" as const,
          testID: "avatar-live-layer",
        },
        liveVideo,
      );

  const badge =
    showLiveBadge && showLive
      ? createElement(
          View,
          { key: "badge", style: styles.badge, pointerEvents: "none" as const },
          createElement(View, { key: "dot", style: styles.badgeDot }),
          createElement(Text, { key: "label", style: styles.badgeText }, liveLabel),
        )
      : null;

  return createElement(
    View,
    { style: [styles.box, style], testID },
    posterLayer,
    idleLayer,
    frontLayer,
    badge,
    children,
  );
}

const styles = StyleSheet.create({
  box: {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  },
  layer: StyleSheet.absoluteFillObject,
  badge: {
    position: "absolute",
    top: 8,
    left: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#34d399",
  },
  badgeText: {
    color: "rgba(255,255,255,0.92)",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
});
