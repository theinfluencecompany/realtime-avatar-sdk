import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Pins the busy-retry floor in src/react/livekit.ts against a carry sync. That file is a
 * scrubbed copy of the upstream SDK, and before the floor a proxy 429 without
 * recommended_retry_ms made the retry delay Math.max(undefined, 250) = NaN — and
 * setTimeout(fn, NaN) fires IMMEDIATELY, a mint loop as fast as the network against the very
 * rate limiter that answered.
 *
 * This is a SOURCE pin, not an import, on purpose: livekit.ts keeps the upstream's
 * extensionless internal imports ("./mic-single-flight"), which node's type-stripping test
 * runner cannot resolve, and re-shaping the carry to make it importable is more divergence —
 * the thing a carry wants least. A sync that reverts the guard flips both assertions.
 */
test("livekit.ts keeps the NaN-proof retry floor (carry-sync tripwire)", async () => {
  const source = await readFile(new URL("../src/react/livekit.ts", import.meta.url), "utf-8");
  assert.match(
    source,
    /Math\.max\(Number\.isFinite\(hinted\) \? hinted : 5_000, 250\)/,
    "the guarded retry floor is gone — an upstream sync likely clobbered livekit.ts; re-apply the fix from PR #30",
  );
  assert.doesNotMatch(
    source,
    /Math\.max\(state\.busy\.recommended_retry_ms, 250\)/,
    "the pre-fix retry expression is back — Math.max(undefined, 250) is NaN and setTimeout(fn, NaN) fires immediately",
  );
});
