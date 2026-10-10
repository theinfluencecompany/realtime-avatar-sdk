# realtime-avatar

A live character your users can talk to — voice, or voice and video. She listens while she
speaks, so you can interrupt her mid-sentence and she stops, the way a person stops.

```bash
npm install --save-exact realtime-avatar@0.17.0
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

## React Native compatibility

The next release requires **LiveKit React Native 3** for `/react-native`; it does not claim
compatibility with LiveKit React Native 2. Install the tested group together:

```bash
npm install --save-exact @livekit/react-native@3.0.0 @livekit/react-native-webrtc@144.2.0 livekit-client@2.22.3 @livekit/components-react@2.9.21
```

`@livekit/components-react@2.9.21` retains `@livekit/components-core@0.12.13`; both satisfy the
native 3.0.0 peer contracts. Keep a single resolved components-react instance: the native room
provides its context and the SDK's shared hooks consume that same context. SDK checks use React
19.2.7 and React Native 0.81.5. The web binding also uses client 2.22.3; no components upgrade or
stream-handling patch is required for this tuple. Peer ranges allow compatible updates, but only
this exact tuple has been checked here. Client 2.22.3 introduces `machina@7.0.1`, whose Node
engine is `>=22.22`; use Node 22.22 or newer for client/native tooling (verified on 22.23.1).
This does not change the dependency-free server entry's Node floor. Node 20 tooling is not
verified for the new LiveKit group.

Call the SDK's re-exported `registerGlobals()` once at app startup, before creating rooms. RN3
configures iOS audio natively by default; do not reintroduce the deprecated JavaScript audio
management callback. `RealtimeAvatarLiveKitRoom` retains the existing `AudioSession.startAudioSession`
and `stopAudioSession` lifecycle while a grant and `connect` intent are present. Apps that own audio
configuration or coordinate overlapping calls must pass `manageAudioSession={false}` and own that
lifecycle; the hook is not a shared audio-session lease. Camera publication still requires both the
server grant's permission and the caller's opt-in. Room callbacks/options continue to use LiveKit's
public types and implementation; no separate connection state machine is introduced.

**This is a native build upgrade, not an OTA-only change.** Rebuild iOS and Android binaries with
RN3/WebRTC 144.2.0 before shipping JavaScript that requires them. Retain the previous SDK group for
installed binaries that still use RN2, and isolate their OTA runtime/channel appropriately.

The packaged-entry regression suite mounts the built `/react-native` adapter with the installed
RN3 room and audio implementations, real React/LiveKit hooks, and shared contexts. It checks room
props, microphone/camera policy, callbacks, start/stop intent, redial, and listener cleanup. It mocks
native module calls, network connection and media capture; it does **not** prove native binary
linking, `registerGlobals`, RTCView rendering, permissions, Bluetooth/speaker routing, interruption
recovery, asynchronous OS audio teardown, or overlapping-room ownership. Test these on iOS and
Android devices, including repeated call/redial and background/foreground transitions, before a
consumer release.

## Optional call recordings

Your server decides whether to record after your application obtains consent:

```ts
const call = await rta.startCall({ avatarId, recording: "audio_video" });
if (!isQueued(call) && call.recording) {
  await saveRecordingId(call.sessionId, call.recording.recordingId);
}

