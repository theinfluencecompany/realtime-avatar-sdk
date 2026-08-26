import { createProxyHandler } from "../../proxy/src/config.ts";
import type { ProxyConfig } from "../../proxy/src/types.ts";

/**
 * TanStack Start. Mount at `routes/api/realtime-avatar/$.ts` — the trailing `$` is Start's
 * splat segment, and without it the handler only ever sees the mount path itself and answers
 * 404 for every operation (the same trap Next.js's `[...path]` exists to avoid).
 *
 * ```ts
 * export const Route = createFileRoute("/api/realtime-avatar/$")({
 *   server: { handlers: realtimeAvatarServerRoute({ apiKey: process.env.KEY!, session }) },
 * });
 * ```
 */
export function realtimeAvatarServerRoute(config: ProxyConfig): {
  GET: (ctx: { request: Request }) => Promise<Response>;
  POST: (ctx: { request: Request }) => Promise<Response>;
} {
  const handler = createProxyHandler(config);
  return { GET: ({ request }) => handler(request), POST: ({ request }) => handler(request) };
}
