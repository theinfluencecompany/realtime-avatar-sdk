import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatar } from "../src/client.ts";
import { RealtimeAvatarError, RealtimeAvatarHttpError } from "../src/errors.ts";

const voiceId = "voice_test";
const wav = new Uint8Array(46);
const view = new DataView(wav.buffer);
wav.set(new TextEncoder().encode("RIFF"));
view.setUint32(4, 38, true);
wav.set(new TextEncoder().encode("WAVEfmt "), 8);
view.setUint32(16, 16, true);
view.setUint16(20, 1, true);
view.setUint16(22, 1, true);
view.setUint32(24, 24000, true);
view.setUint32(28, 48000, true);
view.setUint16(32, 2, true);
view.setUint16(34, 16, true);
wav.set(new TextEncoder().encode("data"), 36);
view.setUint32(40, 2, true);
const headers = { "content-type": "audio/wav", "X-RTA-Billed-Bytes": "5", "X-RTA-Billed-Credits": "1", "x-request-id": "3f8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" };
function audio(overrides: Record<string, string> = {}) {
  return new Response(wav, { headers: { ...headers, ...overrides } });
}
function client(fetchImpl: (request: Request) => Response | Promise<Response>, timeoutMs = 1000) {
  return new RealtimeAvatar({ apiKey: "test-key", maxRetries: 3, timeoutMs, fetch: async (input, init) => fetchImpl(new Request(input, init)) });
}

