import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

/**
 * The live badge says "live". Its resolution readout is a diagnostic, not product copy.
 *
 * 0.26.0 rendered "live · 576×1010" on every production call, and `AvatarCall` offered no way to
 * turn the badge off, so an app that draws its own status showed "Live" twice with a debug
 * readout beside one of them. The readout now needs `debug`; `AvatarCall` forwards
 * `showLiveBadge`, which the surface already had.
 */
const bundle = await build({
  stdin: {
    contents: "export { liveBadgeLabel } from './avatar-video-surface';",
    resolveDir: new URL("../src/react", import.meta.url).pathname,
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
});
const module: { exports: { liveBadgeLabel?: (dims: { width: number; height: number } | null, debug: boolean) => string } } = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url) });
const liveBadgeLabel = module.exports.liveBadgeLabel;

test("the badge never shows the layer's resolution unless debug asks for it", () => {
  assert.equal(typeof liveBadgeLabel, "function", "no single owner of the badge text");
  assert.equal(liveBadgeLabel!({ width: 576, height: 1010 }, false), "live");
  assert.equal(liveBadgeLabel!(null, false), "live");
});

test("debug shows the resolution once the layer has one", () => {
  assert.equal(liveBadgeLabel!({ width: 576, height: 1010 }, true), "live · 576×1010");
  assert.equal(liveBadgeLabel!({ width: 0, height: 0 }, true), "live");
  assert.equal(liveBadgeLabel!(null, true), "live");
});
