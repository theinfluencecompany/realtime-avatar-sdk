import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const USE_CLIENT = '"use client";';

// Re-assert the React Server Components client boundary on the react entry.
// esbuild strips the inner module's "use client" directive during bundling, and
// tsup's `banner` applies to every chunk (it would wrongly mark the server-safe
// entries as client). So we prepend the directive to the react entry chunk only,
// post-build, for both the .js and its .d.ts (Next.js reads it off the .js).
async function prependUseClient(file: string) {
  const source = await readFile(file, "utf8");
  if (source.startsWith(USE_CLIENT)) return;
  await writeFile(file, `${USE_CLIENT}\n${source}`);
}

// Self-contained publish build.
//
// `realtime-avatar-contracts` is an internal, unpublished workspace package, so
// it is BUNDLED IN (noExternal) — the published tarball must carry no
// `workspace:*` dependency. Everything else (react / react-dom /
// @livekit/components-react / livekit-client / zod) is a real npm package that
// stays EXTERNAL and is declared as a (peer)dependency.
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
    server: "src/server.ts",
    "react/index": "src/react/index.ts",
    "react-native/index": "src/react-native/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  // Emit a .d.ts for every entry point. `dts.resolve` forces the declaration
  // rollup to follow + inline the internal contracts package types (it is
  // otherwise treated as external, leaving a dangling
  // `import ... from "realtime-avatar-contracts"` in the published .d.ts).
  dts: {
    resolve: [/^realtime-avatar-contracts$/],
  },
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
  // Bundle the internal contracts package; keep real npm packages external.
  noExternal: ["realtime-avatar-contracts"],
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
