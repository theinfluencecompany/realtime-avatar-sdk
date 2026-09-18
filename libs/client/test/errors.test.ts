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

/**
 * THE CODE TABLE IS THE PLATFORM'S, NOT THIS REPO'S.
 *
 * Every case below was measured failing on 2026-09-18 against platform main, before
 * `ERROR_SEMANTICS` was generated from the contract. The shape of the bug was always the same:
 * a hand-written status ladder that had never heard of a code, so the status answered instead
 * and said something untrue about it.
 *
 *   501 recording_unsupported       -> service_unavailable, retryable: TRUE
 *
 * A recording backend that was not compiled into the deployment does not appear on a retry.
 * The platform had already been corrected to `retryable: false`; the published SDK had not,
 * and there was no mechanism by which it could have been.
 */
test("a published code carries the platform's retry verdict, not the status ladder's", () => {
  const permanent = normalizeRealtimeAvatarError({
    status: 501,
    code: "recording_unsupported",
    message: "recording backend not compiled",
  });
  assert.equal(permanent.code, "recording_unsupported");
  assert.equal(permanent.retryable, false, "a missing backend is permanent and must not be advertised as retryable");
  assert.equal(permanent.message, "Session recording is not enabled for this deployment.");

  const transient = normalizeRealtimeAvatarError({
    status: 503,
    code: "recording_unavailable",
    message: "recorder pool empty",
  });
  assert.equal(transient.code, "recording_unavailable");
  assert.equal(transient.retryable, true);
});

/**
 * Authored copy OUTRANKS upstream prose for a code that has copy.
 *
 * The old ladder read `userSafeMessage(raw) ?? "authored copy"`, which inverts the priority: any
 * upstream sentence that merely passed the shape test won, so `insufficient_credits` answered
 * users with the server's `"balance 0"` and `concurrency_limit_reached` with `"too many"`. Those
 * pass the shape test because they are shaped exactly like prose. Shape is a filter against
 * leaking internals, never a reason to prefer a debug string over a written sentence.
 */
test("authored copy beats plain upstream prose for a copied code", () => {
  const out = normalizeRealtimeAvatarError({ status: 422, code: "recording_requires_new_room", message: "room already started" });
  assert.equal(out.code, "recording_requires_new_room");
  assert.equal(out.message, "Recording requires a new session room. Start a fresh session to record it.");
  assert.equal(out.retryable, false);
});

/**
 * A code the platform recognises but does not copy keeps the SERVER's sentence, because that
 * sentence names a number this table cannot know: the plan's ceiling, the amount owed.
 */
test("an uncopied code prefers the server's own sentence", () => {
  const out = normalizeRealtimeAvatarError({
    status: 429,
    code: "concurrency_limit_reached",
    message: "Your plan allows 3 concurrent sessions.",
  });
  assert.equal(out.code, "concurrency_limit_reached");
  assert.equal(out.message, "Your plan allows 3 concurrent sessions.");
  assert.equal(out.retryable, true);
});

/**
 * A RECOGNISED code on a status it may not accompany is discarded and the status answers.
 * An UNRECOGNISED code is never promoted to the status default, or an unknown refusal gets
 * dressed up as a specific one a caller could switch on. Same two rules as the platform.
 */
test("status mismatch and unknown codes do not become refusals", () => {
  const mismatched = normalizeRealtimeAvatarError({ status: 429, code: "avatar_not_ready", message: "" });
  assert.equal(mismatched.code, "rate_limited");

  const unknown = normalizeRealtimeAvatarError({ status: 418, code: "totally_made_up", message: "" });
  assert.equal(unknown.code, "request_failed");
});

/**
 * `service_warming` is a CODE now. The old ladder sniffed prose for "warming"/"not ready" and
 * its own comment said the fix belonged upstream; the contract has the code, so the guess goes.
 */
test("warming is recognised by code, not by sniffing prose", () => {
  const coded = normalizeRealtimeAvatarError({ status: 503, code: "service_warming", message: "" });
  assert.equal(coded.message, "Realtime Avatar is warming up. Try again in a moment.");
  assert.equal(coded.retryable, true);
});

/**
 * A bodiless 5xx must answer `service_unavailable`, not whichever entry lists that status
 * first.
 *
 * `semanticsForStatus` is a `.find()` over entries whose `statuses` lists OVERLAP in the 500
 * range: 500 is in `internal_error` and `upstream_failed`; 502 in `upstream_failed`,
 * `upstream_unreachable` and `invalid_upstream_response`; 503 in six of them. With no code to
 * disambiguate, the answer is whichever key was declared first, which is table order rather
 * than a decision.
 *
 * Measured 2026-09-18 on the platform side, where the same arm answered `upstream_failed` for
 * a bodiless 502 and `http_504` for a 504. Kept here so parity is asserted on both sides
 * rather than assumed from a shared generator.
 */
test("a 5xx without a code normalizes to service_unavailable", () => {
  for (const status of [500, 502, 503, 504, 599]) {
    const normalized = normalizeRealtimeAvatarError({ status, code: null, message: "" });
    assert.equal(normalized.code, "service_unavailable", `status ${status}`);
    assert.equal(normalized.retryable, true, `status ${status} retryable`);
  }
});

test("a coded 5xx keeps its own identity", () => {
  assert.equal(
    normalizeRealtimeAvatarError({ status: 502, code: "upstream_unreachable", message: "" }).code,
    "upstream_unreachable",
  );
  assert.equal(
    normalizeRealtimeAvatarError({ status: 500, code: "internal_error", message: "" }).code,
    "internal_error",
  );
});
