#!/usr/bin/env node
/**
 * Fail if a PUBLIC ENTRY POINT exports a name that is not on its allowlist.
 *
 * check-boundary.mjs asks "does anything shipped mention a term we listed?". That is a
 * denylist, and it answers only for terms someone thought to add. It passed for months
 * while the public tree carried the render storage layout, the LiveKit orchestration
 * protocol and the TTS vendor catalogs — none of which were on it, because nobody knew
 * to add them.
 *
 * This asks the opposite, and it is the question that scales: "is every name we export
 * one we MEANT to export?" A new export fails by default. Widening the surface is then a
 * line in a *-surface.txt file that a reviewer sees, rather than an omission nobody sees.
 *
 * The allowlists are safe to keep in the public repo precisely because they are allowlists:
 * they name only what already ships.
 *
 * EVERY ENTRY POINT, not just the wire. For its first year this file checked `wire.ts`
 * alone, which is the module whose contents are a protocol — and left the two entry points
 * an app actually imports (`react`, `react-native`) unchecked. That is where the surface
 * grows: a prototype added twelve exports to `react/index.ts` in one commit, including the
 * governor's internal reducer helpers and the frame ledger, and nothing objected.
 */
import { readFile } from "node:fs/promises";

/** Every module an app is expected to import from. Adding one here is the point. */
const ENTRY_POINTS = [
  { source: "libs/client/src/wire.ts", allowlist: "libs/client/wire-surface.txt" },
  { source: "libs/client/src/react/index.ts", allowlist: "libs/client/react-surface.txt" },
  { source: "libs/client/src/react-native/index.ts", allowlist: "libs/client/react-native-surface.txt" },
];

/** The names one module exports, by any form that puts a name in the public surface. */
const exportedNames = (source) => {
  // `export const|type|interface|function|class NAME`. Re-export forms (`export { … }`,
  // `export * from`) are matched separately so neither can smuggle a name past this.
  const declared = [...source.matchAll(/^export (?:const|type|interface|function|class)\s+([A-Za-z0-9_]+)/gm)].map(
    (m) => m[1],
  );
  const reexported = [...source.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) =>
    m[1]
      .split(",")
      // `X as Y` exports Y; `type X` exports X — the modifier is not part of the name.
      .map((s) => s.trim().split(/\s+as\s+/).pop().trim().replace(/^type\s+/, ""))
      .filter(Boolean),
  );
  const starExports = [...source.matchAll(/^export\s+\*\s+from/gm)];
  return { names: [...new Set([...declared, ...reexported])], starExports };
};

const problems = [];
let total = 0;

for (const { source: sourcePath, allowlist: allowlistPath } of ENTRY_POINTS) {
  const allowed = new Set(
    (await readFile(allowlistPath, "utf8"))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  const { names, starExports } = exportedNames(await readFile(sourcePath, "utf8"));
  const extra = names.filter((n) => !allowed.has(n)).sort();
  const stale = [...allowed].filter((n) => !names.includes(n)).sort();
  total += names.length;

  if (starExports.length > 0) {
    problems.push(
      `${sourcePath} uses \`export * from\`, which this check cannot enumerate.\n` +
        `  Name the exports explicitly so the surface stays reviewable.`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `${sourcePath}: ${extra.length} export(s) not on the allowlist:\n` +
        extra.map((n) => `    ${n}`).join("\n") +
        `\n\n  If these belong in the PUBLIC surface, add them to ${allowlistPath} — that is a\n` +
        `  review decision. If they are platform internals, they belong upstream in the\n` +
        `  private contract, not in a repo that goes public.`,
    );
  }
  // A stale entry is not a leak, so it does not fail the build — but it does mean the
  // allowlist has drifted from reality, and a drifted allowlist is one nobody trusts.
  if (stale.length > 0) {
    console.warn(`⚠ ${allowlistPath} lists ${stale.length} name(s) no longer exported: ${stale.join(", ")}`);
  }
}

if (problems.length > 0) {
  console.error(`\n✗ public surface violated\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(
  `✓ public surface — ${total} export(s) across ${ENTRY_POINTS.length} entry point(s), all on their allowlists`,
);
