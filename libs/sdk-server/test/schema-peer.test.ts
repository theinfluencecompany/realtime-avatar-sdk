import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";

const manifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()),
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })).optional(),
}).parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));

test("public validation schemas share the consumer's Zod runtime and types", () => {
  assert.equal(manifest.dependencies?.zod, undefined);
  assert.match(manifest.peerDependencies.zod, /^\^4\./);
  assert.notEqual(manifest.peerDependenciesMeta?.zod?.optional, true);
});
