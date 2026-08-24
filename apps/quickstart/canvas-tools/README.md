# Canvas tools

**What this shows:** the client tool plane end to end — `clientTools: true` server-side,
`attachAvatarTools` in the page, and four functions that close over a live canvas she cannot
see. One of them takes six seconds when a tool has two and a half, and needs a human to agree
first; both of those turn out to be the same problem.

## Setup

From the repo root, once, so the published SDK this example imports is present and built:

```bash
npm install && npm run build
```

Then:

```bash
cp .env.example .env      # add your key, a fal key, and an avatar id
node --env-file=.env server.mjs
```

Open <http://localhost:4193>, press **Call**, and ask her to draw something.

**This costs money.** Live conversation is billed by the second against your Realtime Avatar
balance, and every approved `generate_image` is one fal image. `MAX_CALL_SECONDS` in `.env`
caps the call; nothing caps the images except you pressing Approve.

## What to look at

**The grant is the gate.** `clientTools: true` on the mint in `server.mjs` is the entire
server-side half of the tool plane. Her worker only exposes `rta.tools.register` for a session
minted with that capability, and a browser cannot grant it to itself — so the decision lives on
the server, with the key. Comment that one field out and registration fails with "method not
supported at destination", which is the whole feature failing closed.

**`parameters` is JSON Schema, not zod.** `attachAvatarTools` reads `tool.parameters` and
passes it to the manifest verbatim. A tool authored with an `inputSchema` registers
*successfully* and then shows the model no arguments at all — the single most confusing failure
in this plane, because it reads exactly like her refusing to use the tool. With the Vercel AI
SDK, pass `z.toJSONSchema(schema)`.

**Slow and needs-permission are the same problem.** A tool has `TOOL_DEADLINE_MS` — 2500ms —
before the worker abandons it and tells her it failed. Image generation takes about six
seconds. A human reading an approval dialog takes longer than that every time, which is why
this example does *not* use `window.confirm()`: it blocks the main thread, and the tool would
time out while the user was still reading it. Both cases get the same answer — `generate_image`
asks, returns immediately with `awaiting_confirmation`, and the fal call only happens if the
button is pressed. She covers the gap conversationally instead of standing mute.

**Return words, not blobs.** Every tool result here is fed straight back to a model that has to
say it out loud. `{ ok: true }` gives her nothing to speak from; `{ drew: "a tomato circle" }`
gives her a sentence. The same reason the failure path pushes a sentence onto the canvas
description rather than an error code — that is how she finds out, on her next
`describe_canvas`.

**The second key never reaches the browser.** The `generate_image` tool calls
`/api/draw/generate` on this server, which calls fal. That is what keeps `FAL_KEY` server-side,
and it is the only place a per-user quota or a moderation pass could go.

**Registration reports what was dropped.** `attachAvatarTools` returns `accepted` and
`rejected`. Watch the log on connect: a tool in `rejected` is silently uncallable, and
without that line you would be debugging the model instead of the manifest.

## On Next.js?

The two routes map one-for-one onto App Router route files —
`/api/avatar-session` → `app/api/avatar-session/route.ts`, `/api/draw/generate` →
`app/api/draw/generate/route.ts`. See [`../nextjs-app-router`](../nextjs-app-router) for the
route-handler shape. The tool half is identical either way: `attachAvatarTools` takes a LiveKit
`Room` and knows nothing about your framework.
