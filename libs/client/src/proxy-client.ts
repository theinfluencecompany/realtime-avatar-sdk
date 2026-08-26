import type {
  AvatarSessionClient,
  LiveKitSessionStartResult,
  RealtimeAvatarRequestOptions,
} from "./session-client";
import type { LiveKitSessionReleaseReason } from "./wire";

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
   * Per-request deadline, default 60s, `0` to disable.
   *
   * Not optional in spirit: a proxy that accepts the connection and then never answers leaves
   * a promise that never settles, which presents as a page stuck on "connecting" with no error
   * and a call slot held until the join timeout reclaims it.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Trailing slashes make `${base}/connect` into `…//connect`, which some routers 404. */
const normalize = (url: string): string => url.replace(/\/+$/, "");

export function createProxyClient(options: ProxyClientOptions): AvatarSessionClient {
  const base = normalize(options.proxyUrl);
  const doFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const deadline = (caller?: AbortSignal): AbortSignal | undefined => {
    if (!timeoutMs) return caller;
    const timer = AbortSignal.timeout(timeoutMs);
    // Both matter: the caller's signal is the unmount, the timer is the proxy that never answers.
    return caller ? AbortSignal.any([caller, timer]) : timer;
  };

  const post = async (path: string, body: unknown, request?: RealtimeAvatarRequestOptions): Promise<Response> => {
    if (!doFetch) throw new Error("realtime-avatar: no fetch available — pass one via `fetch`.");
    return doFetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(request?.headers ?? {}) },
      body: JSON.stringify(body),
      signal: deadline(request?.signal),
    });
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
      const response = await post(
        "/connect",
        { avatarId: (input as { avatarId?: string }).avatarId, mode: (input as { mode?: string }).mode },
        requestOptions,
      );

      // A busy pool is a queue, not a failure. Passing it back as a VALUE is what lets a page
      // render a position instead of an error screen.
      if (response.status === 429) {
        const busy = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: "busy", busy: busy as never };
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`realtime-avatar: proxy refused the call (${response.status}) ${detail}`.trim());
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
        const response = await post("/end", { session_id: sessionId, reason }, requestOptions);
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
        const response = await post("/end", { queue_ticket_id: queueTicketId, reason }, requestOptions);
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
