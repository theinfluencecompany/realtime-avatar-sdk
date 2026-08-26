/**
 * What a browser bundler gets when it resolves a server-only subpath of this package.
 *
 * The `browser` and `react-native` export conditions point every key-holding entry here, so the
 * real module never enters a client module graph — the secret cannot be inlined because the file
 * that would read it is never bundled. Measured on a fixture: 0 occurrences of a secret marker in
 * an esbuild `--platform=browser` bundle, 1 in the `--platform=node` control.
 *
 * NOT `"browser": null`, which is the obvious-looking way to do this and is worse than nothing:
 * webpack treats it as a hard resolve error, but Vite 8 / rolldown IGNORES it and bundles the
 * server file WITH the secret. A module that throws is understood by every bundler.
 *
 * Throwing at module scope is deliberate. The failure has to happen when the bundle loads, not at
 * the first call — a lazily-thrown error is one a page can swallow, and this is the one error that
 * must not be swallowed.
 */
throw new Error(
  "realtime-avatar: a server-only entry was imported into a browser build. This module holds your " +
    "API key and must stay on the server. Import `realtime-avatar/react`, `/browser` or `/tools` in " +
    "client code, and keep `realtime-avatar`, `/server` and the route adapters in server files.",
);
