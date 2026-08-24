import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyTranscript } from "../src/webhook.ts";

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