// Later, in your authenticated admin backend:
const recording = await rta.getRecording(recordingId);
if (recording.status === "ready") {
  const { url, expiresAt } = await rta.getRecordingAccess(recordingId);
  // Return this short-lived access to the authorized viewer.
}
```

Omitted or `"off"` disables recording. `"audio"` records published user and avatar audio;
`"video"` records published video without audio; `"audio_video"` keeps both on one media timeline.
Recording does not enable the microphone, camera, or screen sharing. Only tracks that participants
authorize and publish can be recorded. Camera controls remain a future SDK feature.

Recordings may finish processing after a call ends. Use `listRecordings({ sessionId })` to find
them, or refresh `getRecording(recordingId)` while processing. These methods and
`getRecordingAccess` require a server key with `recordings:read`.

Save `recordingId`, not a playback URL. Files are retained until `retainedUntil` (30 days by
default); each URL expires at `expiresAt` (up to one hour, capped by retention). Obtain fresh
access before replaying or seeking after expiry. An expired URL does not delete the file.
Treat the URL as private: anyone who has it can play that file until it expires.

## Optional connection history

Set `connectionHistory: true` in the server's `startCall` policy when the caller needs a
tenant-scoped LiveKit quality timeline. The SDK enables its collector only when RTA grants the
single-session capability. It receives the bridge's existing LiveKit connection snapshots,
deduplicates changes, batches at most 32 observations, and stops at 240; it does not poll WebRTC
statistics or own reconnect logic. Upload failures are bounded and never interrupt a call.

```ts
const call = await rta.startCall({ avatarId, connectionHistory: true });
// Relay call.raw unchanged. The browser SDK uploads capability-gated observations automatically.
const history = await rta.getConnectionHistory(call.sessionId);
```

History is an observation of native connection state and publisher quality. It is not a recording,
packet-loss report, or proof that a device rendered or played a track. The read requires
`usage:read`; store the session ID and fetch history from your authorized backend.

Transcript delivery remains the signed `transcript` webhook configured on `startCall`. Join the
transcript and recordings by `sessionId`; keep your own script revision with that call. Transcript
timestamps describe conversation turns and do not by themselves establish frame-accurate media
alignment for lip-sync analysis.

Client-safe Zod schemas and derived types are available from `realtime-avatar/recording`.
They are the same executable contract used by the service, verified against the published digest.

```mermaid
---
title: Recording ownership and private playback
---
flowchart LR
  App[Application server: consent and recording policy] --> RTA[RTA: call and recording lifecycle]
  RTA --> Media[Media provider: record published tracks]
  Media --> Storage[Private media storage]
  RTA --> Metadata[Recording ID and session ID]
  Admin[Authorized admin backend] --> RTA
  RTA --> Access[Temporary playback URL]
  Access --> Player[Video or audio player]
  Storage --> Player
