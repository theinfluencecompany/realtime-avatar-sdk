import { RealtimeAvatarError } from "./errors.ts";
import {
  speechLiveClientMessageSchema,
  speechLiveServerMessageSchema,
  type SpeechLiveClientMessage,
  type SpeechLiveServerMessage,
} from "./generated/speech.ts";
import { MAX_EVENT_BYTES, MAX_WIRE_BYTES } from "./speech-stream.ts";

const MISMATCH = "Speech session message did not match the SDK contract";
const CLOSED = "Speech session is closed";
const UNOPENED = "Speech session could not be opened";

type TextMessage = Extract<SpeechLiveClientMessage, { type: "text" }>;

/**
 * One live speech session: send text while it is written, read PCM and alignment per utterance.
 *
 * Iterate it once. Every message is validated against the generated `SpeechLiveServerMessage`
 * schema and the session's ordering before it is yielded; a terminal `completed` or `failed` ends
 * the iteration. `break`/`return()` and the caller's signal close the socket, which the platform
 * bills like `cancel`: the bytes already sent are paid for.
 */
export interface SpeechSession extends AsyncIterable<SpeechLiveServerMessage> {
  /** Append text to the open utterance: 0 first, then one more after each flush. */
  text(utterance: TextMessage["utterance"], text: TextMessage["text"]): void;
  /** Speak the open utterance now and open the next. */
  flush(utterance: TextMessage["utterance"]): void;
  /** No more text: the platform speaks what is buffered, then completes. A no-op once the session is over. */
  end(): void;
  /** Stop now. Bytes already sent are billed. A no-op once the session is over. */
  cancel(): void;
  [Symbol.asyncIterator](): AsyncIterator<SpeechLiveServerMessage, void, undefined>;
}

/** The part of a WebSocket the session uses: Node's standard client, or a Workers fetch upgrade. */
export interface SpeechSocket {
  /** Workers only: start delivering events of a socket returned by a fetch upgrade. */
  accept?(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
}

/** A socket whose events can be listened to now, and that is usable once `ready` resolves. */
export interface SpeechConnection {
  socket: SpeechSocket;
  ready: Promise<void>;
}

export function isUpgradedSocket(value: unknown): value is SpeechSocket & { accept(): void } {
  return typeof value === "object" && value !== null
    && "accept" in value && typeof value.accept === "function"
    && "send" in value && typeof value.send === "function"
    && "close" in value && typeof value.close === "function"
    && "addEventListener" in value && typeof value.addEventListener === "function";
}

/** Node 22's global WebSocket, whose constructor accepts request headers (Authorization). */
export function connectStandardSocket(url: string, headers: Record<string, string>): SpeechConnection {
  if (typeof WebSocket === "undefined") {
    throw new RealtimeAvatarError("openSpeechSession needs a global WebSocket (Node 22 or later) or Cloudflare Workers");
  }
  const target = new URL(url);
  target.protocol = target.protocol === "http:" ? "ws:" : "wss:";
  // The standard constructor's second argument is subprotocols; Node's also takes `{ headers }`,
  // which the DOM signature cannot express. The result is checked, not assumed.
  const socket: unknown = Reflect.construct(WebSocket, [target.href, { headers }]);
  if (!(socket instanceof WebSocket)) throw new RealtimeAvatarError(UNOPENED);
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    // The standard client reports no HTTP status for a refused upgrade.
    socket.addEventListener("error", () => reject(new RealtimeAvatarError(UNOPENED)), { once: true });
    socket.addEventListener("close", () => reject(new RealtimeAvatarError(UNOPENED)), { once: true });
  });
  return { socket, ready };
}

/**
 * Opens the connection under the handshake deadline, then returns the session. The session's
 * own lifetime is bounded by the platform's cap, the caller's signal and `sessionMs` if set.
 */
export async function openSpeechSocketSession(
  connect: (signal: AbortSignal) => Promise<SpeechConnection>,
  timing: { handshakeMs: number; sessionMs: number | undefined },
  callerSignal?: AbortSignal,
): Promise<SpeechSession> {
  callerSignal?.throwIfAborted();
  // An owned controller, not AbortSignal.timeout: the upgrade's fetch signal must not fire after
  // the socket it produced is in use.
  const handshake = new AbortController();
  const timer = setTimeout(() => handshake.abort(new DOMException("The operation timed out.", "TimeoutError")), timing.handshakeMs);
  const forward = () => handshake.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", forward, { once: true });
  let connection: SpeechConnection | undefined;
  try {
    connection = await connect(handshake.signal);
    const session = new LiveSession(connection.socket);
    connection.socket.accept?.();
    const opened = connection.ready;
    opened.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(handshake.signal.reason);
      if (handshake.signal.aborted) { abort(); return; }
      handshake.signal.addEventListener("abort", abort, { once: true });
      opened.then(resolve, reject).finally(() => handshake.signal.removeEventListener("abort", abort));
    });
    session.start(callerSignal, timing.sessionMs);
    return session;
  } catch (error) {
    if (connection) closeQuietly(connection.socket);
    callerSignal?.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forward);
  }
}

function closeQuietly(socket: SpeechSocket) {
  try { socket.close(1000); } catch { /* Already closing. */ }
}

function messageText(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null || !("data" in event)) return undefined;
  return typeof event.data === "string" ? event.data : undefined;
}

class LiveSession implements SpeechSession {
  readonly #socket: SpeechSocket;
  readonly #queue: SpeechLiveServerMessage[] = [];
  #waiting: { resolve: (result: IteratorResult<SpeechLiveServerMessage, void>) => void; reject: (error: unknown) => void } | undefined;
  #failure: { error: unknown } | undefined;
  #over = false;
  #iterated = false;
  #stop: (() => void) | undefined;

