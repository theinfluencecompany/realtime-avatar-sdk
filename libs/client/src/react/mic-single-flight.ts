// Tab-global single-flight for LOCAL microphone acquisition.
//
// The browser hands the live capture device to ONE getUserMedia consumer at a
// time. When a call ends and the user redials within seconds — a new character,
// the same character, an accidental double-tap — a SECOND realtime-avatar room
// can mount and enable its mic BEFORE the previous room's local audio track has
// finished stopping. The new room then publishes a contended track that yields
// no samples: the agent hears presence but zero words, every "transcript" holds
// only her lines, and she begs "are you still there?" while the caller talks.
// (Observed 2026-07-29 as the residual ~16% ghost-mic AFTER the intra-call race
// fix #1115 — every case a redial 11–66s after a working call from the same user
// whose live windows OVERLAPPED.)
//
// #1115 collapsed the TWO controllers WITHIN one call onto a single `micLive`
// signal so they can't disagree. This is the orthogonal, CROSS-call guard: a
// serialization barrier so that at most one room holds the mic in this tab, and
// a later acquirer waits for the earlier holder to RELEASE (its track reaching
// `ended`) before it acquires. It gates only acquisition TIMING — once acquired,
// the room owns the mic exactly as before, so the single-signal invariant is
// preserved (no per-session imperative toggling is reintroduced).
//
// The pure lease (acquire/release below) is framework-free so it is unit-testable
// and shared by web + react-native; `useMicLease` is the thin React binding.
// The lease is a FIFO of waiters keyed by an opaque token (one per room mount).

import { useEffect, useRef, useState } from "react";

type Waiter = { token: symbol; resolve: () => void };

let holder: symbol | null = null;
const queue: Waiter[] = [];

// A holder that has begun releasing but is WAITING for its local mic track to
// actually reach `ended` before it hands the lease on. `Room.disconnect()` stops
// the local track on a NON-awaited path (livekit-client 2.19.2), so the browser
// keeps the capture device for a beat after React teardown — handing the lease on
// at that moment lets the next call's getUserMedia collide with the still-closing
// device (the exact contention this lease exists to prevent). While a token is
// `pendingEnded`, the lease is NOT handed on; the next holder waits until either
// the track's `ended` event lands (confirmMicTrackEnded) or a safety timeout.
let pendingEnded: symbol | null = null;

/**
 * Acquire the tab's single mic lease for `token`. Resolves immediately when the
 * lease is free (or already held by this same token — re-acquire is idempotent),
 * otherwise resolves once every earlier holder/waiter has released, in FIFO order.
 * Never rejects: acquisition is a barrier, not a fallible operation.
 */
export function acquireMicLease(token: symbol): Promise<void> {
	if (holder === null || holder === token) {
		holder = token;
		// Re-acquiring while a deferred release was pending for this same token (the
		// user tapped Speak again before the track ended / the timeout fired) CANCELS
		// that release — the token keeps the lease, and a late `ended` must not free it.
		if (pendingEnded === token) pendingEnded = null;
		return Promise.resolve();
	}
	// Already queued (a re-render firing the effect twice) → return a promise that
	// settles with the existing waiter rather than enqueuing a duplicate.
	const existing = queue.find((w) => w.token === token);
	if (existing) {
		return new Promise<void>((resolve) => {
			const prior = existing.resolve;
			existing.resolve = () => {
				prior();
				resolve();
			};
		});
	}
	return new Promise<void>((resolve) => {
		queue.push({ token, resolve });
	});
}

/**
 * Release the lease held by `token`. No-op if `token` is not the current holder
 * (already released, or never acquired — e.g. a text-mode room that never leased),
 * so a supersede + an unmount + a pagehide can all fire and free it exactly once.
 * Hands the lease to the next FIFO waiter, if any.
 */
export function releaseMicLease(token: symbol): void {
	// A queued-but-not-yet-holder token that unmounts before its turn: drop it from
	// the queue so it never acquires a lease no one will release.
	if (holder !== token) {
		const i = queue.findIndex((w) => w.token === token);
		if (i !== -1) queue.splice(i, 1);
		return;
	}
	const next = queue.shift();
	if (next) {
		holder = next.token;
		next.resolve();
	} else {
		holder = null;
	}
}

/**
 * Begin releasing the lease held by `token`, but keep it OUT of the next holder's
 * hands until the token's mic track has actually ended (confirmMicTrackEnded) or
 * `timeoutMs` elapses — whichever comes first. This is the precise release: it
 * closes the window where React has torn down but the browser is still releasing
 * the capture device. No-op if `token` isn't the current holder.
 *
 * Returns a cancel function to clear the safety timer (call it if the component
 * re-acquires or the confirm already fired). The timeout is a BACKSTOP so a track
 * that never emits `ended` (already-stopped, a browser quirk) can't wedge the
 * lease forever — after it, the handoff proceeds exactly as a plain release.
 */
