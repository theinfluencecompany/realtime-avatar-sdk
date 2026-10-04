import type {
  AvatarSessionClient,
  LiveKitSessionStartResult,
  RealtimeAvatarRequestOptions,
} from "./session-client";
import type { LiveKitSessionReleaseReason } from "./wire";
// Extensions on purpose (tsconfig `allowImportingTsExtensions`): with them node's type-stripping
// runner can load the module directly, so the refusal and retry contracts below are pinned by
// tests that CALL it rather than ones that grep it.
import { RealtimeAvatarApiError } from "./errors.ts";
import { DEFAULT_MAX_RETRIES, RETRYABLE_STATUS, backoffMs, sleep } from "../../http-client/src/retry.ts";

/**
 * The client `AvatarCall` and the hooks ask for, talking to YOUR proxy route.
 *
 * Everything in this package is keyless by construction, and this is no exception: it holds a
 * URL, not a credential. Your route holds the key and decides the call; this only relays who to
 * call and, later, that the call is over.
 *
 * It exists because the prop was unsatisfiable without it. `AvatarCall` requires
 * `client: AvatarSessionClient`, and until now nothing in the published package could produce
 * one — the only implementation lived in a key-bearing class that is deliberately not exported
 * to browsers. So the flagship component typechecked, shipped, and could not be used.
 *
 * Pair it with `realtime-avatar/nextjs` (or `/hono`, `/express`, `/tanstack-start`) mounted at
 * the same prefix. Those adapters serve `POST …/connect` and `POST …/end`, which is exactly
 * what the five methods below call.
 */