  // What has been received, checked against the order the platform promises.
  #received = 0;
  #requestId: string | undefined;
  #terminal = false;
  #ended = 0;
  #open: number | undefined;
  #samples = 0;

  constructor(socket: SpeechSocket) {
    this.#socket = socket;
    socket.addEventListener("message", event => this.#receive(event));
    socket.addEventListener("close", () => this.#closed());
    socket.addEventListener("error", () => this.#closed());
  }

  start(signal: AbortSignal | undefined, sessionMs: number | undefined) {
    const stops: (() => void)[] = [];
    if (signal) {
      const abort = () => this.#fail(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      stops.push(() => signal.removeEventListener("abort", abort));
    }
    if (sessionMs !== undefined) {
      const timer = setTimeout(() => this.#fail(new DOMException("The operation timed out.", "TimeoutError")), sessionMs);
      stops.push(() => clearTimeout(timer));
    }
    this.#stop = () => { for (const stop of stops) stop(); };
  }

  text(utterance: TextMessage["utterance"], text: TextMessage["text"]) {
    this.#send({ type: "text", utterance, text });
  }

  flush(utterance: TextMessage["utterance"]) {
    this.#send({ type: "flush", utterance });
  }

  end() {
    if (!this.#over) this.#send({ type: "end" });
  }

  cancel() {
    if (!this.#over) this.#send({ type: "cancel" });
  }

  [Symbol.asyncIterator](): AsyncIterator<SpeechLiveServerMessage, void, undefined> {
    if (this.#iterated) throw new RealtimeAvatarError("A speech session can be iterated only once");
    this.#iterated = true;
    return {
      next: () => this.#next(),
      return: async () => {
        if (!this.#over) {
          this.cancel();
          this.#finish();
        }
        this.#queue.length = 0;
        return { value: undefined, done: true };
      },
    };
  }

  #send(message: SpeechLiveClientMessage) {
    const parsed = speechLiveClientMessageSchema.parse(message);
    if (this.#over) throw new RealtimeAvatarError(CLOSED);
    this.#socket.send(JSON.stringify(parsed));
  }

  #next(): Promise<IteratorResult<SpeechLiveServerMessage, void>> {
    const message = this.#queue.shift();
    if (message) return Promise.resolve({ value: message, done: false });
    if (this.#failure) return Promise.reject(this.#failure.error);
    if (this.#over) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => { this.#waiting = { resolve, reject }; });
  }

  #deliver(message: SpeechLiveServerMessage) {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    if (waiting) waiting.resolve({ value: message, done: false });
    else this.#queue.push(message);
  }

  /** Ends the session: no more messages are accepted and the socket is closed. */
  #finish() {
    if (this.#over) return;
    this.#over = true;
    this.#stop?.();
    closeQuietly(this.#socket);
    const waiting = this.#waiting;
    this.#waiting = undefined;
    if (!waiting) return;
    if (this.#failure) waiting.reject(this.#failure.error);
    else waiting.resolve({ value: undefined, done: true });
  }

  #fail(error: unknown) {
    if (this.#over) return;
    this.#failure = { error };
    // A failure is reported at once, not behind messages the caller has not read yet.
    this.#queue.length = 0;
    this.#finish();
  }

  #closed() {
    // A close after the terminal is the normal end; before it, the session is incomplete.
    if (!this.#terminal) this.#fail(new RealtimeAvatarError("Speech session closed before it completed"));
    this.#finish();
  }

  #receive(event: unknown) {
    if (this.#over) return;
    try {
      const data = messageText(event);
      if (data === undefined || this.#terminal || data.length > MAX_EVENT_BYTES) throw new RealtimeAvatarError(MISMATCH);
      this.#received += data.length;
      if (this.#received > MAX_WIRE_BYTES) throw new RealtimeAvatarError(MISMATCH);
      const raw: unknown = JSON.parse(data);
      const message = speechLiveServerMessageSchema.parse(raw);
      this.#check(message);
      this.#deliver(message);
      if (this.#terminal) this.#finish();
    } catch {
      this.#fail(new RealtimeAvatarError(MISMATCH));
    }
  }

  #check(message: SpeechLiveServerMessage) {
    if (this.#requestId === undefined) {
      if (message.type !== "started") throw new RealtimeAvatarError(MISMATCH);
      this.#requestId = message.requestId;
      return;
    }
    if (message.type === "started" || message.requestId !== this.#requestId) throw new RealtimeAvatarError(MISMATCH);
    switch (message.type) {
      case "audio": {
        const bytes = atob(message.audioBase64).length;
        if (bytes === 0 || bytes % 2 !== 0) throw new RealtimeAvatarError(MISMATCH);
        // An utterance's audio starts at 0 once the one before it has ended, and is contiguous.
        if (this.#open === undefined) {
          if (message.utterance !== this.#ended || message.sampleOffset !== 0) throw new RealtimeAvatarError(MISMATCH);
          this.#open = message.utterance;
          this.#samples = 0;
        } else if (message.utterance !== this.#open || message.sampleOffset !== this.#samples) {
          throw new RealtimeAvatarError(MISMATCH);
        }
        this.#samples += bytes / 2;
        return;
      }
      case "utterance-end":
        if (message.utterance !== this.#open || message.samples !== this.#samples) throw new RealtimeAvatarError(MISMATCH);
        this.#open = undefined;
        this.#ended++;
        return;
      case "alignment":
        // A snapshot may arrive late for an ended utterance, or before the next one's audio.
        if (message.utterance > this.#ended) throw new RealtimeAvatarError(MISMATCH);
        return;
      case "completed":
      case "failed":
        this.#terminal = true;
        return;
    }
  }
}
