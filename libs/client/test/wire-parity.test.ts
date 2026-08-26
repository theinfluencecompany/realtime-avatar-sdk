import assert from "node:assert/strict";
import { test } from "node:test";

import { RealtimeAvatar } from "../../http-client/src/index.ts";
import { toLiveKitSessionWireRequest } from "../src/wire.ts";

/**
 * Two packages translate the same call into the same wire, and nothing was checking that they
 * agreed. They did not: for `startCall({ avatarId })`, `realtime-avatar` sent
 * `stt_mode: "server"` and `realtime-avatar-react` sent `"off"` — so whichever package an app
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
    "realtime-avatar-react disagrees with realtime-avatar about whether she listens",
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
        `realtime-avatar-react sends ${JSON.stringify(react[key])}`,
    );
  }
});
