export type RealtimeAvatarApiErrorBody = unknown;

export type RealtimeAvatarErrorCode =
  | "billing_required"
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "service_unavailable"
  | "request_failed"
  | "network_error";

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

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body : null;
  const record = body as Record<string, unknown>;
  const detail = readMessageValue(record.detail);
  if (detail) return detail;
  const error = readMessageValue(record.error);
  if (error) return error;
  const message = readMessageValue(record.message);
  if (message) return message;
  return null;
}

export function normalizeRealtimeAvatarError(input: {
  status?: number;
  code?: string | null;
  message?: string | null;
}): {
  code: RealtimeAvatarErrorCode | string;
  message: string;
  retryable: boolean;
} {
  const status = input.status ?? 0;
  const rawCode = input.code?.trim() || null;
  const rawMessage = input.message?.trim() || "";
  const blob = `${rawCode ?? ""} ${rawMessage}`.toLowerCase();

  if (rawCode === "insufficient_credits" || rawCode === "spend_limit_exceeded" || status === 402) {
    return {
      code: rawCode ?? "billing_required",
      message: rawMessage && !hasInternalDetail(rawMessage) ? rawMessage : "Add credits to continue using realtime avatars.",
      retryable: false,
    };
  }
  if (status === 401) {
    return { code: "unauthorized", message: "Authentication is required to use Realtime Avatar.", retryable: false };
  }
  if (status === 403) {
    return { code: "forbidden", message: "This API key does not have access to that action.", retryable: false };
  }
  if (status === 404 || blob.includes("unknown avatar_id") || blob.includes("avatar not found")) {
    return { code: "not_found", message: "We could not find that avatar or resource.", retryable: false };
  }
  if (status === 409) {
    return { code: "conflict", message: "That request is already in progress. Try again in a moment.", retryable: true };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "Too many realtime requests. Please slow down and retry.", retryable: true };
  }
  if (isWarmingMessage(blob)) {
    return { code: "service_unavailable", message: "Realtime Avatar is warming up. Try again in a moment.", retryable: true };
  }
  if (status === 400 || status === 422) {
    return { code: "invalid_request", message: userSafeMessage(rawMessage) ?? "Check the request and try again.", retryable: false };
  }
  if (status >= 500) {
    return { code: "service_unavailable", message: "Realtime Avatar is temporarily unavailable. Try again in a moment.", retryable: true };
  }
  return {
    code: isPublicErrorCode(rawCode) ? rawCode : "request_failed",
    message: userSafeMessage(rawMessage) ?? "Realtime Avatar request failed. Try again.",
    retryable: status === 0 || status >= 500,
  };
}

function extractErrorMetadata(
  body: unknown,
  status: number,
  rawMessage: string | null,
): RealtimeAvatarApiErrorMetadata & { message: string } {
  if (!body || typeof body !== "object") {
    const normalized = normalizeRealtimeAvatarError({ status, message: rawMessage });
    return { ...normalized, rawMessage };
  }
  const record = body as Record<string, unknown>;
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

const PUBLIC_ERROR_CODES = new Set<RealtimeAvatarErrorCode>([
  "billing_required",
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "service_unavailable",
  "request_failed",
  "network_error",
]);

function isPublicErrorCode(code: string | null): code is RealtimeAvatarErrorCode {
  return Boolean(code && PUBLIC_ERROR_CODES.has(code as RealtimeAvatarErrorCode));
}

function readMessageValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return readMessageValue(record.message) ?? readMessageValue(record.error) ?? readMessageValue(record.detail);
}

function userSafeMessage(message: string): string | null {
  if (!message || hasInternalDetail(message)) return null;
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}

/**
 * Whether a failure means "not ready yet, try again" rather than "wrong request".
 *
 * The terms here are deliberately ones a user could read without learning anything about
 * how the service is built. This used to also sniff for backend vocabulary — the words a
 * particular component uses when it has not finished loading — which named that component
 * to anyone reading the bundle, for the sake of a slightly better sentence.
 *
 * The cost of dropping them is small and bounded: a not-ready failure that no longer
 * matches still falls through to the >= 500 branch, which returns the same `retryable:
 * true` and a near-identical message. The right long-term fix is upstream — a warming
 * response should carry a code, not prose the client has to guess at.
 */
function isWarmingMessage(blob: string): boolean {
  return blob.includes("warming") || blob.includes("not ready") || blob.includes("starting up");
}

/**
 * Structures that machine output has and user-facing copy does not: identifiers and
 * assignments (`avatar_id`, `available=[…]`), bracketed or braced payloads, template and
 * shell punctuation, dotted module paths, `file:line` references, call syntax, and stack
 * frame preambles.
 */
const MACHINE_SHAPED = /[_=<>{}\[\]|\\$`]|\w+\.\w+\.\w|\S:\d|\w\(\)|^\s*(?:at|File)\b/mu;

/**
 * True when a backend message must not be repeated to a user verbatim.
 *
 * This tests the SHAPE of a message and never its vocabulary. A vocabulary test has to
 * name the private stack in order to look for it, and this function ships inside the
 * published bundle — so the test itself becomes a readable inventory of the thing it
 * protects. That is the reasoning that keeps the boundary denylist out of this repo
 * (scripts/check-boundary.mjs), and it binds harder here: an npm version cannot be
 * withdrawn once published.
 *
 * The residual is deliberate and belongs upstream. A plain-prose sentence that names
 * infrastructure ("the GPU ran out of memory") is shaped exactly like product copy, so no
 * client-side filter can catch it without shipping the word list this one avoids. That has
 * to be prevented where the message is written, not where it is displayed.
 */
function hasInternalDetail(message: string): boolean {
  return MACHINE_SHAPED.test(message);
}
