import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RealtimeAvatar } from "../../http-client/src/client.ts";

/**
 * Two READMEs carry an `## API` block — the repo root's, and this package's, which is the one
 * npm renders on the package page. They must teach the same surface, and twice in one day they
 * did not: #38 (setLoop) and #40 (waitForLoop/waitForClips) each added a client method and
 * updated only the root block, so the package page went stale the moment the feature merged.
 *
 * This replays the check mechanically, against the class itself rather than either README:
 * every public prototype method must appear as `rta.<name>(` in BOTH blocks, and every
 * `rta.<name>(` in a block must exist on the class — so a stale entry fails the same way a
 * missing one does.
 */

// The one deliberate omission: createAvatar is the low-level lane that createAvatarFromImage /
// createAvatarFromVideo call; the blocks document those two instead.
const UNDOCUMENTED = new Set(["createAvatar"]);

const READMES = [
  ["README.md (repo root)", new URL("../../../README.md", import.meta.url)],
  ["libs/sdk-server/README.md", new URL("../README.md", import.meta.url)],
] as const;

const classMethods = Object.getOwnPropertyNames(RealtimeAvatar.prototype).filter(
  (n) => n !== "constructor",
);

function apiBlockMethods(label: string, path: URL): Set<string> {
  const md = readFileSync(path, "utf8");
  const api = md.split(/^## API$/m)[1]?.split(/^## /m)[0];
  assert.ok(api, `${label}: no "## API" section found`);
  const names = new Set<string>();
  for (const m of api.matchAll(/^rta\.(\w+)\(/gm)) names.add(m[1]!);
  assert.ok(names.size > 0, `${label}: the API section lists no rta.* methods`);
  return names;
}

for (const [label, path] of READMES) {
  test(`${label} API block matches the RealtimeAvatar surface`, () => {
    const documented = apiBlockMethods(label, path);
    const missing = classMethods.filter((n) => !UNDOCUMENTED.has(n) && !documented.has(n));
    assert.deepEqual(
      missing,
      [],
      `${label}: class methods absent from the API block (add them, or add to UNDOCUMENTED with a reason): ${missing.join(", ")}`,
    );
    const stale = [...documented].filter((n) => !classMethods.includes(n));
    assert.deepEqual(
      stale,
      [],
      `${label}: API block names methods the class does not have: ${stale.join(", ")}`,
    );
  });
}