```

New here? The [quickstart](https://realtimeavatar.ai/docs/quickstart) goes from an API key to a
working call, and a [sandbox key](https://realtimeavatar.ai/signup) is free with no card. Mount
the server half on your framework:
[Next.js](https://realtimeavatar.ai/docs/nextjs) ·
[Express](https://realtimeavatar.ai/docs/express) ·
[Hono, Workers, Bun, Deno](https://realtimeavatar.ai/docs/hono) ·
[TanStack Start](https://realtimeavatar.ai/docs/tanstack-start), and render it with
[React or React Native](https://realtimeavatar.ai/docs/react).

Using a coding agent? Point it at [`AGENTS.md`](../../AGENTS.md) and give it the
[MCP server](https://realtimeavatar.ai/docs/mcp) so it can read your real avatar ids instead of
inventing them.

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

## Input source on room messages

On React and React Native, `session.sendTurn(text)` automatically observes text.
For already recognized speech, bind
`session.createTranscriptSender({ inputSource: "client_stt" })` once per session.
The adapter defaults to `client_stt`; it captures its own default, and accepts a
per-send `{ inputSource: "text" }` override. `sendTurn` accepts the same optional
declaration. Only `text` and `client_stt` are valid client declarations. No speech
recognition engine is included. `instructions` still work on either sender.

`retryTurn()` preserves the resolved source and declaration scope after a timeout,
with a new `turn_id` and `retry_of_turn_id` pointing to the previous attempt.
Room consumers receive the attributes through the existing `lk.chat` text stream.
`useChat().chatMessages` exposes them as `message.attributes`; an imperative receiver
can read `reader.info.attributes` in `registerTextStreamHandler("lk.chat", handler)`.
The observation is `rta.observed_input_source`; the optional declaration and scope
are `rta.declared_input_source` and `rta.input_source_declaration_scope`. Missing
legacy attributes remain unknown. Use one handler owner per topic; a `useChat`
consumer should not register a duplicate raw handler on the same room.

This path needs no inference or platform changes. The consumer must already be
connected to the room, and text-stream messages are not durable webhook deliveries.
The legacy `lk-chat-topic` compatibility path omits attributes. Automatic RTA server
STT attribution and final transcript webhook provenance are separate work. Existing
webhook types and behavior are unchanged.

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
rta.startCall({ avatarId, mode?, instructions?, context?, maxSeconds?, video?, recording?, connectionHistory?, transcript?, metadata?, llm? })
rta.endCall(sessionId, { reason? })     // free an abandoned call's slot; idempotent, never throws
rta.leaveQueue(queueTicketId, { reason? }) // give up a queued call's place in line; idempotent, never throws

// optional recordings; server only, requires recordings:read
rta.listRecordings({ sessionId, limit?, cursor? })
rta.getRecording(recordingId)
rta.getRecordingAccess(recordingId)
rta.getConnectionHistory(sessionId)    // bounded LiveKit observations; requires usage:read

// avatars
rta.createAvatarFromImage({ displayName, imageUrl, motionPrompt?, voice? })  // the only lane
rta.createAvatarFromVideo({ displayName, videoUrl, voice? })                 // DEPRECATED — closed, 422
rta.listAvatars()
rta.getAvatar(avatarId)
rta.updateAvatar(avatarId, patch)       // re-point displayName / defaultVoiceId
rta.swapSource(avatarId, { sourceAssetId, anchorTimeMs? })  // re-shoot her: new loop, library re-renders
rta.retimeAnchor(avatarId, anchorTimeMs)                    // same loop, different rest frame
rta.deleteAvatar(avatarId)

// clip library — declared as JSON, never as URLs
rta.setClipLibrary(avatarId, { expectedRevision, clips, idle?, on?, actions? })  // full source record + behavior; revision required
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
| `realtime-avatar/browser` | `enableMicrophone`, `attachRemoteAudio`, `prepareAvatarRoom` — no React |
| `realtime-avatar/tools` | `attachAvatarTools` — the browser tool plane |
| `realtime-avatar/recording` | Client-safe Zod recording schemas and derived types |

Every adapter takes the same two hooks: `authorize` gates the request, `session` decides the
call. Policy — `instructions`, `maxSeconds`, `voice`, `video` — is decided in `session`, on
your server. A route that spreads the request body into `startCall` hands your caller your
system prompt and your bill.

### Styling

`AvatarCall` and `AvatarVideoSurface` lay themselves out with inline styles, so they need no
CSS build and no configuration: no stylesheet to import and no Tailwind `@source` for this
package. The surface fills its container; give that container a definite size (an aspect
ratio plus a height, say). `className` on the surface adds your own classes; to change a
property the surface sets itself, such as its 100% size, pass `style`.

`AvatarCall`'s `children` render in a layer that fills the call's box above the video and
the live badge, so an absolutely positioned control places itself against the box and stays
clickable while she is live.

### Microphone and sound

The handle reports the two local failures a "live" call can hide. `call.microphone` says
whether she can hear the user (`off`, `pending`, `on`, `muted`, `blocked`, `unavailable`; the
last two carry `reason`, `message` and `hint`), and `onMicrophoneProblem` fires once per new
problem. A device that stops mid-call reads `pending` while LiveKit retries the default device,
and `unavailable` (`device-lost`) only once that fails. `call.retryMicrophone()` asks again after
the user fixes it, and `call.setMicrophoneEnabled(enabled)` mutes and unmutes. While the call is
waiting or connecting those only record the choice (nothing is captured before the room
connects), a mute made then is kept when the call goes live, and after `end()` they do nothing.

`call.audio` says whether the user can hear her (`unknown`, `allowed`, `blocked`; `unknown` again
once the call ended). While it is `blocked`, `AvatarCall` shows a "Tap to turn on sound" button,
top-centre in a polite live region, that calls `call.startAudio()`. Pass `audioUnlockPrompt` a
function to render your own (your words, your placement), or `false` for nothing.
The small "live" badge over the video is on by default; pass `showLiveBadge={false}` when your own
UI already shows the call's status. `AvatarVideoSurface` takes the same prop, plus `debug` to show
the live layer's resolution on the badge while you develop.
`startAudio()` must run inside a click or tap handler; it never rejects and resolves whether
playback is allowed afterwards.

Every state is derived from LiveKit's public events, and LiveKit still owns the device: it
captures on connect and stops when the room leaves. A microphone error from an earlier call on
the same room is not reported for the next one. A publish that fails after the microphone was
captured reaches only the room's `onError` and stays `pending`: that callback also carries
unrelated failures, so it is not guessed into a microphone problem.

### Ending a call

`call.end()` (and `useRealtimeSession().end()`) is terminal from every phase, including
`waiting` in the queue and `connecting`. It stops the queue retry and the reconnect ladder,
releases the held session or the queue ticket, leaves the room (which stops the microphone),
moves `status` to `"ended"` and fires `onEnded({ reason: "user_ended" })` once. Ending a call
that is already over does nothing. `sayAndEnd(text)` is the graceful path when she should speak
a last line first.

**After `end()`, nothing starts a call except you, explicitly.** Changing `avatarId`, `mode` or
`listen` on an ended `AvatarCall` does not redial; remount it, for example with a `key`:

```tsx
<AvatarCall key={callId} client={client} avatarId={avatarId} />   // new callId → new call
```

On the lower-level hooks, `reconnect()` redials (a double tap mints once), and so does setting
`active` to false and back. `reset()` does not undo an end.

### Waiting for the character

Joining the room is not enough to start a conversation: the character's agent must also
arrive. The shared React and React Native lifecycle allows at most 30 seconds from the first
held grant to that readiness, including automatic retries and signaling reconnects. The
existing connect watchdog (12 seconds by default) also recovers a connected room whose agent
never arrives. A transport connection alone does not reset the retry count or buy more time.

When the budget or retry count runs out, the SDK releases the session, leaves the room and
ends with `phase.reason: "error"` / `onEnded({ reason: "failed" })`. The optional `phase.code`
distinguishes `agent_timeout` from `connection_timeout`; these are client observations, not
HTTP status codes. `agent_timeout` means at least one room connected but the call never became
ready; retries may also have transport delays. `connection_timeout` means no room connected.
While connecting, `phase.waitingFor` distinguishes `agent` from `transport`.
No automatic mint follows that failure; `reconnect()` starts a fresh budget. A call that
already reached live keeps LiveKit's normal recovery of its existing room.

On `useRealtimeSession` or `useSessionLifecycle`, `readyTimeoutSeconds` changes the total
budget (positive, default 30). `connectWatchdogSeconds` changes the per-attempt wait; disabling
that watchdog with zero still leaves the total budget in force. Neither setting fabricates
media readiness or changes the application's first-video-frame gate.

### Optional connection details

`AvatarCall` provides call status, actions and end reasons for your default UI. To show
connection diagnostics, opt in with `onConnectionDetailsChange`. It supplies data for
your own UI; enabling it adds no built-in network notice or controls.

```tsx
import { useState } from "react";
import { AvatarCall, type AvatarCallProps, type AvatarConnectionDetails } from "realtime-avatar/react";

