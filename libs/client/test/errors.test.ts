import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRealtimeAvatarError } from "../src/errors.ts";

/**
 * `normalizeRealtimeAvatarError` decides whether a backend message is repeated to a user
 * verbatim or replaced with the SDK's own copy. It had no tests, which is how the shipped
 * filter stayed a list of internal identifiers for as long as it did.
 *
 * These cases assert the SHAPE rule and nothing about vocabulary — a fixture naming the
 * private stack would put it back in the public tree, one file over from where it was
 * removed.
 */

const MACHINE_SHAPED = [
  "unknown record_id rec_9f2c",
  "available=[alpha, beta]",
  '  File "/srv/app/main", line 42',
  "at handler (/srv/app/index.js:31:9)",
  "some.module.path.Failure",
  "loader.start() returned nothing",
  "out of memory {device:0}",
];

const USER_SAFE = [
  "Add credits to continue using realtime avatars.",
  "Too many realtime requests. Please slow down and retry.",
  "Your plan does not include video calls yet.",
  "Rate limit reached: 100 requests per minute.",
];

test("a machine-shaped 402 message is replaced with the SDK's own billing copy", () => {
  for (const message of MACHINE_SHAPED) {
    const out = normalizeRealtimeAvatarError({ status: 402, code: "insufficient_credits", message });
    assert.equal(out.message, "Add credits to continue using realtime avatars.");
    assert.equal(out.retryable, false);
  }
});

test("a plain-prose 402 message is passed through", () => {
  const out = normalizeRealtimeAvatarError({
    status: 402,
    code: "insufficient_credits",
    message: "Your balance ran out during the call.",
  });
  assert.equal(out.message, "Your balance ran out during the call.");
});

test("a machine-shaped 400 message never reaches the user", () => {
  for (const message of MACHINE_SHAPED) {
    const out = normalizeRealtimeAvatarError({ status: 400, message });
    assert.equal(out.code, "invalid_request");
    assert.equal(out.message, "Check the request and try again.");
  }
});

test("a plain-prose 400 message is kept, because it is the useful half of a validation error", () => {
  for (const message of USER_SAFE) {
    const out = normalizeRealtimeAvatarError({ status: 400, message });
    assert.equal(out.message, message);
  }
});

test("an over-long prose message is truncated rather than dropped", () => {
  const message = `${"word ".repeat(60)}end.`;
  const out = normalizeRealtimeAvatarError({ status: 400, message });
  assert.equal(out.message.length, 180);
  assert.ok(out.message.endsWith("..."));
});

test("an unrecognised status falls back to canned copy when the message is machine-shaped", () => {
  const out = normalizeRealtimeAvatarError({ status: 418, message: "teapot_state={brewing}" });
  assert.equal(out.code, "request_failed");
  assert.equal(out.message, "Realtime Avatar request failed. Try again.");
});

test("the shape test is stateless — a global flag here would alternate results", () => {
  const message = "widget_id=7";
  const first = normalizeRealtimeAvatarError({ status: 400, message }).message;
  const second = normalizeRealtimeAvatarError({ status: 400, message }).message;
  assert.equal(first, second);
});
