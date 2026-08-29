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
// TWO PASSES, and the split between them is the server/client boundary — the same line the
// `browser` export condition draws. It is not a style choice; each half wants the OPPOSITE
// bundler setting, and running them together forces one to lose.
//
//   SERVER half, splitting ON.  The six key-holding entries are the same core behind
//   different framework doors: measured, every pair shared 135-143 identical long lines, so
//   the core shipped SIX times. Splitting emits it once. Consumer cost is ZERO — a server
//   entry goes 31.3K -> 0.1K + a 31.3K shared chunk, the same bytes node reads — and the
//   tarball drops ~159K raw.
//
//   CLIENT half, splitting OFF.  Here a shared chunk is a REGRESSION, because `react` and
//   `react-native` are near-twins that deliberately do NOT ship each other's code: per-entry
//   treeshaking is what keeps the RN entry from carrying the web surface. Measured with
//   splitting on globally, a react-native consumer paid +15.9K raw / +4.1K gzip — a 19% bundle
//   tax on the platform least able to afford it, to save install bytes. Wrong trade; declined.
//
// The two passes also keep the security shape provable rather than argued: with separate
// builds no chunk can straddle the halves, so the key-holding core cannot be pulled into a
// client bundle by a bundler decision nobody reviewed. (Verified anyway — see the
// guarded-subpath tests, and the chunk-topology check that every server entry is free of
// react/livekit and every client entry free of the key markers.)
const shared = {
  format: ["esm"] as const,
  target: "es2022",
  outDir: "dist",
  dts: true,
  // tsup embeds `sourcesContent`, which would ship the original TypeScript of a scrubbed
  // carry inside the tarball. `npm run boundary` scans maps for exactly this.
  sourcemap: false,
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
  esbuildOptions(options: { alias?: Record<string, string> }) {
    options.alias = {
      ...(options.alias ?? {}),
      "realtime-avatar": resolve(import.meta.dirname ?? __dirname, "../http-client/src/index.ts"),
    };
  },
};

export default defineConfig([
  {
    ...shared,
    // Key-holding. Guarded by browser/react-native conditions in package.json.
    entry: {
      index: "src/index.ts",
      server: "src/server.ts",
      nextjs: "src/nextjs.ts",
      hono: "src/hono.ts",
      express: "src/express.ts",
      "tanstack-start": "src/tanstack-start.ts",
      "server-only-guard": "src/server-only-guard.ts",
    },
    // Only this pass clears dist — the client pass runs after and must not wipe it.
    clean: true,
    splitting: true,
  },
  {
    ...shared,
    // Keyless. Safe in any client bundle.
    entry: {
      react: "src/react.ts",
      "react-native": "src/react-native.ts",
      browser: "src/browser.ts",
      tools: "src/tools.ts",
    },
    clean: false,
    splitting: false,
    async onSuccess() {
      const dist = resolve(import.meta.dirname ?? __dirname, "dist");
      // Next.js App Router treats an un-bannered module as a Server Component and fails on the
      // first hook. The banner has to be in the BUILT file, not the source — and it goes on the
      // react entry only, which is why this is not tsup's `banner` (that applies to every chunk
      // and would wrongly mark the key-holding entries as client code).
      await prependUseClient(resolve(dist, "react.js"));
    },
  },
]);
