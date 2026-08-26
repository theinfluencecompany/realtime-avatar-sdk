import { readFile, writeFile } from "node:fs/promises";

const USE_CLIENT = '"use client";';

/**
 * Next.js App Router treats an un-bannered module as a Server Component and fails on the
 * first hook, so the banner has to be in the BUILT file rather than the source. tsup has no
 * per-entry banner option that survives dts, hence the post-step.
 */
export async function prependUseClient(file: string): Promise<void> {
  const source = await readFile(file, "utf8");
  if (source.startsWith(USE_CLIENT)) return;
  await writeFile(file, `${USE_CLIENT}\n${source}`);
}
