import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { RealtimeAvatar } from "../src/client.ts";
import { RealtimeAvatarError, RealtimeAvatarHttpError } from "../src/errors.ts";

const requestId = "3f8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const started = { type: "started", requestId, encoding: "pcm_s16le", sampleRate: 24000, channels: 1 };
// "AAAAAA==" is 4 bytes: two 16-bit samples.
const audio = (utterance: number, sampleOffset: number) => ({ type: "audio", requestId, utterance, sampleOffset, audioBase64: "AAAAAA==" });
const alignment = (utterance: number, text = "你好") => ({ type: "alignment", requestId, utterance, segments: [{ text, start: 0, end: 2 / 24000 }] });
const utteranceEnd = (utterance: number, samples: number) => ({ type: "utterance-end", requestId, utterance, samples });
const completed = { type: "completed", requestId, billedBytes: 12, billedCredits: 0.18 };
const failed = { type: "failed", requestId, error: { code: "speech_busy", error: "Speech is busy.", status: 429, documentation: "https://realtimeavatar.ai/docs/api-reference", retryable: true } };

/** A standard WebSocket stand-in: the server side is driven by the test. */
class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readonly init: unknown;
  readonly sent: unknown[] = [];
  accepted = false;
  closedWith: number | undefined;
  constructor(url: string, init?: unknown) {
    super();
    this.url = url;
    this.init = init;
    FakeSocket.instances.push(this);
  }
  accept() { this.accepted = true; }
  send(data: string) {
    if (this.closedWith !== undefined) throw new Error("send after close");
    const decoded: unknown = JSON.parse(data);
    this.sent.push(decoded);
  }
  close(code?: number) {
    if (this.closedWith !== undefined) return;
    this.closedWith = code ?? 1005;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
  open() { this.dispatchEvent(new Event("open")); }
  refuse() { this.dispatchEvent(new Event("error")); this.dispatchEvent(new Event("close")); }
  serve(...messages: unknown[]) {
    for (const message of messages) this.dispatchEvent(new MessageEvent("message", { data: typeof message === "string" ? message : JSON.stringify(message) }));
  }
  serverClose() { this.dispatchEvent(new Event("close")); }
}

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
function useFakeWebSocket() {
  FakeSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { value: FakeSocket, configurable: true, writable: true });
}
function pretendWorkers() {
  // Installed here too, so a regression that takes the Node path still cannot open a real socket.
  useFakeWebSocket();
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Cloudflare-Workers" }, configurable: true });
}
afterEach(() => {
  if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
});

function client(options: { timeoutMs?: number; totalTimeoutMs?: number; fetch?: typeof fetch } = {}) {
  return new RealtimeAvatar({ apiKey: "test-key", baseUrl: "https://rta.invalid/api/v1", maxRetries: 3, timeoutMs: 1000, fetch: async () => { throw new Error("no HTTP in this test"); }, ...options });
}
/** Opens on the Node path and returns the session with its fake socket, already open. */
async function opened(rta = client(), input = { maxTextBytes: 600 }) {
  useFakeWebSocket();
  const pending = rta.openSpeechSession("voice_test", input);
  const socket = FakeSocket.instances[0];
  assert.ok(socket);
  socket.open();
  return { session: await pending, socket };
}
async function collect(session: AsyncIterable<unknown>) {
  const messages = [];
  for await (const message of session) messages.push(message);
  return messages;
}
function upgraded(socket: FakeSocket) {
  const response = new Response(null);
  Object.defineProperty(response, "status", { value: 101 });
  Object.defineProperty(response, "webSocket", { value: socket });
  return response;
}

