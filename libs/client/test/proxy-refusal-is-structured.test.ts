import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatarApiError } from "../src/errors.ts";
import { createProxyClient } from "../src/proxy-client.ts";

/**
 * A refusal from YOUR route must reach the page as a structured error.
 *
 * `createProxyClient` is the only client a browser or React Native app can hold, and the
 * route behind it is where the product decisions live: out of credits (402), sign in (401),
 * plan gate (403 + a code), character gone (404). The page routes each to a different wall,
 * and it routes on `error.status` and the body's `code` — which is what the key-bearing
 * client has always thrown (`RealtimeAvatarApiError`).
 *
 * The proxy client used to throw a bare `Error` with the status typeset into the message.
 * `.status` was undefined, `.body` did not exist, and every refusal collapsed into whatever an
 * adopter does when it cannot tell: the retryable "connection lost" wall. Concretely, a user
 * whose balance had dropped below the start floor tapped Call and saw the character as
 * unavailable on every attempt — not the paywall the 402 was asking for. That ran for over a
 * week without a metric moving, because the mint was refused correctly; only the routing lied.
 *
 * These tests CALL the client with a fake transport. They are not source pins.
 */

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const clientAnswering = (response: Response) =>
  createProxyClient({ proxyUrl: "/api/realtime-avatar", fetch: async () => response });

const mint = (response: Response) =>
  clientAnswering(response).createLiveKitSessionOrBusy({ avatarId: "ava_test", mode: "avatar" } as never);

test("a 402 from the route is a RealtimeAvatarApiError carrying status, code and billing", async () => {
  // The exact body an adopter's credit gate answers with when a wallet is under its start floor.
  const refusal = json(402, {
    error: "You're out of credits.",
    code: "insufficient_credits",
    feature: "credits",
    required: 120,
    balance: 88,
    deficit: 32,
  });

  await assert.rejects(mint(refusal), (err: unknown) => {
    assert.ok(
      err instanceof RealtimeAvatarApiError,
      `the proxy client threw ${String(err)} — a bare Error again; the page cannot route a wall from it`,
    );
    assert.equal(err.status, 402, "status must be on the error, not typeset into its message");
    assert.equal((err.body as { code?: string }).code, "insufficient_credits", "the route's raw code must survive on .body");
    assert.equal(err.isBillingRequired, true);
    return true;
  });
});

test("401, 403 and 404 keep their status and the route's own code", async () => {
  const cases: Array<[number, string]> = [
    [401, "unauthorized"],
    [403, "upgrade_required"],
    [404, "character_not_found"],
  ];
  for (const [status, code] of cases) {
    await assert.rejects(mint(json(status, { error: "refused", code })), (err: unknown) => {
      assert.ok(err instanceof RealtimeAvatarApiError, `${status}: not a RealtimeAvatarApiError`);
      assert.equal(err.status, status);
      assert.equal((err.body as { code?: string }).code, code, `${status}: raw code lost`);
      return true;
    });
  }
});

test("a non-JSON refusal still carries its status", async () => {
  const refusal = new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } });
  await assert.rejects(mint(refusal), (err: unknown) => {
    assert.ok(err instanceof RealtimeAvatarApiError);
    assert.equal(err.status, 502);
    return true;
  });
});

test("a 429 is still the busy VALUE, never a throw", async () => {
  const result = await mint(json(429, { queue_size: 3, queue_position: 2, recommended_retry_ms: 2000 }));
  assert.equal(result.status, "busy");
});

test("a 200 is still the grant, relayed byte for byte", async () => {
  const grant = { status: "ready", session_id: "rts_x", room_name: "live:x", livekit_url: "wss://x", participant_token: "t" };
  const result = await mint(json(200, grant));
  assert.equal(result.status, "ready");
  assert.deepEqual((result as { grant: unknown }).grant, grant);
});
