import { RealtimeAvatar, RealtimeAvatarError, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";
import { ERROR_SEMANTICS, type CopiedErrorCode } from "../../http-client/src/generated/error-semantics.ts";
import { ROUTE_TIMEOUT_MS } from "../../http-client/src/retry.ts";
import type { ProxyConfig, ProxyOperation } from "./types.ts";

/**
 * The route's own failures, named from the generated vocabulary with the status it pairs each
 * code with, so the page's `normalizeRealtimeAvatarError` reads them back unchanged.
 */
const MISCONFIGURED = "internal_error" satisfies CopiedErrorCode;
const TIMED_OUT = "upstream_timeout" satisfies CopiedErrorCode;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * A platform failure, ANSWERED rather than thrown: its status, `code`, request ID and the
 * platform's own `retryable` verdict, never its private diagnostics. Thrown, it became a
 * framework's body-less 500 that the page could not tell from a blip, and the request ID was
 * lost. Because it is answered, a framework error handler never sees it, so it is logged here.
 */
function relayFailure(operation: ProxyOperation, error: RealtimeAvatarHttpError): Response {
  // A platform 401 or 403 is about this route's own key, never the visitor's sign-in or plan, and
  // a refused key does not fix itself: the page must not offer a retry the platform never judged.
  const misconfigured = error.status === 401 || error.status === 403;
  const status = misconfigured ? ERROR_SEMANTICS[MISCONFIGURED].statuses[0] : error.status;
  const verdict = error.retryable === undefined ? {} : { retryable: error.retryable };
  const body = misconfigured
    ? { code: MISCONFIGURED, status, retryable: false }
    : error.status === 429
      ? throttled(error)
      : { code: error.isBilling ? error.code ?? "insufficient_credits" : error.code, status, ...verdict };
  console.error(
    `realtime-avatar: platform answered ${operation} with ${error.status} ` +
      `(code ${error.code ?? "none"}, requestId ${error.requestId ?? "none"}); relayed as ${status}` +
      (misconfigured ? " — the platform refused this route's API key" : ""),
  );
  const response = json({ ...body, ...(error.requestId ? { requestId: error.requestId } : {}) }, status);
  if (error.requestId) response.headers.set("X-Request-ID", error.requestId);
  return response;
}

/**
 * The platform gave no answer inside the route's budget. Answered as the same classified timeout
 * the browser raises at its own deadline, so the page routes it one way whichever ran out first.
 */
function timedOut(operation: ProxyOperation): Response {
  const { retryable, statuses: [status] } = ERROR_SEMANTICS[TIMED_OUT];
  console.error(`realtime-avatar: platform did not answer ${operation} inside the route's budget; answered ${status}`);
  return json({ code: TIMED_OUT, status, retryable }, status);
}

function throttled(error: RealtimeAvatarHttpError): Record<string, unknown> {
  const concurrency = error.code === "concurrency_limit_reached";
  const counts = error.concurrency;
  const message = concurrency
    ? counts?.maxConcurrentSessions !== undefined && counts.activeSessions !== undefined &&
      counts.connectingSessions !== undefined && counts.pendingSessions !== undefined
      ? `Session limit reached (${counts.maxConcurrentSessions} allowed): ${counts.activeSessions} active, ${counts.connectingSessions} connecting, ${counts.pendingSessions} starting. End a session or wait for pending starts to clear, then retry.`
      : "The concurrent session limit is reached. Active and starting sessions count. End a session or wait for pending starts to clear, then retry."
    : "Too many requests. Wait before retrying.";
  return {
    error: message, code: concurrency ? "concurrency_limit_reached" : "rate_limited",
    status: 429, retryable: error.retryable ?? true,
    ...(concurrency ? counts : {}),
  };
}

/** POST /connect is the only route that starts anything; the rest are reads. */
function operationFor(pathname: string, method: string): ProxyOperation | null {
  const tail = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (method === "POST" && (tail === "connect" || tail === "call")) return "connect";
  if (method === "POST" && (tail === "end" || tail === "release")) return "end";
  if (method === "GET" && tail === "avatars") return "avatars";
  if (method === "GET" && tail === "credits") return "credits";
  return null;
}

/**
 * The framework-agnostic core. Every adapter in this package is a thin shell over this.
 *
 * It exists because the alternative — every integrator hand-writing an auth check, a policy
 * merge, and a verbatim relay — is three chances to ship a security bug, and the middle one
 * is silent when you get it wrong.
 */
export function createProxyHandler(config: ProxyConfig): (request: Request) => Promise<Response> {
  /**
   * Session ids THIS handler minted. Rule 12 is the reason: a route that relays an arbitrary
   * session id from the request body lets any visitor hang up any call on the account, and the
   * platform cannot tell the difference — the id is all it gets. So only ids we issued are
   * releasable, and an id we did not issue is answered 204 rather than 404, because telling a
   * caller which ids exist is itself an oracle.
   *
   * In-process, so it does not survive a restart and is not shared between instances. That is
   * the right default for a single server and WRONG for serverless — pass `ownsSession` there,
   * backed by whatever already knows which user started which call.
   */
  const minted = new Map<string, number>();
  const MINTED_TTL_MS = 30 * 60_000;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const operation = operationFor(url.pathname, request.method);
    if (!operation) return json({ error: "not found" }, 404);

    const refusal = await config.authorize?.({ request, operation });
    if (refusal instanceof Response) return refusal;

    const apiKey = typeof config.apiKey === "function" ? await config.apiKey() : config.apiKey;
    const rta = new RealtimeAvatar({ apiKey, baseUrl: config.baseUrl, totalTimeoutMs: config.timeoutMs ?? ROUTE_TIMEOUT_MS });

    try {
      if (operation === "avatars") return json({ data: await rta.listAvatars() });
      if (operation === "credits") return json(await rta.creditBalance());

      if (operation === "end") {
        const ended = (await request.json().catch(() => ({}))) as {
          session_id?: string;
          queue_ticket_id?: string;
          reason?: string;
        };
        // A call that is still QUEUED has no session id — the ticket is the only handle on it,
        // and a user who closes the tab while waiting holds their place until it times out
        // otherwise. Both ids go through the same ownership check for the same reason.
        const sessionId = ended.session_id ?? ended.queue_ticket_id;
        if (!sessionId) return json({ error: "session_id or queue_ticket_id is required" }, 422);

        const owns = config.ownsSession
          ? await config.ownsSession({ request, sessionId })
          : minted.delete(sessionId);
        // Not ours: acknowledge and do nothing. `endCall` is best-effort by contract, and the
        // join timeout reclaims a slot we decline to release here.
        if (!owns) return new Response(null, { status: 204 });

        const reason = ended.reason === "page_hide" || ended.reason === "unmount" ? ended.reason : "manual";
        await rta.endCall(sessionId, { reason });
        return new Response(null, { status: 204 });
      }

      // The client chooses WHO to call and whether it wants video. Nothing else.
      const body = (await request.json().catch(() => ({}))) as { avatarId?: string; mode?: string };
      if (!body.avatarId) return json({ error: "avatarId is required" }, 422);
      const mode = body.mode === "voice" ? "voice" : "avatar";

      const decided = await config.session?.({ request, avatarId: body.avatarId, mode });
      if (decided instanceof Response) return decided;

      const call = await rta.startCall({ avatarId: body.avatarId, mode, ...(decided ?? {}) });

      // A busy pool is a queue. Passing 429 through lets the client show a position.
      if (isQueued(call)) {
        // Remember the TICKET the same way a session id is remembered, or the ownership check
        // below declines every queue release and the place in line is held until it times out.
        if (call.queueTicketId) minted.set(call.queueTicketId, Date.now());
        // queueTicketId travels too: it is the only handle that can release a place in LINE,
        // and dropping it meant a user who closed the tab while waiting held their slot until
        // it timed out.
        return json(
          {
            queued: true,
            position: call.position,
            size: call.size,
            retryAfterMs: call.retryAfterMs,
            queue_ticket_id: call.queueTicketId,
          },
          429,
        );
      }
      // Remembered BEFORE the relay, so a beacon that races the response still finds it.
      // Swept lazily: once a call cannot still be live, the entry protects nothing.
      const now = Date.now();
      for (const [id, at] of minted) if (now - at > MINTED_TTL_MS) minted.delete(id);
      minted.set(call.sessionId, now);

      // Verbatim. Reshaping this is what makes a client reject the whole payload.
      return json(call.raw);
    } catch (error) {
      if (error instanceof RealtimeAvatarHttpError) return relayFailure(operation, error);
      if (error instanceof RealtimeAvatarError && error.cause instanceof Error && error.cause.name === "TimeoutError") {
        return timedOut(operation);
      }
      throw error;
    }
  };
}
