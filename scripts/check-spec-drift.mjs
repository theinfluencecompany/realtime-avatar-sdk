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
 * OFFLINE IS NOT A FAILURE, BUT AN ANSWER IS. A fork or a runner with no egress cannot reach
 * the platform at all, and must not turn a red X on someone's PR — that case reports and exits 0.
 * An HTTP status is the opposite: the service answered, so the comparison was possible and its
 * outcome is real. Folding those two into one green is what let this gate pass for a whole
 * generation while the vendored spec was genuinely behind (platform shipped `weights` on
 * 2026-09-17; five consecutive green runs on main; a clean checkout reproduced exit 1 by hand).
 * The edge also returns 403 to clients that send no User-Agent, which is exactly the shape of
 * "reachable but not compared" that used to read as "no drift".
 */
import { readFile } from "node:fs/promises";

const SPEC_URL = "https://realtimeavatar.ai/openapi.json";
const VENDORED = new URL("../spec/realtime-avatar.openapi.json", import.meta.url);

const vendored = JSON.parse(await readFile(VENDORED, "utf8"));

// Sent explicitly: the edge answers 403 to a request with no User-Agent, and a 403 that reads
// as "offline" is the bug this gate is recovering from.
const USER_AGENT = "realtime-avatar-sdk-spec-drift-check";

// The catch covers ONLY the round trip. Everything after it — status, body, comparison —
// happened because the platform answered, so every one of those outcomes is a real finding.
// Only a genuine inability to reach the host is exempt: DNS, connect, timeout, abort.
let response;
try {
  response = await fetch(SPEC_URL, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json", "user-agent": USER_AGENT },
  });
} catch (cause) {
  console.log(`· spec drift — could not reach ${SPEC_URL} (${cause.message}); skipping`);
  process.exit(0);
}

if (!response.ok) {
  console.error(`✗ spec drift — ${SPEC_URL} answered HTTP ${response.status}`);
  console.error("\n  The platform is reachable but did not serve the contract, so the vendored");
  console.error("  copy could not be verified. Treat as drift until a 200 proves otherwise.");
  process.exit(1);
}

const body = await response.text();
let live;
try {
  live = JSON.parse(body);
} catch (cause) {
  console.error(`✗ spec drift — ${SPEC_URL} served ${body.length} byte(s) that are not JSON`);
  console.error(`\n  ${cause.message}`);
  process.exit(1);
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
