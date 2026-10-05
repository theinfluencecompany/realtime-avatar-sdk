import type {
  AvatarSessionClient,
  LiveKitSessionStartResult,
  RealtimeAvatarRequestOptions,
} from "./session-client";
import type { LiveKitSessionReleaseReason } from "./wire";
import type { ProxyConnectRequest, ProxyEndRequest } from "./proxy-route.ts";
// Extension on purpose (tsconfig `allowImportingTsExtensions`): it is the one runtime import in
// this file, and with it node's type-stripping runner can load the module directly, so the
// refusal contract below is pinned by a test that CALLS it rather than one that greps it.
import { RealtimeAvatarApiError } from "./errors.ts";
import { PROXY_CLIENT_TIMEOUT_MS } from "../../http-client/src/retry.ts";

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
  /** Swap the transport — a test double, or a fetch that adds your own auth header. */
  fetch?: typeof globalThis.fetch;
  /**
   * The `credentials` mode of EVERY request this client makes, the page-hide release included.
   * Default `"same-origin"`, which is `fetch`'s own default.
   *
   * Set `"include"` when your route is on another origin and authorizes on a cookie — an
   * `app.example.com` page calling an `api.example.com` route. The route's CORS must then answer
   * with `Access-Control-Allow-Credentials: true` and the page's exact origin, for the preflight
   * of `connect` and of the release alike.
   */
  credentials?: RequestCredentials;
  /**
   * Per-request deadline, default 60s, `0` to disable. Keep it above your route's `timeoutMs`
   * (default 50s), so the route's answer arrives before the page stops listening. Running out throws a
   * `RealtimeAvatarApiError` with `code: "upstream_timeout"` (status 504, `response: null`).
   * Do not re-send a timed-out `connect` automatically: your route may still be minting it, and
   * this client never retries a mint — the server client inside your route owns that retry.
   *
   * Not optional in spirit: a proxy that accepts the connection and then never answers leaves
   * a promise that never settles, which presents as a page stuck on "connecting" with no error
   * and a call slot held until the join timeout reclaims it.
   */
  timeoutMs?: number;
}

/** Trailing slashes make `${base}/connect` into `…//connect`, which some routers 404. */
const normalize = (url: string): string => url.replace(/\/+$/, "");

export function createProxyClient(options: ProxyClientOptions): AvatarSessionClient {
  const base = normalize(options.proxyUrl);
  const doFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? PROXY_CLIENT_TIMEOUT_MS;
  const credentials = options.credentials ?? "same-origin";

  const post = async (path: string, body: unknown, request?: RealtimeAvatarRequestOptions): Promise<Response> => {
    if (!doFetch) throw new Error("realtime-avatar: no fetch available — pass one via `fetch`.");
    // Both matter: the caller's signal is the unmount, the timer is the proxy that never answers.
    const caller = request?.signal;
    const timer = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      return await doFetch(`${base}${path}`, {
        method: "POST",
        credentials,
        headers: { "content-type": "application/json", ...(request?.headers ?? {}) },
        body: JSON.stringify(body),
        signal: timer && caller ? AbortSignal.any([caller, timer]) : timer ?? caller,
      });
    } catch (cause) {
      // The deadline is a failure the page has to route; the caller's abort is an unmount and stays one.
      if (timer?.aborted && !caller?.aborted) throw RealtimeAvatarApiError.timeout(timeoutMs);
      throw cause;
    }
  };

  /**
   * The page-hide send: one that outlives a closing page, dispatched synchronously — hence a
   * boolean, so the caller can fall back to the awaited path when nothing could be sent (React
   * Native has neither a keepalive fetch nor a beacon).
   *
   * A keepalive `fetch` first, because it outlives the page exactly as a beacon does AND carries
   * the same `credentials` (and, through a custom `fetch`, the same headers) as the request that
   * started the call. `sendBeacon` is always `credentials: "include"` and cannot carry a header:
   * measured in Chromium 148 against a cross-origin route, its JSON preflight failed outright
   * when the route's CORS did not allow credentials, while `connect` under `same-origin` had
   * succeeded. So the beacon is used only where its fixed `include` cannot differ from the policy:
   * a same-origin route, or `credentials: "include"`.
   */
  const keepalive = (body: ProxyEndRequest): boolean => {
    const page = globalThis.location?.href;
    let target: URL;
    try {
      // A relative `proxyUrl` with no page to resolve it against (SSR, a test runner) cannot be
      // sent anywhere; say so, and the caller falls back to the awaited release.
      target = new URL(`${base}/end`, page);
    } catch {
      return false;
    }
    const payload = JSON.stringify(body);
    if (doFetch) {
      try {
        // No deadline signal: aborting would cancel the very release the page is leaving behind.
        void doFetch(target.href, {
          method: "POST",
          keepalive: true,
          credentials,
          headers: { "content-type": "application/json" },
          body: payload,
        }).catch(() => undefined);
        return true;
      } catch {
        // A fetch that refuses synchronously (a keepalive quota) falls through to the beacon.
      }
    }
    const send = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
    if (!send || !page) return false;
    if (credentials !== "include" && target.origin !== new URL(page).origin) return false;
    // A Blob with an explicit type: a bare string is sent as text/plain, which a route that
    // parses JSON by content-type will drop on the floor without telling anyone.
    return send(target.href, new Blob([payload], { type: "application/json" }));
  };

  return {
    async createLiveKitSessionOrBusy(
      input: Parameters<AvatarSessionClient["createLiveKitSessionOrBusy"]>[0],
      requestOptions?: RealtimeAvatarRequestOptions,
    ): Promise<LiveKitSessionStartResult> {
      // The client picks WHO to call and whether it wants video. Every other decision — the
      // persona, the memory, the time limit — is your route's, and anything sent here for those
      // is discarded there. Rule 1.
      const connect: Partial<ProxyConnectRequest> = { avatarId: input.avatarId, mode: input.mode };
      const response = await post("/connect", connect, requestOptions);

      // A busy pool is a queue, not a failure. Passing it back as a VALUE is what lets a page
      // render a position instead of an error screen.
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
        throw await RealtimeAvatarApiError.fromResponse(response);
      }
      // Opaque. The grant is relayed byte-for-byte and read only by the room.
      return { status: "ready", grant: (await response.json()) as never };
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
        const body: ProxyEndRequest = { session_id: sessionId, reason };
        const response = await post("/end", body, requestOptions);
        return response.ok;
      } catch {
        return false;
      }
    },

    releaseLiveKitSessionBeacon(sessionId: string, reason?: LiveKitSessionReleaseReason): boolean {
      if (!sessionId) return false;
      return keepalive({ session_id: sessionId, reason: reason ?? "page_hide" });
    },

    async releaseLiveKitQueueTicket(
      queueTicketId: string,
      reason?: LiveKitSessionReleaseReason,
      requestOptions?: RealtimeAvatarRequestOptions,
    ): Promise<boolean> {
      if (!queueTicketId) return false;
      try {
        const body: ProxyEndRequest = { queue_ticket_id: queueTicketId, reason };
        const response = await post("/end", body, requestOptions);
        return response.ok;
      } catch {
        return false;
      }
    },

    releaseLiveKitQueueTicketBeacon(queueTicketId: string, reason?: LiveKitSessionReleaseReason): boolean {
      if (!queueTicketId) return false;
      return keepalive({ queue_ticket_id: queueTicketId, reason: reason ?? "page_hide" });
    },
  };
}
