# realtime-avatar-tools

Your page's own functions, callable by the avatar. **No React required.**

```ts
import { attachAvatarTools } from "realtime-avatar-tools";

await attachAvatarTools(room, {
  check_order: {
    description: "Look up an order's delivery status. Call this whenever the user asks " +
      "where something is, or when it will arrive.",
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    execute: async ({ order_id }) => api.order(order_id),
  },
});
```

The shape is structurally the Vercel AI SDK's `tool()`, so an AI SDK tool passes straight
through — but nothing is imported, so you do not need the AI SDK.

## Two things that decide how you use it

**1. The grant is the gate.** Your server must mint the call with `clientTools: true`. Without
it the worker never exposes registration and no page code is reachable from the model. That is
the only off switch, and it is server-side by design.

**2. Call it once connected — it waits for the agent itself.** Registration is an RPC *to the
agent*, so there is nobody to call before it arrives; and joining the room and ARMING the
method are not the same instant. `attachAvatarTools` polls until the agent answers (default 8s,
`timeoutMs` to change), and addresses agent-looking identities first, so a room with other
participants in it still registers. The manifest deliberately does not ride the mint — that
request is strict and 422s on an unknown key.

> **If registration does fail, read the message carefully.** `Method not supported at
> destination` is what BOTH a missing `client_tools` grant and an unarmed agent produce. That
> collision is why this retries rather than throwing on the first attempt — one try cannot tell
> the two apart, and assuming the grant sends you to the wrong layer.

## Read the result

```ts
const reg = await attachAvatarTools(room, tools);
reg.accepted;   // armed
reg.rejected;   // [{ name, reason }] — a dropped tool is silently uncallable otherwise,
                // which reads exactly like the model ignoring it
```

## Limits

32 tools · 12 KB manifest · 8 KB per result. A result over the limit is **refused, not
truncated** — a truncated JSON fragment is worse than an error, because the model reasons over
it. A throwing tool becomes an error result rather than an RPC throw, because LiveKit's
fallback string is `"An internal error occurred"` and she would say it out loud.

MIT licensed.
