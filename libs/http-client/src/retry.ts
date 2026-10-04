/**
 * The transport policy — retry set, idempotency key, backoff — in ONE place.
 *
 * It used to live only inside `client.ts`, so the browser client in `libs/client` had none of
 * it: no retry, no idempotency key, and 429 handled as a failure. Copying it across would
 * have replaced "one has it, one doesn't" with two definitions free to drift, which is the
 * shape of every other divergence in this repo. So it moved here instead, and both request
 * loops import it.
 */

/**
 * 429 is deliberately ABSENT. On a call it means the pool is full — that is the queue, not a
 * rate limit. Retrying burns the backoff and hands the caller the same queued answer with
 * `isQueued()` destroyed.
 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 500, 502, 503, 504]);

/** Methods that change something, and so carry an idempotency key. */
export const MUTATING: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Uniqueness is all this needs, not unpredictability. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function backoffMs(attempt: number, retryAfter: string | null): number {
  const server = retryAfter ? Number(retryAfter) * 1000 : NaN;
  // Honour Retry-After when the server sends one; it knows more than we do.
  if (Number.isFinite(server) && server >= 0) return Math.min(server, 20_000);
  return Math.random() * Math.min(500 * 2 ** attempt, 8_000);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A dropped connection or a timed-out attempt. A caller's own abort is NOT transient. */
export function isTransient(cause: unknown): boolean {
  const name = (cause as { name?: string })?.name;
  return name === "TimeoutError" || name === "TypeError" || name === "FetchError";
}
