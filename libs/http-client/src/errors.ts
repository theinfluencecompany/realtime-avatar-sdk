/** Base for everything this SDK throws, so `catch (e) { if (e instanceof RealtimeAvatarError) }` works. */
export class RealtimeAvatarError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RealtimeAvatarError";
  }
}

/**
 * A non-2xx from the API.
 *
 * `code` is the machine-readable reason when the body was JSON — `insufficient_credits` and
 * `spend_limit_exceeded` are the two worth branching on. An HTML body (no `code`) almost
 * always means the route is not served at all rather than that your request was wrong.
 *
 * Fields are declared and assigned rather than written as TypeScript parameter properties:
 * that syntax cannot be type-stripped, and this package is meant to run straight from source
 * under `node --experimental-strip-types` as well as from `dist`.
 */
export class RealtimeAvatarHttpError extends RealtimeAvatarError {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: string;

  constructor(status: number, code: string | undefined, body: string) {
    super(`Realtime Avatar API ${status}${code ? ` (${code})` : ""}: ${body || "no body"}`);
    this.name = "RealtimeAvatarHttpError";
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** Out of credits, or over this key's spend limit. Surface a paywall, not an error. */
  get isBilling(): boolean {
    return this.status === 402;
  }
}
