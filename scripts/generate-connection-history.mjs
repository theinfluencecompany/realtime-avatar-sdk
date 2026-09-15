#!/usr/bin/env node
/** Materialize LiveKit enum values from the vendored public contract. */
import { readFile, writeFile } from "node:fs/promises";

const spec = JSON.parse(await readFile(new URL("../spec/realtime-avatar.openapi.json", import.meta.url), "utf8"));
const observation = spec.components?.schemas?.ConnectionHistoryResponse?.properties?.observations?.items;
const enumValues = (name) => {
  const value = observation?.properties?.[name]?.enum ?? observation?.properties?.[name]?.anyOf?.find((item) => Array.isArray(item.enum))?.enum;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`connection-history: ${name} enum missing from OpenAPI`);
  return value;
};
const object = (values) => `{ ${values.map((value) => `${value[0].toUpperCase()}${value.slice(1)}: ${JSON.stringify(value)}`).join(", ")} } as const`;
const path = new URL("../libs/http-client/src/generated/connection-history.ts", import.meta.url);
const source = await readFile(path, "utf8");
const header = `const ConnectionQuality = ${object(enumValues("localQuality"))};\nconst ConnectionState = ${object(enumValues("connectionState"))};`;
const body = source
  .replace(/^import \{ ConnectionQuality, ConnectionState \} from "livekit-client";\n/, "")
  .replace(/^import \{ z \} from "zod";\n(?:\nconst ConnectionQuality = .*\nconst ConnectionState = .*)?/, `import { z } from "zod";\n\n${header}`);
if (!body.includes(header)) throw new Error("connection-history: enum materialization failed");
if (process.argv.includes("--check")) {
  if (body !== source) throw new Error("connection-history generated source is stale; run npm run spec:types");
} else {
  await writeFile(path, body);
  console.log(`Connection history enums materialized from OpenAPI: ${path.pathname}`);
}
