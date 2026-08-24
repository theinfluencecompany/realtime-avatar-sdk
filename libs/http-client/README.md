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
[`libs/client/src/types.ts`](./libs/client/src/types.ts) — one file, no import chasing.

```ts
// calls
rta.startCall({ avatarId, mode?, instructions?, context?, maxSeconds?, video?, transcript?, metadata? })
rta.endCall(sessionId, { reason? })    // free an abandoned call's slot now; idempotent, never throws

// avatars
rta.createAvatarFromVideo({ displayName, videoUrl, voice? })
rta.listAvatars()
rta.getAvatar(avatarId)
rta.syncClips(avatarId, clipUrls)      // after ANY clip change

// assets
rta.createRemoteAsset({ kind, remoteUrl })
rta.uploadAsset(file, { kind })

// billing
rta.creditBalance()

// webhooks
verifyTranscript(rawBytes, headers, secret)
```

---

## Docs and support

- Full documentation: <https://realtimeavatar.ai/docs>
- Issues and feature requests: this repo
- The API is versioned at `/api/v1`; breaking changes get a new version, not a silent edit.

MIT licensed.
