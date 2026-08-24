import { createProxyHandler } from "./config.ts";
import type { ProxyConfig } from "./types.ts";

/**
 * Hono (and anything else built on Fetch handlers — Workers, Bun, Deno).
 *
 * ```ts
 * app.all("/api/realtime-avatar/*", realtimeAvatarHono({ apiKey: () => env.KEY, session }));
 * ```
 *
 * Pass `apiKey` as a factory on Workers, where there is no `process.env`.
 */
export function realtimeAvatarHono(
  config: ProxyConfig,
): (c: { req: { raw: Request } }) => Promise<Response> {
  const handler = createProxyHandler(config);
  return (c) => handler(c.req.raw);
}