export function releaseMicLeaseWhenEnded(
	token: symbol,
	timeoutMs: number,
	setTimer: (fn: () => void, ms: number) => () => void,
): () => void {
	if (holder !== token) {
		// Not the holder (queued-and-abandoned, or already released) — fall back to
		// the plain release so a queued waiter is still dropped from the FIFO.
		releaseMicLease(token);
		return () => {};
	}
	pendingEnded = token;
	const cancelTimer = setTimer(() => {
		// Safety net: the track never reported `ended`. Hand the lease on anyway.
		if (pendingEnded === token) finishPendingRelease(token);
	}, timeoutMs);
	return cancelTimer;
}

/**
 * The local mic track for `token` reached `ended` (the true hardware-release
 * signal). If this token is the one pending release, complete the handoff now.
 * No-op otherwise (a late/duplicate event, or a token that released plainly).
 */
export function confirmMicTrackEnded(token: symbol): void {
	if (pendingEnded === token) finishPendingRelease(token);
}

/** Complete a deferred release: clear the pending flag, then hand off / free. */
function finishPendingRelease(token: symbol): void {
	pendingEnded = null;
	releaseMicLease(token);
}

/** The token currently holding the mic lease (or null). Test/introspection only. */
export function currentMicLeaseHolder(): symbol | null {
	return holder;
}

/** The token pending an `ended`-gated release, if any. Test/introspection only. */
export function pendingMicLeaseRelease(): symbol | null {
	return pendingEnded;
}

/** How long the deferred (`ended`-gated) release waits for the track's `ended`
 *  event before handing the lease on anyway. A backstop against a track that
 *  never fires `ended`; comfortably longer than a normal stop (~tens of ms). */
export const MIC_LEASE_ENDED_TIMEOUT_MS = 1500;

export type MicLease = {
	/** True once THIS room owns the lease — fold into the mic-intent signal. */
	held: boolean;
	/** Stable per-mount lease token. Pass to {@link useReleaseMicLeaseOnTrackEnded}
	 *  (rendered INSIDE the room) to release on the real hardware `ended` signal. */
	token: symbol;
};

/**
 * React binding for the tab-global mic lease. Pass `want=true` when this room
 * intends to hold the live microphone (a voice-first / speak-mode call); pass
 * `false` for a text-mode room that must not touch the mic. Returns `{ held,
 * token }` — the caller folds `held` into its single mic-intent signal
 * (`micLive = want && held`), so a rapid redial keeps its mic OFF until the
 * previous call's room has released, and no two rooms contend for getUserMedia.
 *
 * RELEASE is DEFERRED to the local mic track's real `ended` event when an in-room
 * {@link useReleaseMicLeaseOnTrackEnded} is mounted with this `token`: on unmount
 * / `want=false` the lease is not handed on until the browser has actually let go
 * of the capture device (or a safety timeout). Without that companion hook it
 * falls back to releasing on unmount (still correct for the dominant overlap
 * case, just coarser). Uncontended, acquisition resolves in a microtask.
 */
export function useMicLease(want: boolean): MicLease {
	// One stable identity for this room mount — the lease is keyed on it.
	const tokenRef = useRef<symbol | null>(null);
	if (tokenRef.current === null) tokenRef.current = Symbol("mic-lease");
	const token = tokenRef.current;
	const [held, setHeld] = useState(false);

	useEffect(() => {
		if (!want) {
			// Defer the release to the track's `ended` event (with a timeout backstop),
			// so the next call can't grab a still-closing device. If no in-room hook
			// ever confirms (text-mode room that never captured), the timeout frees it.
			releaseMicLeaseWhenEnded(token, MIC_LEASE_ENDED_TIMEOUT_MS, timeoutSetter);
			setHeld(false);
			return;
		}
		let alive = true;
		void acquireMicLease(token).then(() => {
			// The room may have unmounted / flipped to text while we waited in the
			// FIFO queue — don't claim a lease we've already released.
			if (alive) setHeld(true);
		});
		return () => {
			alive = false;
			// Same deferred release on unmount: hold the lease until the mic track
			// truly ends (the in-room companion fires confirmMicTrackEnded) or the
			// timeout elapses. No setHeld here (cleanup also runs on unmount).
			releaseMicLeaseWhenEnded(token, MIC_LEASE_ENDED_TIMEOUT_MS, timeoutSetter);
		};
	}, [want, token]);

	return { held, token };
}

/** setTimeout adapter with a cancel — injected so the pure lease stays timer-free. */
function timeoutSetter(fn: () => void, ms: number): () => void {
	const id = setTimeout(fn, ms);
	return () => clearTimeout(id);
}

/** Reset all lease state. TEST-ONLY — never call from product code. */
export function __resetMicLeaseForTest(): void {
	holder = null;
	pendingEnded = null;
	queue.length = 0;
}
