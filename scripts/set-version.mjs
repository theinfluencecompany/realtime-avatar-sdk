#!/usr/bin/env node
/**
 * Set every publishable workspace to one version, and repoint the internal deps at it.
 *
 * The six libs ship in lockstep — they are one SDK cut at one version, not six packages
 * on their own schedules — and libs/mcp depends on `realtime-avatar` at an
 * EXACT version rather than a range. So a bump is eight edits, of which two are in a
 * `dependencies` block that nothing about a version bump reminds you to open.
 *
 * Missing one of those two is the failure this exists to prevent, and it is silent in the
 * worst way: the packages still typecheck, still build, and still pass tests, because the
 * workspace link resolves locally regardless of what the manifest says. It only breaks at
 * a consumer, after publish, when `npm i realtime-avatar-proxy` pulls a realtime-avatar
 * that is a version behind. release.yml's tag check catches the six top-level versions;
 * nothing catches the two pinned deps.
 *
 *   node scripts/set-version.mjs 0.3.0
 *
 * Writes package.json only. Committing and tagging stay manual — that is the release
 * decision, and it is not this script's to make.
 */
import { readFile, writeFile } from "node:fs/promises";

const LIBS = ["http-client", "browser", "tools", "proxy", "client", "sdk-server", "sdk-react", "mcp"];
// The one name other packages pin. Kept as a list so a second such dep is one line.
const INTERNAL = ["realtime-avatar"];

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/set-version.mjs <version>");
  process.exit(1);
}
// Deliberately strict: npm would accept a range or a `v` prefix here, but release.yml
// compares these against a git tag with `v` stripped, so anything else fails later and
// further from the cause.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a plain semver version: ${version}`);
  process.exit(1);
}

const names = new Map();
for (const dir of LIBS) {
  const path = `libs/${dir}/package.json`;
  names.set(JSON.parse(await readFile(path, "utf8")).name, dir);
}

for (const dir of LIBS) {
  const path = `libs/${dir}/package.json`;
  const raw = await readFile(path, "utf8");
  const pkg = JSON.parse(raw);
  const was = pkg.version;
  pkg.version = version;

  const repointed = [];
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const dep of INTERNAL) {
      if (!pkg[field]?.[dep]) continue;
      if (!names.has(dep)) continue;
      pkg[field][dep] = version;
      repointed.push(`${field}.${dep}`);
    }
  }

  // Trailing newline: npm writes one, so omitting it makes every run a spurious diff.
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  const note = repointed.length ? `  (+ ${repointed.join(", ")})` : "";
  console.log(`· ${pkg.name}  ${was} → ${version}${note}`);
}

console.log(`\nNext:\n  npm install --package-lock-only\n  npm run check\n  git commit -am "release: ${version}"\n  git tag -a v${version} -m "${version}" && git push origin main v${version}`);
