import { resolve } from "node:path";
import { defineConfig } from "tsup";

// The key-holding half. Entries here are the ones a SERVER file imports; nothing in this
// package should ever be reachable from a browser bundle, which is why the React bindings
// live under a different npm NAME rather than a subpath — an `exports` condition picks which
// file gets bundled, never whether the package does.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    server: "src/server.ts",
    nextjs: "src/nextjs.ts",
    hono: "src/hono.ts",
    express: "src/express.ts",
    "tanstack-start": "src/tanstack-start.ts",
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
  // libs/proxy imports the core by its published name, which is THIS package — without the
  // alias the bundle would import itself.
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      "realtime-avatar": resolve(import.meta.dirname ?? __dirname, "../http-client/src/index.ts"),
    };
  },
});
