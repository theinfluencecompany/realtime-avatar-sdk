import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * One call, one mint, even under React StrictMode.
 *
 * StrictMode is on by default in a new Next.js or Vite app while developing, which is exactly
 * when a developer is wiring their first call. It runs every effect, its cleanup, and the effect
 * again, synchronously, on mount. The grant hook posted the mint straight from its effect, so one
 * "Start call" sent two: two rooms, two agent dispatches, two of the plan's concurrent-session
 * seats, with the first released as `superseded` a second later. On a plan with a small session
 * ceiling the twin is what refuses the developer's next attempt, so the first integration on a new
 * account looks flaky for reasons nothing on the page explains.
 *
 * A SOURCE pin, following never-strand-a-grant.test.ts and for the same reason: this file keeps
 * extensionless internal imports that node's type-stripping runner cannot resolve.
 */

test("the grant POST waits until StrictMode's synchronous effect pair is over", async () => {
  const source = await readFile(new URL("../src/react/livekit.ts", import.meta.url), "utf-8");

  // Deferred to a timer that re-checks `cancelled` before anything leaves the browser.
  assert.match(
    source,
    /const mintTimer = setTimeout\(\(\) => \{\s*\n\s*if \(cancelled\) return;\s*\n\s*void client\s*\n\s*\.createLiveKitSessionOrBusy\(request, requestOptions\)/,
    "the grant POST is no longer deferred behind a cancellable timer: StrictMode's mount, cleanup, mount sends two mints for one call",
  );

  // And the effect's cleanup clears it, so the first StrictMode run never posts at all.
  assert.match(
    source,
    /return \(\) => \{\s*\n\s*cancelled = true;\s*\n\s*clearTimeout\(mintTimer\);\s*\n\s*\};/,
    "the effect cleanup no longer clears the pending mint: the first StrictMode run would still post",
  );

  // The only mint in the hook is the deferred one.
  assert.equal(
    source.match(/\.createLiveKitSessionOrBusy\(/g)?.length,
    1,
    "a second mint call site appeared in the grant hook; is it deferred and cancellable too?",
  );
});
