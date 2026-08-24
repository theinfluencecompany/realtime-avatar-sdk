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
// Platform differences, by design:
//   - The live layer is @livekit/react-native's <VideoTrack> (a native RTCView).
//     On iOS that RTCView is a UIView, so it composites like any other layer:
//     it crossfades with RN's Animated opacity (native driver) and sits in tree
//     order above the poster/idle floor. ANDROID's RTCView is a SurfaceView on
//     its OWN hardware layer, which breaks both of those assumptions — see
//     `IS_ANDROID` below.
//   - There is no <video> element on native, so the IDLE CLIP is app-injected
//     via `renderIdleVideo` (bring expo-video / react-native-video — the SDK
//     stays player-agnostic instead of hard-depending on one). Without it the
//     poster is the resting floor, exactly like a web avatar with no idle clip.
//   - No requestVideoFrameCallback on native → no frame-flow stall detection;
//     liveness gates on connection state + the MediaStreamTrack producing
//     signal (mute/unmute/ended fire on RN's WebRTC shim too).
// ---------------------------------------------------------------------------
import {
  isTrackReference,
  useConnectionState,
  useVoiceAssistant,
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
import { useAvatarQualityGovernor } from "../react/use-quality-governor";

// Android's <VideoTrack> renders an RTCView backed by a SurfaceView — a separate
// hardware layer, NOT a normal view in the RN tree. Two SurfaceView facts break the
// DOM-shaped layer model this surface inherits from the web twin, and together they
// make the avatar show as "voice only" on Android while iOS is fine:
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
    adaptiveQuality = true,
    fit = "contain",
    crossfadeMs = 500,
    idleReturnDelayMs = 700,
    style,
    children,
    showLiveBadge = true,
    testID,
  } = props;

  const { videoTrack, audioTrack } = useVoiceAssistant();
  // The native de-jitter cushion, same as web: equal playout delay on both
  // tracks keeps lips locked. Where the native receiver lacks the hint the SDK
  // warns and moves on — calling it is always safe.
  useAvatarPlayoutDelay(videoTrack, audioTrack);
  const connectionState = useConnectionState();
  const connected = connectionState === ConnectionState.Connected;
  // Android needs the coarse subscribed-and-not-ended gate (see
  // isNativeLiveTrackSubscribed); iOS/default keeps the strict web predicate.
  const trackProducing = useLiveTrackProducing(
    videoTrack,
    IS_ANDROID ? isNativeLiveTrackSubscribed : undefined,
  );
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

  // iOS: the live layer stays MOUNTED at opacity 0 between turns (same as web) so
  // the next turn's first frame appears under a fade, not a mount hitch. Android:
  // alpha does nothing on a SurfaceView, so we mount the live layer only while it
  // should show — the idle/poster floor shows through when it's unmounted.
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
