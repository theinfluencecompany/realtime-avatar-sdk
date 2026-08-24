import { createProxyHandler } from "./config.ts";
import type { ProxyConfig } from "./types.ts";

/**
 * App Router. Mount at `app/api/realtime-avatar/[...path]/route.ts`:
 *
 * ```ts
 * export const { GET, POST } = createRealtimeAvatarRoute({ apiKey: process.env.KEY!, session });
 * ```
 *
 * Name the variable without `NEXT_PUBLIC_` — that prefix inlines it into the client bundle.
 */
export function createRealtimeAvatarRoute(config: ProxyConfig): {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
} {
  const handler = createProxyHandler(config);
  return { GET: handler, POST: handler };
}
