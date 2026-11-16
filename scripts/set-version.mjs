#!/usr/bin/env node
/**
 * Set every publishable workspace to one version, and repoint the internal deps at it.
 *
 * All eight workspaces ship in lockstep — they are one SDK cut at one version, not eight packages
 * on their own schedules — and libs/mcp depends on `realtime-avatar` at an
 * EXACT version rather than a range. So a bump is ten edits, of which two are in a
 * `dependencies` block that nothing about a version bump reminds you to open.
 *
 * Missing one of those two is the failure this exists to prevent, and it is silent in the
 * worst way: the packages still typecheck, still build, and still pass tests, because the
 * workspace link resolves locally regardless of what the manifest says. It only breaks at
 * a consumer, after publish, when `npm i realtime-avatar-mcp` pulls a realtime-avatar
 * that is a version behind. release.yml's tag check catches the top-level versions;
 * nothing catches the two pinned deps.
 *
 *   node scripts/set-version.mjs 0.3.0
 *
 * Writes files only: the manifests, server.json, the version constants and the README install
 * lines. Committing and tagging stay manual — that is the release decision, and it is not this
 * script's to make.
 */
import { readFile, writeFile } from "node:fs/promises";

// Two source constants mirror the version so the User-Agent and the MCP server identity
// cannot go stale. Tests assert they match package.json; bumping only the manifests turns
// those tests red at the end of a release rather than at the start of one.
const VERSION_CONSTANTS = [
  ["libs/http-client/src/client.ts", "SDK_VERSION"],
  ["libs/mcp/src/server.ts", "MCP_VERSION"],
];

const LIBS = ["http-client", "browser", "tools", "proxy", "client", "sdk-server", "mcp", "examples"];
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

// The MCP Registry entry names the npm version it points at, twice. release.yml publishes it
// after npm, and the registry rejects a version whose package is not on npm yet, so a stale
// server.json would re-announce the previous release instead of this one.
{
  const path = "libs/mcp/server.json";
  const entry = JSON.parse(await readFile(path, "utf8"));
  entry.version = version;
  for (const pkg of entry.packages) pkg.version = version;
  await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`);
  console.log(`· ${path}  -> ${version}`);
}

// Both READMEs open with an exact install line, and the package one IS the npm page. Nothing
// moved it, so it told every reader to install 0.17.0 while 0.40.0 was current: a pin only a
// human remembers to bump is a pin that is wrong. readme-surface.test.ts holds it to this version.
// `realtime-avatar@` exactly: a `realtime-avatar-mcp@…` pin belongs to the agent plugin, which
// is released on its own schedule.
for (const path of ["README.md", "libs/sdk-server/README.md"]) {
  const before = await readFile(path, "utf8");
  const pin = /\brealtime-avatar@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;
  if (!before.match(pin)) throw new Error(`${path}: no realtime-avatar@<version> install line`);
  const after = before.replace(pin, `realtime-avatar@${version}`);
  if (after !== before) await writeFile(path, after);
  console.log(`· ${path}  install line -> ${version}`);
}

console.log(`\nNext:\n  npm install --package-lock-only\n  npm run check\n  git commit -am "release: ${version}"\n  git tag -a v${version} -m "${version}" && git push origin main v${version}`);

for (const [file, name] of VERSION_CONSTANTS) {
  const path = new URL(`../${file}`, import.meta.url);
  const before = await readFile(path, "utf8");
  const pattern = new RegExp(`(export const ${name} = ")[^"]+(")`);
  // Match, not difference: re-running at the same version is a no-op, not a missing constant.
  if (!pattern.test(before)) throw new Error(`${file}: could not find ${name}`);
  const after = before.replace(pattern, `$1${version}$2`);
  if (after !== before) await writeFile(path, after);
  console.log(`  ${file}  ${name} -> ${version}`);
}
