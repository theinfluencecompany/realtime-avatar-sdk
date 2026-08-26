#!/usr/bin/env node
/**
 * The vendored spec must still equal the one the platform serves.
 *
 * The spec is vendored rather than fetched at build time for the ordinary reason — a published
 * package must build without a network — but a vendored copy is a copy, and a copy drifts.
 * This is the check that makes the drift loud instead of silent: it is the same failure this
 * repo has already had twice, once when two wire translators disagreed about whether the
 * avatar listens, and once when a Python worker only recognised a value the contract does not
 * define.
 *
 * Compared on PARSED JSON, not bytes: key order and whitespace are not the contract, and a
 * byte compare would fail on a re-serialisation that changed nothing.
 *
 * OFFLINE IS NOT A FAILURE. A fork, a runner with no egress, or a platform deploy in flight
 * must not turn a red X on someone's PR — this reports and exits 0. It is a drift detector,
 * not an availability check, and the artifact it guards is committed either way.
 */
import { readFile } from "node:fs/promises";

const SPEC_URL = "https://realtimeavatar.ai/openapi.json";
const VENDORED = new URL("../spec/realtime-avatar.openapi.json", import.meta.url);

const vendored = JSON.parse(await readFile(VENDORED, "utf8"));

let live;
try {
  const response = await fetch(SPEC_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  live = await response.json();
} catch (cause) {
  console.log(`· spec drift — could not reach ${SPEC_URL} (${cause.message}); skipping`);
  process.exit(0);
}

const canonical = (value) => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

if (canonical(vendored) === canonical(live)) {
  const paths = Object.keys(live.paths ?? {}).length;
  const schemas = Object.keys(live.components?.schemas ?? {}).length;
  console.log(`✓ spec matches the published contract — ${paths} path(s), ${schemas} schema(s)`);
  process.exit(0);
}

// Name what moved, so the fix is `npm run spec` rather than a diff hunt.
const pathsOf = (d) => new Set(Object.keys(d.paths ?? {}));
const schemasOf = (d) => new Set(Object.keys(d.components?.schemas ?? {}));
const only = (a, b) => [...a].filter((k) => !b.has(k));

const addedPaths = only(pathsOf(live), pathsOf(vendored));
const droppedPaths = only(pathsOf(vendored), pathsOf(live));
const addedSchemas = only(schemasOf(live), schemasOf(vendored));
const droppedSchemas = only(schemasOf(vendored), schemasOf(live));

console.error("✗ the vendored spec no longer matches the published contract");
if (addedPaths.length) console.error(`  published has, vendored lacks:  ${addedPaths.join(", ")}`);
if (droppedPaths.length) console.error(`  vendored has, published lacks:  ${droppedPaths.join(", ")}`);
if (addedSchemas.length) console.error(`  new schema(s):                  ${addedSchemas.join(", ")}`);
if (droppedSchemas.length) console.error(`  removed schema(s):              ${droppedSchemas.join(", ")}`);
if (!addedPaths.length && !droppedPaths.length && !addedSchemas.length && !droppedSchemas.length) {
  console.error("  same paths and schemas — a shape changed inside one of them.");
}
console.error("\n  Run `npm run spec` to re-vendor and regenerate, then commit both.");
process.exit(1);
