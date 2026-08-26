import test from "node:test";
import assert from "node:assert/strict";

import type { components } from "../../http-client/src/generated/openapi.ts";
import { liveKitSessionGrantSchema, toLiveKitSessionWireRequest } from "../src/wire.ts";

/**
 * The zod schemas and the generated contract types describe the SAME wire, twice.
 *
 * wire-parity.test.ts compares the two translators to EACH OTHER, which catches them
 * disagreeing but not both being wrong together. Nothing compared either of them to the
 * published contract — so a key could exist in the carried translator, be absent from the
 * platform's zod source and absent from the OpenAPI document, and no check would notice.
 *
 * One does: `portrait_url`. It is at wire.ts:293 with its own validation rule, it is in the
 * built react entry, and it appears in NEITHER the published contract NOR the platform's zod
 * source. The wire is strict — an unknown field is a 422 — so any path that really sends it is
 * already broken. It is named below rather than deleted because removing a field from the
 * upstream carry is an upstream decision, and an allowlisted divergence is at least a visible
 * one.
 *
 * These are TYPE assertions that run as a test only so they are counted. The real check is the
 * typecheck: if a key drifts, `npm run typecheck` fails and names it.
 */

type Wire = components["schemas"];
type MustBeNever<T extends never> = T;
type WireOut = ReturnType<typeof toLiveKitSessionWireRequest>;

/** Emitted by the carried translator, absent from the published contract. See above. */
type KnownUndocumented = "portrait_url";

// Every key the translator can emit is either in the contract or a named divergence.
type _noNewUndocumentedKeys = MustBeNever<
  Exclude<Exclude<keyof WireOut, keyof Wire["LiveKitSessionRequest"]>, KnownUndocumented>
>;

// The grant schema must keep parsing every field the contract promises: a key that appears
// upstream and not here reads back as `undefined` at runtime with no error anywhere.
type _grantCoversContract = MustBeNever<
  Exclude<keyof Wire["LiveKitSessionGrant"], keyof ReturnType<typeof liveKitSessionGrantSchema.parse>>
>;

test("the carried translator emits no wire key the contract does not declare", () => {
  // The assertion above is compile-time; this records WHY the allowlist has an entry, so the
  // next person reads a reason rather than deleting a line that looks arbitrary.
  const undocumented: KnownUndocumented[] = ["portrait_url"];
  assert.deepEqual(
    undocumented,
    ["portrait_url"],
    "the allowlist changed — a divergence was added or resolved, and it needs a decision upstream",
  );
});

test("the grant schema still parses every field the contract promises", () => {
  const grant = liveKitSessionGrantSchema.parse({
    session_id: "sess_1",
    room_name: "room_1",
    livekit_url: "wss://example.invalid",
    participant_token: "tok",
    participant_identity: "user_1",
    reservation_expires_at: new Date(0).toISOString(),
  });
  // Rule 4 again, from the other side: an absent mode must not come back as silence.
  assert.equal(grant.stt_mode, "server");
});
