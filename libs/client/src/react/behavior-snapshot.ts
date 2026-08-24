/**
 * Avatar nonverbal-behavior snapshot + its SSOT derivation.
 *
 * This is the ONE place that turns a decoded `behavior_state` frame into the app-facing
 * snapshot. Both {@link useSessionLifecycle} (opt-in `onBehaviorChange`) and
 * {@link useRealtimeSession} (`behavior` state + `onBehaviorChange`) route through
 * {@link nextBehaviorSnapshot}, so the extract + change-diff live exactly once.
 *
 * A LEAF module (no hook imports) so both hooks depend on it without an import cycle.
 */

/**
 * The avatar's live nonverbal behavior (multi-clip choreography). `state` is an OPEN
 * string so newer workers can ship new states without breaking old apps — narrow with
 * `knownBehaviorStates` and treat unknown values like `"idle"`. `clipId` is the internal
 * render clip currently playing (a debug/admin detail), or `null` before the first frame.
 */
export type BehaviorSnapshot = {
  state: string;
  clipId: string | null;
  /** WIRE clip model of the current clip — the same trigger vocabulary the session
   *  minted with ("idle" | "listen" | "directive"; "think" is retired and never emitted). `null` on pre-Tier-1
   *  workers (the fields simply aren't on the frame yet). */
  trigger: string | null;
  /** Whether the current clip is a looping resting state (vs a one-shot). */
  loop: boolean | null;
  /** The clip the last seam faded FROM (`null` before the first seam). */
  prevClipId: string | null;
};

/**
 * The next {@link BehaviorSnapshot} for a decoded `behavior_state` frame, or `null` when it
 * is UNCHANGED from `prev` — so callers fire only on a real change (no redundant renders).
 *
 * Pure: the caller owns validation (the `behavior_state` arm of `lifecycleServerFrameSchema`)
 * and the "last snapshot" ref. Keeping the extract + diff here means neither hook re-implements
 * the shape or the change rule.
 */
export function nextBehaviorSnapshot(
  prev: BehaviorSnapshot | null,
  frame: {
    state: string;
    clip_id?: string | null;
    trigger?: string | null;
    loop?: boolean | null;
    prev_clip_id?: string | null;
  },
): BehaviorSnapshot | null {
  const next: BehaviorSnapshot = {
    state: frame.state,
    clipId: frame.clip_id ?? null,
    trigger: frame.trigger ?? null,
    loop: frame.loop ?? null,
    prevClipId: frame.prev_clip_id ?? null,
  };
  if (
    prev &&
    prev.state === next.state &&
    prev.clipId === next.clipId &&
    prev.trigger === next.trigger &&
    prev.loop === next.loop &&
    prev.prevClipId === next.prevClipId
  )
    return null;
  return next;
}
