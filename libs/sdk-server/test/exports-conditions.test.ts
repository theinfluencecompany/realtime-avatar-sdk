import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The credential guard lives in the exports map: guarded subpaths resolve to a throwing stub
 * under the `browser` and `react-native` conditions. What that map must ALSO get right is who
 * the guard does NOT fire on — Cloudflare Workers are key-holding server runtimes, and wrangler
 * and @cloudflare/vite-plugin resolve with the conditions `workerd, worker, browser`. Without a
 * `workerd` key ahead of `browser`, every guarded subpath resolves to the stub and a Worker
 * build dies with MISSING_EXPORT (measured 2026-08-27, on a consumer's Worker build that had
 * been green for weeks under the pre-guard package).
 *
 * Condition matching is ORDER-SENSITIVE — the first key present in the resolver's condition set
 * wins — so this is a property of the object's key order, which nothing else checks. This test
 * replays Node's matching rule over the shipped map for each consumer class we serve.
 */

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, Record<string, string>>;
};

// Node's resolver, for the flat maps this package ships: first key that is "default" or in the
// active condition set wins. ("types" is TypeScript's, never active at runtime — excluded.)
function resolve(subpath: string, conditions: string[]): string {
  const entry = pkg.exports[subpath];
  assert.ok(entry, `no exports entry for ${subpath}`);
  for (const [key, target] of Object.entries(entry)) {
    if (key === "types") continue;
    if (key === "default" || conditions.includes(key)) return target;
  }
  assert.fail(`nothing matched for ${subpath} under [${conditions.join(", ")}]`);
}

const GUARD = "./dist/server-only-guard.js";
const GUARDED = [".", "./server", "./nextjs", "./hono", "./express", "./tanstack-start"];
const KEYLESS = ["./react", "./react-native", "./browser", "./tools"];

// The condition sets the real consumers resolve with.
const NODE = ["node", "import"];
const WORKERD = ["workerd", "worker", "browser", "import"]; // wrangler / @cloudflare/vite-plugin
const BROWSER = ["browser", "import"]; // vite/webpack web build
const WEB_WORKER = ["worker", "browser", "import"]; // vite web-worker build — a browser context
const REACT_NATIVE = ["react-native", "browser", "import"]; // metro

test("every guarded subpath serves real code to the server runtimes", () => {
  for (const sub of GUARDED) {
    assert.notEqual(resolve(sub, NODE), GUARD, `${sub} guards node`);
    assert.notEqual(resolve(sub, WORKERD), GUARD, `${sub} guards Cloudflare Workers`);
  }
});

test("every guarded subpath serves the throwing stub to browser-side resolutions", () => {
  for (const sub of GUARDED) {
    assert.equal(resolve(sub, BROWSER), GUARD, `${sub} does not guard the browser`);
    assert.equal(resolve(sub, WEB_WORKER), GUARD, `${sub} does not guard a web worker`);
    assert.equal(resolve(sub, REACT_NATIVE), GUARD, `${sub} does not guard react-native`);
  }
});

test("the keyless subpaths never resolve to the stub for anyone", () => {
  for (const sub of KEYLESS) {
    for (const conditions of [NODE, WORKERD, BROWSER, WEB_WORKER, REACT_NATIVE]) {
      assert.notEqual(resolve(sub, conditions), GUARD, `${sub} under [${conditions.join(", ")}]`);
    }
  }
});

test("the stub stays named in sideEffects, or a bundler treeshakes the guard away", () => {
  const sideEffects = (pkg as unknown as { sideEffects: string[] }).sideEffects;
  assert.ok(Array.isArray(sideEffects) && sideEffects.includes(GUARD));
});
