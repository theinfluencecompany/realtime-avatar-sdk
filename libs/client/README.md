# realtime-avatar-react

A live character your users can talk to, rendered in React or React Native. She listens
while she speaks, so she can be interrupted mid-sentence and stops, the way a person stops.

```bash
npm install realtime-avatar-react
```

```tsx
import { AvatarCall } from "realtime-avatar-react/react";

<AvatarCall
  client={client}
  avatarId="ava_…"
  idleVideoUrl={idleClip}
  onEnding={({ call }) => call.sayAndEnd("I have to go — talk soon.")}
  onEnded={({ reason }) => console.log("ended:", reason)}
/>;
```

`mode="voice"` is audio-only and cheaper; `avatar` is the full call and is the default.
`listen={false}` renders her without opening the microphone.

The API key never reaches the browser. Your server mints the connection payload with
[`realtime-avatar`](../http-client), or you put
[`realtime-avatar-proxy`](../proxy) in front of it — see
[`apps/demo/coding-companion`](../../apps/demo/coding-companion) for the whole path in one
file.

---

## Entry points

| Import | What it is |
| --- | --- |
| `realtime-avatar-react` | Client, errors, API-key parsing. No React. |
| `realtime-avatar-react/react` | `AvatarCall`, `useAvatarCall`, `useRealtimeSession`, `RealtimeAvatarProvider` |
| `realtime-avatar-react/react-native` | The same surface for Expo / React Native |
| `realtime-avatar-react/browser` | Microphone and playback helpers, no React |
| `realtime-avatar-react/server` | Server-side helpers for minting a call |

`useAvatarCall` is the hook underneath `AvatarCall`, for when you want the state machine
but not the markup. `useRealtimeSession` is a level below that: session lifecycle,
reconnection, the grace window before time runs out.

## Peer dependencies

React 18+, plus `@livekit/components-react` on web or `@livekit/react-native` on native.
Both are optional peers — install the one for your platform. `livekit-client` is a direct
dependency and comes with the package.

## Known rough edge

The `/react` entry currently re-exports a number of LiveKit symbols (`Room`, `RoomEvent`,
`Track`, `useRoomContext`, and others). That makes the transport visible in this package's
public types, which is more surface than the facade needs and is not something to depend
on: it may narrow in a future minor. Prefer `AvatarCall` / `useAvatarCall` and the hooks
named above.
