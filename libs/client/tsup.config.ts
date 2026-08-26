import { resolve } from "node:path";
import { defineConfig } from "tsup";
import { prependUseClient } from "../tsup-use-client.ts";

// Re-assert the React Server Components client boundary on the react entry.
// esbuild strips the inner module's "use client" directive during bundling, and
// tsup's `banner` applies to every chunk (it would wrongly mark the server-safe
// entries as client). So we prepend the directive to the react entry chunk only,
// post-build, for both the .js and its .d.ts (Next.js reads it off the .js).
// Self-contained publish build.
//
// The wire schemas used to live in a sibling workspace package that was bundled in here
// (noExternal) so the tarball carried no `workspace:*` dependency. They are now
// src/wire.ts inside this package, so there is nothing to bundle and nothing to resolve —
// an ordinary relative import. react / react-dom / @livekit/* / livekit-client / zod are
// real npm packages and stay EXTERNAL, declared as (peer)dependencies.
//
// Output paths intentionally mirror the previous `tsc` layout so the public
// `exports` map in package.json is unchanged:
//   src/index.ts             -> dist/index.{js,d.ts}
//   src/browser/index.ts     -> dist/browser/index.{js,d.ts}
//   src/server.ts            -> dist/server.{js,d.ts}
//   src/generated/openapi.ts -> dist/generated/openapi.{js,d.ts}
//   src/react/index.ts       -> dist/react/index.{js,d.ts}
//   src/react-native/index.ts -> dist/react-native/index.{js,d.ts}
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "browser/index": "src/browser/index.ts",
    "react/index": "src/react/index.ts",
    "react-native/index": "src/react-native/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  // Emit a .d.ts for every entry point. `resolve` is no longer needed: wire.ts is a file
  // in this package, so the declaration rollup follows it without being told to.
  dts: true,
  // NO sourcemaps. tsup emits them with `sourcesContent`, inlining the original TypeScript
  // into the tarball: 23 files, 334,826 bytes, repeated across five entry-point maps for a
  // 417 KB package against 5-15 KB for every other one here. Turning this off took it to
  // 129 KB.
  //
  // Not a secrecy fix — `libs/client/src` is published in the public repo, so the same
  // bytes are already readable there under MIT. Two reasons it is still off:
  //
  //   - Size. The maps were ~69% of the tarball, duplicating what the repo already serves.
  //   - What this repo publishes is reviewed; a sourcemap is not. A map is assembled from
  //     whatever happens to be on disk at build time, so it routes around that review
  //     entirely — and unlike a repo, a published tarball cannot be retracted.
  //
  // If stack traces are wanted later, emit maps with `sourcesContent` stripped: line
  // mapping is not the hazard. Do not just flip this back — `npm run boundary` now fails.
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    "react",
    "react-dom",
    "react-native",
    "@livekit/components-react",
    "@livekit/react-native",
    "livekit-client",
    "zod",
  ],
  async onSuccess() {
    const dist = resolve(import.meta.dirname ?? __dirname, "dist");
    await prependUseClient(resolve(dist, "react/index.js"));
    // Expo Router's experimental RSC mode applies the same client-boundary rule.
    await prependUseClient(resolve(dist, "react-native/index.js"));
  },
});
