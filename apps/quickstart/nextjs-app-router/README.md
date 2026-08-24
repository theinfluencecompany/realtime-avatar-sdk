# Next.js voice call

**What this shows:** the smallest real integration — one route handler that starts a call
with server-decided policy, and a button that joins it.

## Setup

```bash
cp .env.example .env.local     # add your key and an avatar id
npm install
npm run dev
```

## What to look at

- `app/api/realtime-avatar/route.ts` — the server half, using the **proxy package**. Two
  hooks and no plumbing: `authorize` decides who may call, `session` decides what she knows.
- `app/api/call/route.ts` — the same thing written by hand against the client, for when you
  want to see what the proxy is doing for you.
- `app/page.tsx` — the client half. It POSTs to your route, then joins with `livekit-client`.

## Cost

Starting a call bills by the second while it is live (under $5/hour). This example caps each
call at 120 seconds so a forgotten tab cannot run up a bill.
