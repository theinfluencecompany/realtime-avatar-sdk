import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatarApiError } from "../src/errors.ts";
import { createProxyClient, type ProxyClientOptions } from "../src/proxy-client.ts";
import { createProxyHandler } from "../../proxy/src/config.ts";

/**
 * One transient refusal must not end a user's call attempt, and a proxy that never answers must
 * end it with an error an app can route.
 *
 * The platform's mint answers transient upstream trouble — a slow room service, a dispatch that
 * did not land — with a retryable 503 carrying a `requestId`. The proxy client used to throw that
 * first 503 straight to the page, so a blip lasting one request became a failed call. Its
 * deadline surfaced as a bare `TimeoutError`, with no status, code or `retryable` to route on.
 *
 * These tests CALL the client with a scripted transport. They are not source pins.
 */

const A = "123e4567-e89b-42d3-a456-426614174001";
const B = "123e4567-e89b-42d3-a456-426614174002";
const C = "123e4567-e89b-42d3-a456-426614174003";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const unavailable = (requestId: string, headers: Record<string, string> = { "retry-after": "0" }): Response =>
  json(503, {
    error: "Session admission is temporarily unavailable. Try again.",
    status: 503,
    code: "admission_unavailable",
    retryable: true,
    requestId,
  }, headers);

const grant = { status: "ready", session_id: "rts_x", room_name: "live:x", livekit_url: "wss://x", participant_token: "t" };

/** A transport that answers each attempt from a script and records what it was asked. */
function scripted(answers: Array<() => Response>) {
  const calls: number[] = [];
  const fetch: typeof globalThis.fetch = async () => {
    calls.push(Date.now());
    const next = answers.shift();
    if (!next) throw new Error("the client made more attempts than the script allows");
    return next();
  };
  return { fetch, calls };
}

/**
 * A transport that never answers on its own and settles only through its abort signal.
 *
 * The held timer stands in for the open socket a real fetch keeps: `AbortSignal.timeout` is
 * unref'd in node, so without something holding the loop the process exits before it fires.
 */
const hanging: typeof globalThis.fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const socket = setTimeout(() => reject(new Error("the client never gave up")), 30_000);
    signal.addEventListener("abort", () => {
      clearTimeout(socket);
      reject(signal.reason);
    }, { once: true });
  });

const mint = (options: Omit<ProxyClientOptions, "proxyUrl">, signal?: AbortSignal) =>
  createProxyClient({ proxyUrl: "/api/realtime-avatar", ...options }).createLiveKitSessionOrBusy(
    { avatarId: "ava_test", mode: "avatar" },
    signal ? { signal } : undefined,
  );

test("a retryable 503 is retried and the call proceeds on the next answer", async () => {
  const transport = scripted([() => unavailable(A), () => json(200, grant)]);
  const result = await mint({ fetch: transport.fetch });
  assert.equal(transport.calls.length, 2, "one transient 503 ended the call attempt");
  assert.ok(result.status === "ready");
  assert.deepEqual(result.grant, grant);
});

test("retries stop at three attempts and the final error keeps every attempt's request ID", async () => {
  const transport = scripted([() => unavailable(A), () => unavailable(B), () => unavailable(C)]);
  await assert.rejects(mint({ fetch: transport.fetch }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError, `threw ${String(error)}`);
    assert.equal(error.status, 503);
    assert.equal(error.code, "admission_unavailable");
    assert.equal(error.retryable, true);
    assert.equal(error.requestId, C, "the final failure lost its platform request ID");
    const earlier: unknown[] = [];
    for (let cause = error.cause; cause instanceof RealtimeAvatarApiError; cause = cause.cause) {
      earlier.push(cause.requestId);
    }
    assert.deepEqual(earlier, [B, A], "earlier attempts must stay reachable for correlation");
    return true;
  });
  assert.equal(transport.calls.length, 3);
});

test("the request ID falls back to X-Request-ID when the body does not carry one", async () => {
  const transport = scripted([() => json(402, { code: "insufficient_credits" }, { "x-request-id": A })]);
  await assert.rejects(mint({ fetch: transport.fetch }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError);
    assert.equal(error.requestId, A);
    return true;
  });
});

