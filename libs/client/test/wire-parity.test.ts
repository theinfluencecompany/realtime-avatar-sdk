import assert from "node:assert/strict";
import { test } from "node:test";

import { RealtimeAvatar } from "../../http-client/src/index.ts";
import { liveKitSessionGrantSchema, toLiveKitSessionWireRequest } from "../src/wire.ts";

/**
 * Two packages translate the same call into the same wire, and nothing was checking that they
 * agreed. They did not: for `startCall({ avatarId })`, `realtime-avatar` sent
 * `stt_mode: "server"` and `realtime-avatar/react` sent `"off"` — so whichever package an app
 * installed decided whether the avatar could hear the user, with no error on either side.
 * AGENTS.md rule 4 says full duplex "is not a setting"; one of the two implementations had
 * made it one.
 *
 * These tests compare the BYTES each package puts on the wire. A field only needs to appear
 * here once it exists on both sides — the point is that a default can never again diverge
 * silently, which is the failure mode that shipped.
 */

/** Capture the body `realtime-avatar` would POST, without a network. */
async function coreWire(options: Parameters<RealtimeAvatar["startCall"]>[0]): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const rta = new RealtimeAvatar({
    apiKey: "tic_test_parity",
    maxRetries: 0,
    fetch: async (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await rta.startCall(options).catch(() => undefined);
  assert.ok(body, "the core client did not send a request body");
  return body;
}

test("both packages ask the platform to listen, for the same minimal call", async () => {
  const core = await coreWire({ avatarId: "ava_parity" });
  const react = toLiveKitSessionWireRequest({ avatarId: "ava_parity" });

  assert.equal(core.stt_mode, "server", "the core must ask the platform to listen");
  assert.equal(
    react.stt_mode,
    core.stt_mode,
    "realtime-avatar/react disagrees with realtime-avatar about whether she listens",
  );
});

test("both packages name the avatar the same way", async () => {
  const core = await coreWire({ avatarId: "ava_parity" });
  const react = toLiveKitSessionWireRequest({ avatarId: "ava_parity" });

  assert.equal(core.avatar_id, "ava_parity");
  assert.equal(react.avatar_id, core.avatar_id);
});

test("both packages default to the avatar renderer, not to voice", async () => {
  const core = await coreWire({ avatarId: "ava_parity" });
  const react = toLiveKitSessionWireRequest({ avatarId: "ava_parity" });

  assert.equal(core.mode, "avatar");
  assert.equal(react.mode, core.mode);
});

test("an explicit voice call is voice in both", async () => {
  const core = await coreWire({ avatarId: "ava_parity", mode: "voice" });
  const react = toLiveKitSessionWireRequest({ avatarId: "ava_parity", mode: "voice" });

  assert.equal(core.mode, "voice");
  assert.equal(react.mode, core.mode);
  // Voice is still full duplex — rule 4. The renderer changed, not the listening.
  assert.equal(core.stt_mode, "server");
  assert.equal(react.stt_mode, "server");
});

test("every wire key present on both sides carries the same value", async () => {
  const core = await coreWire({ avatarId: "ava_parity" });
  const react = toLiveKitSessionWireRequest({ avatarId: "ava_parity" }) as Record<string, unknown>;

  const shared = Object.keys(core).filter((key) => react[key] !== undefined);
  assert.ok(shared.length >= 3, `expected the two wires to overlap; shared keys: ${shared.join(", ")}`);

  for (const key of shared) {
    assert.deepEqual(
      react[key],
      core[key],
      `wire key '${key}' differs: realtime-avatar sends ${JSON.stringify(core[key])}, ` +
        `realtime-avatar/react sends ${JSON.stringify(react[key])}`,
    );
  }
});

/**
 * The test above compares the INTERSECTION, and that is a hole: it cannot see a key one side
 * sends and the other omits. Measured 2026-08-26 — for the same minimal call, `realtime-avatar`
 * sends 3 keys and the React translator sends 7.
 *
 * Presence asymmetry is the same class of bug as the `stt_mode` value divergence, one step
 * removed. These four are sent by the React side carrying the CONTRACT'S OWN DEFAULT, so today
 * both requests behave identically. The risk is what happens when the platform changes one of
 * those defaults: the side that spells the value out keeps the OLD behaviour forever while the
 * side that omits it picks up the new one, and nothing errors — which is exactly how a call
 * ended up not listening.
 *
 * So the asymmetry is allowed but ENUMERATED. A new one fails here and has to be argued for.
 */
const KNOWN_ONLY_ON_THE_REACT_SIDE = new Set([
  "background_id",    // contract default "plain_white"
  "create_room",      // contract default true
  "dispatch_agent",   // contract default true
  "initial_context",  // contract default []
]);

test("neither side sends a key the other does not, beyond the four known defaults", async () => {
  const core = await coreWire({ avatarId: "ava_parity" });
  const react = toLiveKitSessionWireRequest({ avatarId: "ava_parity" }) as Record<string, unknown>;

  const coreOnly = Object.keys(core).filter((k) => !(k in react));
  assert.deepEqual(coreOnly, [], `realtime-avatar sends keys the React translator does not: ${coreOnly.join(", ")}`);

  const reactOnly = Object.keys(react).filter((k) => !(k in core));
  const unexpected = reactOnly.filter((k) => !KNOWN_ONLY_ON_THE_REACT_SIDE.has(k));
  assert.deepEqual(
    unexpected,
    [],
    `the React translator sends ${unexpected.join(", ")}, which realtime-avatar omits. Either send ` +
      `it from both, omit it from both, or add it to KNOWN_ONLY_ON_THE_REACT_SIDE with the reason.`,
  );

  // And the allowlist must not rot: a name that stops diverging has to come out of it.
  const stale = [...KNOWN_ONLY_ON_THE_REACT_SIDE].filter((k) => !reactOnly.includes(k));
  assert.deepEqual(stale, [], `these no longer diverge — drop them from the allowlist: ${stale.join(", ")}`);
});

test("a grant with fields missing reports them as unknown, not as invented numbers", () => {
  // The schema used to fill absent timing fields with plausible-looking constants, so a page
  // counted down from a limit the server never set. `realtime-avatar` reads them as
  // `Number(grant.x ?? 0)`, and grace-window.ts already branches on `!maxSessionSeconds` —
  // the fabrication was defeating a guard the consumer already had.
  const grant = liveKitSessionGrantSchema.parse({
    session_id: "sess_1",
    room_name: "room_1",
    livekit_url: "wss://example.invalid",
    participant_token: "tok",
    participant_identity: "user_1",
    reservation_expires_at: new Date(0).toISOString(),
  });

  assert.equal(grant.max_session_seconds, 0, "an absent session cap must not be invented");
  assert.equal(grant.idle_timeout_seconds, 0);
  assert.equal(grant.join_timeout_seconds, 0);
  // Rule 4: full duplex is not a setting, so an absent mode must not silence the microphone.
  assert.equal(grant.stt_mode, "server");
});
