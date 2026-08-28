# realtime-avatar

A live character your users can talk to — voice, or voice and video. She listens while she
speaks, so you can interrupt her mid-sentence and she stops, the way a person stops.

```bash
npm install realtime-avatar
```

```ts
import { RealtimeAvatar, isQueued } from "realtime-avatar";

const rta = new RealtimeAvatar({ apiKey: process.env.REALTIME_AVATAR_API_KEY! });

// On your server. The client picks WHO to call; you decide everything about the call.
const call = await rta.startCall({
  avatarId: "ava_…",
  instructions: "You are Rin. Short, warm, specific sentences.",
  maxSeconds: 600,
});

if (isQueued(call)) return { queued: true, position: call.position };
return call.raw;   // relay to the browser byte-for-byte
```

That is the whole server half. The client joins with the payload and renders her.

---

## What you get

| | |
| --- | --- |
| **Voice or video** | The same call, the same code. `mode: "voice"` is audio-only and cheaper. |
| **Full-duplex** | Interrupt her and she stops. A cough does not derail her. A pause is not the end of your turn. |
| **Your character** | Your footage, your voice, your persona — not a stock presenter. |
| **Your tools** | You run them; you feed the result back into a turn. Nothing calls your API on your behalf. |
| **Priced to leave on** | Under $5/hour of live conversation, billed by the second. |

---

## The shape of an integration

```
your client  ──▶  your backend  ──▶  Realtime Avatar
                  (holds the key,      (capacity, listening,
                   decides the call)    thinking, speaking, rendering)
     ◀────────── live audio + video, and she is listening ──────────
```

Two facts follow from that picture and drive everything else:

1. **The key is server-only.** A browser holding it can start unlimited calls on your
   account. The constructor throws in a browser runtime so that fails loudly, not silently.
2. **The connection payload is opaque.** Relay `call.raw` untouched — the browser client
   validates it strictly.

---

## API

Everything is on one class. The full types are in
[`libs/http-client/src/types.ts`](../http-client/src/types.ts) — one file, no import chasing.
Almost every shape in it is **derived** from the published OpenAPI contract rather than declared
beside it, so a field that changes upstream fails the typecheck here. The exceptions are named at
the top of that file with the reason for each: two are gaps in the contract itself (it declares no
query parameters for `GET /v1/usage/sessions`, and the transcript webhook body is not in it at
all), and the `video` policy types are deliberately not one-to-one with the wire.

```ts
// calls
rta.startCall({ avatarId, mode?, instructions?, context?, maxSeconds?, video?, transcript?, metadata? })
rta.endCall(sessionId, { reason? })    // free an abandoned call's slot now; idempotent, never throws

// avatars
rta.createAvatarFromImage({ displayName, imageUrl, motionPrompt?, voice? })  // loop is GENERATED
rta.createAvatarFromVideo({ displayName, videoUrl, voice? })                 // DEPRECATED — closed, 422
rta.listAvatars()
rta.getAvatar(avatarId)

// clip library — declared as JSON, never as URLs
rta.setClipLibrary(avatarId, { clips, expectedRevision? })
rta.listClips(avatarId)
rta.syncClips(avatarId, clipUrls)      // DEPRECATED — external-URL tier

// assets
rta.createRemoteAsset({ kind, remoteUrl })
rta.uploadAsset(file, { kind })

// billing
rta.creditBalance()

// webhooks
verifyTranscript(rawBytes, headers, secret)
```

---

## Subpaths

**One install.** tsup treeshakes per entry, so a server-only app importing `realtime-avatar/server`
gets 18.8 KB with no React and no LiveKit in it, even though they sit in the same tarball.

Server — these hold your API key:

| Import | What it is |
| --- | --- |
| `realtime-avatar` | `RealtimeAvatar`, `isQueued`, `verifyTranscript`, the two error classes |
| `realtime-avatar/server` | The same client with no route adapters — 18.8 KB |
| `realtime-avatar/nextjs` | `createRealtimeAvatarRoute` — App Router `{ GET, POST }` |
| `realtime-avatar/hono` | `realtimeAvatarHono` — Hono, Workers, Bun, Deno |
| `realtime-avatar/express` | `realtimeAvatarExpress` |
| `realtime-avatar/tanstack-start` | TanStack Start server route |

Browser — these never can:

| Import | What it is |
| --- | --- |
| `realtime-avatar/react` | `AvatarCall`, `useAvatarCall`, `useRealtimeSession`, `useSessionLifecycle` |
| `realtime-avatar/react-native` | The same surface for Expo / React Native |
| `realtime-avatar/browser` | `enableMicrophone`, `attachRemoteAudio` — no React |
| `realtime-avatar/tools` | `attachAvatarTools` — the browser tool plane |

Every adapter takes the same two hooks: `authorize` gates the request, `session` decides the
call. Policy — `instructions`, `maxSeconds`, `voice`, `video` — is decided in `session`, on
your server. A route that spreads the request body into `startCall` hands your caller your
system prompt and your bill.

### Importing a server entry into a browser build throws

Not a lint rule and not a naming convention — the six server subpaths carry `browser` and
`react-native` export conditions pointing at a module whose only statement is a `throw`, so the
key-holding code never enters a client module graph. Measured: a browser bundle that imports both
halves contains **0** occurrences of `Bearer` or `apiKey`.

This lived under a second npm name (`realtime-avatar-react`) until 2026-08-26, on the theory that a
condition "chooses which file is bundled, never whether the package is". That was tested and is
false. Two things worth knowing if you copy the pattern: do **not** use `"browser": null` — Vite 8
and rolldown ignore it and bundle the server file *with* the secret — and do not leave
`"sideEffects": false` in place, which lets a bundler treeshake a throw-only module away and
silently disarms the whole guard.

## The two subpaths that are not React

`enableMicrophone` returns the cause as a value instead of throwing, because "the mic won't
start" is one sentence covering six causes with different fixes — and one of them, a macOS
system denial, cannot be fixed from the address bar and needs the browser restarted.
`attachRemoteAudio` attaches into the DOM *before* `connect`, which is what stops a track
arriving mid-connect from being lost on a fast connection.

`attachAvatarTools` runs your functions in the page. Nothing is executed on the platform, and
a tool has **2.5 seconds** to answer before the call gives up on it and tells her it failed.

## What `/react` exports, and what it deliberately does not

31 names, down from 82 on 2026-08-26. Two groups came out and are not coming back:

**LiveKit symbols.** `Room`, `RoomEvent`, `Track`, `useRoomContext` and 20 others were
re-exported from here. `livekit-client` and `@livekit/components-react` are peer dependencies, so
import them from LiveKit directly and you get the version you installed — re-exporting put their
types in this package's public surface, which meant a LiveKit major could break ours without a
line of our code changing.

**State-machine internals.** `acquireMicLease`, `stepQualityGovernor`, `retryStep`,
`resolveWarnBeforeMs` and 27 more were the individual steps the hooks drive. None was callable in
a useful order from outside, and every one was a name we would have had to keep working forever.

What stayed: the components and hooks, the `DEFAULT_*` constants (so you can read the timings
rather than guess them), the two capacity mappers `capacityErrorFromBusy` / `capacityStateFromGrant`
for building your own queue UI, and the zod schemas `sessionBehaviorSchema` / `sessionClipSchema`.


---

## Docs and support

- Full documentation: <https://realtimeavatar.ai/docs>
- Issues and feature requests: this repo
- The API is versioned at `/api/v1`; breaking changes get a new version, not a silent edit.

MIT licensed.
