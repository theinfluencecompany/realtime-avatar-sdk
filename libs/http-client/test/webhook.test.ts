import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { RealtimeAvatarError, RealtimeAvatarWebhookError } from "../src/errors.ts";
import { verifyTranscript, verifyVoiceWebhook } from "../src/webhook.ts";

const SECRET = "a-secret-at-least-16-chars";

function sign(body: string, ts: number): Record<string, string> {
  const mac = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  return { "x-rta-signature": `v1=${mac}`, "x-rta-timestamp": String(ts) };
}

const PAYLOAD = JSON.stringify({
  type: "session.transcript", session_id: "s", avatar_id: "a", mode: "voice",
  started_at: 1, ended_at: 2, seconds: 1, truncated: false,
  segments: [{ role: "user", text: "hi", ts: 1 }], client_metadata: { user_id: "u1" },
});

test("a correctly signed payload verifies", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const out = await verifyTranscript(PAYLOAD, sign(PAYLOAD, ts), SECRET);
  assert.equal(out.client_metadata.user_id, "u1");
});

test("a tampered body is rejected", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const headers = sign(PAYLOAD, ts);
  await assert.rejects(() => verifyTranscript(PAYLOAD.replace("hi", "hj"), headers, SECRET), /signature mismatch/);
});

test("an old timestamp is rejected even with a valid signature", async () => {
  const ts = Math.floor(Date.now() / 1000) - 4000;
  await assert.rejects(() => verifyTranscript(PAYLOAD, sign(PAYLOAD, ts), SECRET), /replay window/);
});

test("re-serializing the body breaks the signature — verify the RAW bytes", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const headers = sign(PAYLOAD, ts);
  const reserialized = JSON.stringify(JSON.parse(PAYLOAD), null, 2);
  await assert.rejects(() => verifyTranscript(reserialized, headers, SECRET), /signature mismatch/);
});

const VOICE_REQUEST = {
  type: "voice.synthesize", version: 1, request_id: "req_1", session_id: "s",
  text: "Hello there.", voice_id: "narrator", language: null,
  output: { encoding: "pcm_s16le", sample_rate: 24000, channels: 1 },
  client_metadata: { user_id: "u1" },
};
const VOICE_BODY = JSON.stringify(VOICE_REQUEST);

async function webhookCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof RealtimeAvatarWebhookError, `expected a RealtimeAvatarWebhookError, got ${String(error)}`);
    assert.ok(error instanceof RealtimeAvatarError);
    return error.code;
  }
  assert.fail("expected the webhook to be refused");
}

test("a signed voice request verifies and returns the typed contract", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const out = await verifyVoiceWebhook(Buffer.from(VOICE_BODY), sign(VOICE_BODY, ts), SECRET);
  assert.deepEqual(out, VOICE_REQUEST);
  const text: string = out.text;
  const rate: 8000 | 16000 | 22050 | 24000 | 44100 | 48000 = out.output.sample_rate;
  assert.equal(`${text}@${rate}`, "Hello there.@24000");
});

test("a field from a newer worker is dropped, not refused", async () => {
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ ...VOICE_REQUEST, emotion_hint: "warm", output: { ...VOICE_REQUEST.output, bit_depth: 16 } });
  const out = await verifyVoiceWebhook(body, new Headers(sign(body, ts)), SECRET);
  assert.deepEqual(out, VOICE_REQUEST);
});

test("each refusal names its cause as a code", async () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.equal(await webhookCode(() => verifyVoiceWebhook(VOICE_BODY, {}, SECRET)), "missing_signature");
  assert.equal(
    await webhookCode(() => verifyVoiceWebhook(VOICE_BODY.replace("Hello", "Jello"), sign(VOICE_BODY, ts), SECRET)),
    "bad_signature",
  );
  assert.equal(await webhookCode(() => verifyVoiceWebhook(VOICE_BODY, sign(VOICE_BODY, ts - 4000), SECRET)), "stale_timestamp");
  assert.equal(
    await webhookCode(() => verifyVoiceWebhook(VOICE_BODY, sign(VOICE_BODY, ts), "a-different-secret-entirely")),
    "bad_signature",
  );
});

test("a correctly signed body that is not the contract is invalid_body", async () => {
  const ts = Math.floor(Date.now() / 1000);
  for (const body of ["not json", JSON.stringify({ ...VOICE_REQUEST, text: "" }), JSON.stringify({ ...VOICE_REQUEST, type: "session.transcript" })]) {
    assert.equal(await webhookCode(() => verifyVoiceWebhook(body, sign(body, ts), SECRET)), "invalid_body", body);
  }
});

test("the transcript verifier refuses with the same codes", async () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.equal(await webhookCode(() => verifyTranscript(PAYLOAD, {}, SECRET)), "missing_signature");
  assert.equal(await webhookCode(() => verifyTranscript(PAYLOAD.replace("hi", "hj"), sign(PAYLOAD, ts), SECRET)), "bad_signature");
  assert.equal(await webhookCode(() => verifyTranscript(PAYLOAD, sign(PAYLOAD, ts - 4000), SECRET)), "stale_timestamp");
});