test("createSpeech returns completed WAV bytes and billing using the authenticated HTTP owner", async () => {
  let calls = 0;
  const rta = client(async (request) => {
    calls++;
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/api/v1/voices/voice_test/speech");
    assert.equal(request.headers.get("authorization"), "Bearer test-key");
    assert.match(request.headers.get("user-agent") ?? "", /realtime-avatar-sdk\//);
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.deepEqual(await request.json(), { text: "Hello", format: "wav" });
    return audio();
  });
  const result = await rta.createSpeech(voiceId, { text: " Hello ", format: "wav" });
  const bytes: Uint8Array<ArrayBuffer> = result.bytes;
  assert.deepEqual(result, { bytes: wav, contentType: "audio/wav", billedBytes: 5, billedCredits: 1, requestId: "3f8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" });
  assert.ok(bytes.buffer instanceof ArrayBuffer);
  assert.equal(calls, 1);
});

test("createSpeech defaults to MP3 and keeps missing billing and request ID unknown", async () => {
  const rta = client(() => new Response(new Uint8Array([0xff, 0xfb, 0x90, 0]), { headers: { "content-type": "audio/mpeg" } }));
  const result = await rta.createSpeech("vce_test", { text: "Hello" });
  assert.equal(result.contentType, "audio/mpeg");
  assert.equal(result.billedBytes, null);
  assert.equal(result.billedCredits, null);
  assert.equal(result.requestId, null);
});

test("createSpeech never retries 500 or ambiguous network errors even with maxRetries", async () => {
  for (const kind of ["http", "network"]) {
    let calls = 0;
    const rta = client(() => {
      calls++;
      if (kind === "network") throw new TypeError("fetch failed after upstream accepted");
      return Response.json({ code: "internal_error" }, { status: 500, headers: { "retry-after": "0", "x-request-id": "0b8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" } });
    });
    await assert.rejects(rta.createSpeech(voiceId, { text: "Hello" }), (error: unknown) => {
      assert.ok(error instanceof RealtimeAvatarError);
      if (kind === "http") {
        assert.ok(error instanceof RealtimeAvatarHttpError);
        assert.equal(error.status, 500);
        assert.equal(error.code, "internal_error");
        assert.equal(error.requestId, "0b8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
      }
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("createSpeech rejects invalid voice IDs and strict request fields before fetching", async () => {
  let calls = 0;
  const rta = client(() => { calls++; return audio(); });
  for (const id of ["", "ava_test", "../voice_test"]) {
    await assert.rejects(rta.createSpeech(id, { text: "Hello" }));
  }
  for (const input of [
    { text: "" }, { text: "  " }, { text: "x".repeat(2001) },
    { text: "Hello", speed: 0.49 }, { text: "Hello", speed: 2.01 },
    { text: "Hello", language: "e" }, { text: "Hello", language: "en_US" },
    { text: "Hello", surprise: true },
  ]) await assert.rejects(rta.createSpeech(voiceId, input));
  // @ts-expect-error Unsupported output formats must also fail at compile time.
  await assert.rejects(rta.createSpeech(voiceId, { text: "Hello", format: "pcm" }));
  assert.equal(calls, 0);
});

test("createSpeech encodes a spec-valid voice ID as one path segment", async () => {
  const rta = client((request) => {
    assert.equal(new URL(request.url).pathname, "/api/v1/voices/voice_x%2F..%2Fy/speech");
    return audio();
  });
  await rta.createSpeech("voice_x/../y", { text: "Hello", format: "wav" });
});

test("createSpeech propagates an already-aborted signal without sending", async () => {
  let calls = 0;
  const rta = client(() => { calls++; return audio(); });
  await assert.rejects(rta.createSpeech(voiceId, { text: "Hello" }, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("createSpeech combines caller cancellation with its timeout and never retries either", async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let calls = 0;
    const rta = client((request) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        if (cancel) controller.abort();
      });
    }, 10);
    // AbortSignal.timeout does not keep Node alive on its own.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(rta.createSpeech(voiceId, { text: "Hello" }, { signal: controller.signal }), { name: cancel ? "AbortError" : "TimeoutError" });
      assert.equal(calls, 1);
    } finally { clearTimeout(keepAlive); }
  }
});

test("createSpeech preserves cancellation while decoding an HTTP error body", async () => {
  const controller = new AbortController();
  const rta = client(() => new Response(new ReadableStream({
    pull(stream) {
      controller.abort();
      stream.error(controller.signal.reason);
    },
  }), { status: 500 }));
  await assert.rejects(rta.createSpeech(voiceId, { text: "Hello" }, { signal: controller.signal }), { name: "AbortError" });
});

test("createSpeech rejects missing, unknown, and requested/default-mismatched content types", async () => {
  for (const contentType of ["", "text/html", "audio/mpeg"]) {
    const rta = client(() => audio({ "content-type": contentType }));
    await assert.rejects(rta.createSpeech(voiceId, { text: "Hello", format: "wav" }), /Speech response did not match/);
  }
  await assert.rejects(client(() => audio()).createSpeech(voiceId, { text: "Hello" }), /Speech response did not match/);
});

test("createSpeech rejects malformed billing headers rather than inventing numbers", async () => {
  for (const [name, values] of [
    ["X-RTA-Billed-Bytes", ["", "NaN", "Infinity", "-1", "0", "1.5", "9007199254740992"]],
    ["X-RTA-Billed-Credits", ["", "NaN", "Infinity", "-1", "oops", "0x10"]],
  ] as const) {
    for (const value of values) {
      await assert.rejects(client(() => audio({ [name]: value })).createSpeech(voiceId, { text: "Hello", format: "wav" }), /Speech response did not match/);
    }
  }
});

test("createSpeech rejects empty and oversized bodies and cancels the stream at the bound", async () => {
  await assert.rejects(client(() => new Response(null, { headers })).createSpeech(voiceId, { text: "Hello", format: "wav" }), /Speech response did not match/);
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  }), { headers });
  await assert.rejects(client(() => response).createSpeech(voiceId, { text: "Hello", format: "wav" }), /Speech response did not match/);
  assert.equal(cancelled, true);
  await assert.rejects(client(() => audio({ "content-length": String(24 * 1024 * 1024 + 1) })).createSpeech(voiceId, { text: "Hello", format: "wav" }), /Speech response did not match/);
});

test("createSpeech rejects binary bytes that contradict their audio type", async () => {
  for (const format of ["wav", "mp3"] as const) {
    const rta = client(() => new Response("<html>upstream error</html>", { headers: { ...headers, "content-type": format === "wav" ? "audio/wav" : "audio/mpeg" } }));
    await assert.rejects(rta.createSpeech(voiceId, { text: "Hello", format }), /Speech response did not match/);
  }
});

test("createSpeech's timeout also bounds a stalled response body", async () => {
  let cancelled = false;
  const rta = client(() => new Response(new ReadableStream({
    start(stream) { stream.enqueue(wav); },
    cancel() { cancelled = true; },
  }), { headers }), 10);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(rta.createSpeech(voiceId, { text: "Hello", format: "wav" }), { name: "TimeoutError" });
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test("createSpeech rejects a malformed success request ID", async () => {
  await assert.rejects(client(() => audio({ "x-request-id": "private-unbounded-value" })).createSpeech(voiceId, { text: "Hello", format: "wav" }), /Speech response did not match/);
});

test("createSpeech aborts and cancels an unfinished binary body", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const rta = client(() => new Response(new ReadableStream({
    start(stream) { stream.enqueue(wav); },
    pull() { controller.abort(); },
    cancel() { cancelled = true; },
  }), { headers }));
  await assert.rejects(rta.createSpeech(voiceId, { text: "Hello", format: "wav" }, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(cancelled, true);
});
