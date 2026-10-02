# Changelog

## Unreleased

- Fix a duplicate session start under React StrictMode (the default in a new Next.js or
  Vite app while developing): `useLiveKitAvatarGrant`, and so `useAvatarCall` and
  `<AvatarCall>`, posted the mint straight from its effect, so StrictMode's mount, cleanup,
  mount sent two mints for one call and used two of the plan's concurrent sessions. The
  mint is now deferred past that synchronous pair and cancelled by the effect cleanup.

## 0.24.0 (unreleased candidate)

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
