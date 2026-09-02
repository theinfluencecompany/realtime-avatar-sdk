import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Two ways the SDK used to strand a capacity slot, pinned against a carry sync.
 *
 * Measured in production over 24h (2026-09-01/02): 28 of 66 real mint attempts were
 * refused with `concurrency_limit_reached`, and EVERY one was a tenant blocked by its
 * own hold — zero cross-tenant. The free tier advertises exactly 1 concurrent stream,
 * so a single stranded session is a total lockout, and the user's next attempt is
 * refused by a call they may never have seen.
 *
 * These are SOURCE pins, not imports, following busy-retry-floor.test.ts: these files
 * keep the upstream's extensionless internal imports, which node's type-stripping test
 * runner cannot resolve, and re-shaping the carry to make it importable is exactly the
 * divergence a carry wants least. A sync that reverts either fix flips an assertion.
 */

test("a grant that lands after the effect is cancelled is released, not stranded", async () => {
  const source = await readFile(new URL("../src/react/livekit.ts", import.meta.url), "utf-8");

  // The fix: the cancelled branch releases the grant it is about to drop.
  assert.match(
    source,
    /if \(cancelled\) \{\s*\n\s*if \(result\.status !== "busy"\) \{\s*\n\s*void client\.releaseLiveKitSession\(result\.grant\.session_id, "superseded"\);/,
    "the cancelled-effect branch no longer releases the grant it drops — a mint in flight at unmount/avatar-switch strands the slot for the platform's whole join timeout",
  );

  // The pre-fix shape: a bare early return before heldSessionRef was ever assigned,
  // so releaseHeld() had nothing to free and nothing else knew the session existed.
  assert.doesNotMatch(
    source,
    /\.then\(\(result\) => \{\s*\n\s*if \(cancelled\) return;/,
    "the bare `if (cancelled) return;` is back at the top of the grant .then() — the arriving grant is dropped with no release",
  );
});

test("the reconnect ladder releases the dead slot BEFORE asking for a fresh grant", async () => {
  const source = await readFile(new URL("../src/react/session-lifecycle.ts", import.meta.url), "utf-8");

  // Both ladders — the bounded auto-reconnect and the manual tap — must release first.
  // `useLiveKitAvatarGrant` does release the superseded session, but only once the NEW
  // grant lands; on a 1-seat plan that ordering cannot converge, because the re-mint is
  // refused precisely because the old session is still held.
  const releasesBeforeRefresh = source.match(/releaseRef\.current\("superseded"\);(?:\s*\/\/[^\n]*\n)*\s*setRecovery\(\{ kind: "refreshing"/g);
  assert.equal(
    releasesBeforeRefresh?.length,
    2,
    "expected BOTH reconnect paths (auto ladder + manual reconnect) to release the held slot before re-minting; a 1-seat plan otherwise burns its whole retry budget against its own corpse",
  );

  // Neither path may dispatch a refresh without having released first.
  const refreshSites = source.match(/refreshRef\.current\(\);/g) ?? [];
  assert.equal(refreshSites.length, 2, "a new refreshRef call site appeared — does it release the held slot first?");
});

test("an unconnected grant is given back before the platform's join timeout", async () => {
  const source = await readFile(new URL("../src/react/session-lifecycle.ts", import.meta.url), "utf-8");

  // The default must stay well under the platform's 75s join timeout — the whole
  // point is to free the slot BEFORE a retrying caller collides with it (clients were
  // observed retrying every ~7.3s).
  const declared = source.match(/export const DEFAULT_CONNECT_WATCHDOG_SECONDS = (\d+);/);
  assert.ok(declared, "DEFAULT_CONNECT_WATCHDOG_SECONDS is gone — an unconnected grant would hold its slot for the platform's full join timeout");
  const seconds = Number(declared[1]);
  assert.ok(seconds > 0 && seconds <= 20, `connect watchdog is ${seconds}s; it must be well under the platform's 75s join timeout to be useful`);

  // It must RELEASE, not merely re-render, and hand off to the bounded ladder so a
  // room that never comes up ends in `failed` rather than retrying forever.
  assert.match(
    source,
    /releaseRef\.current\("disconnected"\);[\s\S]{0,220}setRecovery\(\{ kind: "reconnecting", attempt: attemptRef\.current \}\)/,
    "the watchdog no longer releases the slot and hands off to the bounded ladder carrying the current attempt (resetting the attempt would retry forever)",
  );

  // It must not fire on a queued request: a queue holds a ticket, not a session.
  assert.match(
    source,
    /if \(grantState\.status !== "ready" \|\| !grantState\.grant\) return;/,
    "the watchdog must only arm for a HELD grant — arming while queued would release a ticket the queue loop is waiting on",
  );
});
