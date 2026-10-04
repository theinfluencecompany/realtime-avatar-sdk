import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatarApiError, normalizeRealtimeAvatarError } from "../src/errors.ts";
import { createProxyClient, type ProxyClientOptions } from "../src/proxy-client.ts";
import { createProxyHandler } from "../../proxy/src/config.ts";

/**
 * A mint has exactly one retry owner: the server client inside your route, which retries a
 * transient platform failure under one idempotency key. The browser does not re-ask.
 *
 * A second retry loop in the browser multiplied each click into up to nine platform mints, and
 * every browser retry of a route that had already forwarded the mint risked a session the page
 * never heard of. What the browser owns is the classification: a refusal arrives with its status,
 * code and request ID, and a deadline arrives as a routable error rather than a bare TimeoutError.
 *
 * These tests CALL the client with a scripted transport. They are not source pins.
 */

const A = "123e4567-e89b-42d3-a456-426614174001";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const unavailable = (requestId: string): Response =>
  json(503, {
    error: "Session admission is temporarily unavailable. Try again.",
    status: 503,
    code: "admission_unavailable",
    retryable: true,
    requestId,
  }, { "retry-after": "0" });

const grant = { status: "ready", session_id: "rts_x", room_name: "live:x", livekit_url: "wss://x", participant_token: "t" };

/** A transport that answers each attempt from a script and counts what it was asked. */
function scripted(answers: Array<() => Response>) {
  const seen = { calls: 0 };
  const fetch: typeof globalThis.fetch = async () => {
    seen.calls += 1;
    const next = answers.shift();
    if (!next) throw new Error("the client made more attempts than the script allows");
    return next();
  };
  return { fetch, seen };
}

/**
 * A transport that never answers on its own and settles only through its abort signal.
 *
 * The held timer stands in for the open socket a real fetch keeps: `AbortSignal.timeout` is
 * unref'd in node, so without something holding the loop the process exits before it fires.
 */
function hanging() {
  const seen = { calls: 0 };
  const fetch: typeof globalThis.fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      seen.calls += 1;
      const signal = init?.signal;
      if (!signal) return;
      const socket = setTimeout(() => reject(new Error("the client never gave up")), 30_000);
      signal.addEventListener("abort", () => {
        clearTimeout(socket);
        reject(signal.reason);
      }, { once: true });
    });
  return { fetch, seen };
}

const mint = (options: Omit<ProxyClientOptions, "proxyUrl">, signal?: AbortSignal) =>
  createProxyClient({ proxyUrl: "/api/realtime-avatar", ...options }).createLiveKitSessionOrBusy(
    { avatarId: "ava_test", mode: "avatar" },
    signal ? { signal } : undefined,
  );

test("a retryable 503 from the route is answered once: the browser does not re-ask", async () => {
  const transport = scripted([() => unavailable(A), () => json(200, grant)]);
  await assert.rejects(mint({ fetch: transport.fetch }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError, `threw ${String(error)}`);
    assert.equal(error.status, 503);
    assert.equal(error.code, "admission_unavailable");
    assert.equal(error.retryable, true, "the route's verdict is reported, not acted on");
    assert.equal(error.requestId, A);
    return true;
  });
  assert.equal(transport.seen.calls, 1, "the browser re-asked a mint the route had already retried");
});

test("the request ID falls back to X-Request-ID when the body does not carry one", async () => {
  const transport = scripted([() => json(402, { code: "insufficient_credits" }, { "x-request-id": A })]);
  await assert.rejects(mint({ fetch: transport.fetch }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError);
    assert.equal(error.requestId, A);
    return true;
  });
});

