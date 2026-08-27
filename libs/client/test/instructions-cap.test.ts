import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_SESSION_INSTRUCTIONS_CHARS, liveKitSessionRequestSchema } from "../src/wire.ts";

/**
 * The constant exists so an app can budget its prompt assembly without probing the schema
 * with a binary search. That only holds while it IS the number the mint enforces, so the
 * schema is read back here both by reflection and at the boundary itself.
 */

function instructionIssues(instructions: string): number {
  const parsed = liveKitSessionRequestSchema.safeParse({ avatarId: "ava_1", instructions });
  if (parsed.success) return 0;
  return parsed.error.issues.filter((issue) => issue.path[0] === "instructions").length;
}

test("the exported cap is the one the mint schema enforces", () => {
  const cap = liveKitSessionRequestSchema.shape.instructions.unwrap().maxLength;
  assert.equal(cap, MAX_SESSION_INSTRUCTIONS_CHARS);
});

test("the cap is exact: at the boundary passes, one past it is refused", () => {
  assert.equal(instructionIssues("x".repeat(MAX_SESSION_INSTRUCTIONS_CHARS)), 0);
  assert.ok(instructionIssues("x".repeat(MAX_SESSION_INSTRUCTIONS_CHARS + 1)) > 0);
});
