import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";
import type { ProxyConfig, ProxyOperation } from "./types.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

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
    const rta = new RealtimeAvatar({ apiKey, baseUrl: config.baseUrl });

    try {
      if (operation === "avatars") return json({ data: await rta.listAvatars() });
      if (operation === "credits") return json(await rta.creditBalance());

      if (operation === "end") {
        const ended = (await request.json().catch(() => ({}))) as { session_id?: string; reason?: string };
        const sessionId = ended.session_id;
        if (!sessionId) return json({ error: "session_id is required" }, 422);

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
      if (error instanceof RealtimeAvatarHttpError && error.isBilling) {
        return json({ code: error.code ?? "insufficient_credits" }, 402);
      }
      throw error;
    }
  };
}
