import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatar } from "../src/client.ts";
import { RealtimeAvatarError, RealtimeAvatarHttpError } from "../src/errors.ts";

const requestId = "3f8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const started = { type: "started", requestId, encoding: "pcm_s16le", sampleRate: 24000, channels: 1 };
const audio = { type: "audio", requestId, sequence: 0, sampleOffset: 0, audioBase64: "AAAAAA==" };
const completed = { type: "completed", requestId, totalSamples: 2, billedCredits: 1, billedBytes: 5 };
const alignment = { type: "alignment", requestId, chunkSeq: 0, segments: [{ text: "你好", start: 0, end: 2 / 24000 }] };
const failed = { type: "failed", requestId, error: { code: "internal_error", error: "Something went wrong.", status: 500, documentation: "https://realtimeavatar.ai/docs/api-reference", retryable: true } };
const headers = { "content-type": "text/event-stream; charset=utf-8" };
const encoder = new TextEncoder();
function sse(value: unknown) { return `data: ${JSON.stringify(value)}\n\n`; }
function response(events: unknown[]) { return new Response(events.map(sse).join(""), { headers }); }
function client(fetchImpl: (request: Request) => Response | Promise<Response>, options: { timeoutMs?: number; totalTimeoutMs?: number } = {}) {
  return new RealtimeAvatar({ apiKey: "test-key", maxRetries: 3, timeoutMs: 1000, ...options, fetch: async (input, init) => fetchImpl(new Request(input, init)) });
}
async function consume(rta: RealtimeAvatar, signal?: AbortSignal) {
  const events = [];
  for await (const event of rta.createSpeechStream("voice_test", { text: " Hello " }, { signal })) events.push(event);
  return events;
}
function controlled() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  return { response: new Response(body, { headers }), send: (text: string) => controller.enqueue(encoder.encode(text)), close: () => controller.close(), get cancelled() { return cancelled; } };
}

