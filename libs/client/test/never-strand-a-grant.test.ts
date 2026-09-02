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
