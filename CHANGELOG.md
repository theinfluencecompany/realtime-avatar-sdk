# Changelog

## 0.17.1

- Fix a React Native call crash when connection history is enabled: register the
  browser-only `pagehide` flush listener only when both DOM event methods exist.
  Native history uploads and unmount cleanup remain active.
