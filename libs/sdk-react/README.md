# realtime-avatar-react

A live character your users can talk to, rendered in React or React Native. She listens
while she speaks, so she can be interrupted mid-sentence and stops, the way a person stops.

```bash
npm install realtime-avatar-react
```

```tsx
import { AvatarCall } from "realtime-avatar-react";

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

The API key never reaches the browser — nothing in this package can send one, which is why
it is a separate npm name rather than a subpath. Your server mints the connection payload
with [`realtime-avatar`](../sdk-server), or mounts one of its route adapters in front — see
[`apps/demo/coding-companion`](../../apps/demo/coding-companion) for the whole path in one
file.

---

## Entry points

| Import | What it is |
| --- | --- |
| `realtime-avatar-react` | `AvatarCall`, `useAvatarCall`, `useRealtimeSession`, `useSessionLifecycle` |
| `realtime-avatar-react/react-native` | The same surface for Expo / React Native |
| `realtime-avatar-react/browser` | `enableMicrophone`, `attachRemoteAudio` — no React |
| `realtime-avatar-react/tools` | `attachAvatarTools` — the browser tool plane |

`useAvatarCall` is the hook underneath `AvatarCall`, for when you want the state machine
but not the markup. `useRealtimeSession` is a level below that: session lifecycle,
reconnection, the grace window before time runs out.

## Peer dependencies

React 18+, plus `@livekit/components-react` on web or `@livekit/react-native` on native.
Both are optional peers — install the one for your platform. `livekit-client` is a direct
dependency and comes with the package.

## The two subpaths that are not React

`enableMicrophone` returns the cause as a value instead of throwing, because "the mic won't
start" is one sentence covering six causes with different fixes — and one of them, a macOS
system denial, cannot be fixed from the address bar and needs the browser restarted.
`attachRemoteAudio` attaches into the DOM *before* `connect`, which is what stops a track
arriving mid-connect from being lost on a fast connection.

`attachAvatarTools` runs your functions in the page. Nothing is executed on the platform, and
a tool has **2.5 seconds** to answer before the call gives up on it and tells her it failed.

## Known rough edge

The default entry re-exports a great deal more than the facade needs — LiveKit symbols
(`Room`, `RoomEvent`, `Track`, `useRoomContext`) and internal machinery (`acquireMicLease`,
`stepQualityGovernor`, `retryStep`, `resolveWarnBeforeMs`). That is not a surface to depend
on and it will narrow. Prefer `AvatarCall` / `useAvatarCall` and the hooks named above.
