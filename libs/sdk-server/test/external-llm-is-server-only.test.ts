import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * `CallPolicy.llm` carries a credential: the token your server minted for the endpoint that will
 * answer the call. It belongs to the key-holding entries only. The browser and native entries,
 * and the declarations they ship, must not even name the wire field it is sent as, so a client
 * bundle has no way to put one on a mint.
 *
 * Reads the BUILT package, which is what a consumer's bundler sees.
 */
const dist = new URL("../dist/", import.meta.url);
const files = readdirSync(dist);
const read = (name: string) => readFileSync(new URL(name, dist), "utf8");

/** An entry and every chunk it imports, transitively. */
function closure(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const match of read(entry).matchAll(/from\s*["']\.\/([^"']+)["']/g)) closure(match[1]!, seen);
  return seen;
}

test("the server entry sends the endpoint as external_llm", () => {
  assert.ok([...closure("server.js")].some((file) => read(file).includes("external_llm")));
});

for (const entry of ["react.js", "react-native.js", "browser.js", "tools.js"]) {
  test(`${entry} never names external_llm, in code or in its declarations`, () => {
    assert.ok(files.includes(entry), `${entry} is not built`);
    const declarations = entry.replace(/\.js$/, ".d.ts");
    for (const file of [...closure(entry), declarations]) {
      if (!files.includes(file)) continue;
      assert.doesNotMatch(read(file), /external_llm/, `${file} (reached from ${entry})`);
    }
  });
}