function CallWithDetails(props: Pick<AvatarCallProps, "client" | "avatarId">) {
  const [details, setDetails] = useState<AvatarConnectionDetails | null>(null);

  return (
    <>
      <AvatarCall {...props} onConnectionDetailsChange={setDetails} />
      {details && <p>Connection: {details.connectionState}. Local quality: {details.localQuality}.</p>}
    </>
  );
}
```

Once bound to a call, the callback receives an initial snapshot, then changed facts only. It receives `null`
when its room or session binding is retired, before a replacement binding's snapshot.
Clearing the session grant keeps details reset until a new grant arrives.
Keep this state scoped to one call and clear it on `null`, as the example does. This is
a current snapshot, not a lossless event history. Replacing the handler does not restart
the call, and errors in your handler do not interrupt it. Omitting the callback adds no
reporting listeners; the callback adds no timers, stats polling or uploads.

Each field preserves LiveKit's native type and meaning:

| Field | Source |
| --- | --- |
| `connectionState` | The bound room's `state`. |
| `localQuality` | The local participant's `connectionQuality`. |
| `audio.publisherQuality` | The selected audio publisher's `connectionQuality`. |
| `video.publisherQuality` | The selected video publisher's `connectionQuality`. |
| `audio.streamState`, `video.streamState` | The corresponding remote track's `streamState`, or `null` before the track exists. |

Audio and video publishers are selected independently and can differ. Neither field
substitutes the control agent or an arbitrary remote participant. `audio` or `video` is
`null` when no corresponding track reference is selected; LiveKit's `Unknown` quality
means a publisher exists but its quality is unknown. An active or subscribed track does
not prove that video has rendered or audio is audible. Continue using call status for
the call lifecycle.

Native and custom integrations pass the same optional callback to their existing
`SessionLifecycleRoomBridge` inside `RealtimeAvatarLiveKitRoom`. Both
`realtime-avatar/react` and `realtime-avatar/react-native` export `AvatarConnectionDetails`.
For deeper receiver measurements, use LiveKit's public `RemoteVideoTrack.getReceiverStats()`
and `RemoteAudioTrack.getReceiverStats()` methods and their native return types.

Retain the app's session-to-room association (`room_name`, timestamps and participant
identity), adding the server-observed room SID when exact room-lifetime lookup needs it.
LiveKit owns participant connection history; a participant SID identifies one incarnation.
Use these references to look up details in LiveKit's own diagnostics. The existing quality governor
and opt-in adaptive playout are product policies over LiveKit facts; setting
`adaptiveQuality={false}` releases the manual quality ceiling while LiveKit's bandwidth
adaptation continues. Adaptive playout reads only public LiveKit track reports.

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
`prepareAvatarRoom(room)` — one call after `new Room()` — gives every track the room subscribes
the same 0.5s receiver cushion the React surface applies on its own: the avatar crosses the public
internet, a shallow buffer freezes on every lost packet, and a deeper one recovers it before
playout (measured at ~5% loss: ~11fps with multi-second freezes → a steady 25fps). It covers audio
and video alike so the pair stays lip-locked, and `attachRemoteAudio` calls it for you, so a page
that follows the pattern above never has to know the knob exists. `applyPlayoutDelay(track)` is the
per-track primitive underneath. Until these lived here the cushion was only reachable through
`/react`, which is why every plain-DOM page — this repo's demos included — froze that way; and in
React it was applied only by `AvatarVideoSurface`, so `RealtimeAvatarLiveKitRoom` now applies it
room-wide to whatever you render inside it (`playoutDelaySeconds={false}` opts out).

`attachAvatarTools` runs your functions in the page. Nothing is executed on the platform, and
a tool has **2.5 seconds** to answer before the call gives up on it and tells her it failed.

A failed registration throws `ToolRegistrationError`, whose `retryable` says whether trying again
can help: the agent not there or not armed by the deadline (a slow start, or a session minted
without `client_tools`; one attempt cannot tell which), or an RPC transport failure, is retryable;
an oversized manifest or a request LiveKit or the agent refused is not.

In React, `useCharacterTools(tools)` registers them while the room is connected and returns
their state: `idle`, `registering` (with `attempt`), `ready` (`registered`, `rejected`) or
`error`. A retryable failure is retried twice (after 1s, then 3s) while the room stays
connected; only then is it `error`. It re-registers when the manifest changes (names,
descriptions, parameters), not when the `tools` object does, so an inline object is fine and
each call reaches your latest `execute`. With `AvatarCall`, call it from a component you render
as a child, which runs inside the call's room, and show its state rather than ignore it:

```tsx
function Tools() {
  const tools = useCharacterTools(myTools);
  return tools.status === "error" ? <p role="status">Tools are off for this call: {tools.error}</p> : null;
}

