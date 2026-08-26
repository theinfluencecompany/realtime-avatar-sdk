#!/usr/bin/env node
/**
 * Every bare import a built entry makes must be a package the consumer will actually have.
 *
 * This exists because of a bug that shipped invisibly. Merging two manifests demoted
 * `livekit-client` and `zod` from regular dependencies to OPTIONAL peers, to spare a server-only
 * consumer the download. npm does not install optional peers — so `npm i realtime-avatar` followed
 * by `import { AvatarCall } from "realtime-avatar/react"` failed with a bare Cannot-find-module.
 * Nothing caught it: the build was green, the types were green, every test passed. The failure
 * only existed in a fresh install of the published tarball, which no check ever performed.
 *
 * So this reads what the BUILD actually emitted rather than what anyone believes it needs, and
 * checks each import against the manifest. An optional peer is accepted only when another
 * declared package peer-depends on it — that is how `livekit-client` legitimately arrives, via
 * `@livekit/components-react` and `@livekit/react-native`, and it is the difference between a
 * reasoned decision and a hole.
 *
 * It also prints the per-entry import list, which is the honest answer to "what does a
 * server-only consumer pay for?" — the key-holding entries import nothing at all.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PKG = join(ROOT, "libs/sdk-server");

const manifest = JSON.parse(await readFile(join(PKG, "package.json"), "utf8"));
const deps = new Set(Object.keys(manifest.dependencies ?? {}));
const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
const optional = new Set(
  Object.entries(manifest.peerDependenciesMeta ?? {})
    .filter(([, v]) => v?.optional)
    .map(([k]) => k),
);

/** Which declared packages peer-depend on `name` — i.e. would drag it in for a consumer. */
async function broughtInBy(name) {
  const carriers = [];
  for (const candidate of [...deps, ...peers]) {
    if (candidate === name) continue;
    try {
      const m = JSON.parse(await readFile(join(ROOT, "node_modules", candidate, "package.json"), "utf8"));
      if (m.peerDependencies?.[name] || m.dependencies?.[name]) carriers.push(candidate);
    } catch {
      /* not installed locally — cannot vouch for it */
    }
  }
  return carriers;
}

/** Peers a consumer picks deliberately, per platform. Documented in the package README. */
const PLATFORM_CHOICE = new Set([
  "react",
  "react-dom",
  "react-native",
  "@livekit/components-react",
  "@livekit/react-native",
]);

const dist = join(PKG, "dist");
const entries = (await readdir(dist)).filter((f) => f.endsWith(".js")).sort();
const problems = [];

console.log("what each published entry imports at runtime:\n");
for (const file of entries) {
  const source = await readFile(join(dist, file), "utf8");
  // Only real import STATEMENTS, which tsup emits at the top of each ESM file, one per line.
  // A looser /from ['"].../ pattern matches `query.set("from", options.from)` in ordinary code —
  // the first version of this check did exactly that and reported seven imaginary imports.
  const bare = [
    ...new Set(
      source
        .split("\n")
        .map((line) => /^import\s[^'"]*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/.exec(line.trim()))
        .filter(Boolean)
        .map((m) => m[1] ?? m[2])
        .filter((spec) => !spec.startsWith(".") && !spec.startsWith("node:")),
    ),
  ].sort();

  console.log(`  ${file.replace(/\.js$/, "").padEnd(16)} ${bare.length ? bare.join(", ") : "— nothing"}`);

  for (const name of bare) {
    const pkg = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
    if (deps.has(pkg)) continue;
    if (peers.has(pkg) && !optional.has(pkg)) continue;
    if (peers.has(pkg) && optional.has(pkg)) {
      // A platform choice is legitimately optional: you install the one for YOUR platform, and
      // the README says so. What is NOT legitimate is a library the consumer has no reason to
      // know about and nothing installs for them — that was zod, and it broke ./react silently.
      if (PLATFORM_CHOICE.has(pkg)) continue;
      const carriers = await broughtInBy(pkg);
      if (carriers.length) continue;
      problems.push(
        `${file} imports '${pkg}', declared as an OPTIONAL peer that nothing else brings in. ` +
          `npm will not install it, so this entry throws Cannot-find-module on a fresh install.`,
      );
      continue;
    }
    problems.push(`${file} imports '${pkg}', which is in neither dependencies nor peerDependencies.`);
  }
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} import(s) a consumer would not have:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n✓ every import is either a dependency, a required peer, or carried by one");