test("speech stream delivers first PCM before upstream EOF and uses authenticated request owner", { timeout: 1500 }, async () => {
  const upstream = controlled();
  let calls = 0;
  const rta = client(async (request) => {
    calls++;
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/api/v1/voices/voice_test/speech/stream");
    assert.equal(request.headers.get("authorization"), "Bearer test-key");
    assert.match(request.headers.get("user-agent") ?? "", /realtime-avatar-sdk\//);
    assert.deepEqual(await request.json(), { text: "Hello" });
    return upstream.response;
  });
  const iterator = rta.createSpeechStream("voice_test", { text: " Hello " });
  upstream.send(sse(started) + sse(audio));
  assert.deepEqual(await iterator.next(), { value: started, done: false });
  assert.deepEqual(await iterator.next(), { value: audio, done: false });
  upstream.send(sse(completed));
  upstream.close();
  assert.deepEqual(await iterator.next(), { value: completed, done: false });
  assert.equal((await iterator.next()).done, true);
  assert.equal(calls, 1);
});

test("speech stream handles split UTF-8, CRLF, BOM, comments and multiline SSE", async () => {
  const text = "﻿: keepalive\r\n\r\n" + [started, audio, alignment, completed].map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event, null, 2).replaceAll("\n", "\r\ndata: ")}\r\n\r\n`).join("");
  const bytes = encoder.encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(stream) { if (offset === bytes.length) stream.close(); else stream.enqueue(bytes.slice(offset, ++offset)); } });
  assert.deepEqual(await consume(client(() => new Response(body, { headers }))), [started, audio, alignment, completed]);
});

test("speech stream accepts bare CR framing at EOF without inventing a terminal delimiter", async () => {
  const text = [started, audio, completed].map(sse).join("").replaceAll("\n", "\r");
  assert.deepEqual(await consume(client(() => new Response(text, { headers }))), [started, audio, completed]);
});

test("speech stream preserves corrected alignment updates by chunkSeq without synthesizing timing", async () => {
  const correction = { ...alignment, segments: [{ text: "你好！", start: 0, end: 2 / 24000 }] };
  assert.deepEqual(await consume(client(() => response([started, audio, alignment, correction, completed]))), [started, audio, alignment, correction, completed]);
});

test("speech stream yields typed failed terminal without converting it into success", async () => {
  assert.deepEqual(await consume(client(() => response([started, failed]))), [started, failed]);
});

test("speech stream cancels blocked reader and fetch on caller abort", { timeout: 1500 }, async () => {
  const upstream = controlled();
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const iterator = client(request => { requestSignal = request.signal; return upstream.response; }).createSpeechStream("voice_test", { text: "Hello" }, { signal: controller.signal });
  upstream.send(sse(started));
  await iterator.next();
  const waiting = iterator.next();
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(upstream.cancelled, true);
  assert.equal(requestSignal?.aborted, true);
});

test("speech stream return cancels upstream even with an outstanding next", { timeout: 1500 }, async () => {
  for (const pendingRead of [false, true]) {
    const upstream = controlled();
    let requestSignal: AbortSignal | undefined;
    const iterator = client(request => { requestSignal = request.signal; return upstream.response; }).createSpeechStream("voice_test", { text: "Hello" });
    upstream.send(sse(started));
    await iterator.next();
    const pending = pendingRead ? assert.rejects(iterator.next(), { name: "AbortError" }) : undefined;
    assert.equal((await iterator.return()).done, true);
    await pending;
    assert.equal(upstream.cancelled, true);
    assert.equal(requestSignal?.aborted, true);
  }
});

test("speech stream break cancels upstream, and return before next never fetches", async () => {
  const upstream = controlled();
  upstream.send(sse(started));
  for await (const _event of client(() => upstream.response).createSpeechStream("voice_test", { text: "Hello" })) break;
  assert.equal(upstream.cancelled, true);
  let calls = 0;
  const iterator = client(() => { calls++; return response([]); }).createSpeechStream("voice_test", { text: "Hello" });
  await iterator.return();
  assert.equal(calls, 0);
});

test("speech stream total deadline covers a stalled body, not only response headers", { timeout: 1500 }, async () => {
  const upstream = controlled();
  upstream.send(sse(started));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(consume(client(() => upstream.response, { totalTimeoutMs: 10 })), { name: "TimeoutError" });
    assert.equal(upstream.cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test("speech stream rejects malformed schemas, correlation, PCM and event ordering", async () => {
  const badSequences = [
    [], [audio, completed], [completed], [failed], [started], [started, audio],
    [started, started, audio, completed],
    [started, { ...audio, requestId: "00000000-0000-4000-8000-000000000000" }, completed],
    [{ ...started, requestId: "not-a-uuid" }, audio, completed],
    [{ ...started, sampleRate: 48000 }, audio, completed],
    [started, { ...audio, sequence: 1 }, completed],
    [started, { ...audio, sampleOffset: 1 }, completed],
    [started, audio, audio, completed],
    [started, { ...audio, audioBase64: "AA==" }, completed],
    [started, { ...audio, audioBase64: "????" }, completed],
    [started, { ...audio, audioBase64: Buffer.alloc(16386).toString("base64") }, completed],
    [started, { ...audio, audioBase64: "" }, completed],
    [started, audio, { ...completed, totalSamples: 1 }],
    [started, { ...completed, totalSamples: 0 }],
    [started, audio, { ...completed, totalSamples: 4320001 }],
    [started, audio, { ...completed, billedBytes: 0 }],
    [started, audio, { ...completed, billedCredits: -1 }],
    [started, audio, { ...alignment, segments: [{ text: "bad", start: 2, end: 1 }] }, completed],
    [started, audio, { ...alignment, segments: [{ text: "bad", start: 0, end: 181 }] }, completed],
    [started, { ...failed, error: { code: "internal_error" } }],
    [started, audio, completed, audio], [started, audio, completed, completed],
    [started, failed, completed], [started, failed, failed],
    [started, { type: "unknown", requestId }],
  ];
  for (const events of badSequences) {
    await assert.rejects(consume(client(() => response(events))), error => {
      assert.ok(error instanceof RealtimeAvatarError);
      assert.match(error.message, /Speech stream response did not match/);
      return true;
    });
  }
});

test("speech stream rejects truncated terminal, malformed JSON, wrong SSE event and malformed UTF-8", async () => {
  for (const text of [sse(started) + sse(audio) + `data: ${JSON.stringify(completed)}`, sse(started) + "data: {secret\n\n", `event: audio\ndata: ${JSON.stringify(started)}\n\n`]) {
    await assert.rejects(consume(client(() => new Response(text, { headers }))), /Speech stream response did not match/);
  }
  await assert.rejects(consume(client(() => new Response(new Uint8Array([0xff]), { headers }))), /Speech stream response did not match/);
});

test("speech stream rejects events after terminal across separate transport reads", async () => {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({ pull(stream) { const event = [started, audio, completed, alignment][index++]; if (event) stream.enqueue(encoder.encode(sse(event))); else stream.close(); } });
  await assert.rejects(consume(client(() => new Response(body, { headers }))), /Speech stream response did not match/);
});

test("speech stream rejects an unterminated extra event after its terminal", async () => {
  const text = [started, audio, completed].map(sse).join("") + `data: ${JSON.stringify(audio)}`;
  await assert.rejects(consume(client(() => new Response(text, { headers }))), /Speech stream response did not match/);
});

test("speech stream bounds complete events, unterminated events and total wire bytes", async () => {
  for (const text of ["data: " + "x".repeat(512 * 1024), "data: " + JSON.stringify({ ...alignment, segments: [{ text: "x".repeat(512 * 1024), start: 0, end: 1 }] }) + "\n\n"]) {
    const upstream = controlled();
    upstream.send(text);
    await assert.rejects(consume(client(() => upstream.response)), /Speech stream response did not match/);
    assert.equal(upstream.cancelled, true);
  }
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(stream) { stream.enqueue(encoder.encode(": keepalive\n\n".repeat(4096))); }, cancel() { cancelled = true; } });
  await assert.rejects(consume(client(() => new Response(body, { headers }), { timeoutMs: 10000 })), /Speech stream response did not match/);
  assert.equal(cancelled, true);
});

test("speech stream rejects absent bodies and non-SSE successful responses", async () => {
  for (const result of [new Response(null, { headers }), new Response("{}", { headers: { "content-type": "application/json" } }), new Response(sse(started)), new Response(null, { status: 204 })]) {
    await assert.rejects(consume(client(() => result)), /Speech stream response did not match/);
  }
});

test("speech stream validates strict request, voice and aborted signal before any paid fetch", async () => {
  let calls = 0;
  const rta = client(() => { calls++; return response([]); });
  await assert.rejects(consume(rta, AbortSignal.abort()), { name: "AbortError" });
  for (const input of [{ text: "" }, { text: "x".repeat(2001) }, { text: "Hello", speed: 4 }, { text: "Hello", format: "mp3" }]) {
    await assert.rejects(async () => { for await (const _event of rta.createSpeechStream("voice_test", input)) { /* rejected before fetch */ } });
  }
  await assert.rejects(async () => { for await (const _event of rta.createSpeechStream("../invalid", { text: "Hello" })) { /* rejected before fetch */ } });
  assert.equal(calls, 0);
});

test("speech stream never retries paid HTTP or network failures", async () => {
  for (const kind of ["http", "network"] as const) {
    let calls = 0;
    const rta = client(() => { calls++; if (kind === "network") throw new TypeError("fetch failed"); return Response.json({ code: "internal_error" }, { status: 503, headers: { "retry-after": "0", "x-request-id": requestId } }); });
    await assert.rejects(consume(rta), error => {
      assert.ok(error instanceof RealtimeAvatarError);
      if (kind === "http") { assert.ok(error instanceof RealtimeAvatarHttpError); assert.equal(error.status, 503); assert.equal(error.code, "internal_error"); assert.equal(error.requestId, requestId); }
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("speech stream enforces the cumulative audio duration cap", async () => {
  let sequence = -1;
  const audioBase64 = Buffer.alloc(16384).toString("base64");
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      if (sequence === -1) { stream.enqueue(encoder.encode(sse(started))); sequence = 0; }
      else { stream.enqueue(encoder.encode(sse({ ...audio, sequence, sampleOffset: sequence * 8192, audioBase64 }))); sequence++; }
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(consume(client(() => new Response(body, { headers }), { timeoutMs: 10000 })), /Speech stream response did not match/);
  assert.equal(cancelled, true);
});

test("speech stream preserves canonical open API error fields and scrubs invalid event payloads", async () => {
  const extended = { ...failed, error: { ...failed.error, extraDiagnostic: { value: "retained" } } };
  assert.deepEqual(await consume(client(() => response([started, extended]))), [started, extended]);
  await assert.rejects(consume(client(() => response([started, { ...audio, sequence: "secret-provider-detail" }]))), error => {
    assert.ok(error instanceof RealtimeAvatarError);
    assert.doesNotMatch(String(error) + JSON.stringify(error), /secret-provider-detail/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("speech stream cancels a stalled HTTP error body within the same deadline", { timeout: 1500 }, async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(consume(client(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 }), { totalTimeoutMs: 10 })), { name: "TimeoutError" });
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});
