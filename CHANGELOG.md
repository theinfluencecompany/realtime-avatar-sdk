# Changelog

## Unreleased

### Fixed

- **React Native, iOS: a call after a server-ended call no longer hears silence.** iOS 26 keeps one
  input-mute flag per app process. When the server closed a room, livekit-client disabled the
  microphone track while the peer connection was still live, libwebrtc muted the app through
  Voice Processing, and no later engine wrote it back, so every later call published an unmuted
  track of zeros until the app was relaunched or a user hang-up happened. An app's own mute on a
  live room took the same path. `RealtimeAvatarLiveKitRoom` now clears it each time its own
  microphone goes live (published unmuted, or unmuted later): it waits up to 5 seconds for input
  to start, then mutes and unmutes the audio engine once, so the engine writes "unmuted" itself.
  It writes nothing if the microphone is unpublished or muted first, if the room unmounts, if the
  engine's mute mode is not Voice Processing, or on Android. The unmute is attempted even if the
  mute fails, and nothing throws.

### Added

- **`clearStaleInputMute(stillWanted)` and `useClearStaleInputMute(room)`** on
  `realtime-avatar/react-native`, for apps that compose their own room. The web entry does not
  import `@livekit/react-native-webrtc`.

## 0.31.0

A minor release: pre-rendered video. An avatar can perform a script into an MP4 with no live call.

### Added

