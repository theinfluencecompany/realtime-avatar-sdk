import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const USE_CLIENT = '"use client";';

async function prependUseClient(file: string) {
  const source = await readFile(file, "utf8");
  if (source.startsWith(USE_CLIENT)) return;
  await writeFile(file, `${USE_CLIENT}\n${source}`);
}

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "react-native": "src/react-native.ts",
    browser: "src/browser.ts",
    tools: "src/tools.ts",
  },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  dts: true,
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
    // Next.js App Router treats an un-bannered module as a Server Component and fails on the
    // first hook. The banner has to be in the BUILT file, not the source.
    await prependUseClient(resolve(dist, "index.js"));
  },
});
