#!/usr/bin/env node
/**
 * Every public type must be able to say where it came from.
 *
 * Internal-versus-external answers whether a type should be EXPOSED. It does not answer where
 * the type came FROM, and that second question is the one this system keeps getting wrong: two
 * wire translators disagreeing about `stt_mode`, four hand-mirrored constants nobody compared,
 * a redaction list kept in a different file from the fields it redacted. Every one of those was
 * a shape written down twice, and in each case both copies looked authoritative.
 *
 * So a type here is in exactly one of two states, and it must say which:
 *
 *   DERIVED    it indexes `components["schemas"]` from the generated contract. A change
 *              upstream fails the typecheck. Nothing to assert — the compiler is the assertion.
 *   DECLARED   it is written by hand, and the declaration carries a `DERIVATION:` note saying
 *              WHY it is not derived. "The contract does not describe it" and "this is a
 *              product decision the wire should not dictate" are both good reasons. Silence is
 *              not a reason, and silence is what this catches.
 *
 * The note goes at the DECLARATION, not in the file header. A reader lands on a type, not on
 * line one — five of the six hand-written types here had their reasons explained at the top of
 * the file, which is exactly as useful as not explaining them.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const FILE = resolve(import.meta.dirname, "../libs/http-client/src/types.ts");
const source = await readFile(FILE, "utf8");
const lines = source.split("\n");

/** Indexes into the generated contract — the compiler enforces these, so no note is required. */
const DERIVED = /\b(Wire|Grant|UsageSessionsResponse)\[/;

const undocumented = [];
const counts = { derived: 0, declared: 0 };

for (let i = 0; i < lines.length; i++) {
  const match = /^export (?:interface|type) (\w+)/.exec(lines[i]);
  if (!match) continue;

  // The body runs to the next top-level `export`, which is where the next type begins.
  let end = i + 1;
  while (end < lines.length && !/^export /.test(lines[end])) end++;
  const body = lines.slice(i, end).join("\n");

  if (DERIVED.test(body)) {
    counts.derived++;
    continue;
  }

  // Hand-written: walk back over the doc comment attached to it and look for the note.
  let start = i - 1;
  while (start >= 0 && (lines[start].trim().startsWith("*") || lines[start].trim().startsWith("/**"))) start--;
  const doc = lines.slice(start + 1, i).join("\n");

  counts.declared++;
  if (!/DERIVATION:/.test(doc)) undocumented.push({ name: match[1], line: i + 1 });
}

console.log(`public types in ${FILE.split("/").slice(-4).join("/")}`);
console.log(`  derived from the contract : ${counts.derived}`);
console.log(`  declared by hand          : ${counts.declared}`);

if (undocumented.length) {
  console.error(`\n✗ ${undocumented.length} hand-written type(s) do not say why they are not derived:`);
  for (const u of undocumented) console.error(`  - ${u.name}  (types.ts:${u.line})`);
  console.error(
    `\n  Add a "DERIVATION:" note to the doc comment ON THE DECLARATION. If the contract does\n` +
      `  describe the shape, derive it instead — that is better than a note.`,
  );
  process.exit(1);
}
console.log("\n✓ every hand-written type says why it is not derived");
