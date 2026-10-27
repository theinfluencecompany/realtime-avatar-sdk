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
- `app/api/voice/route.ts` — optional: her voice from your own text-to-speech. Set
  `VOICE_WEBHOOK_URL` to this route's public https URL and `app/api/call/route.ts` mints with
  `voiceWebhook`. Each sentence she is about to say arrives here signed; `verifyVoiceWebhook`
  checks the raw bytes and returns it typed, and the route streams OpenAI's 24 kHz PCM back as
  `audio/pcm`. A `401` from this route ends the call, so answer one only to a request that did
  not verify. An upstream failure is a `502`, which is retried once as a new POST; if that fails
  too, the rest of that reply goes unspoken and the next reply tries again.

## Cost

Starting a call bills by the second while it is live (under $5/hour). This example caps each
call at 120 seconds so a forgotten tab cannot run up a bill.
