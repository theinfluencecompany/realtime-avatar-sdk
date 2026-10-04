import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatarApiError } from "../src/errors.ts";
import { createProxyClient, type ProxyClientOptions } from "../src/proxy-client.ts";

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
  await assert.rejects(mint({ fetch, timeoutMs: 100 }), (error: unknown) => {
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
