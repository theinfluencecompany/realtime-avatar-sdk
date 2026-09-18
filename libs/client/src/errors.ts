import {
  ERROR_SEMANTICS,
  hasInternalDetail,
  normalizeError,
  userSafeMessage,
  type KnownErrorCode,
  type NormalizedError,
} from "../../http-client/src/generated/error-semantics.ts";

export type RealtimeAvatarApiErrorBody = unknown;

/**
 * DERIVED from the platform contract via `scripts/generate-error-semantics.mjs`.
 *
 * This was a hand-written union of eleven codes. The platform publishes 31 with copy and 6
 * more it recognises, so the union was wrong in the ordinary way a copy is wrong: it named
 * codes the server no longer sends and omitted every refusal added since it was typed. A
 * consumer switching on it was switching on a snapshot.
 *
 * `| (string & {})` keeps an unrecognised code assignable — the platform may send one this
 * package predates — while still offering the known names to autocomplete. It is the one
 * honest shape for an open vocabulary, and it is why `Error.code` is not an enum upstream.
 */
export type RealtimeAvatarErrorCode = KnownErrorCode | (string & {});

type RealtimeAvatarApiErrorMetadata = {
  code?: string;
  retryable?: boolean;
  billingUrl?: string;
  rawMessage?: string | null;
};

export class RealtimeAvatarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: RealtimeAvatarApiErrorBody,
    readonly response: Response,
    metadata: RealtimeAvatarApiErrorMetadata = {},
  ) {
    super(message);
    this.name = "RealtimeAvatarApiError";
    this.code = metadata.code;
    this.retryable = metadata.retryable;
    this.billingUrl = metadata.billingUrl;
    this.rawMessage = metadata.rawMessage ?? null;
  }

  readonly code?: string;
  readonly retryable?: boolean;
  readonly billingUrl?: string;
  /** Debug detail returned by the API. Do not render directly in user-facing UI. */
  readonly rawMessage: string | null;

  get isBillingRequired(): boolean {
    return this.status === 402 || this.code === "insufficient_credits" || this.code === "spend_limit_exceeded";
  }

  static async fromResponse(response: Response): Promise<RealtimeAvatarApiError> {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.clone().json().catch(() => null)
      : await response.clone().text().catch(() => "");
    const rawMessage = (extractErrorMessage(body) ?? response.statusText) || null;
    const metadata = extractErrorMetadata(body, response.status, rawMessage);
    return new RealtimeAvatarApiError(
      metadata.message,
      response.status,
      body,
      response,
      metadata,
    );
  }
}

export class RealtimeAvatarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeAvatarConfigError";
  }
}

export class RealtimeAvatarCapacityError extends Error {
  constructor(
    message: string,
    readonly busy: import("./wire").CapacityBusyResponse,
  ) {
    super(message);
    this.name = "RealtimeAvatarCapacityError";
  }

  get queueSize(): number {
    return this.busy.queue_size;
  }

  get queuePosition(): number | undefined {
    return this.busy.queue_position;
  }

  get queueTicketId(): string | undefined {
    return this.busy.queue_ticket_id;
  }

  get recommendedRetryMs(): number {
    return this.busy.recommended_retry_ms;
  }
}

/**
 * Thrown when a server response parses as JSON but does not match the expected
 * contract (the generated OpenAPI schema). Surfaces the underlying issues so a
 * drifted backend is caught at the boundary instead of flowing through as a
 * blindly-cast value.
 */
export class RealtimeAvatarValidationError extends Error {
  constructor(
    message: string,
    readonly issues: unknown,
    readonly value: unknown,
  ) {
    super(message);
    this.name = "RealtimeAvatarValidationError";
  }
}

/**
 * Read whichever of `detail`, `error` or `message` the upstream used, at any nesting depth.
 *
 * `readRecord` is the ONLY place a wire value becomes a keyed object, and it is a type guard
 * rather than a cast: `body as Record<string, unknown>` asserted a shape the compiler could
 * not check, and it appeared three times in this file. A guard makes the runtime check and the
 * narrowing the same statement, so an `unknown` that is not an object cannot reach the indexing.
 */
function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? { ...value } : null;
}

function extractErrorMessage(body: unknown): string | null {
  if (typeof body === "string") return body || null;
  const record = readRecord(body);
  if (!record) return null;
  return readMessageValue(record.detail) ?? readMessageValue(record.error) ?? readMessageValue(record.message);
}

/**
 * Shape an upstream failure into what a user may see. A thin projection of the GENERATED
 * `normalizeError`, so this SDK and the platform run the same decision procedure rather than
 * two hand-written copies of it. The only thing supplied here is the copy the contract does
 * not own — see `CONCURRENCY_LIMIT_FALLBACK_MESSAGE`.
 */
export function normalizeRealtimeAvatarError(input: {
  status?: number;
  code?: string | null;
  message?: string | null;
}): NormalizedError {
  return normalizeError(input, {
    concurrencyLimitFallback: CONCURRENCY_LIMIT_FALLBACK_MESSAGE,
    requestFailedFallback: "Realtime Avatar request failed. Try again.",
  });
}

function extractErrorMetadata(
  body: unknown,
  status: number,
  rawMessage: string | null,
): RealtimeAvatarApiErrorMetadata & { message: string } {
  const record = readRecord(body);
  if (!record) {
    const normalized = normalizeRealtimeAvatarError({ status, message: rawMessage });
    return { ...normalized, rawMessage };
  }
  const code = typeof record.code === "string" ? record.code : null;
  const normalized = normalizeRealtimeAvatarError({ status, code, message: rawMessage });
  return {
    code: normalized.code,
    retryable: typeof record.retryable === "boolean" ? record.retryable : normalized.retryable,
    ...(typeof record.billingUrl === "string" ? { billingUrl: record.billingUrl } : {}),
    rawMessage,
    message: normalized.message,
  };
}

/**
 * The sentence used when the server sends `concurrency_limit_reached` without one of its own.
 *
 * DERIVATION: declared, not derived. `concurrency_limit_reached` is in the platform's
 * `x-error-codes-uncopied` list precisely because the real sentence names the caller's plan
 * ceiling, which the contract cannot know. This is the fallback for when that sentence is
 * missing, and it is the only product copy in this file that the platform does not own.
 */
const CONCURRENCY_LIMIT_FALLBACK_MESSAGE =
  "The concurrent session limit is reached. Active and starting sessions count. End a session or wait for pending starts to clear, then retry.";






function readMessageValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const record = readRecord(value);
  if (!record) return null;
  return readMessageValue(record.message) ?? readMessageValue(record.error) ?? readMessageValue(record.detail);
}

// `userSafeMessage`, `hasInternalDetail` and `MACHINE_SHAPED` WERE HERE. All three are now
// generated from the platform contract into ../../http-client/src/generated/error-semantics.ts
// and imported above.
//
// The local `MACHINE_SHAPED` was a NEAR-copy: it never had the locator half, so a URL, an
// absolute path, an email address, a bearer token or an embedded newline in an upstream
// sentence passed the test and reached users. Measured 2026-09-18 against the platform's own
// filter, which caught all five. That is the ordinary fate of a pattern written down twice —
// both were correct the day they were written.
//
// `isWarmingMessage` was here too, and its own comment named its replacement: "the right
// long-term fix is upstream — a warming response should carry a code, not prose the client has
// to guess at." The contract publishes `service_warming` (503), so the guess is gone.
