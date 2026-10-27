import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Two call policies carry a credential: `CallPolicy.llm` (the token your server minted for the
 * endpoint that answers the call, sent as `external_llm`) and `CallPolicy.voiceWebhook` (the
 * HMAC secret for the endpoint that speaks it, sent as `voice_webhook`). They belong to the
 * key-holding entries only. The browser and native entries, and the declarations they ship, must
 * not even name either wire field, so a client bundle has no way to put one on a mint.
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
  for (const match of read(entry).matchAll(/from\s*["']\.\/([^"']+)["']/g)) {
    // A declaration imports its chunks by their `.js` name; the file on disk is the `.d.ts`.
    const chunk = match[1]!;
    closure(files.includes(chunk) ? chunk : chunk.replace(/\.js$/, ".d.ts"), seen);
  }
  return seen;
}

// `\b` keeps the in-call error codes (`voice_webhook_timeout`, …), which clients do receive, from
// counting as the mint field.
const SERVER_ONLY = [/\bexternal_llm\b/, /\bvoice_webhook\b/];

for (const field of SERVER_ONLY) {
  test(`the server entry sends ${field.source}`, () => {
    assert.ok([...closure("server.js")].some((file) => field.test(read(file))));
  });
}

for (const entry of ["react.js", "react-native.js", "browser.js", "tools.js"]) {
  test(`${entry} never names a server-only credential field, in code or in its declarations`, () => {
    assert.ok(files.includes(entry), `${entry} is not built`);
    for (const file of [...closure(entry), ...closure(entry.replace(/\.js$/, ".d.ts"))]) {
      if (!files.includes(file)) continue;
      for (const field of SERVER_ONLY) assert.doesNotMatch(read(file), field, `${file} (reached from ${entry})`);
    }
  });
}