<AvatarCall client={client} avatarId="ava_…">{() => <Tools />}</AvatarCall>
```

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
- [Quickstart](https://realtimeavatar.ai/docs/quickstart) — key to a live call
- [Authentication](https://realtimeavatar.ai/docs/authentication) — what belongs on your server, and why
- [Calls](https://realtimeavatar.ai/docs/sessions) — what your server decides and what the client reports
- [Creating an avatar](https://realtimeavatar.ai/docs/video) — one photo in, a moving character out
- [Tool calling](https://realtimeavatar.ai/docs/tool-calling) — your handlers, your server, no hosted executor
- [MCP server](https://realtimeavatar.ai/docs/mcp) — give a coding agent the account itself
- [API reference](https://realtimeavatar.ai/docs/api-reference) · [OpenAPI 3.1](https://realtimeavatar.ai/openapi.json)
- [Pricing](https://realtimeavatar.ai/pricing) — one meter, seconds on air
- Issues and feature requests: this repo
- The API is versioned at `/api/v1`; breaking changes get a new version, not a silent edit.

MIT licensed.


### Continuous participant recordings

Use `recording: "participants"` on your server to retain the two participants
separately. A camera-enabled call has four logical media tracks in two MP4 files:
user camera/microphone and character video/voice. Each file is continuous through
camera mute, unpublish and republish; the user's microphone continues while their
camera is off. `camera: true` is still a separate publication permission, and
recording alone never opens a camera. Voice-only participants get audio-only MP4s.

The returned `call.recordings` contains both pending artifacts, while legacy
modes retain `call.recording`. Once finalized, use `listRecordings({ sessionId })`
and `getRecordingAccess(recordingId)` to retrieve authorized, renewable URLs.
`recording.participant.role` identifies the user or character; media timestamps
align the files without fixing their visual layout. Keep failed/missing files
visible instead of treating the surviving participant as a complete recording.

```tsx
import { RecordingPlayer } from "realtime-avatar/react";

// assets comes from your authenticated application endpoint.
// Each item is { recording, url }; refresh expiring URLs through your server.
<RecordingPlayer assets={assets} />
```

The player provides one play/pause control and one seek bar for both files. It
plays each file's audio once, preserves start offsets, waits for buffering and
refuses to guess synchronization when media timestamps are missing. Original
files remain independently playable and editable. Participant departure ends
that file; a new call is a new session, not an automatic concatenation.