test("a refusal is never retried: non-retryable 4xx, 429, and a 5xx the server marks final", async () => {
  const refusals: Array<() => Response> = [
    () => json(402, { code: "insufficient_credits" }),
    () => json(404, { code: "not_found" }),
    () => json(409, { code: "conflict", retryable: true }),
    () => json(429, { code: "concurrency_limit_reached" }),
    () => json(503, { code: "admission_unavailable", retryable: false }),
    () => json(501, { code: "recording_unsupported" }),
  ];
  for (const refusal of refusals) {
    const transport = scripted([refusal, () => json(200, grant)]);
    await assert.rejects(mint({ fetch: transport.fetch }), RealtimeAvatarApiError);
    assert.equal(transport.calls.length, 1, `${refusal().status} was retried`);
  }
});

test("a 5xx the route did not classify is never retried: only the route's own retryable: true authorises one", async () => {
  // A body-less 500 is a route that threw, perhaps after it started a call; a gateway 502/504
  // may sit in front of a route still minting. Re-asking either can start a second call.
  const unclassified: Array<() => Response> = [
    () => new Response(null, { status: 500 }),
    () => new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain", "retry-after": "0" } }),
    () => json(504, { error: "upstream timed out" }),
    () => json(503, { code: "admission_unavailable", requestId: A }),
  ];
  for (const answer of unclassified) {
    const transport = scripted([answer, () => json(200, grant)]);
    await assert.rejects(mint({ fetch: transport.fetch }), RealtimeAvatarApiError);
    assert.equal(transport.calls.length, 1, `an unclassified ${answer().status} was retried`);
  }
});

test("a retry is not started without time left to finish a mint", async () => {
  // Aborting a mint the route has already forwarded leaves a session the page never hears of,
  // holding a seat until the join timeout. 4s left is under the floor an attempt needs.
  const transport = scripted([() => unavailable(A), () => json(200, grant)]);
  await assert.rejects(mint({ fetch: transport.fetch, timeoutMs: 4_000 }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError, `threw ${String(error)}`);
    assert.equal(error.status, 503);
    assert.equal(error.requestId, A);
    return true;
  });
  assert.equal(transport.calls.length, 1, "started a mint with too little time left to finish it");
});

test("the floor grows to the last attempt's duration: a slow route gets no retry it cannot finish", async () => {
  // 6s for the first answer leaves ~5.5s, above the fixed floor but below what this route takes.
  const answers: Array<typeof globalThis.fetch> = [
    () => new Promise((resolve) => setTimeout(() => resolve(unavailable(A)), 6_000)),
    async () => json(200, grant),
  ];
  let attempts = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    attempts += 1;
    const next = answers.shift();
    if (!next) throw new Error("unexpected attempt");
    return next(input, init);
  };
  await assert.rejects(mint({ fetch, timeoutMs: 11_500 }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError, `threw ${String(error)}`);
    assert.equal(error.status, 503);
    assert.equal(error.requestId, A);
    return true;
  });
  assert.equal(attempts, 1, "retried a slow route with less time left than its last attempt took");
});

test("maxRetries: 0 turns the retry off", async () => {
  const transport = scripted([() => unavailable(A), () => json(200, grant)]);
  await assert.rejects(mint({ fetch: transport.fetch, maxRetries: 0 }), RealtimeAvatarApiError);
  assert.equal(transport.calls.length, 1);
});

test("Retry-After is honoured", async () => {
  const transport = scripted([() => unavailable(A, { "retry-after": "1" }), () => json(200, grant)]);
  const result = await mint({ fetch: transport.fetch });
  assert.equal(result.status, "ready");
  const [first, second] = transport.calls;
  assert.ok(second - first >= 950, `retried after ${second - first}ms despite Retry-After: 1`);
});

test("a retry that would outlast the deadline is not attempted; the 503 is the answer", async () => {
  const transport = scripted([() => unavailable(A, { "retry-after": "5" }), () => json(200, grant)]);
  const started = Date.now();
  await assert.rejects(mint({ fetch: transport.fetch, timeoutMs: 1_000 }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError);
    assert.equal(error.status, 503);
    assert.equal(error.requestId, A);
    return true;
  });
  assert.equal(transport.calls.length, 1);
  assert.ok(Date.now() - started < 900, "the client slept toward a retry it could never make");
});

