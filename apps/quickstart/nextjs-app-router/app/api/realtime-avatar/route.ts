// The proxy package IS this file. Everything below is your policy, none of it is plumbing.
import { createRealtimeAvatarRoute } from "realtime-avatar-proxy/nextjs";

export const { GET, POST } = createRealtimeAvatarRoute({
  apiKey: process.env.REALTIME_AVATAR_API_KEY!,   // never NEXT_PUBLIC_ prefixed

  authorize: async ({ request, operation }) => {
    const user = await currentUser(request);
    if (!user) return new Response("Unauthorized", { status: 401 });
    // Only starting a call costs money; the reads stay cheap.
    if (operation === "connect" && !(await hasCredits(user))) {
      return Response.json({ code: "insufficient_credits" }, { status: 402 });
    }
  },

  session: async () => ({
    instructions: "You are Rin. Short, warm, specific sentences. Never mention being an AI.",
    maxSeconds: 120,           // a forgotten tab cannot run up a bill
  }),
});

declare function currentUser(request: Request): Promise<{ id: string } | null>;
declare function hasCredits(user: { id: string }): Promise<boolean>;
