import { resolve } from "node:path";
import { defineConfig } from "tsup";
import { prependUseClient } from "../tsup-use-client.ts";

// ONE package, ten entries. The server half and the browser half used to be two npm names on the
// theory that an `exports` condition "picks which file gets bundled, never whether the package
// does" — that was measured on a fixture and is false. A `browser` condition pointing at a module
// that throws keeps the server file out of the client graph entirely (0 occurrences of a secret
// marker in an esbuild browser bundle, 1 in the node control), which is a build-time guarantee a
// second npm name never provided. See src/server-only-guard.ts and the exports map.
//
// treeshake is per-entry, so this costs nothing at install: `realtime-avatar/server` carries no
// React and no LiveKit even though they are in the same tarball.
export default defineConfig({
  entry: {
    // Key-holding. Guarded by browser/react-native conditions in package.json.
    index: "src/index.ts",
    server: "src/server.ts",
    nextjs: "src/nextjs.ts",
    hono: "src/hono.ts",
    express: "src/express.ts",
    "tanstack-start": "src/tanstack-start.ts",
    "server-only-guard": "src/server-only-guard.ts",
    // Keyless. Safe in any client bundle.
    react: "src/react.ts",
    "react-native": "src/react-native.ts",
    browser: "src/browser.ts",
    tools: "src/tools.ts",
  },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  dts: true,
  // tsup embeds `sourcesContent`, which would ship the original TypeScript of a scrubbed
  // carry inside the tarball. `npm run boundary` scans maps for exactly this.
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  // Real npm packages, and peers of the browser entries — never bundled in.
  external: [
    "react",
    "react-dom",
    "react-native",
    "@livekit/components-react",
    "@livekit/react-native",
    "livekit-client",
    "zod",
  ],
  // libs/proxy imports the core by its published name, which is THIS package — without the
  // alias the bundle would import itself.
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      "realtime-avatar": resolve(import.meta.dirname ?? __dirname, "../http-client/src/index.ts"),
    };
  },
  async onSuccess() {
    const dist = resolve(import.meta.dirname ?? __dirname, "dist");
    // Next.js App Router treats an un-bannered module as a Server Component and fails on the
    // first hook. The banner has to be in the BUILT file, not the source — and it goes on the
    // react entry only, which is why this is not tsup's `banner` (that applies to every chunk
    // and would wrongly mark the key-holding entries as client code).
    await prependUseClient(resolve(dist, "react.js"));
  },
});
