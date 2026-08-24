import { createProxyHandler } from "./config.ts";
import type { ProxyConfig } from "./types.ts";

type Expressish = {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type ResponseLike = {
  status(code: number): ResponseLike;
  set(field: string, value: string): ResponseLike;
  send(body: string): void;
};

/**
 * Express 4/5.
 *
 * ```ts
 * app.use("/api/realtime-avatar", express.json(), realtimeAvatarExpress({ apiKey, session }));
 * ```
 *
 * Express hands us a parsed body, so it is re-serialized here rather than streamed. That is
 * fine for this route — the payloads are small — but it is why the Fetch adapters are the
 * better path if you have a choice.
 */
export function realtimeAvatarExpress(
  config: ProxyConfig,
): (req: Expressish, res: ResponseLike) => Promise<void> {
  const handler = createProxyHandler(config);
  return async (req, res) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const request = new Request(`http://localhost${req.originalUrl}`, {
      method: req.method,
      headers,
      body: req.method === "GET" ? undefined : JSON.stringify(req.body ?? {}),
    });
    const response = await handler(request);
    res.status(response.status).set("content-type", "application/json").send(await response.text());
  };
}
