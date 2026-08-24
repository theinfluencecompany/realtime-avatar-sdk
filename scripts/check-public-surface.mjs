#!/usr/bin/env node
/**
 * Fail if libs/contracts exports a name that is not on its allowlist.
 *
 * check-boundary.mjs asks "does anything shipped mention a term we listed?". That is a
 * denylist, and it answers only for terms someone thought to add. It passed for months
 * while the public tree carried the render storage layout, the LiveKit orchestration
 * protocol and the TTS vendor catalogs — none of which were on it, because nobody knew
 * to add them.
 *
 * This asks the opposite, and it is the question that scales: "is every name we export
 * one we MEANT to export?" A new export fails by default. Widening the surface is then a
 * line in public-surface.txt that a reviewer sees, rather than an omission nobody sees.
 *
 * The allowlist is safe to keep in the public repo precisely because it is an allowlist:
 * it names only what already ships.
 */
import { readFile } from "node:fs/promises";

const SOURCE = "libs/contracts/src/index.ts";
const ALLOWLIST = "libs/contracts/public-surface.txt";

const allowed = new Set(
  (await readFile(ALLOWLIST, "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")),
);

const source = await readFile(SOURCE, "utf8");
// `export const|type|interface|function|class NAME`. Re-export forms (`export { … }`,
// `export * from`) are matched separately below so neither can smuggle a name past this.
const declared = [...source.matchAll(/^export (?:const|type|interface|function|class)\s+([A-Za-z0-9_]+)/gm)].map(
  (m) => m[1],
);
const reexported = [...source.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) =>
  m[1]
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/).pop().trim())
    .filter(Boolean),
);
const starExports = [...source.matchAll(/^export\s+\*\s+from/gm)];

const exported = [...new Set([...declared, ...reexported])];
const extra = exported.filter((n) => !allowed.has(n)).sort();
const stale = [...allowed].filter((n) => !exported.includes(n)).sort();

const problems = [];
if (starExports.length > 0) {
  problems.push(
    `${SOURCE} uses \`export * from\`, which this check cannot enumerate.\n` +
      `  Name the exports explicitly so the surface stays reviewable.`,
  );
}
if (extra.length > 0) {
  problems.push(
    `${extra.length} export(s) not on the allowlist:\n` +
      extra.map((n) => `    ${n}`).join("\n") +
      `\n\n  If these belong in the PUBLIC surface, add them to ${ALLOWLIST} — that is a\n` +
      `  review decision. If they are platform internals, they belong in the private\n` +
      `  contracts package, not in a repo that goes public.`,
  );
}
// A stale entry is not a leak, so it does not fail the build — but it does mean the
// allowlist has drifted from reality, and a drifted allowlist is one nobody trusts.
if (stale.length > 0) {
  console.warn(`⚠ ${ALLOWLIST} lists ${stale.length} name(s) no longer exported: ${stale.join(", ")}`);
}

if (problems.length > 0) {
  console.error(`\n✗ public surface violated\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(`✓ public surface — ${exported.length} export(s), all on the allowlist`);
