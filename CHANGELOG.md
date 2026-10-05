# Changelog

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
