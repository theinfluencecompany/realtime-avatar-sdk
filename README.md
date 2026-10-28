<div align="center">

# Realtime Avatar

**Live voice and video characters you can interrupt.**

Your footage. Your voice. Your persona. Talking back in real time — and stopping
mid-sentence the moment someone cuts in, the way a person stops.

[![npm](https://img.shields.io/npm/v/realtime-avatar?color=1a7f37&label=npm)](https://www.npmjs.com/package/realtime-avatar)
[![CI](https://github.com/theinfluencecompany/realtime-avatar-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/theinfluencecompany/realtime-avatar-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-realtimeavatar.ai-6f42c1)](https://realtimeavatar.ai/docs)
[![Agent-ready](https://img.shields.io/badge/agent--ready-AGENTS.md-ff6b35)](./AGENTS.md)

[Quickstart](#quickstart) · [Examples](#examples) · [Packages](#packages) · [API](#api) · [Docs](https://realtimeavatar.ai/docs)

</div>

---

## Quickstart

For Claude Code or Cursor, install the [shared Realtime Avatar plugin](./plugins/realtime-avatar/README.md).
It connects your account's avatars, credits and clips to the agent, with opt-in writes
and a shared workflow for building an avatar app. The [plugin source and packaging](./integrations/agent-plugin/README.md)
also document an optional, separately installed hosted call preview.

```bash
npm install --save-exact realtime-avatar@0.17.0
```

Start the call on your **server**. Your key never touches a browser.

```ts
import { RealtimeAvatar, isQueued } from "realtime-avatar";

const rta = new RealtimeAvatar({ apiKey: process.env.REALTIME_AVATAR_API_KEY! });

const call = await rta.startCall({
  avatarId: "ava_…",
  instructions: "You are Rin. Short, warm, specific sentences.",
  maxSeconds: 600,
});

if (isQueued(call)) return { queued: true, position: call.position };
return call.raw;            // relay to the browser, byte-for-byte
```

Join it from your **client**.

```tsx
import { AvatarCall, createProxyClient } from "realtime-avatar/react";

// Holds a URL, not a credential. Your route holds the key.
const client = createProxyClient({ proxyUrl: "/api/realtime-avatar" });

<AvatarCall client={client} avatarId="ava_…" onEnded={({ reason }) => router.push("/")} />;
```

That's the whole integration. Two halves, one payload between them.

> [!TIP]
> Not on Node? The server half is plain HTTP — see
> [`apps/quickstart/python-fastapi`](./apps/quickstart/python-fastapi) for the same split
> from a Python backend.

---

## Why this one

|  |  |
| --- | --- |
| 🎙️ **Full duplex, always** | They listen the entire time they speak. Interrupt and they stop. A cough doesn't derail them; a pause isn't the end of your turn. Video doesn't cost you this. |
| 🎭 **Your character, not a stock presenter** | Hand it one still image: the resting loop and a starter motion library are generated from it — no footage to shoot, no clips to host. Direct her further in JSON (`setClipLibrary`), or re-shoot her later with footage of your own. ([the one rule](./AGENTS.md#the-one-rule-that-decides-whether-multi-clip-looks-good) if you do: every clip starts and ends on the same frame.) |
| 🛠️ **Tools run on your machine** | Your functions, your data, your secrets — never uploaded. They're called mid-conversation and have 2.5s to answer. |
| 💸 **Priced to leave running** | Under $5 per hour of live conversation, billed by the second — not rounded up to the minute. |
| 🧾 **An itemised bill** | `listSessions` returns every session: when it ran, how long, what it cost. Tag calls with your own user id to attribute them. |
| 🤖 **Written for coding agents** | [`AGENTS.md`](./AGENTS.md) ships in the package. Point your agent at it and it writes the integration correctly the first time. |

---

## How it fits together

```
your client  ──▶  your backend  ──▶  Realtime Avatar
                  (holds the key,      (capacity, listening,
                   decides the call)    thinking, speaking, rendering)
     ◀────────── live audio + video, and they're still listening ──────────
```

Two rules fall out of that picture, and they drive everything else:

1. **The key is server-only.** A browser holding it can start unlimited calls on your
   account. The constructor throws in a browser runtime, so that fails loudly instead of
   quietly costing you money.
2. **The connection payload is opaque.** Relay `call.raw` untouched — the client validates
   it strictly and will reject a reshaped object.

---

## Built with an AI agent?

Most people integrating this in 2026 aren't typing it by hand. So the reference is written
for the reader that shows up: **[`AGENTS.md`](./AGENTS.md)** is the entire surface in one
file, plus the twelve rules that are expensive to learn the hard way.

```
"Add a voice call to my Next.js app using the Realtime Avatar SDK.
 Read AGENTS.md in node_modules/realtime-avatar first."
```

`CLAUDE.md` symlinks to it, so Claude Code picks it up with no prompting. Codex, Cursor and
Copilot read `AGENTS.md` directly. There's also an
**[MCP server](./libs/mcp)** if you'd rather your agent query your avatars, balance and bill
live instead of reading about them.

---

The SDK exports composable validation schemas, so Zod 4.4.3 or a compatible newer
Zod 4 is a required peer. Modern npm/Bun installs peers automatically; applications
that already use Zod should declare one compatible version at their root. This is
a JavaScript dependency and introduces no native module.

## Packages

**One.** `npm install --save-exact realtime-avatar@0.17.0` and you have the server client, the route adapters, the
React bindings and the browser helpers. Everything is a subpath, treeshaken per entry, so a
server-only app still ships 18.8 KB with no React and no LiveKit in it.

The credential boundary is enforced by the build, not by the package name: importing a
key-holding entry into a browser bundle **throws at bundle time**. `realtime-avatar-mcp` is a
separate name only because it is a CLI you run with `npx` and never install.

**A server-only app pays for nothing it does not import.** `.`, `/server`, the route adapters,
`/browser` and `/tools` have **zero** external imports — `npm run externals` prints that per entry
and fails the build if it stops being true.

One runtime dependency comes along: `zod` (4.3 MB), which `/react` and `/react-native` need for
runtime validation. It is deliberately **not** bundled — inlining it costs every React app **+64 KB
gzipped** in shipped bytes (15 KB → 79 KB gzip, measured), and shipped bytes are what your users
feel, while `node_modules` is what a developer feels once. React, `livekit-client`, and the
`@livekit/*` packages are optional peers — install the group for your platform. Native compatibility
and the exact verified dependency tuple are documented in the [package README](./libs/sdk-server/README.md#react-native-compatibility).

| Package | Import | What it does |
| --- | --- | --- |
| [`libs/sdk-server`](./libs/sdk-server) | `realtime-avatar` | The whole SDK, one install. `.` and the adapters hold your key. |
| | `realtime-avatar/server` | The same client, without the route adapters |
| | `realtime-avatar/{nextjs,hono,express,tanstack-start}` | Mount a route that keeps the key server-side |
| | `realtime-avatar/react` | React bindings. **Never holds a key.** |
| | `realtime-avatar/react-native` | The same, for Expo and React Native |
| | `realtime-avatar/browser` | Mic and playback, with the six failure modes turned into values |
| | `realtime-avatar/tools` | The browser tool plane — your functions, called mid-conversation |
| | `realtime-avatar/recording` | Client-safe recording schemas and derived types |
| [`libs/mcp`](./libs/mcp) | `realtime-avatar-mcp` | MCP server for coding agents |

---

## Examples

Every example runs standalone — copy one out of the repo and it still works.

### `apps/quickstart/` — the smallest correct integration

| | |
| --- | --- |
| [**nextjs-app-router**](./apps/quickstart/nextjs-app-router) | A route handler and a call button. Start here. |
| [**python-fastapi**](./apps/quickstart/python-fastapi) | The same split from Python, plus verifying the signed session history |
| [**canvas-tools**](./apps/quickstart/canvas-tools) | The tool plane end to end — four tools drawing on a live canvas, including one that deliberately blows the deadline |

### `apps/demo/` — the showcases

| | |
| --- | --- |
| [**coding-companion**](./apps/demo/coding-companion) | A builder you talk to: the character is the conversation, a cheaper model writes the page, and they ship it to a public URL through the tool plane |
| [**pair-programmer**](./apps/demo/pair-programmer) | The same builder, composited into the room instead of sat beside it — same brief, same tools, same build engine, so the pair shows what a layout changes and what it does not |
| [**livestream**](./apps/demo/livestream) | An audience is not a new primitive — comments, gifts and hearts all ride one chat topic |
| [**live-shopping**](./apps/demo/live-shopping) | The character is not allowed to know the price — every commercial figure comes back from a tool and expires when the fact behind it does |
| [**math-studio**](./apps/demo/math-studio) | A tool plane that stays six tools wide however far the app grows — the things on screen register with the page, not with the character |
| [**terminal-tutor**](./apps/demo/terminal-tutor) | The character draws on the screen to teach vim and tmux, and never sends a coordinate — they name the thing, the page resolves where it is |
| [**dating-rehearsal**](./apps/demo/dating-rehearsal) | A first date you practice on, and four tools that are all the character's own call — he rates his interest into a live meter, pins the beats that turned it, walks out if it dies, and writes the debrief |
| [**persuasion**](./apps/demo/persuasion) | A win condition that is the character's own judgement — she concedes only by calling a `concede` tool when a genuinely new argument defeats her, and nothing else decides it |
| [**set-designer**](./apps/demo/set-designer) | One clip, many worlds — the browser picks a set by id, the id→prose map lives next to the key, and "as built" sends no `video` key at all |

See [`apps/README.md`](./apps/README.md) for what a new example has to contain and which tier
it belongs in.

---

## API

One class, one types file. The full surface is
[`libs/http-client/src/types.ts`](./libs/http-client/src/types.ts) — no import chasing.

```ts
// calls
rta.startCall({ avatarId, mode?, instructions?, context?, maxSeconds?, transcription?, video?, recording?, connectionHistory?, transcript?, metadata?, llm?, voiceWebhook? })
rta.endCall(sessionId, { reason? })     // free an abandoned call's slot; idempotent, never throws
rta.leaveQueue(queueTicketId, { reason? }) // give up a queued call's place in line; idempotent, never throws

// optional recordings; server only, requires recordings:read
rta.listRecordings({ sessionId, limit?, cursor? })
rta.getRecording(recordingId)          // durable metadata and processing state
rta.getRecordingAccess(recordingId)    // { recordingId, url, expiresAt }; renew when needed
rta.getConnectionHistory(sessionId)    // bounded LiveKit observations; requires usage:read

// pre-rendered video (MP4, no live call); server only, requires renders:write / renders:read
rta.createRender({ avatarId, voiceId?, lipGain?, shots })  // 202 queued; one Idempotency-Key across retries
rta.waitForRender(renderId)            // block until ready | failed; RETURNS a failed render, throws only on timeout
rta.getRender(renderId)
rta.listRenders({ limit?, cursor? })
rta.iterateRenders({ limit? })         // every render, paging handled
rta.getRenderAccess(renderId)          // { id, url, expiresAt }; signed for an hour, renew when needed

// avatars
rta.createAvatarFromImage({ displayName, imageUrl, motionPrompt?, voice? })  // the only lane
rta.createAvatarFromVideo({ displayName, videoUrl, voice? })                 // DEPRECATED — closed, 422
rta.listAvatars()
rta.getAvatar(avatarId)
rta.updateAvatar(avatarId, patch)       // re-point displayName / defaultVoiceId
rta.swapSource(avatarId, { sourceAssetId, anchorTimeMs? })  // re-shoot her: new loop, library re-renders
rta.retimeAnchor(avatarId, anchorTimeMs)                    // same loop, different rest frame
rta.deleteAvatar(avatarId)

// clip library
rta.setClipLibrary(avatarId, { expectedRevision, clips, idle?, on?, actions? }) // full declaration; revision required
rta.setLoop(avatarId, { motionPrompt })     // re-direct the RESTING LOOP; clips untouched
rta.waitForLoop(avatarId)               // block until it settles; THROWS if it failed
rta.waitForClips(avatarId)              // block until nothing is still rendering
rta.listClips(avatarId)                 // rows + revision, anchor, eligibility

// assets
rta.createRemoteAsset({ kind, remoteUrl })
rta.uploadAsset(file, { kind })

// billing
rta.creditBalance()                                 // balance + reserved
rta.listSessions({ from, to, endUserId })           // per-session: when, how long, what it cost
rta.iterateSessions({ from, to })                   // the same, paging handled

// webhooks
verifyTranscript(rawBytes, headers, secret)
verifyVoiceWebhook(rawBytes, headers, secret)   // one sentence to speak, typed; see "Custom voice (webhook)"

// contract values; also exported by realtime-avatar/react and /react-native
fishTtsModelSchema.safeParse(storedModelId)     // a Fish model id you stored -> FishTtsModel, or a failure
DEFAULT_FISH_TTS_MODEL                          // the platform's Fish default model
```

**A Fish model id you stored is validated once, with the SDK's own list.** Both values are
generated from the platform's contract: every live and deprecated id it accepts, and its
default. `fishTtsModelSchema.safeParse(row.model)` returns the public `FishTtsModel` on success,
so the voice you build needs no cast and your code keeps no copy of the list. Do it where the
stored string enters your server, and decide there what a refused id falls back to.

```ts
import { DEFAULT_FISH_TTS_MODEL, fishTtsModelSchema, type VoiceSpecInput } from "realtime-avatar/react";

const parsed = fishTtsModelSchema.safeParse(row.model);
const voice: VoiceSpecInput = {
  provider: "fish",
  voice_id: row.voiceId,
  model: parsed.success ? parsed.data : DEFAULT_FISH_TTS_MODEL,
};
```

`listSessions` validates the entire response against the generated platform contract before
returning `{ sessions, nextCursor, from, to }`. Malformed pages reject with
the public `RealtimeAvatarError` with a contract-mismatch message, rather than silently
becoming empty pages, failed sessions or null billing values. The error does not retain
the rejected response or validation details; malformed successful JSON uses the same safe
error. All own metadata keys, including `__proto__`, are preserved without mutating prototypes.
Nullable fields must
be present; unknown page and session fields are rejected, while metadata remains an open
record and is preserved. Contract-defined optional fields, including `releaseIdentity` when
returned, are retained. `iterateSessions` uses the same validation and follows cursors unchanged.

Opt in to closed-session speech measurements with `listSessions({ speechDiagnostics: true })`
or `iterateSessions({ speechDiagnostics: true })`. Only `true` sends
`X-RTA-Speech-Diagnostics: 1` on every page; false or omission sends no header. This is not a
query parameter or call metadata. `session.speechDiagnostics` is either `available` with
whole-session dialogue `latency_ms` statistics (`count`, `p50`, `p90`, `max`) per measured leg
and log coverage (`first_at`, `last_at`, `lines`), or `unavailable` with an explicit reason.
Coverage timestamps can be null. Missing legs stay absent; these are not pooled turn
percentiles, a query-window slice, or browser-audible latency. No raw logs or warnings are
returned. Older servers may omit the field even after opt-in; absence does not mean zero or
healthy. Opt-in pages are capped by the API at 50 sessions, with a 65,536-byte summary limit,
a 5,000 ms total page deadline and concurrency 4. The SDK forwards your requested limit and
cursor rather than reimplementing those server limits.

Recording defaults to off. `"participants"` keeps one continuous user file and one character file, each with only its own voice and permitted video. Camera toggles do not split the user file. `"tracks"` stores separate published audio/video tracks and replacement-camera segments; list them by session after capture. Its initial grant omits recording fields for compatibility with older clients. Your server can choose `"audio"`, `"video"`, `"audio_video"`, `"participants"`, or `"tracks"`
after obtaining consent. Keep `recordingId` and `sessionId` for your admin views; fetch temporary
playback access when needed. File retention (`retainedUntil`, the platform default is 36,500 days) is independent
of URL expiry (`expiresAt`, up to one hour). Join transcripts and your script revisions by
session ID. Retention follows the existing platform policy; the SDK does not set or extend it.
See [recording details](./libs/sdk-server/README.md#optional-call-recordings).

Connection history is separately opt-in: set `connectionHistory: true` in the server policy. When
RTA grants it, the browser SDK batches existing LiveKit connection snapshots automatically (no
WebRTC statistics polling). Read the bounded result with `getConnectionHistory(sessionId)` using
the `usage:read` scope.

### Errors worth branching on

| Status | Means | Do |
| --- | --- | --- |
| `401` | Bad, missing or revoked key | Check the bearer and the environment tag |
| `402` | Out of credits, or over the key's spend limit | Show a paywall, not an error screen |
| `403` | Key lacks the scope | Mint one with it. Don't widen to `*`. |
| `422` | Schema rejection | Unknown or mis-cased field — the wire is strict |
| `429` | Capacity queue, concurrent session limit, or rate limited | Only capacity returns a queue; other refusals throw. Not auto-retried. |
| `503` | Transient upstream | Retried for you, up to `maxRetries`, by the server client only. `createProxyClient` never retries a mint |

Only a capacity-queue response returns `{ queued: true, position, retryAfterMs }`.
`concurrency_limit_reached` throws: active, connecting and starting sessions all count toward
the workspace limit. End a session or wait for pending starts to clear, then retry.
Avoid duplicate parallel starts. The HTTP error retains safe counts at `.concurrency` and
the correlation ID at `.requestId`; the proxy and browser client preserve the refusal.
Showing an error there is the most common bad first impression.

The `realtime-avatar/*` route adapters relay every platform failure as JSON with its
`status`, `code`, `requestId` (also in `X-Request-ID`, with `cache-control: no-store`) and the
platform's own `retryable` verdict, never its private diagnostics. A platform `401` or `403` is
the route's own key, so it reaches the page as a `500` `internal_error` with `retryable: false`,
not a sign-in wall, a plan wall or a retry button. These failures are answered, not thrown, so a
framework error handler no longer sees them; the route logs each once with `console.error`
(operation, status, `code`, `requestId`, no secrets).

The route spends at most `timeoutMs` (default 50s) on one platform request, retries and backoff
included, and answers `504` `upstream_timeout` when that runs out. That budget sits inside
`createProxyClient`'s default 60s wait so the page always hears the route's answer; raise both
together, and keep the route's under your host's max function duration.

In the browser, `createProxyClient` never retries a mint: the server client inside your route
is the one retry owner, and a browser retry on top would multiply each click into up to nine
mints. A refusal throws a `RealtimeAvatarApiError` carrying `.status`, `.code`, `.retryable`
and `.requestId`; offer a retry button rather than looping. A deadline that runs out throws
the same class with `code: "upstream_timeout"`, `status: 504` and `response: null`. The route
may still be minting, so do not re-send it automatically: release the session if an id reached
you, otherwise wait for the server-side join timeout, or leave the retry to the user.

**A route on another origin.** If the page is `app.example.com` and the route is
`api.example.com` and authorizes on a cookie, pass `credentials: "include"` and have the route's
CORS answer with `Access-Control-Allow-Credentials: true` and the page's exact origin.
`createProxyClient` applies that mode to every request, the release it sends when the page is
hidden included. Unset, it sets no `credentials` at all, so `fetch`'s default (`same-origin`) or
your own `fetch` wrapper decides. The page-hide release is a `sendBeacon` where a beacon's fixed
`include` matches (a same-origin route, or `credentials: "include"`), and otherwise a `keepalive`
fetch through your `fetch`. Neither carries per-request `requestOptions.headers`, and a beacon
carries no header at all, so a route that authorizes the release by header sees none. Only
Chromium has been measured; Firefox before 133 ignores `keepalive`, which matters only for a
cross-origin route without `credentials: "include"`.

```ts
const client = createProxyClient({ proxyUrl: "https://api.example.com/realtime-avatar", credentials: "include" });
```

---

## Speech recognition hints

Your server can supply the languages and names relevant to a call:

```ts
const call = await rta.startCall({
  avatarId,
  transcription: {
    languageCodes: ["en-US", "zh-CN"],
    customVocabulary: ["Mira", "Acme"],
  },
});
```

Omit `languageCodes`, or use `[]`, for automatic multilingual detection. Prefer
at most 100 relevant vocabulary terms; the limit is 1,000 terms, 160 characters
each. Hints bias recognition rather than guaranteeing a spelling or faster
response. They do not change character instructions. This configuration is set
when the call starts; changing the object does not update an active call.

## Custom voice (webhook)

Speak a call in your own voice. Each sentence she is about to say is POSTed, signed, to an
endpoint your server hosts, and the audio it streams back is what she says, lip-synced, in
`avatar` and `voice` mode alike:

```ts
const call = await rta.startCall({
  avatarId,
  voiceWebhook: { url: "https://api.example.com/voice", secret: process.env.VOICE_WEBHOOK_SECRET!, voiceId: "narrator" },
});
```

```ts
// POST https://api.example.com/voice
import { verifyVoiceWebhook } from "realtime-avatar";

const raw = Buffer.from(await request.arrayBuffer());   // the RAW bytes, as for transcripts
const { text, voice_id, output } = await verifyVoiceWebhook(raw, request.headers, process.env.VOICE_WEBHOOK_SECRET!);
return new Response(await myTts(text, voice_id), { headers: { "content-type": "audio/pcm;rate=24000" } });
```

- `voiceWebhook` is `{ url, secret, voiceId?, language?, sampleRate?, timeoutMs? }`, derived from
  the platform's `voice_webhook`. It carries a secret, so only the server entries send it; it
  replaces `voice`, and a mint with both is refused with `422`. The URL must be https.
- Reply `200` with audio, streamed as soon as you have it. `timeoutMs` (default 5000) bounds the
  first audio byte of each attempt and every later gap between chunks. `audio/pcm` (alias
  `audio/raw`) is raw signed 16-bit little-endian mono at `output.sample_rate` (default 24000), or
  name the rate with `audio/pcm;rate=…`; no other raw type is accepted. OpenAI's
  `response_format: "pcm"` is exactly 24 kHz `audio/pcm`. A 2xx with no body (a `204`,
  `Content-Length: 0`, or an empty first chunk) is `voice_webhook_empty_audio`.
- `verifyVoiceWebhook` throws `RealtimeAvatarWebhookError` with a `code` (`missing_signature`,
  `bad_signature`, `stale_timestamp`, `invalid_body`).
- A `401` or `403` from your endpoint ends the call. A timeout, an unreachable endpoint, or a
  `408`, `429` or 5xx is retried once, only before any audio has arrived, as a new POST with a new
  `request_id`. Any other failure, or a retry that fails too, drops the rest of that reply: the
  sentences after it are not POSTed, and the next reply tries again. Repeated failures end the
  call with a fatal error carrying the last failure's code.
- In the client, `onVoiceError` on `useRealtimeSession` and `AvatarCall` fires with
  `{ code, message, status?, fatal, requestId? }`, and `voiceError` holds the last one of this
  call. `fatal` means the call is ending; `onEnded` follows with `failed`.

Working endpoints: `apps/quickstart/nextjs-app-router/app/api/voice/route.ts` and `POST /api/voice`
in `apps/quickstart/python-fastapi/main.py`.

## Pre-rendered video

**Everything in one shot happens at the same time; shots play one after another.**

```ts
const render = await rta.createRender({
  avatarId: "ava_6b80f113f07346c0ba6eedb32ec76aee",
  shots: [
    { clipId: "gesture_send_flower", say: "你终于来了。今天……我有话想对你说。" },
    { clipId: "idle_touch_collar", say: "别笑，我是认真的。", pauseAfterMs: 800 },
    { say: "所以，今晚留下来。" },
  ],
});
const done = await rta.waitForRender(render.id);
if (done.status === "failed") throw new Error(done.error?.message);
const { url, expiresAt } = await rta.getRenderAccess(done.id);   // <video src={url}> plays it
```

She sends the flower while she says the first line, touches her collar while she says the
second and then stays quiet for 800 ms, and says the last line without a new clip. The result is
an MP4 (H.264 + AAC, 25 fps) with the same face, clips, voice and lip-sync as a call, made
offline with no call and no LiveKit room.

| Field | What it is |
| --- | --- |
| `avatarId` | The avatar. |
| `voiceId` | A voice this workspace can use. Omit it for the avatar's own voice. |
| `lipGain` | Mouth-motion amplitude, as on a call. Omit it for the default. |
| `shots` | The script: 1 to 50 shots, played one after another. |
| `shots[].clipId` | What she does: a ready clip from the avatar's clip library, or `"primary"` for the avatar's own video. Omit it to keep the current loop clip. |
| `shots[].say` | What she says, 1 to 1,000 characters. Speech starts when the shot starts. |
| `shots[].pauseAfterMs` | How long she stays silent after speaking, 0 to 10,000 ms. Default 0. |

**How long a shot lasts.** Its speech plus `pauseAfterMs`, or its clip's action if that is
longer, rounded up to 200 ms. A clip plays one of two ways:

- **once**, an action: it plays exactly once from its first frame and is never cut. If the shot
  runs longer, she continues on the loop clip from before the shot. The same clip in two shots
  in a row plays twice.
- **loop**: `"primary"` and the clips she rests or listens on. It fills the shot, and the same
  loop clip in shots in a row continues without restarting.

The video opens with about 400 ms and closes with about 600 ms on the current loop clip.

**Where each shot landed.** A `ready` render carries `timeline`, one entry per shot, in order.
Every time is milliseconds from the start of the video.

| Field | What it is |
| --- | --- |
| `index` | The shot's position in your `shots`, from 0. |
| `startMs` · `endMs` | When the shot starts and ends; the next shot starts at `endMs`. |
| `clipId` | The clip the shot played: the one you named, else the loop clip it kept, else `"primary"`. |
| `playback` | `"once"` or `"loop"`. |
| `speechStartMs` · `speechEndMs` | When she starts and stops speaking. `null` when the shot has no `say`. |
| `clipEndMs` | When the action finished. Once clips only, else `null`. |
| `afterClipId` | The loop clip shown after the action, when the shot outlasts it. Once clips only, else `null`. |

- **The key needs `renders:write` to create and `renders:read` to read.** Both are off on a new
  key until you tick them; a key without the scope answers `403 insufficient_scope`.
- **`createRender` returns on acceptance.** A render is `queued`, then `rendering`, then `ready`
  or `failed`. `waitForRender` returns a failed render rather than throwing, so `error.code`
  (`asset_unavailable`, `tts_failed`, `too_long`, `render_failed`) stays a value you can branch
  on. It throws only when its timeout (30 minutes by default) runs out, and that is not a
  failure.
- **A `clipId` must be a READY clip of the avatar, or `"primary"`.** Otherwise the create is
  refused with `422 render_clip_unavailable` before anything is charged. Run `waitForClips`
  after changing the library.
- **`voiceId` is strict.** A voice the workspace cannot see is `404 voice_not_found`, and one
  that cannot speak a render is `422 voice_unavailable`. A render is never quietly re-voiced.
- **Keep the render id, not the URL.** The URL is signed for an hour; ask `getRenderAccess`
  again for a fresh one. The file itself is kept until you delete the account.
- **Limits.** Every shot sets at least one field (`pauseAfterMs: 0` alone does not count), at
  least one shot has `say`, at most 4,000 characters of `say` in total and 16 different clips
  besides `"primary"`. A script whose video would run past 180 seconds is refused with a `400`
  before any credits are held. A workspace may have 4 renders queued or rendering at once; the
  next is `429 concurrency_limit_reached`, which clears when one settles.
- **Billing.** Per second of rendered video at the live per-second rate. A failed render is not
  charged.

## Input source on room messages

`useRealtimeSession` on React and React Native observes normal `sendTurn` calls as
text automatically. If your app already recognizes speech, bind its final-text
callback once per session:

```ts
await session.sendTurn("Hello");
const sendTranscript = session.createTranscriptSender({ inputSource: "client_stt" });
await sendTranscript("Recognized words");
await sendTranscript("Typed correction", { inputSource: "text" });
// A single send can also declare its source:
await session.sendTurn("Recognized words", { inputSource: "client_stt" });
```

The adapter defaults to `client_stt` and captures its source at creation. An explicit
per-send declaration wins for that send only. Only `text` and `client_stt` are accepted
as client declarations; the transport observation stays `text`. The adapter accepts
recognized text; it does not run speech recognition. Existing `instructions` still work.
`retryTurn()` retains the original resolved declaration and scope, even after a timeout,
and sends a new `turn_id` linked to the previous attempt by `retry_of_turn_id`.

Consumers subscribed to the same room's `lk.chat` text streams can read these
attributes directly. The existing `useChat` hook exposes them on received messages:

```ts
import { useChat } from "realtime-avatar/react";

// Inside a component connected to the receiving room.
const { chatMessages } = useChat();
const inputs = chatMessages.map((message) => ({
  id: message.id,
  text: message.message,
  turnId: message.attributes?.["rta.turn_id"],
  observedSource: message.attributes?.["rta.observed_input_source"] ?? "unknown",
  declaredSource: message.attributes?.["rta.declared_input_source"],
  declarationScope: message.attributes?.["rta.input_source_declaration_scope"],
}));
```

For an imperative consumer that owns its room's text handler:

```ts
room.registerTextStreamHandler("lk.chat", async (reader, participant) => {
  const text = await reader.readAll();
  await consumeInput({
    text,
    senderIdentity: participant.identity,
    attributes: reader.info.attributes ?? {},
  });
});
```

Choose one handler owner per topic on a room instance; do not register another
`lk.chat` handler alongside `useChat`. Stream updates share a message ID; update
the existing record rather than inserting each partial update as a new input.
The receiving consumer must be connected and subscribed when the message arrives.
Room messages are not a durable history or an automatic push to an HTTP backend.
Source attributes require text-stream reception; the legacy `lk-chat-topic`
compatibility message does not carry these attributes.

This room-message path requires no inference Worker or platform contract changes.
Attributes are client-reported metadata, not verified facts about audio recognition.
Automatically tagging RTA's own server STT and returning provenance in the final
transcript webhook are separate capabilities; this SDK release does not establish
them. Existing webhook types and behavior are unchanged.

## Let the character see your camera

Authorize camera sharing in your server's call policy:

```ts
const call = await rta.startCall({ avatarId, camera: true, maxSeconds: 600 });
```

This permits sharing; it does not open the camera. Keep `camera` in your server
policy rather than forwarding it from an end-user request. Use the in-room
`useAvatarCamera` hook for camera controls on web and native. With `AvatarCall`,
render your camera control as a child; with a custom view, place it inside the
existing `RealtimeAvatarLiveKitRoom`.

Capture defaults to off and uses a front camera at 640×360, 5 fps. The server grant
must allow camera publication. Use the hook's participant/publication with the
platform's VideoTrack for preview. Stop sharing when your app goes into the
background, including native AppState transitions, and render the hook's error.

The character receives short-lived visual observations while normal conversation
continues. Sharing does not enable recording. This requires the matching platform
and inference release; an older grant does not authorize capture.

For an in-room control on either web or native, use
`useAvatarCamera({ allowed: grant.camera === true, active: foreground })`. It
returns `enabled`, `pending`, `error`, `toggle`, `setEnabled`, `publication` and
`participant`. Bind `active` to your page/app foreground and live-call state.
Capture stays off until an explicit action, stops when inactive or unmounted,
and cancelled permission requests cannot publish it. Capture and publication are
separate operations; a late captured track is stopped before it reaches the room.
The existing room `video` prop remains a lower-level LiveKit escape hatch. Do not
drive it alongside this hook; choose one camera controller.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
npm install
npm run check     # typecheck + build + tests, all of it
```

Found a security issue? Please don't open a public issue —
[SECURITY.md](./SECURITY.md) has the disclosure path.

---

## Support

- 📖 **Docs** — <https://realtimeavatar.ai/docs>
- 🐛 **Bugs and feature requests** — [open an issue](https://github.com/theinfluencecompany/realtime-avatar-sdk/issues)
- 🔀 **Versioning** — the API is pinned at `/api/v1`. Breaking changes get a new version, never a silent edit.

---

<div align="center">

**[MIT](./LICENSE)** © The Influence Company

</div>
