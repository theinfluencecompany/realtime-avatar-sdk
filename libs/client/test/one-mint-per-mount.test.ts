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

test("the grant POST waits until StrictMode's synchronous effect triple is over", async () => {
  const source = await readFile(new URL("../src/react/livekit.ts", import.meta.url), "utf-8");

  // Deferred to a microtask that re-checks `cancelled` before anything leaves the browser.
  // React runs effect, cleanup, effect in one synchronous passive-effects flush, so the first
  // run's microtask finds itself cancelled. A timer would also work, but it is throttled in a
  // hidden tab, and this path carries reconnects.
  assert.match(
    source,
    /queueMicrotask\(\(\) => \{\s*\n\s*if \(cancelled\) return;\s*\n\s*void client\s*\n\s*\.createLiveKitSessionOrBusy\(request, requestOptions\)/,
    "the grant POST is no longer deferred behind a cancelled-check: StrictMode's mount, cleanup, mount sends two mints for one call",
  );

  // And the effect's cleanup is what cancels it.
  assert.match(
    source,
    /return \(\) => \{\s*\n\s*cancelled = true;\s*\n\s*\};\s*\n\s*\}, \[active, client, sessionKey, requestOptions, version, releaseHeld\]\);/,
    "the mint effect's cleanup no longer marks it cancelled: the first StrictMode run would still post",
  );

  // The only mint in the hook is the deferred one.
  assert.equal(
    source.match(/\.createLiveKitSessionOrBusy\(/g)?.length,
    1,
    "a second mint call site appeared in the grant hook; is it deferred and cancellable too?",
  );
});
