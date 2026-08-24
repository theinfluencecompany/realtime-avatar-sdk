# realtime-avatar-proxy

Framework adapters that keep your Realtime Avatar API key on the server.

Your browser cannot hold the key — anyone with it can start unlimited calls on your account.
So the browser talks to your app, and your app talks to us. This package is that route, with
the two hooks that matter already in the right places.

```bash
npm install realtime-avatar-proxy
```

## Next.js (App Router)

```ts
// app/api/realtime-avatar/[...path]/route.ts
import { createRealtimeAvatarRoute } from "realtime-avatar-proxy/nextjs";

export const { GET, POST } = createRealtimeAvatarRoute({
  apiKey: process.env.REALTIME_AVATAR_API_KEY!,   // never NEXT_PUBLIC_ prefixed

  authorize: async ({ request, operation }) => {
    const user = await currentUser(request);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (operation === "connect" && !(await hasCredits(user))) {
      return Response.json({ code: "insufficient_credits" }, { status: 402 });
    }
  },

  session: async ({ avatarId }) => {
    const character = await db.character(avatarId);
    return { instructions: character.prompt, maxSeconds: 600 };
  },
});
```

## Hono, Workers, Bun, Deno

```ts
import { realtimeAvatarHono } from "realtime-avatar-proxy/hono";

app.all("/api/realtime-avatar/*", realtimeAvatarHono({
  apiKey: () => env.REALTIME_AVATAR_API_KEY,      // a factory: no process.env on Workers
  session: async ({ avatarId }) => ({ instructions: await promptFor(avatarId) }),
}));
```

## Express

```ts
import express from "express";
import { realtimeAvatarExpress } from "realtime-avatar-proxy/express";

app.use("/api/realtime-avatar", express.json(),
  realtimeAvatarExpress({ apiKey: process.env.REALTIME_AVATAR_API_KEY!, session }));
```

## The two hooks

**`authorize({ request, operation })`** — return a `Response` to refuse, nothing to allow.
`operation` is `connect | avatars | credits`. Only `connect` costs money to start, so that is
where a wallet check belongs; leaving the reads ungated keeps them cheap.

**`session({ request, avatarId, mode })`** — what the character knows for this call.
Whatever the browser sent for these concerns is **discarded**; this hook is the only source,
and a field you do not set is absent rather than inherited. Omissions fail closed.

The client chooses two things: which avatar, and whether it wants video. Nothing else.

## What the routes do

| Route | Operation | Returns |
| --- | --- | --- |
| `POST …/connect` | `connect` | The connection payload, **verbatim** — or `429 { queued, position }` |
| `GET …/avatars` | `avatars` | The workspace's avatars |
| `GET …/credits` | `credits` | The credit balance |

A `429` is a queue, not a failure: every slot is busy. Show the position and retry.

MIT licensed. Docs: <https://realtimeavatar.ai/docs>
