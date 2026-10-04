# Changelog

## 0.25.0

- `createProxyClient` still sends a mint once and never retries it. The one retry owner is
  the server client inside your route, which retries a transient platform failure under one
  idempotency key; a browser retry on top would multiply a click into up to nine mints. The
  429 queue path is unchanged.
- The `realtime-avatar/*` route adapters relay every platform failure as JSON with its
  status, `code` and `requestId` (also in `X-Request-ID`) and `retryable: false`, instead of
  throwing it into a body-less framework 500. A platform `401` (the route's key) answers
  `500`; a `402` now carries the request ID too.
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