export interface ProxyClientOptions {
  /**
   * Where your route is mounted, e.g. `/api/realtime-avatar`.
   *
   * Same-origin and relative is the normal case. React Native has no page origin, so pass an
   * ABSOLUTE url there or every request resolves against nothing.
   */
  proxyUrl: string;
  /** Swap the transport — a test double, or a fetch that carries your session cookie. */
  fetch?: typeof globalThis.fetch;
  /**
   * Deadline for one call to a method, default 60s, `0` to disable. For `connect` it covers every
   * attempt and the waits between them, so a retry never stretches a mint past it. Running out
   * throws a `RealtimeAvatarApiError` with `code: "upstream_timeout"`, `status: 0` and
   * `retryable: true`.
   *
   * Not optional in spirit: a proxy that accepts the connection and then never answers leaves
   * a promise that never settles, which presents as a page stuck on "connecting" with no error
   * and a call slot held until the join timeout reclaims it.
   */
  timeoutMs?: number;
  /**
   * Extra `connect` attempts after a retryable failure, default 2 (three in all), `0` to disable.
   *
   * Retried: a 5xx (or 408) whose JSON body says `retryable: true`, after full-jitter backoff or
   * the `Retry-After` the route sent. Never retried: a refusal (4xx), a capacity queue or a 429,
   * a 5xx without `retryable: true` (a route that threw, a gateway error), a retry that would
   * start with under 5s (or under the last attempt's duration) of `timeoutMs` left, and your own
   * abort. `realtime-avatar/*` route adapters answer `retryable: false`: the server client
   * behind them has already retried. The thrown error is the last attempt's; earlier attempts
   * hang off `.cause`, each with its own `.requestId`.
   */
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The least time a retried `connect` must have left before it is sent. */
const MIN_ATTEMPT_MS = 5_000;

const routeSaysRetryable = (body: unknown): boolean =>
  typeof body === "object" && body !== null && "retryable" in body && body.retryable === true;

/** One deadline for a whole method call. A caller's abort is an unmount, never a timeout. */
type Budget = { signal: AbortSignal | undefined; expired: () => boolean; remainingMs: () => number };

/** Trailing slashes make `${base}/connect` into `…//connect`, which some routers 404. */
const normalize = (url: string): string => url.replace(/\/+$/, "");

export function createProxyClient(options: ProxyClientOptions): AvatarSessionClient {
  const base = normalize(options.proxyUrl);
  const doFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = typeof options.maxRetries === "number" && Number.isFinite(options.maxRetries)
    ? Math.max(0, Math.floor(options.maxRetries))
    : DEFAULT_MAX_RETRIES;

  const budget = (caller?: AbortSignal): Budget => {
    if (!timeoutMs) return { signal: caller, expired: () => false, remainingMs: () => Infinity };
    const timer = AbortSignal.timeout(timeoutMs);
    const endsAt = Date.now() + timeoutMs;
    // Both matter: the caller's signal is the unmount, the timer is the proxy that never answers.
    return {
      signal: caller ? AbortSignal.any([caller, timer]) : timer,
      expired: () => timer.aborted && !caller?.aborted,
      remainingMs: () => endsAt - Date.now(),
    };
  };

  const post = async (
    path: string,
    body: unknown,
    request: RealtimeAvatarRequestOptions | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    if (!doFetch) throw new Error("realtime-avatar: no fetch available — pass one via `fetch`.");
    return doFetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(request?.headers ?? {}) },
      body: JSON.stringify(body),
      signal,
    });
  };

  /** One `connect` attempt: the grant, a queue, or the refusal as a value for the retry loop to judge. */
  const connectOnce = async (
    body: unknown,
    request: RealtimeAvatarRequestOptions | undefined,
    signal: AbortSignal | undefined,
    previous: RealtimeAvatarApiError | undefined,
  ): Promise<LiveKitSessionStartResult | RealtimeAvatarApiError> => {
    const response = await post("/connect", body, request, signal);

    // A busy pool is a queue, not a failure. Passing it back as a VALUE is what lets a page
    // render a position instead of an error screen. It is never retried here: re-asking on the
    // route's own hint is the queue's job (`autoRetryBusy` in the grant hook), not a transport's.
    if (response.status === 429) {
      const value: unknown = await response.clone().json().catch(() => null);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const busy = value as Record<string, unknown>;
        const valid = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
        const queue = (busy.queued === true && valid(busy.size) && valid(busy.retryAfterMs)) ||
          (valid(busy.queue_size) && valid(busy.recommended_retry_ms));
        if (!("code" in busy) && queue) return { status: "busy", busy: busy as never };
      }
    }
    if (!response.ok) {
      // Your route's refusal IS the answer the page has to act on: a 402 is the paywall, a 401
      // is sign-in, a 403 `upgrade_required` is the plan wall, a 404 is "no longer here". Every
      // one of those is routed on `.status` and the body's `code`, so they have to be ON the
      // thrown value. The bare Error this used to throw typeset the status into a sentence and
      // carried neither: an adopter reading `error.status` found undefined, and every refusal
      // fell through to its retryable "connection lost" wall. A user who was simply out of
      // credits saw the character as unavailable — never the paywall — on every call, until
      // their balance changed. Same class the key-bearing client throws, so one wall router
      // serves both transports.
      return RealtimeAvatarApiError.fromResponse(response, { cause: previous });
    }
    // Opaque. The grant is relayed byte-for-byte and read only by the room.
    return { status: "ready", grant: (await response.json()) as never };
  };

  /**
   * `sendBeacon` is the only send that outlives a closing page, and it is
   * synchronous-or-nothing — hence a boolean, so the caller can fall back to the awaited path
   * when the browser has no beacon (React Native has none).
   */
  const beacon = (path: string, body: unknown): boolean => {
    const send = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
    if (!send) return false;
    // A Blob with an explicit type: a bare string is sent as text/plain, which a route that
    // parses JSON by content-type will drop on the floor without telling anyone.
    return send(`${base}${path}`, new Blob([JSON.stringify(body)], { type: "application/json" }));
  };

  return {
    async createLiveKitSessionOrBusy(
      input: Parameters<AvatarSessionClient["createLiveKitSessionOrBusy"]>[0],
      requestOptions?: RealtimeAvatarRequestOptions,
    ): Promise<LiveKitSessionStartResult> {
      // The client picks WHO to call and whether it wants video. Every other decision — the
      // persona, the memory, the time limit — is your route's, and anything sent here for those
      // is discarded there. Rule 1.
      const body = { avatarId: (input as { avatarId?: string }).avatarId, mode: (input as { mode?: string }).mode };
      const call = budget(requestOptions?.signal);
      let previous: RealtimeAvatarApiError | undefined;
      for (let attempt = 0; ; attempt++) {
        let outcome: LiveKitSessionStartResult | RealtimeAvatarApiError;
        const attemptStarted = Date.now();
        try {
          outcome = await connectOnce(body, requestOptions, call.signal, previous);
        } catch (cause) {
          if (call.expired()) throw RealtimeAvatarApiError.timeout(timeoutMs, { cause: previous });
          throw cause;
        }
        if (!(outcome instanceof RealtimeAvatarApiError)) return outcome;

        // Only the route's own `retryable: true` authorises a retry. A 5xx it did not classify
        // may come from a route that threw after starting a call, or a gateway in front of one
        // still minting, and re-asking either can start a second call. A 4xx is never re-asked.
        // The attempt also needs time to finish: one aborted after the route forwarded it still
        // mints, and the page never learns the session it would have to release.
        const delay = backoffMs(attempt, outcome.response?.headers.get("retry-after") ?? null);
        const attemptFloorMs = Math.max(MIN_ATTEMPT_MS, Date.now() - attemptStarted);
        const retry = attempt < maxRetries && RETRYABLE_STATUS.has(outcome.status) && routeSaysRetryable(outcome.body) &&
          delay + attemptFloorMs < call.remainingMs();
        if (!retry) throw outcome;
        void outcome.response?.body?.cancel().catch(() => {});
        try {
          await sleep(delay, call.signal);
        } catch (cause) {
          if (call.expired()) throw outcome;
          throw cause;
        }
        previous = outcome;
      }
    },

    async releaseLiveKitSession(
      sessionId: string,
      reason?: LiveKitSessionReleaseReason,
      requestOptions?: RealtimeAvatarRequestOptions,
    ): Promise<boolean> {
      if (!sessionId) return false;
      // Never throws: a release that is lost is a slower release, never a broken page, because
      // the join timeout is the backstop. Rule 12.
      try {
        const response = await post("/end", { session_id: sessionId, reason }, requestOptions, budget(requestOptions?.signal).signal);
        return response.ok;
      } catch {
        return false;
      }
    },

    releaseLiveKitSessionBeacon(sessionId: string, reason?: LiveKitSessionReleaseReason): boolean {
      if (!sessionId) return false;
      return beacon("/end", { session_id: sessionId, reason: reason ?? "page_hide" });
    },

    async releaseLiveKitQueueTicket(
      queueTicketId: string,
      reason?: LiveKitSessionReleaseReason,
      requestOptions?: RealtimeAvatarRequestOptions,
    ): Promise<boolean> {
      if (!queueTicketId) return false;
      try {
        const response = await post("/end", { queue_ticket_id: queueTicketId, reason }, requestOptions, budget(requestOptions?.signal).signal);
        return response.ok;
      } catch {
        return false;
      }
    },

    releaseLiveKitQueueTicketBeacon(queueTicketId: string, reason?: LiveKitSessionReleaseReason): boolean {
      if (!queueTicketId) return false;
      return beacon("/end", { queue_ticket_id: queueTicketId, reason: reason ?? "page_hide" });
    },
  };
}
