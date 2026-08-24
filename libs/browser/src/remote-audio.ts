/**
 * Making the character AUDIBLE — the half of "audio works" that has nothing to do with the
 * microphone.
 *
 * WHY THIS EXISTS. Two failures here look identical to a developer ("she never speaks") and
 * neither raises anything:
 *
 *  1. The audio element is created but never inserted into the document. `track.attach()`
 *     hands back a detached `<audio>`; a detached element is not reliably played by every
 *     engine, and there is no node on the page to fall back to. Nothing errors — the call is
 *     connected, the track is subscribed, the meter moves, and it is silent.
 *  2. Autoplay is blocked. A page that has not yet had a user gesture may not start audio,
 *     so the first call a visitor makes is mute. `room.startAudio()` fixes it, but it must be
 *     called FROM a gesture — which means the page needs a button, which means the page has
 *     to know it is blocked. That signal is an event nobody subscribes to.
 *
 * So this owns both: it attaches into the DOM, and it tells you when a gesture is required
 * and hands you the closure that spends it.
 *
 * Structural like its sibling — no `livekit-client` import, no version pin.
 */

/** LiveKit's event name for "audio playback became allowed or blocked". Verified against
 *  `RoomEvent.AudioPlaybackStatusChanged` in livekit-client; it is not the enum's key. */
const AUDIO_PLAYBACK_CHANGED = "audioPlaybackChanged";
/** `RoomEvent.TrackSubscribed`. */
const TRACK_SUBSCRIBED = "trackSubscribed";
/** `Track.Kind.Audio`. */
const AUDIO_KIND = "audio";

/** The sliver of a livekit-client `Track` this needs. */
export interface AttachableTrack {
  kind: string;
  attach(): HTMLMediaElement;
  detach(): HTMLMediaElement[];
}

/** The sliver of a livekit-client `Room` this needs. */
export interface AudioCapableRoom {
  canPlaybackAudio: boolean;
  startAudio(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

export interface AttachRemoteAudioOptions {
  /**
   * Where to park the audio elements. Defaults to `document.body`.
   *
   * They are not `display:none` — a hidden media element is still subject to the same
   * autoplay rules, and hiding it only removes the browser's own affordance.
   */
  container?: HTMLElement;
  /**
   * Called when the browser refuses to start audio without a gesture, and again with `null`
   * once audio is playing. Render a button from it and call `unblock` in the click handler:
   *
   * ```ts
   * onPlaybackBlocked: (unblock) => {
   *   button.hidden = unblock === null;
   *   button.onclick = () => unblock?.();
   * }
   * ```
   */
  onPlaybackBlocked?: (unblock: (() => Promise<void>) | null) => void;
}

export interface RemoteAudioAttachment {
  /** Stop listening and remove every element this created. Safe to call twice. */
  detach(): void;
}

/**
 * Play every remote audio track the room subscribes to, and surface an autoplay block.
 *
 * Call it BEFORE `room.connect()` — a track subscribed during connect is missed otherwise,
 * and that race is the version of this bug that only reproduces on a fast connection.
 *
 * ```ts
 * const audio = attachRemoteAudio(room, {
 *   onPlaybackBlocked: (unblock) => {
 *     enableSound.hidden = unblock === null;
 *     enableSound.onclick = () => unblock?.();
 *   },
 * });
 * await room.connect(url, token);
 * // …later
 * audio.detach();
 * ```
 */
export function attachRemoteAudio(
  room: AudioCapableRoom,
  options: AttachRemoteAudioOptions = {},
): RemoteAudioAttachment {
  const container = options.container ?? document.body;
  const elements = new Set<HTMLMediaElement>();
  let detached = false;

  const publishPlaybackState = () => {
    if (detached) return;
    // `startAudio` must be invoked from the gesture itself, so hand out the closure rather
    // than a boolean — the caller cannot accidentally call it too late.
    options.onPlaybackBlocked?.(room.canPlaybackAudio ? null : () => room.startAudio());
  };

  const onTrackSubscribed = (track: AttachableTrack) => {
    if (detached || track.kind !== AUDIO_KIND) return;
    const element = track.attach();
    element.autoplay = true;
    // The local participant is not subscribed to their own track, so nothing here is the
    // caller's own microphone — muting would only silence the character.
    container.appendChild(element);
    elements.add(element);
    // Attaching is itself a moment the block can become observable.
    publishPlaybackState();
  };

  room.on(TRACK_SUBSCRIBED, onTrackSubscribed as (...args: never[]) => void);
  room.on(AUDIO_PLAYBACK_CHANGED, publishPlaybackState as (...args: never[]) => void);

  // Report the state we are already in, so a caller that mounts late still renders correctly.
  publishPlaybackState();

  return {
    detach() {
      if (detached) return;
      detached = true;
      room.off(TRACK_SUBSCRIBED, onTrackSubscribed as (...args: never[]) => void);
      room.off(AUDIO_PLAYBACK_CHANGED, publishPlaybackState as (...args: never[]) => void);
      for (const element of elements) element.remove();
      elements.clear();
    },
  };
}