- **`createRender({ avatarId, voiceId? | voice?, lipGain?, shots })`** renders the avatar performing a
  script of shots into an MP4 offline. Everything in one shot happens at the same time; shots
  play one after another. A shot is `{ clipId?, say?, pauseAfterMs? }`: what she does (a ready
  clip from the avatar's library, or `"primary"` for her own video), what she says, and how long
  she stays silent afterwards. It returns the `queued` render (202). A retry carries the same
  `Idempotency-Key`, so a lost response never starts or bills a second render. The voice is one of:
  - `voiceId`: a voice from your workspace's voice library.
  - `voice`: an inline Fish voice, the same object a live call takes (`{ provider: "fish",
    voice_id, model?, speed?, emotion?, language? }`).
  - Neither: the avatar's own voice.

  Sending both does not compile (the platform refuses it with `422`). Only a Fish voice renders:
  any other is `422 voice_unavailable`, including an avatar's own voice that is not Fish when
  neither was sent, so a render is never quietly spoken in another voice.
- **`Render.timeline`**: once a render is `ready`, one entry per shot with `startMs`, `endMs`,
  the `clipId` it played, `playback` (`once` | `loop`), `speechStartMs`, `speechEndMs`,
  `clipEndMs` and `afterClipId`, all in video time. `Render.voiceId` is the library voice used
  (the `voiceId` sent, else the avatar's own), or `null` for an inline `voice`.
- **`waitForRender(renderId, { timeoutMs?, pollMs? })`** polls until the render is `ready` or
  `failed` and returns it. A failure is returned with its typed `error.code`, not thrown; only
  a timeout throws (default 30 minutes, the platform's own budget), and its message says it is a
  timeout, not a failure.
- **`getRender`, `listRenders({ limit?, cursor? })`, `iterateRenders`** and
  **`getRenderAccess(renderId)`**, which returns `{ id, url, expiresAt }`: a signed download URL
  that lasts an hour.
- Types `Render`, `RenderStatus`, `RenderFailureCode`, `RenderPlayback`, `ShotTiming`,
  `CreateRenderInput`, `RenderShot`, `ListRendersQuery`, `ListRendersResponse` and
  `RenderAccessResponse`, and the runtime schemas
  `renderSchema`, `listRendersResponseSchema` and `renderAccessResponseSchema`. The resource
  types and schemas are the platform's published `/render.contract.ts` (`x-render-contract`),
  vendored byte for byte and SHA-256 checked like the recording contract. The request types are
  the generated `CreateRenderRequest` and its `shots` entry; `CreateRenderInput` restates the two
  rules the generator drops: `voice` and `voiceId` are either/or, and `voice.model` is optional.
- The key scopes `renders:read` and `renders:write`. Both are off on a new key.

### Changed

- Every render response is validated against its contract. A malformed one, including malformed
  JSON, throws `RealtimeAvatarError` with one fixed message and no cause, the way `listSessions`
  already did; the two now share that code path.
- The vendored contract is re-synced from the platform with the renders routes.
- `concurrency_limit_reached` (429) also comes from `createRender` when a workspace already has 4
  renders queued or rendering; `RealtimeAvatarHttpError`'s table says so, and it names
  `400 render_too_long` (the shots would make a video over 180 seconds; nothing held) and
  `503 render_start_failed`.

### Release order

Publish only after the platform serves the renders routes, inline `voice` included. Until it
does, `npm run spec:check` reports the drift, and every call answers 404; a platform that serves
the routes without inline `voice` refuses a request that sends one with `422`. A platform that serves the routes but has not
been configured answers `503 render_export_unavailable` to `createRender` with `retryable: false`
and nothing charged. `503 render_start_failed` with `retryable: true` means the render was created
but could not be started: the SDK retries it, and the attempt stays in `listRenders` as a `failed`
render, not charged.

## 0.30.0

### Added

- **`fishTtsModelSchema` and `DEFAULT_FISH_TTS_MODEL` are public, so a stored Fish model id can
  be validated without a cast or a copied list.** They are exported by `realtime-avatar` (and
  `/server`), `realtime-avatar/react` and `realtime-avatar/react-native`, and are the same
  values 0.29.0 generates from the platform's contract. `fishTtsModelSchema.safeParse(id)`
  returns the public `FishTtsModel` on success, which a `VoiceSpecInput` accepts as its Fish
  `model`. `FishTtsModel` is now also exported by `realtime-avatar`; every entry names one type,
  declared in the generated file.

## 0.29.0

A minor release: Fish voices follow the platform's model list and default.

### Changed

- **A Fish voice with no `model` now asks for `s2.1-pro`, not `speech-1.6`.** Fish retired
  `speech-1.6` and `speech-1.5` and serves them, and `s1-mini`, as `s2.1-pro`; the platform made
  `s2.1-pro` its default. The SDK's default is generated from the published contract
  (`DEFAULT_FISH_TTS_MODEL`), so it moves when the platform's does. The retired ids are still
  accepted and the platform serves them as `s2.1-pro`.

### Fixed

- **Fish voices accept every model the platform accepts, including `s2.1-pro` and `drama-3`.**
  `voice: { provider: "fish", model }` was validated against a hand-kept list that had fallen
  behind the platform: `drama-3` and `s2.1-pro` were refused before any request was sent. The
  list is now generated from the published contract (`fishTtsModelSchema` in
  `libs/http-client/src/generated/fish-tts-model.ts`), and the typecheck fails if it and the
  contract ever disagree.
- The vendored contract also carries the platform's optional `lip_gain` session field; the
  SDK's session options do not expose it yet.

## 0.28.0

A minor release: a call can speak in a voice your server provides.

### Added

- **`CallPolicy.voiceWebhook`: speak the call in your own voice.**
  `startCall({ …, voiceWebhook: { url, secret, voiceId?, language?, sampleRate?, timeoutMs? } })`
  sends `voice_webhook`. Each sentence she is about to say is POSTed to `url`, signed with
  `secret`, and the audio you stream back is what she says, lip-synced, in both modes.
  - The option, its validation and its snake_case mapping are generated from the platform's
    `voice_webhook` contract, and an invalid value, including a URL that is not https, is refused
    before any request is sent.
  - Reply with streamed `audio/pcm` (alias `audio/raw`): raw signed 16-bit little-endian mono.
    No other raw type is accepted. `timeoutMs` bounds the first audio byte of each attempt and
    every later gap between chunks. A 2xx with no body, including a `204`, is
    `voice_webhook_empty_audio`.
  - A `401` or `403` ends the call. A timeout, an unreachable endpoint, or a `408`, `429` or
    5xx is retried once, only before any audio has arrived, as a new POST with a new
    `request_id`. Any other failure, or a failed retry, drops the rest of that reply, and the
    next reply tries again. Repeated failures end the call with a fatal error carrying the last
    failure's code.
  - It replaces the built-in voice; the platform answers `422` to a mint that also sets `voice`.
  - `voice_webhook` is emitted only by the key-holding entries. The browser and native entries,
    and their declarations, do not name it.
  - See AGENTS.md rule 15 and "Custom voice (webhook)" in the README.
- **`verifyVoiceWebhook(rawBody, headers, secret)`** verifies a `voice.synthesize` request with
  the transcript webhook's signature scheme and returns it as the generated, typed
  `VoiceWebhookRequest`. A field added by a newer worker is dropped rather than refused.
- **`RealtimeAvatarWebhookError`**, with `code`: `missing_signature`, `bad_signature`,
  `stale_timestamp` or `invalid_body`.
- **`onVoiceError` and `voiceError`** on `useRealtimeSession` and on `AvatarCall` /
  `useAvatarCall` (web), and on `useRealtimeSession` in `realtime-avatar/react-native`. They
  report the worker's new `voice_error` lifecycle frame as
  `{ code, message, status?, fatal, requestId? }`. A `code` newer than this SDK still surfaces as
  a string. `fatal` means the call is ending, and `onEnded` follows with `failed`. `voiceError`
  belongs to one call: the next one starts at null, whether it starts by reactivating, a new
  avatar or mode, a redial or `reset()`.
- Types: `VoiceWebhook`, `VoiceWebhookRequest`, `VoiceWebhookErrorCode`,
  `WebhookVerificationErrorCode`, `VoiceError` and `VoiceErrorCode`.
- The Next.js and FastAPI quickstarts include an endpoint that verifies the request and streams
  OpenAI's 24 kHz PCM back as `audio/pcm`.

### Changed

- `verifyTranscript` now throws `RealtimeAvatarWebhookError` with the same messages as before. It
  is still an `Error`, so existing `catch` blocks behave the same.
- The vendored contract is re-synced. Besides the voice webhook, it brings the already deployed
  `speech:write` key scope and the `avatar_not_callable` error message.

### Release order

Publish only after the platform accepts `voice_webhook`. The mint request is strict, so an older
platform refuses it with `422`.

## 0.27.4

- Add the server-owned `safe-content-v1` call policy from the platform contract. It selects no-sexual-content enforcement for voice and video while preserving the existing minor protections. Browser policy overrides remain stripped. Deploy worker enforcement and platform support before selecting this policy.

## 0.27.3

- Support separate recording tracks and preserve native replay timing.

## 0.27.0

A minor release: a call can take its replies from an endpoint your server hosts, and the live
badge stops printing a debug readout.

### Added

- **`CallPolicy.llm`: answer a call's turns from your own endpoint.**
  `startCall({ …, llm: { backend: "external", baseUrl, token, model? } })` sends
  `llm: { backend: "external", model? }` and the server-only `external_llm: { base_url, token }`.
  The platform keeps listening, turn-taking, interruption, voice and video; each reply streams
  from `POST {baseUrl}/chat/completions` with `Authorization: Bearer <token>`.
  - Enabled per workspace. Otherwise it answers `403 external_llm_not_enabled`, or
    `403 external_llm_host_not_allowed` for a host the workspace has not allowlisted.
  - A failure before a reply's first token speaks that reply from the platform's model.
  - `ExternalLlm` is exported. Its `backend` and `model` are derived from the published contract.
  - `external_llm` is emitted only by the key-holding entries; the browser and native entries do
    not name it.
  - See AGENTS.md rule 14.
- **`AvatarCall` accepts `showLiveBadge`.** It is forwarded to the surface, so an app that shows
  its own call status can turn the built-in badge off. The default is unchanged (on).
- **`AvatarVideoSurface` (web and native) accepts `debug`.** It defaults to false. Only under
  `debug` does the live badge show the layer's resolution.

### Changed

- **The live badge reads "live".** 0.26.0 printed the live layer's resolution on every call
  ("live · 576×1010"), a diagnostic that reached production UIs. Pass `debug` to the surface to
  see it again.

## 0.26.0

A minor release with breaking changes: hanging up is terminal, the call reports its microphone
and audio playback, the video surface needs no Tailwind configuration, and the proxy releases a
queued call correctly.

### Breaking changes

1. **`/connect` refuses an unknown `mode`.** The route adapters answer `422` to a `mode` other
   than `"avatar"` or `"voice"`; 0.25 silently coerced it to `"avatar"` (the more expensive call).
2. **`AvatarVideoSurface` and `AvatarCall` size and stack themselves with inline styles.** A
   `className` can no longer resize the surface's box (inline wins over classes); use `style`,
   which `AvatarCall` now accepts. The box is `isolation: isolate`, so z-indexes inside the call
   no longer compete with the page's. The box gets `data-testid="avatar-video-surface"` by default.
3. **`AvatarCall` renders a default "Tap to turn on sound" prompt** while the browser blocks her
   audio, inside an always-mounted live region in the overlay layer. Opt out with
   `audioUnlockPrompt={false}`, or pass a function to render your own.
4. **`AvatarCall` children render inside an overlay layer** (absolute, filling the box, above the
   video and badge). Absolutely positioned children place themselves exactly as before; a child
   that relied on painting UNDER the live video no longer can.
5. **`SessionEndReason` gains `"user"`.** An exhaustive `switch` over it needs a new arm.
6. **`AvatarCallHandle`, `RealtimeSessionApi` and `SessionLifecycleApi` gain required members**
   (`microphone`, `audio`/`audioPlayback`, `startAudio`, `setMicrophoneEnabled`,
   `retryMicrophone`, `microphoneMuted`, `end`, and the bridge's media sinks). Code that builds
   these objects by hand, typically a test fake, must add them.
7. **`end()` is terminal; `reset()` no longer restarts after it,** and changing `avatarId`, `mode`
   or `listen` on an ended `AvatarCall` does not redial. Remount (a `key`), or call `reconnect()`
   on the lower-level hooks.
8. **`useCharacterTools` re-registers when the manifest changes**, not when the `tools` object's
   identity does, and calls each tool's latest `execute`. `attachAvatarTools` failures are
   `ToolRegistrationError` (still an `Error`); a wrapped RPC failure's message is prefixed
   `tool registration failed:`.

### Migrating from 0.25

- Sending a `mode` other than `avatar`/`voice` to `/connect`: send one of the two.
- Resizing `AvatarCall`/`AvatarVideoSurface` with `className` (`h-[480px]`, `aspect-…`): move it
  to `style={{ height: 480 }}`, or size the container the surface fills. Remove any Tailwind
  `@source` you added for `realtime-avatar/dist/react.js`; it is no longer needed.
- Rendering your own "enable sound" UI: pass `audioUnlockPrompt={false}`, or hand your UI to
  `audioUnlockPrompt={(call) => …}` and call `call.startAudio()` from its click handler.
- Switching on `SessionEndReason`: add `case "user"` (the app hung up; `onEnded` reports it as
  `user_ended`).
- Faking `AvatarCallHandle` / `RealtimeSessionApi` in tests: add the new members.
- Redialling by changing props or calling `reset()` after `end()`: remount with a new `key`, or
  call `reconnect()`.
- Passing an inline `tools` object to `useCharacterTools`: nothing to do; it used to loop.

### Fixes and additions

- **Hanging up is terminal.** `AvatarCallHandle.end()`, `useRealtimeSession().end()` and the new
  `useSessionLifecycle().end()` stop the queue retry and the reconnect ladder, release the held
  session or queue ticket (`manual`), leave the room (stopping the microphone), and park on
  `ended` from ANY phase; `onEnded` fires once with `user_ended`. In 0.25, `end()` only
  published a graceful-close frame and reset in-memory state: while queued the retry kept
  minting, so a call the user hung up on later started and billed; while live the status fell
  back to "connecting" and the connect watchdog minted a fresh session. Ending an ended call is
  a no-op. `reconnect()` after an end is one redial (a double tap mints once), and deactivating
  the hook starts a new call with a clean end reason. A mint that lands after the hook stopped
  wanting it now also gives back a queue ticket, not only a session.
- **The proxy releases a queued call.** The server client gains `leaveQueue(queueTicketId,
  { reason? })`. The route adapters' `POST …/end` used to pass a queue ticket to `endCall`,
  which sent it as `session_id`; the platform acknowledged that as a no-op and the place stayed
  held until its TTL. The route now validates the browser's body once, against one contract
  shared with `createProxyClient`: a body that is not a JSON object (`null`, `42`), names neither
  id, or carries a wrong-typed id is a `422` instead of a TypeError thrown into a body-less 500.
  A body naming both ids releases both; an unknown `reason` is released as `manual`, as before.
- **`createProxyClient` takes `credentials`,** applied to every request including the page-hide
  release, for a route on another origin that authorizes on a cookie. Unset, the client sets no
  `credentials`, exactly as before, so a `fetch` wrapper's own choice still wins. The page-hide
  release stays a `sendBeacon` where a beacon's fixed `include` matches (a same-origin route, or
  `credentials: "include"`), and is a `keepalive` fetch through your `fetch` for a cross-origin
  route under any other mode: measured in Chromium 148, a beacon's credentialed JSON preflight to
  a route whose CORS does not allow credentials failed and the release never arrived.
- **The call reports its microphone.** `AvatarCallHandle.microphone` is `off` | `pending` | `on` |
  `muted` | `blocked` | `unavailable`, the last two with `reason`, `message` and `hint`, plus an
  `onMicrophoneProblem` prop and `setMicrophoneEnabled(enabled)` / `retryMicrophone()`. In 0.25 a
  microphone LiveKit could not start (permission denied, no device, `NotReadableError`) reached
  only the room's `onError`, which the lifecycle ignores, so the call read live while she could
  never hear the user. The state is derived from LiveKit's `lastMicrophoneError` (scoped to the
  current call), `MediaDevicesError`, and the local publication and its track's events. A device
  that ends mid-call is `pending` while LiveKit retries the default device, and
  `unavailable`/`device-lost` only if that fails. Before the room connects the actions only record
  the choice (nothing is captured), a mute made then is kept at connect, and after `end()` they do
  nothing. `useRealtimeSession()` carries the same (`microphone`, `setMicrophoneEnabled`,
  `microphoneMuted`), and `SessionLifecycleRoomBridge` gains a `microphone` prop. The classifier is
  the one behind `enableMicrophone`, now exported as `describeMicrophoneFailure`.
- **The call reports blocked audio.** `AvatarCallHandle.audio` is `unknown` | `allowed` |
  `blocked`, from LiveKit's `canPlaybackAudio`; `startAudio()` (call it from a gesture) never
  rejects and resolves whether playback is allowed. In 0.25 a browser that blocked autoplay left
  her silent with no signal anywhere. The SDK also tries `room.startAudio()` once as the room
  starts connecting, while the click that started the call may still count.
- **No Tailwind configuration.** The surface's box, layers and badge are styled inline. Tailwind
  does not scan `node_modules`, so 0.25 needed an `@source` for this package or the face crop,
  the layer stacking and the badge were purged.
- **The overlay is clickable while live.** `AvatarCall`'s children used to render under the live
  video layer, which took their clicks once the call went live (measured in Chromium).
- **Tools recover.** `useCharacterTools` retries a retryable registration failure twice (1s, then
  3s) while the room stays connected; its state is the exported `CharacterToolsState`, with
  `attempt`. In 0.25 one RPC timeout ended her tools for the call, and an inline `tools` object
  looped until React threw "Maximum update depth exceeded". `attachAvatarTools` no longer treats
  LiveKit's RPC code 1402 (REQUEST_PAYLOAD_TOO_LARGE) as "method not armed yet", which was polled
  for the whole deadline and reported as a missing `client_tools` grant.

## 0.25.0

- `createProxyClient` still sends a mint once and never retries it. The one retry owner is
  the server client inside your route, which retries a transient platform failure under one
  idempotency key; a browser retry on top would multiply a click into up to nine mints. The
  429 queue path is unchanged.
- The `realtime-avatar/*` route adapters relay every platform failure as JSON with its
  `status`, `code`, `requestId` (also in `X-Request-ID`) and the platform's own `retryable`
  verdict, instead of throwing it into a body-less framework 500. A platform `401` or `403`
  (the route's own key) answers `500` with `code: "internal_error"` and `retryable: false`,
  because a refused key does not fix itself. Because these are answered rather than thrown, a
  framework error handler no longer sees them; the route logs each once with `console.error`
  (operation, status, `code`, `requestId`, no secrets).
- The route adapters take `timeoutMs` (default 50s): the most the route spends on one
  platform request, every retry and backoff included. A retry starts only if it can take as long
  as the attempt before it and still finish inside the budget; a platform that has not answered
  by then is answered `504` `upstream_timeout`. The default sits inside `createProxyClient`'s 60s
  wait, so a route can no longer still be retrying, and minting, after the page stopped listening.
  The server client gains the option underneath it as `totalTimeoutMs` (default unbounded).
- The Express adapter now forwards the handler's headers, so `X-Request-ID` and
  `cache-control: no-store` reach the browser as they do through the Fetch adapters.
- `RealtimeAvatarHttpError` gains `.retryable`: the platform's verdict, when its body gave one.
- The proxy client's deadline is now a classified `RealtimeAvatarApiError`
  (`code: "upstream_timeout"`, `status: 504`, `retryable: true`, `response: null`) instead of
  a bare `TimeoutError`, so `normalizeRealtimeAvatarError` reads it back as the same failure.
  Do not re-send a timed-out mint automatically: the route may still be minting. A caller's
  abort is still an `AbortError`.
- `RealtimeAvatarApiError` gains `.requestId` (the body's `requestId`, else `X-Request-ID`).
  `.response` is now `Response | null`.

## 0.24.1

- Fix a duplicate session start under React StrictMode (the default in a new Next.js or
  Vite app while developing): `useLiveKitAvatarGrant`, and so `useAvatarCall`,
  `<AvatarCall>` and `useRealtimeSession`, posted the mint straight from its effect, so
  StrictMode's mount, cleanup, mount sent two mints for one call and used two of the plan's
  concurrent sessions. The mint now leaves from a microtask that the effect cleanup
  cancels. A production render (no double invoke) mints exactly as before.

## 0.24.0

- Require LiveKit React Native 3 for the native binding. Verify the exact
  RN 3.0.0 / WebRTC 144.2.0 / client 2.22.3 group while retaining components-react
  2.9.21 and components-core 0.12.13. Native consumers need rebuilt binaries;
  do not deliver this group to RN2 binaries through an OTA update.
- Add packaged-native room, shared-context, audio lifecycle/cleanup and camera
  regression coverage. Native calls and network/media operations are mocked;
  device validation remains required. See the package README's compatibility section.

## 0.17.1

- Fix a React Native call crash when connection history is enabled: register the
  browser-only `pagehide` flush listener only when both DOM event methods exist.
  Native history uploads and unmount cleanup remain active.