test("the deadline is a classified upstream_timeout whose status the vocabulary accepts", async () => {
  const transport = hanging();
  await assert.rejects(mint({ fetch: transport.fetch, timeoutMs: 50 }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError, `threw ${String(error)}`);
    assert.equal(error.code, "upstream_timeout");
    assert.equal(error.status, 504);
    assert.equal(error.retryable, true);
    assert.equal(error.response, null, "no response arrived");
    // Normalizing what the error carries must give back the same classification, or an app
    // routing on `normalizeRealtimeAvatarError` sees a different failure than `.code` names.
    const normalized = normalizeRealtimeAvatarError({ status: error.status, code: error.code });
    assert.equal(normalized.code, error.code, `status ${error.status} is not one upstream_timeout may accompany`);
    assert.equal(normalized.retryable, error.retryable);
    return true;
  });
  assert.equal(transport.seen.calls, 1, "a timed-out mint was sent again");
});

test("the caller's abort stays an abort, never a timeout", async () => {
  const caller = new AbortController();
  const transport = hanging();
  const pending = mint({ fetch: transport.fetch }, caller.signal);
  caller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(!(error instanceof RealtimeAvatarApiError), "an unmount was reported as a failure");
    assert.ok(error instanceof Error && error.name === "AbortError", `threw ${String(error)}`);
    return true;
  });
});

/**
 * This client and the `realtime-avatar/*` route handler, wired together, against a scripted platform.
 *
 * Unless the handler relays the platform's verdict, every refusal leaves it as a body-less 500:
 * the page cannot tell a revoked key or a missing avatar from a blip, and the platform's request
 * ID never reaches it.
 */
const PLATFORM_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174009";

function platform(answer: () => Response) {
  const seen = { calls: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    seen.calls += 1;
    return answer();
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

const platformFailure = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ status, requestId: PLATFORM_REQUEST_ID, ...body }), {
    status,
    headers: { "content-type": "application/json", "retry-after": "0", "x-request-id": PLATFORM_REQUEST_ID },
  });

async function mintThroughHandler(answer: () => Response) {
  const upstreamPlatform = platform(answer);
  const handler = createProxyHandler({ apiKey: "k" });
  const browser = { attempts: 0 };
  const client = createProxyClient({
    proxyUrl: "http://app.test/api/realtime-avatar",
    fetch: async (input, init) => {
      browser.attempts += 1;
      // What Next.js, Hono and Express answer for a handler that throws: a 500 with no body.
      return handler(new Request(input, init)).catch(() => new Response(null, { status: 500 }));
    },
  });
  try {
    const error = await client.createLiveKitSessionOrBusy({ avatarId: "ava_1", mode: "avatar" }).then(
      () => assert.fail("the mint should have failed"),
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof RealtimeAvatarApiError, `threw ${String(error)}`);
    return { error, browserAttempts: browser.attempts, platformCalls: upstreamPlatform.seen.calls };
  } finally {
    upstreamPlatform.restore();
  }
}

test("a platform refusal reaches the browser once, with its status, code and request ID", async () => {
  const { error, browserAttempts, platformCalls } = await mintThroughHandler(() =>
    platformFailure(404, { error: "PRIVATE_DIAGNOSTIC", code: "not_found" }));
  assert.equal(browserAttempts, 1);
  assert.equal(platformCalls, 1);
  assert.equal(error.status, 404);
  assert.equal(error.code, "not_found");
  assert.equal(error.requestId, PLATFORM_REQUEST_ID, "the platform request ID did not reach the browser");
  assert.ok(!JSON.stringify(error.body).includes("PRIVATE_DIAGNOSTIC"));
});

test("a platform 503 is retried by the server client only: three platform calls, one browser attempt", async () => {
  const { error, browserAttempts, platformCalls } = await mintThroughHandler(() =>
    platformFailure(503, { code: "admission_unavailable", retryable: true }));
  assert.equal(platformCalls, 3, "the server client owns the transport retry");
  assert.equal(browserAttempts, 1, "the browser multiplied a mint the route had already retried");
  assert.equal(error.status, 503);
  assert.equal(error.code, "admission_unavailable");
  assert.equal(error.requestId, PLATFORM_REQUEST_ID);
});