test("the deadline is a classified, retryable timeout error rather than a bare TimeoutError", async () => {
  await assert.rejects(mint({ fetch: hanging, timeoutMs: 50 }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError, `threw ${String(error)}`);
    assert.equal(error.code, "upstream_timeout");
    assert.equal(error.retryable, true);
    assert.equal(error.status, 0, "no HTTP status was received, so none is reported");
    assert.equal(error.response, null);
    return true;
  });
});

test("the deadline spans the retries, and the timeout keeps the earlier attempt's request ID", async () => {
  const answers: Array<typeof globalThis.fetch> = [async () => unavailable(A), hanging];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const next = answers.shift();
    if (!next) throw new Error("unexpected attempt");
    return next(input, init);
  };
  await assert.rejects(mint({ fetch, timeoutMs: 5_300 }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarApiError, `threw ${String(error)}`);
    assert.equal(error.code, "upstream_timeout");
    assert.ok(error.cause instanceof RealtimeAvatarApiError);
    assert.equal(error.cause.requestId, A);
    return true;
  });
});

test("the caller's abort stays an abort, including during the backoff", async () => {
  const caller = new AbortController();
  await assert.rejects(
    (async () => {
      const pending = mint({ fetch: hanging }, caller.signal);
      caller.abort();
      return pending;
    })(),
    (error: unknown) => {
      assert.ok(!(error instanceof RealtimeAvatarApiError), "an unmount was reported as a failure");
      assert.ok(error instanceof Error && error.name === "AbortError", `threw ${String(error)}`);
      return true;
    },
  );

  const during = new AbortController();
  const transport = scripted([() => unavailable(A, { "retry-after": "5" }), () => json(200, grant)]);
  const started = Date.now();
  setTimeout(() => during.abort(), 50);
  await assert.rejects(mint({ fetch: transport.fetch }, during.signal), (error: unknown) => {
    assert.ok(error instanceof Error && error.name === "AbortError", `threw ${String(error)}`);
    return true;
  });
  assert.equal(transport.calls.length, 1, "retried after the caller had gone");
  assert.ok(Date.now() - started < 1_000, "the backoff ignored the caller's abort");
});

/**
 * This client and the `realtime-avatar/*` route handler, wired together, against a scripted platform.
 *
 * Unless the handler relays the platform's verdict, every refusal leaves it as a body-less 500:
 * the browser cannot tell a revoked key or a missing avatar from a blip, retries each one, and
 * the platform's request ID never reaches the page. And a platform 503 the server client has
 * already retried must not be retried again by the browser, or one click becomes nine mints.
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
  assert.equal(browserAttempts, 1, "a 404 from the platform was retried by the browser");
  assert.equal(platformCalls, 1);
  assert.equal(error.status, 404);
  assert.equal(error.code, "not_found");
  assert.equal(error.requestId, PLATFORM_REQUEST_ID, "the platform request ID did not reach the browser");
  assert.ok(!JSON.stringify(error.body).includes("PRIVATE_DIAGNOSTIC"));
});

test("a platform 401 is the route's key, so the page is not sent to sign in", async () => {
  const { error, browserAttempts } = await mintThroughHandler(() => platformFailure(401, { code: "unauthorized" }));
  assert.equal(browserAttempts, 1);
  assert.equal(error.status, 500, "the route's own credential failure reached the page as a sign-in 401");
  assert.equal(error.retryable, false);
  assert.equal(error.requestId, PLATFORM_REQUEST_ID);
});

test("a platform 503 is retried by the server client only, never multiplied by the browser", async () => {
  for (const retryable of [false, true]) {
    const { error, browserAttempts, platformCalls } = await mintThroughHandler(() =>
      platformFailure(503, { code: "admission_unavailable", retryable }));
    assert.equal(platformCalls, 3, "the server client owns the transport retry");
    assert.equal(browserAttempts, 1, `retryable: ${retryable} — the browser retried a 503 the route had already retried`);
    assert.equal(error.status, 503);
    assert.equal(error.code, "admission_unavailable");
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, PLATFORM_REQUEST_ID, "the platform request ID did not reach the browser");
  }
});
