#!/usr/bin/env node
/**
 * Fail if anything that ships mentions an internal identifier.
 *
 * Scans every file a reader of this repo can see — source, built JS, .d.ts, sourcemaps and
 * markdown. Sourcemaps matter because `sourcesContent` embeds original source into the
 * published artifact; markdown matters because prose is where the leaks actually were.
 *
 * The term list is NOT committed here. A denylist of internal identifiers is itself an
 * inventory of the things it protects, so it is supplied at run time via
 * `BOUNDARY_TERMS_FILE` (one term per line, `#` comments allowed) and lives with the
 * private source of truth. With no terms file set this check passes trivially and says so —
 * that is expected for an outside contributor, and the real gate runs before release.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// Explicit env var wins; otherwise pick up the private list if this checkout has one, so
// the maintainer repo needs no configuration and a public checkout needs no apology.
const DEFAULT_TERMS = "scripts/boundary-terms.private.txt";
const termsFile =
  process.env.BOUNDARY_TERMS_FILE ??
  ((await stat(DEFAULT_TERMS).catch(() => null)) ? DEFAULT_TERMS : null);

const FORBIDDEN = termsFile
  ? (await readFile(termsFile, "utf8"))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
  : [];

/**
 * Everything a reader of the repo can see — not just what npm publishes.
 *
 * This used to be `dist` plus two `src` trees, and a verbatim copy of an internal package
 * README sat in `libs/client/` for weeks. Markdown was not scanned, so nothing failed.
 * Prose is the likeliest leak surface and was the one place the guard did not look.
 */
const ROOTS = ["libs", "apps", "docs", "."];
const SCANNED = /\.(ts|tsx|js|mjs|cjs|map|json|md|txt|html|yml|yaml)$/;

/** Never scanned: dependencies, git internals, generated locks. */
const SKIP_DIR = new Set(["node_modules", ".git", ".github/workflows/cache"]);
const SKIP_FILE = new Set(["package-lock.json"]);

/**
 * Private-only files. These name internal concepts by design and are removed by
 * `scripts/make-publish-tree.sh` before anything is published, so scanning them here would
 * fail the build on files that never ship. Must stay in step with that script's STRIP list —
 * which is why the script re-scans its own output afterwards rather than trusting this set.
 */
for (const f of [
  "BOUNDARY.md",
  "PROVENANCE.md",
  "scripts/make-publish-tree.sh",
  "scripts/sync-public.sh",
]) SKIP_FILE.add(f);

// The terms file contains every forbidden term by definition — scanning it would flag it.
if (termsFile) SKIP_FILE.add(relative(process.cwd(), resolve(termsFile)));

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // not built yet — `npm run build` runs first in CI
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) yield* walk(path);
    } else if (SCANNED.test(entry.name) && !SKIP_FILE.has(path.replace(/^\.\//, ""))) {
      yield path;
    }
  }
}

const hits = [];
let scanned = 0;

// A sourcemap carrying `sourcesContent` inlines the ORIGINAL source — comments included —
// into whatever ships. The term scan below cannot police that: it matches known
// identifiers, and prose is where a paraphrase slips through. So this is a separate,
// categorical rule rather than another entry on the denylist.
//
// It fires on anything under a `dist/`, because that is what `files` publishes. A map
// with no `sourcesContent` is fine — line mapping is not the hazard, shipped source is.
const embeddedSource = [];

const seen = new Set();
for (const root of ROOTS) {
  if (!(await stat(root).catch(() => null))) continue;
  for await (const file of walk(root)) {
    const key = file.replace(/^\.\//, "");
    if (seen.has(key)) continue; // "." overlaps libs/ and apps/
    seen.add(key);
    scanned++;
    const text = await readFile(file, "utf8");

    if (file.endsWith(".map") && /(^|\/)dist\//.test(key)) {
      try {
        const map = JSON.parse(text);
        const carried = (map.sourcesContent ?? []).filter(Boolean);
        if (carried.length > 0) {
          embeddedSource.push({
            file: key,
            files: carried.length,
            bytes: carried.reduce((n, s) => n + s.length, 0),
          });
        }
      } catch {
        // Not valid JSON — the term scan below still covers it as text.
      }
    }

    for (const term of FORBIDDEN) {
      if (text.includes(term)) {
        const line = text.split("\n").findIndex((l) => l.includes(term)) + 1;
        hits.push({ file, term, line });
      }
    }
  }
}

if (embeddedSource.length > 0) {
  console.error(`\n✗ boundary violated — ${embeddedSource.length} sourcemap(s) inline original source:\n`);
  for (const { file, files, bytes } of embeddedSource) {
    console.error(`  ${file}  ${files} source file(s), ${bytes.toLocaleString()} bytes`);
  }
  console.error("\nThese ship inside the npm tarball, comments and all, and cannot be retracted.");
  console.error("Set `sourcemap: false`, or emit maps with `sourcesContent` stripped.\n");
  process.exit(1);
}

if (hits.length > 0) {
  console.error(`\n✗ boundary violated — ${hits.length} internal reference(s) in public files:\n`);
  for (const { file, term, line } of hits) console.error(`  ${file}:${line}  ${term}`);
  console.error("\nRe-state the concept in this repo's own words, or keep it private.");
  console.error("Do not add the term to the allowlist to make this pass.\n");
  process.exit(1);
}

if (FORBIDDEN.length === 0) {
  console.log(`✓ boundary — ${scanned} file(s) scanned, no term list configured (set BOUNDARY_TERMS_FILE)`);
} else {
  console.log(`✓ boundary clean — ${scanned} public file(s), ${FORBIDDEN.length} terms checked`);
}
