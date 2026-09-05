/**
 * Make a livekit-client `Room` render her the way the React surface does — without React.
 *
 * One call after `new Room()`, before `connect()`: every remote track the room
 * subscribes, audio and video alike, gets the receiver playout cushion from
 * `./playout-delay.ts` (0.5s; the measured freeze-free depth), and any track that is
 * already subscribed gets it immediately. Nobody embedding the SDK should have to
 * know that knob exists: a plain page that forgot it froze on every lost packet while
 * a React page next to it did not, and the only difference was one hidden call.
 *
 * `attachRemoteAudio` calls this for you, so the documented vanilla pattern is
 * covered without a second line. Calling it twice on one room is safe: the second
 * call returns the same handle and, if it names a different delay, re-applies that
 * delay to the tracks already on screen. `detach()` stops listening; it does not
 * undo the hint on tracks already carrying it (a shallower buffer mid-call would
 * only bring the freezes back).
 *
 * Structural like its siblings — no `livekit-client` import, no version pin.
 * Anything with `on`/`off` and (optionally) `remoteParticipants` satisfies it.
 */
import { applyPlayoutDelay, DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS } from "./playout-delay.ts";

const TRACK_SUBSCRIBED = "trackSubscribed";

/** The sliver of a livekit-client `Room` this needs. */
export interface PreparableRoom {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  /** Read once, so tracks subscribed BEFORE this call are covered too. Optional on purpose. */
  remoteParticipants?: Iterable<[unknown, PreparableParticipant]> | { values(): Iterable<PreparableParticipant> };
}

/** The sliver of a livekit-client `RemoteParticipant` this needs. */
export interface PreparableParticipant {
  trackPublications?: Iterable<[unknown, { track?: unknown }]> | { values(): Iterable<{ track?: unknown }> };
}

export interface PrepareAvatarRoomOptions {
  /** Receiver cushion in seconds for every remote track. Default 0.5 — see `./playout-delay.ts`. */
  playoutDelaySeconds?: number;
}

export interface PreparedAvatarRoom {
  /** Stop applying the cushion to tracks subscribed from now on. Idempotent. */
  detach(): void;
  /** The delay currently applied to new tracks. */
  readonly playoutDelaySeconds: number;
}

interface Prepared {
  delay: number;
  listener: (...args: never[]) => void;
  handle: PreparedAvatarRoom;
}

/** Per-room state, keyed weakly so a torn-down room takes its entry with it. */
const prepared = new WeakMap<object, Prepared>();

export function prepareAvatarRoom(
  room: PreparableRoom,
  options: PrepareAvatarRoomOptions = {},
): PreparedAvatarRoom {
  const requested = options.playoutDelaySeconds;
  const existing = prepared.get(room);
  if (existing) {
    // Same room, second caller (say, attachRemoteAudio after an explicit call, or the
    // reverse): one listener, and the most recent explicit delay wins — re-applied to
    // what is already on screen so the pair never sits at two different depths.
    if (requested !== undefined && requested !== existing.delay) {
      existing.delay = requested;
      applyToExisting(room, requested);
    }
    return existing.handle;
  }
  const state: Prepared = {
    delay: requested ?? DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS,
    listener: ((track: unknown) => {
      const current = prepared.get(room);
      applyPlayoutDelay(track, current ? current.delay : DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS);
    }) as (...args: never[]) => void,
    handle: {
      get playoutDelaySeconds() {
        return prepared.get(room)?.delay ?? state.delay;
      },
      detach() {
        const live = prepared.get(room);
        if (!live) return;
        room.off(TRACK_SUBSCRIBED, live.listener);
        prepared.delete(room);
      },
    },
  };
  prepared.set(room, state);
  room.on(TRACK_SUBSCRIBED, state.listener);
  applyToExisting(room, state.delay);
  return state.handle;
}

function applyToExisting(room: PreparableRoom, delay: number): void {
  for (const participant of values(room.remoteParticipants)) {
    for (const publication of values(participant?.trackPublications)) {
      if (publication?.track) applyPlayoutDelay(publication.track, delay);
    }
  }
}

/**
 * A Map, an iterable of entries, or nothing — livekit-client uses Maps; a fake may not.
 * Iterables come first: a Map, an Array and a Set all iterate as `[key, value]` entries,
 * and all three also have a `.values()` whose meaning differs (an Array's yields the
 * entries themselves), so the entry shape is the one thing they agree on.
 */
function values<T>(
  source: Iterable<[unknown, T]> | { values(): Iterable<T> } | undefined,
): Iterable<T> {
  if (!source) return [];
  if (Symbol.iterator in (source as object)) {
    return Array.from(source as Iterable<[unknown, T]>, ([, value]) => value);
  }
  return (source as { values(): Iterable<T> }).values();
}
