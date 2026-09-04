import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * The connect watchdog must not fire on a call that is already connected.
 *
 * Shipped in 0.7.0 to catch the opposite problem — a grant that lands and then goes
 * nowhere, holding a slot until the platform's own join timeout, which on the 1-seat free
 * tier is a total lockout. That part is right and is pinned by never-strand-a-grant.test.ts.
 *
 * What it also caught, and must not, is an ESTABLISHED call. `onConnectionStateChange`
 * clears `connected` the moment LiveKit reports `reconnecting`/`signalReconnecting` and
 * moves recovery to `in-place-reconnecting` — which is precisely the state this effect arms
 * on. So between 0.7.0 and this fix, any transient blip lasting more than the 12s default
 * (a backgrounded tab, wifi handing over to cellular, a tunnel) was escalated from a
 * recovery LiveKit was already performing into a hard `releaseLiveKitSession` plus a full
 * re-mint. The room the video element was rendering went away and the element held its last
 * decoded frame, so the user watched the character freeze mid-conversation.
 *
 * It is invisible in platform metrics, which is why it needs a test rather than a dashboard:
 * the old session releases cleanly, a fresh one mints and joins, so join rate and average
 * duration both stay healthy while the experience is broken.
 *
 * A SOURCE pin, matching never-strand-a-grant.test.ts and busy-retry-floor.test.ts: these
 * files keep extensionless internal imports that node's type-stripping runner cannot
 * resolve, and re-shaping them to be importable is the divergence a carry wants least.
 */

const SOURCE = new URL("../src/react/session-lifecycle.ts", import.meta.url);

test("the watchdog stands down while LiveKit is reconnecting in place", async () => {
  const source = await readFile(SOURCE, "utf-8");

  assert.match(
    source,
    /if \(recovery\.kind === "in-place-reconnecting"\) return;/,
    "the watchdog no longer exempts `in-place-reconnecting` — a transient blip over the watchdog "
      + "window now hard-releases a live call and re-mints it, freezing the character on screen",
  );
});

test("the exemption is inside the watchdog effect, not some other guard", async () => {
  const source = await readFile(SOURCE, "utf-8");

  // Anchored on the two conditions that uniquely identify this effect — the `connected`
  // short-circuit it arms on, and the held-grant precondition — so moving the line into an
  // unrelated guard elsewhere in the file cannot satisfy the test above.
  const effect = source.slice(source.indexOf("if (!active || connected || connectWatchdogMs <= 0) return;"));
  const body = effect.slice(0, effect.indexOf("connectWatchdogMs);"));

  assert.ok(body.length > 0, "the watchdog effect could not be located — has its guard been renamed?");
  assert.match(body, /grantState\.status !== "ready"/, "wrong region: this is not the watchdog effect");
  assert.match(
    body,
    /in-place-reconnecting/,
    "the in-place-reconnect exemption is not inside the watchdog effect itself",
  );
});

test("the watchdog still guards the case it was built for", async () => {
  const source = await readFile(SOURCE, "utf-8");

  // The fix must not disarm the watchdog wholesale. A grant that is ready and has never
  // connected still has to be released, or the 0.7.0 strand returns.
  assert.match(
    source,
    /releaseRef\.current\("disconnected"\);/,
    "the watchdog no longer releases a grant that never connected",
  );
  assert.match(
    source,
    /export const DEFAULT_CONNECT_WATCHDOG_SECONDS = \d+;/,
    "the watchdog default is gone entirely — this fix was meant to narrow it, not remove it",
  );
});
