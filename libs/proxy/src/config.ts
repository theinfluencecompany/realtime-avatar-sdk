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

      // The client chooses WHO to call and whether it wants video. Nothing else.
      const body = (await request.json().catch(() => ({}))) as { avatarId?: string; mode?: string };
      if (!body.avatarId) return json({ error: "avatarId is required" }, 422);
      const mode = body.mode === "voice" ? "voice" : "avatar";

      const decided = await config.session?.({ request, avatarId: body.avatarId, mode });
      if (decided instanceof Response) return decided;

      const call = await rta.startCall({ avatarId: body.avatarId, mode, ...(decided ?? {}) });

      // A busy pool is a queue. Passing 429 through lets the client show a position.
      if (isQueued(call)) {
        return json({ queued: true, position: call.position, retryAfterMs: call.retryAfterMs }, 429);
      }
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
