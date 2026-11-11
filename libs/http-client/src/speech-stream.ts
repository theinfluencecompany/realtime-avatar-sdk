import { createParser } from "eventsource-parser";
import { RealtimeAvatarError } from "./errors.ts";
import { speechStreamEventSchema, SPEECH_STREAM_CONTRACT, type SpeechStreamEvent } from "./generated/speech.ts";

const MISMATCH = "Speech stream response did not match the SDK contract";
// Local receive budgets, not promises about the platform's future limits.
const MAX_WIRE_BYTES = 24 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const FEED_BYTES = 4096;

/** Owns cancellation while the generator is suspended, including an outstanding next(). */
export function speechStreamIterator(
  open: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): AsyncGenerator<SpeechStreamEvent, void, unknown> {
  const controller = new AbortController();
  async function* iterate(): AsyncGenerator<SpeechStreamEvent, void, unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeout, ...(callerSignal ? [callerSignal] : [])]);
    try {
      signal.throwIfAborted();
      const response = await open(signal);
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
        await response.body?.cancel().catch(() => {});
        throw new RealtimeAvatarError(MISMATCH);
      }
      yield* parseEvents(response, signal);
    } finally {
      controller.abort();
    }
  }
  const iterator = iterate();
  return {
    next: value => iterator.next(value),
    return: value => { controller.abort(); return iterator.return(value); },
    throw: error => { controller.abort(); return iterator.throw(error); },
    [Symbol.asyncIterator]() { return this; },
  };
}

async function* bodyChunks(response: Response, signal: AbortSignal, limit: number) {
  if (!response.body) throw new RealtimeAvatarError(MISMATCH);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return;
      size += value.byteLength;
      if (size > limit) throw new RealtimeAvatarError(MISMATCH);
      yield value;
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RealtimeAvatarError) throw error;
    throw new RealtimeAvatarError(MISMATCH);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only error text is collected; the existing HTTP error owner still interprets it. */
export async function boundedSpeechErrorResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (!response.body) return response;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of bodyChunks(response, signal, MAX_ERROR_BYTES)) chunks.push(new Uint8Array(chunk));
  return new Response(new Blob(chunks), { status: response.status, headers: response.headers });
}

async function* parseEvents(response: Response, signal: AbortSignal): AsyncGenerator<SpeechStreamEvent, void, unknown> {
  let requestId: string | undefined;
  let sequence = 0;
  let samples = 0;
  let terminal = false;
  const queue: SpeechStreamEvent[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let endsWithCR = false;
  const parser = createParser({
    maxBufferSize: MAX_EVENT_BYTES,
    onError() { throw new RealtimeAvatarError(MISMATCH); },
    onEvent(message) {
      if (terminal || encoder.encode(message.data).byteLength > MAX_EVENT_BYTES) throw new RealtimeAvatarError(MISMATCH);
      const raw: unknown = JSON.parse(message.data);
      const event = speechStreamEventSchema.parse(raw);
      if (message.event !== undefined && message.event !== event.type) throw new RealtimeAvatarError(MISMATCH);
      if (requestId === undefined) {
        if (event.type !== "started") throw new RealtimeAvatarError(MISMATCH);
        requestId = event.requestId;
      } else {
        if (event.type === "started" || event.requestId !== requestId) throw new RealtimeAvatarError(MISMATCH);
      }
      if (event.type === "audio") {
        const bytes = atob(event.audioBase64).length;
        if (event.sequence !== sequence || event.sampleOffset !== samples || bytes === 0 || bytes % 2 !== 0
          || bytes > SPEECH_STREAM_CONTRACT.maxAudioEventBytes) throw new RealtimeAvatarError(MISMATCH);
        samples += bytes / 2;
        sequence++;
        if (samples > SPEECH_STREAM_CONTRACT.maxSamples) throw new RealtimeAvatarError(MISMATCH);
      } else if (event.type === "completed") {
        if (samples <= 0 || event.totalSamples !== samples) throw new RealtimeAvatarError(MISMATCH);
        terminal = true;
      } else if (event.type === "failed") {
        terminal = true;
      }
      queue.push(event);
    },
  });
  try {
    for await (const bytes of bodyChunks(response, signal, MAX_WIRE_BYTES)) {
      // The parser dispatches synchronously. Bounded feeds prevent a large network chunk from
      // turning into a whole-response event queue before the first consumer yield.
      for (let offset = 0; offset < bytes.byteLength; offset += FEED_BYTES) {
        signal.throwIfAborted();
        const text = decoder.decode(bytes.subarray(offset, offset + FEED_BYTES), { stream: true });
        if (text.length) endsWithCR = text.endsWith("\r");
        parser.feed(text);
        while (queue.length) {
          signal.throwIfAborted();
          const event = queue.shift();
          if (event) yield event;
        }
      }
    }
    const remainder = decoder.decode();
    if (remainder.length) endsWithCR = remainder.endsWith("\r");
    parser.feed(remainder);
    // The parser defers a trailing CR in case LF follows. At EOF, finish that existing
    // delimiter only; never append a blank line to a genuinely truncated data event.
    if (endsWithCR) parser.feed("\n");
    while (queue.length) {
      const event = queue.shift();
      if (event) yield event;
    }
    if (!terminal) throw new RealtimeAvatarError(MISMATCH);
    // Probe buffered trailing data only after a real terminal was received. Any dispatched
    // event now fails the terminal guard; an incomplete event must not disappear at EOF.
    parser.feed("\n\n");
    parser.reset();
  } catch {
    signal.throwIfAborted();
    throw new RealtimeAvatarError(MISMATCH);
  }
}
