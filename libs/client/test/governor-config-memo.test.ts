import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG,
  GOVERNOR_CONFIG_MEMO_KEYS,
  resolveGovernorConfig,
} from "../src/react/quality-governor.ts";

// The hook value-memoises its config on GOVERNOR_CONFIG_MEMO_KEYS so a caller's fresh
// object does not re-init the governor (0.11.0, #63). The cost of that design is that a
// config field absent from the list is silently DROPPED by the hook: the reducer then runs
// on `undefined` for it. This pins the list to the config shape at runtime; the `satisfies`
// plus the never-check beside the list pin it at compile time.
test("every DEFAULT_GOVERNOR_CONFIG field has a memo key, and nothing else does", () => {
  assert.deepEqual([...GOVERNOR_CONFIG_MEMO_KEYS].sort(), Object.keys(DEFAULT_GOVERNOR_CONFIG).sort());
});

test("resolveGovernorConfig copies every field by value and applies only DEFINED overrides", () => {
  const picked = resolveGovernorConfig(DEFAULT_GOVERNOR_CONFIG);
  assert.notEqual(picked, DEFAULT_GOVERNOR_CONFIG, "a fresh object");
  assert.deepEqual(picked, DEFAULT_GOVERNOR_CONFIG);
  assert.deepEqual(resolveGovernorConfig(), DEFAULT_GOVERNOR_CONFIG);
  const partial = resolveGovernorConfig({ openingCap: "high", probeMs: undefined, linkEvidence: "optional" });
  assert.equal(partial.openingCap, "high");
  assert.equal(partial.linkEvidence, "optional");
  assert.equal(partial.probeMs, DEFAULT_GOVERNOR_CONFIG.probeMs, "an explicit undefined does not erase a default");
  // An unknown property is dropped, not carried (the hook memoises on the listed keys only).
  const withExtra = resolveGovernorConfig({ ...DEFAULT_GOVERNOR_CONFIG, ...{ unknownKnob: 1 } });
  assert.equal("unknownKnob" in withExtra, false);
});
