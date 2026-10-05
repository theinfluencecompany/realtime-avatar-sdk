# Changelog

## Unreleased

- The server client gains `leaveQueue(queueTicketId, { reason? })`, which releases a QUEUED
  call's place in line. The route adapters' `POST …/end` used to pass a queue ticket to
  `endCall`, which sent it as `session_id`; the platform acknowledged that as a no-op, so a
  user who hung up or closed the tab while waiting held their place until its TTL. A
  `{ queue_ticket_id }` body now reaches the platform as `queue_ticket_id`.
- The route adapters validate the browser's body once, against one route contract shared with
  `createProxyClient`. A body that is not a JSON object (`null`, `42`), names neither or both of
  `session_id` and `queue_ticket_id`, or carries a wrong-typed id or an unknown `reason`, is
  answered `422` instead of throwing a `TypeError` into a body-less 500. `/connect` now answers
  `422` to a `mode` other than `"avatar"` or `"voice"`, which it used to coerce to `"avatar"`.
- `createProxyClient` takes `credentials` (default `"same-origin"`), applied to every request
  including the page-hide release, for a route on another origin that authorizes on a cookie.
  The page-hide release is now a `keepalive` fetch under that mode (through your `fetch`, so its
  headers apply too) instead of `sendBeacon`. A beacon is always `credentials: "include"` and
  cannot carry a header: measured in Chromium 148, its JSON preflight to a cross-origin route
  whose CORS does not allow credentials failed and the release never arrived, while `connect`
  had succeeded. The beacon remains the fallback only where no fetch exists and its `include`
  matches the mode (a same-origin route, or `credentials: "include"`).
- Hanging up is terminal. `AvatarCallHandle.end()`, `useRealtimeSession().end()` and the new
  `useSessionLifecycle().end()` stop the queue retry and the reconnect ladder, release the held
  session or queue ticket (`manual`), leave the room, and park on `ended` from ANY phase. Before,
  `end()` only published a graceful-close frame and reset in-memory state: while queued the
  retry kept minting, so a call the user hung up on later started and billed; while live the
  status fell back to "connecting" and the connect watchdog released the session and minted a
  fresh one. `onEnded` fires once with `user_ended`. Only `reconnect()` (or deactivating the hook)
  starts again; `reset()` no longer can. `SessionEndReason` gains `"user"`.
- A mint that lands after the hook stopped wanting it now also gives back a queue ticket, not
  only a session.
- `AvatarVideoSurface` (and so `AvatarCall`) styles its box, media layers and live badge
  inline instead of with Tailwind classes. Tailwind does not scan `node_modules`, so an app had
  to add an `@source` for this package or the layout was purged: the face crop, the stacking of
  poster, idle clip and live video, and the badge. That configuration is no longer needed, and
  an app without Tailwind now gets the intended layout. Because inline styles win over classes,
  a `className` that used to resize the surface's box must move to `style`. The box now carries
  `data-testid="avatar-video-surface"` unless you pass your own.
- `AvatarCall`'s overlay children (and `AvatarVideoSurface`'s) now render in a layer above the
  live video and the badge, as documented. They were appended bare under the `z-index: 20`
  live layer, so once a call went live the video took their clicks: measured in Chromium, the
  centre of an `absolute bottom-4 left-4` End button hit the live layer. The layer fills the
  box, so an absolutely positioned child places itself exactly as before.
- `AvatarCallHandle` reports the microphone and audio playback, which a "live" call used to hide:
  - `microphone`: `off` | `pending` | `on` | `muted` | `blocked` | `unavailable`, the last two with
    `reason`, `message` and `hint`. A microphone LiveKit could not start (permission denied, no
    device, `NotReadableError`) reached only the room's `onError`, which the lifecycle ignores,
    so the call read live while she could never hear the user. Derived from LiveKit's
    `lastMicrophoneError`, `MediaDevicesError`, the local publication and its track's events; a
    device lost mid-call is `unavailable` with reason `device-lost`, not a mute. New
    `onMicrophoneProblem` prop, and `setMicrophoneEnabled(enabled)` / `retryMicrophone()` actions.
  - `audio`: `unknown` | `allowed` | `blocked`, from LiveKit's `canPlaybackAudio`, and a
    `startAudio()` action to call from a gesture. When the browser blocked autoplay her voice was
    silent with no signal anywhere. `AvatarCall` now renders a "Tap to turn on sound" button while
    blocked (`audioUnlockPrompt={false}` to opt out), and tries `room.startAudio()` once as the
    room mounts, while the click that started the call may still count.
  - `useRealtimeSession()` gains the same as `microphone`, `audioPlayback`, `startAudio` and
    `setMicrophoneEnabled`; `SessionLifecycleRoomBridge` gains a `microphone` prop. The classifier
    is shared with `enableMicrophone` and exported as `describeMicrophoneFailure`.

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
