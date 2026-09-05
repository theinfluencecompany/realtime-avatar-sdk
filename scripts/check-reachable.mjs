#!/usr/bin/env node
/**
 * Which source files can the published package actually reach?
 *
 * Grep cannot answer this, and twice in this repo it answered wrongly — once claiming 403
 * deletable lines that were all in use, and once missing a subpath import because the pattern
 * required a closing quote. This walks the real import graph instead: it starts at the entry
 * files named in libs/sdk-server/tsup.config.ts, follows every static import and re-export, and
 * reports the .ts files under libs/ that nothing in that graph touches.
 *
 * Test files are roots too. A file reachable ONLY from a test is reported separately, because
 * that is a different fact from being reachable by a consumer: it means the code ships nowhere
 * but something still asserts on it.
 *
 * It is a GATE, not a report: the count is zero as of 2026-08-26, and the way it stopped being
 * 1,230 was someone going and looking. A file that nothing can reach costs a reader's attention
 * and a maintainer's edits forever, and it is invisible in review — the diff that orphans it does
 * not mention it. `--json` for machine output.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SDK = join(ROOT, "libs/sdk-server");

/** Entry files, read from the build configs rather than hardcoded so the two cannot drift. */
async function entryFiles() {
  const out = [];
  // libs/client publishes NOTHING — its dist exists only so a test can import the built artifact.
  // Treating its entries as roots would make its whole subtree look shipped, which is the mistake
  // this script exists to avoid. The dist-to-src mapping in resolveSpec picks it up via the test.
  for (const pkg of [SDK, join(ROOT, "libs/mcp"), join(ROOT, "libs/examples")]) {
    let config;
    try {
      config = await readFile(join(pkg, "tsup.config.ts"), "utf8");
    } catch {
      // libs/mcp builds with tsc, so its entries come from the manifest instead.
      const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
      for (const p of [manifest.main, ...Object.values(manifest.bin ?? {})].filter(Boolean)) {
        out.push(join(pkg, p.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")));
      }
      continue;
    }
    // EVERY `entry: {` block, not just the first. sdk-server builds in two passes (server half
    // split, client half not — see its tsup.config.ts for why), so a reader that stopped at the
    // first block saw only the key-holding entries and declared the whole client subtree
    // unreachable. The guard was right that those files must be walked; it just could not find
    // the roots. Missing a root here is the failure mode that matters, because it reads as
    // "delete this code".
    for (let at = config.indexOf("entry: {"); at !== -1; at = config.indexOf("entry: {", at + 1)) {
      const block = config.slice(at, config.indexOf("},", at));
      for (const m of block.matchAll(/"(src\/[^"]+)"/g)) out.push(join(pkg, m[1]));
    }
  }
  return out;
}

async function testFiles() {
  const out = [];
  for (const lib of await readdir(join(ROOT, "libs"))) {
    const dir = join(ROOT, "libs", lib, "test");
    try {
      for (const f of await readdir(dir)) if (f.endsWith(".test.ts")) out.push(join(dir, f));
    } catch {
      /* no test dir */
    }
  }
  return out;
}

/** Resolve a relative specifier the way the bundler does: exact, +.ts, then /index.ts. */
async function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // bare = a real npm package, not our source
  let base = resolve(dirname(fromFile), spec);
  // `../dist/react.js` is a BUILT artifact; the thing it actually depends on is the entry source
  // tsup compiled into it. Tests import through dist, so without this they look like they depend
  // on nothing and their subjects look dead.
  if (base.includes(`${"/"}dist${"/"}`)) base = base.replace(`${"/"}dist${"/"}`, `${"/"}src${"/"}`).replace(/\.js$/, ".ts");
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts"), base.replace(/\.js$/, ".ts")]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

const SPEC = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

async function walk(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const m of source.matchAll(SPEC)) {
      const next = await resolveSpec(file, m[1]);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

async function allSources(dir, out = []) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) {
      if (["node_modules", "dist", "test"].includes(name.name)) continue;
      await allSources(full, out);
    } else if (name.name.endsWith(".ts") && !name.name.endsWith(".d.ts") && !name.name.endsWith(".config.ts") && name.name !== "tsup-use-client.ts") {
      out.push(full);
    }
  }
  return out;
}

const shipped = await walk(await entryFiles());
const withTests = await walk([...(await entryFiles()), ...(await testFiles())]);
const every = await allSources(join(ROOT, "libs"));

const rel = (f) => relative(ROOT, f);
const unreachable = every.filter((f) => !withTests.has(f)).map(rel).sort();
const testOnly = every.filter((f) => !shipped.has(f) && withTests.has(f)).map(rel).sort();
const lines = async (files) => {
  let n = 0;
  for (const f of files) n += (await readFile(join(ROOT, f), "utf8")).split("\n").length;
  return n;
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ unreachable, testOnly, shipped: [...shipped].map(rel).sort() }, null, 2));
} else {
  console.log(`reachable from the published entries : ${shipped.size} file(s)`);
  console.log(`reachable only from a test           : ${testOnly.length} file(s), ${await lines(testOnly)} lines`);
  for (const f of testOnly) console.log(`   ${f}`);
  console.log(`reachable from NOTHING               : ${unreachable.length} file(s), ${await lines(unreachable)} lines`);
  for (const f of unreachable) console.log(`   ${f}`);
  if (unreachable.length) {
    console.error(
      `\n✗ ${unreachable.length} source file(s) are reachable from neither a published entry nor a test.` +
        `\n  Delete them, or import them from something. If a file is deliberately kept for an` +
        `\n  upstream carry sync, say so in a comment AND give it a test — otherwise it is invisible.`,
    );
    process.exit(1);
  }
}