test("Node: opens the authenticated socket with the session's query, sends validated frames and yields every message in order", { timeout: 1500 }, async () => {
  useFakeWebSocket();
  const pending = client().openSpeechSession("voice_test", { maxTextBytes: 600, latency: "low", chunkLength: 200, language: "zh-CN" });
  const socket = FakeSocket.instances[0];
  assert.ok(socket);
  const url = new URL(socket.url);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/api/v1/voices/voice_test/speech/live");
  assert.deepEqual(Object.fromEntries(url.searchParams), { language: "zh-CN", latency: "low", chunkLength: "200", maxTextBytes: "600" });
  assert.ok(typeof socket.init === "object" && socket.init !== null && "headers" in socket.init);
  const sentHeaders = socket.init.headers;
  assert.ok(typeof sentHeaders === "object" && sentHeaders !== null && "authorization" in sentHeaders && "user-agent" in sentHeaders);
  assert.equal(sentHeaders.authorization, "Bearer test-key");
  assert.match(String(sentHeaders["user-agent"]), /realtime-avatar-sdk\//);
  socket.open();
  const session = await pending;

  session.text(0, "超级棒哦！");
  session.flush(0);
  session.text(1, "第二句。");
  session.flush(1);
  session.end();
  assert.deepEqual(socket.sent, [
    { type: "text", utterance: 0, text: "超级棒哦！" }, { type: "flush", utterance: 0 },
    { type: "text", utterance: 1, text: "第二句。" }, { type: "flush", utterance: 1 }, { type: "end" },
  ]);

  const script = [
    started, alignment(0), audio(0, 0), audio(0, 2), utteranceEnd(0, 4),
    alignment(1), audio(1, 0), alignment(0, "你好！"), utteranceEnd(1, 2), completed,
  ];
  const iterator = session[Symbol.asyncIterator]();
  socket.serve(script[0], script[1]);
  assert.deepEqual(await iterator.next(), { value: started, done: false });
  assert.deepEqual(await iterator.next(), { value: script[1], done: false });
  const later = iterator.next();
  socket.serve(...script.slice(2));
  assert.deepEqual(await later, { value: script[2], done: false });
  for (const message of script.slice(3)) assert.deepEqual(await iterator.next(), { value: message, done: false });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.equal(socket.closedWith, 1000);
});

test("Workers: upgrades through fetch with the Authorization header and accepts the returned socket", { timeout: 1500 }, async () => {
  pretendWorkers();
  const socket = new FakeSocket("upgraded");
  let seen: Request | undefined;
  const rta = client({ fetch: async (input, init) => { seen = new Request(input, init); return upgraded(socket); } });
  const session = await rta.openSpeechSession("voice_test", { maxTextBytes: 30 });
  assert.ok(seen);
  assert.equal(seen.method, "GET");
  assert.equal(new URL(seen.url).protocol, "https:");
  assert.equal(new URL(seen.url).pathname, "/api/v1/voices/voice_test/speech/live");
  assert.equal(new URL(seen.url).search, "?maxTextBytes=30");
  assert.equal(seen.headers.get("upgrade"), "websocket");
  assert.equal(seen.headers.get("authorization"), "Bearer test-key");
  assert.equal(socket.accepted, true);
  session.text(0, "Hi.");
  session.end();
  assert.deepEqual(socket.sent, [{ type: "text", utterance: 0, text: "Hi." }, { type: "end" }]);
  queueMicrotask(() => socket.serve(started, audio(0, 0), utteranceEnd(0, 2), completed));
  assert.deepEqual(await collect(session), [started, audio(0, 0), utteranceEnd(0, 2), completed]);
});

test("Workers: a refusal before the upgrade is the platform's HTTP error, never retried", async () => {
  pretendWorkers();
  let calls = 0;
  const rta = client({ fetch: async () => { calls++; return Response.json({ code: "speech_busy", error: "busy", status: 429 }, { status: 429, headers: { "retry-after": "0", "x-request-id": requestId } }); } });
  await assert.rejects(rta.openSpeechSession("voice_test", { maxTextBytes: 30 }), error => {
    assert.ok(error instanceof RealtimeAvatarHttpError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "speech_busy");
    assert.equal(error.requestId, requestId);
    return true;
  });
  assert.equal(calls, 1);
  const ok = client({ fetch: async () => new Response("{}") });
  await assert.rejects(ok.openSpeechSession("voice_test", { maxTextBytes: 30 }), /upgrade did not match the SDK contract/);
});

test("Node: a refused upgrade rejects the open and leaves no socket behind", async () => {
  useFakeWebSocket();
  const pending = client().openSpeechSession("voice_test", { maxTextBytes: 30 });
  FakeSocket.instances[0]?.refuse();
  await assert.rejects(pending, error => error instanceof RealtimeAvatarError && /could not be opened/.test(error.message));
});

test("opening times out under timeoutMs and honours an aborted or aborting signal", { timeout: 1500 }, async () => {
  useFakeWebSocket();
  await assert.rejects(client({ timeoutMs: 20 }).openSpeechSession("voice_test", { maxTextBytes: 30 }), { name: "TimeoutError" });
  assert.equal(FakeSocket.instances[0]?.closedWith, 1000);

  FakeSocket.instances = [];
  await assert.rejects(client().openSpeechSession("voice_test", { maxTextBytes: 30 }, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(FakeSocket.instances.length, 0);

  const controller = new AbortController();
  const pending = client().openSpeechSession("voice_test", { maxTextBytes: 30 }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(FakeSocket.instances[0]?.closedWith, 1000);
});

test("invalid session parameters and voice ids are refused before any connection", async () => {
  useFakeWebSocket();
  const rta = client();
  const extra = { maxTextBytes: 30, voice: "other" };
  for (const input of [{ maxTextBytes: 0 }, { maxTextBytes: 6001 }, { maxTextBytes: 1.5 }, { maxTextBytes: 30, chunkLength: 50 }, { maxTextBytes: 30, language: "x" }, extra]) {
    await assert.rejects(rta.openSpeechSession("voice_test", input));
  }
  await assert.rejects(rta.openSpeechSession("../invalid", { maxTextBytes: 30 }));
  assert.equal(FakeSocket.instances.length, 0);
});

test("client frames are validated by the generated schema before they are sent", async () => {
  const { session, socket } = await opened();
  assert.throws(() => session.text(0, ""));
  assert.throws(() => session.text(0, "x".repeat(301)));
  assert.throws(() => session.text(128, "Hi"));
  assert.throws(() => session.flush(-1));
  assert.deepEqual(socket.sent, []);
});

test("a failed terminal is yielded as a typed message, not thrown", async () => {
  const { session, socket } = await opened();
  queueMicrotask(() => socket.serve(started, audio(0, 0), failed));
  assert.deepEqual(await collect(session), [started, audio(0, 0), failed]);
  assert.equal(socket.closedWith, 1000);
});

test("messages that break the schema or the session's order fail the iteration and close the socket", { timeout: 3000 }, async () => {
  const sequences: unknown[][] = [
    [audio(0, 0)],
    [started, started],
    [started, { ...audio(0, 0), requestId: "00000000-0000-4000-8000-000000000000" }],
    [{ ...started, sampleRate: 48000 }],
    [started, audio(0, 2)],
    [started, audio(1, 0)],
    [started, audio(0, 0), audio(0, 0)],
    [started, audio(0, 0), audio(1, 0)],
    [started, { ...audio(0, 0), audioBase64: "AA==" }],
    [started, audio(0, 0), utteranceEnd(0, 3)],
    [started, utteranceEnd(0, 2)],
    [started, audio(0, 0), utteranceEnd(1, 2)],
    [started, alignment(1)],
    [started, audio(0, 0), utteranceEnd(0, 2), alignment(2)],
    [started, { ...alignment(0), segments: [{ text: "bad", start: 2, end: 1 }] }],
    [started, { ...completed, extra: true }],
    [started, { type: "unknown", requestId }],
    [started, "{not json"],
    [started, JSON.stringify({ ...alignment(0), segments: [{ text: "x".repeat(300 * 1024), start: 0, end: 1 }] })],
  ];
  for (const messages of sequences) {
    const { session, socket } = await opened();
    queueMicrotask(() => socket.serve(...messages));
    await assert.rejects(collect(session), error => {
      assert.ok(error instanceof RealtimeAvatarError);
      assert.match(error.message, /Speech session message did not match the SDK contract/);
      return true;
    }, JSON.stringify(messages).slice(0, 200));
    assert.equal(socket.closedWith, 1000);
  }
});

test("a binary frame or a close before the terminal fails the session", async () => {
  {
    const { session, socket } = await opened();
    queueMicrotask(() => { socket.serve(started); socket.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(4) })); });
    await assert.rejects(collect(session), /did not match the SDK contract/);
  }
  {
    const { session, socket } = await opened();
    queueMicrotask(() => { socket.serve(started, audio(0, 0)); socket.serverClose(); });
    await assert.rejects(collect(session), /closed before it completed/);
  }
});

test("break sends cancel and closes; later text is refused while end and cancel are no-ops", async () => {
  const { session, socket } = await opened();
  queueMicrotask(() => socket.serve(started, audio(0, 0)));
  for await (const message of session) if (message.type === "audio") break;
  assert.deepEqual(socket.sent, [{ type: "cancel" }]);
  assert.equal(socket.closedWith, 1000);
  assert.throws(() => session.text(0, "late"), /Speech session is closed/);
  assert.throws(() => session.flush(0), /Speech session is closed/);
  session.end();
  session.cancel();
  assert.deepEqual(socket.sent, [{ type: "cancel" }]);
  assert.throws(() => session[Symbol.asyncIterator](), /iterated only once/);
});

test("the caller's signal and totalTimeoutMs end a running session with their reason", { timeout: 1500 }, async () => {
  useFakeWebSocket();
  const controller = new AbortController();
  const pending = client().openSpeechSession("voice_test", { maxTextBytes: 30 }, { signal: controller.signal });
  const socket = FakeSocket.instances[0];
  assert.ok(socket);
  socket.open();
  const session = await pending;
  const iterator = session[Symbol.asyncIterator]();
  socket.serve(started);
  await iterator.next();
  const waiting = iterator.next();
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(socket.closedWith, 1000);

  const timed = await opened(client({ totalTimeoutMs: 30 }));
  timed.socket.serve(started);
  await assert.rejects(collect(timed.session), { name: "TimeoutError" });
  assert.equal(timed.socket.closedWith, 1000);
});
