import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep } from "node:path";

const specUrl = new URL("https://realtimeavatar.ai/openapi.json");
const specTarget = new URL("../spec/realtime-avatar.openapi.json", import.meta.url);
const vendorTarget = new URL("../libs/http-client/src/generated/character-motion.ts", import.meta.url);
const target = new URL("../libs/http-client/src/generated/clip-library-schema.ts", import.meta.url);
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === "--check";
const pull = args.length === 1 && args[0] === "--pull";
const sync = args.length === 2 && args[0] === "--sync" && isAbsolute(args[1]);
if (args.length && !check && !pull && !sync) {
  throw new Error("Usage: generate-clip-schema.mjs [--check | --pull | --sync <absolute platform root>]");
}

async function fetchBytes(url) {
  // Executable code must not follow a redirect to an untrusted origin.
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const specBytes = pull ? await fetchBytes(specUrl) : await readFile(sync
  ? resolve(args[1], "packages/realtime-avatar-contracts/openapi/realtime-avatar.openapi.json")
  : specTarget);
const spec = JSON.parse(specBytes.toString("utf8"));
const reference = spec["x-clip-contract"];
if (!reference || typeof reference.source !== "string" || !/^\/[\w./-]+\.ts$/.test(reference.source)
  || reference.source.startsWith("//") || reference.source.split("/").some(part => part === "." || part === "..")
  || typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
  throw new Error("Missing or invalid x-clip-contract source/sha256");
}
const sourceUrl = new URL(reference.source, specUrl);
if (sourceUrl.origin !== specUrl.origin) throw new Error("Clip contract must use the trusted spec origin");

let vendorBytes;
if (pull) {
  vendorBytes = await fetchBytes(sourceUrl);
} else if (sync) {
  const publicRoot = resolve(args[1], "apps/web/public");
  const artifact = resolve(publicRoot, `.${reference.source}`);
  if (relative(publicRoot, artifact).startsWith(`..${sep}`)) throw new Error("Clip artifact escapes public root");
  vendorBytes = await readFile(artifact);
  const ownerBytes = await readFile(resolve(args[1], "packages/realtime-avatar-contracts/src/character-motion.ts"));
  if (!vendorBytes.equals(ownerBytes)) throw new Error("Published clip artifact differs from its canonical owner");
} else {
  vendorBytes = await readFile(vendorTarget);
}
const hash = createHash("sha256").update(vendorBytes).digest("hex");
if (hash !== reference.sha256) throw new Error(`Clip contract SHA-256 mismatch: expected ${reference.sha256}, got ${hash}`);

const supported = new Set([
  "$schema", "type", "properties", "required", "additionalProperties",
  "anyOf", "enum", "format", "pattern", "minLength", "maxLength", "minimum", "maximum",
  "items", "minItems", "maxItems",
]);
const definitions = [];
const behavior = JSON.stringify(spec.components.schemas.ListAvatarClipsResponse.properties.behavior);
if (behavior !== JSON.stringify(spec.components.schemas.PutAvatarClipsResponse.properties.behavior)) {
  throw new Error("Clip response behavior schemas disagree");
}
const names = new Map([[behavior, "clipBehaviorSchema"]]);

function expression(schema) {
  const key = JSON.stringify(schema);
  if (names.has(key)) return names.get(key);
  for (const keyword of Object.keys(schema)) {
    if (!supported.has(keyword)) throw new Error(`Unsupported clip schema keyword: ${keyword}`);
  }
  // OpenAPI 3.1 spells a type as an ARRAY. A nullable field that 3.0 wrote as
  // `anyOf: [{type:"string"},{type:"null"}]` becomes `type: ["string","null"]`, and a plain one
  // may become `type: ["string"]`. Both spellings belong to the same migration, so both are
  // understood here: handling only the nullable one would leave the next field the platform
  // respells free to reopen exactly the outage this normalisation exists to close.
  //
  // Normalise into the 3.0 spelling and let the paths below emit it. A type array that is a
  // genuine union of two real types throws instead, because such a union belongs in `anyOf`
  // where a reader of the contract can see it.
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((candidate) => candidate !== "null");
    if (nonNull.length !== 1 || schema.type.length > 2) {
      throw new Error(`Unsupported clip schema type union: ${JSON.stringify(schema.type)}`);
    }
    // The string-enum branch below rejects a non-string `type`, which is its proxy for "every
    // member is a string". Normalising sets `type` to the non-null member and would walk a
    // nullable enum straight past that proxy, so reject the null member here, where it is still
    // visible, rather than emitting a `z.enum` that cannot typecheck.
    if (Array.isArray(schema.enum) && schema.enum.some((member) => member === null)) {
      throw new Error(`Unsupported clip schema nullable enum: ${JSON.stringify(schema.enum)}`);
    }
    // `type` first, matching how the 3.0 spelling writes it, so a respelled field that carries
    // siblings still memoises onto the identical hand-written twin instead of emitting a second
    // definition of the same schema under a different key.
    const { type: _spelledAsArray, ...rest } = schema;
    const spelled = { type: nonNull[0], ...rest };
    return expression(schema.type.length === 1 ? spelled : { anyOf: [spelled, { type: "null" }] });
  }
  let result;
  if (schema.anyOf) {
    result = `z.union([${schema.anyOf.map(expression).join(", ")}])`;
  } else if (schema.enum) {
    if (schema.type !== "string") throw new Error("Only string enums are supported");
    result = `z.enum(${JSON.stringify(schema.enum)})`;
  } else {
    switch (schema.type) {
      case "object": {
        if (!schema.properties || schema.additionalProperties !== false) throw new Error("Expected a closed clip response object");
        const required = new Set(schema.required ?? []);
        result = `z.strictObject({\n${Object.entries(schema.properties).map(([field, value]) =>
          `  ${JSON.stringify(field)}: ${expression(value)}${required.has(field) ? "" : ".optional()"},`
        ).join("\n")}\n})`;
        break;
      }
      case "array":
        result = `z.array(${expression(schema.items)})`;
        if (schema.minItems !== undefined) result += `.min(${schema.minItems})`;
        if (schema.maxItems !== undefined) result += `.max(${schema.maxItems})`;
        break;
      case "string":
        if (schema.format && schema.format !== "uri") throw new Error(`Unsupported format: ${schema.format}`);
        result = schema.format === "uri" ? "z.url()" : "z.string()";
        if (schema.pattern) result += `.regex(new RegExp(${JSON.stringify(schema.pattern)}))`;
        if (schema.minLength !== undefined) result += `.min(${schema.minLength})`;
        if (schema.maxLength !== undefined) result += `.max(${schema.maxLength})`;
        break;
      case "number":
      case "integer":
        result = schema.type === "integer" ? "z.int()" : "z.number()";
        if (schema.minimum !== undefined) result += `.min(${schema.minimum})`;
        if (schema.maximum !== undefined) result += `.max(${schema.maximum})`;
        break;
      case "boolean": result = "z.boolean()"; break;
      case "null": result = "z.null()"; break;
      default: throw new Error(`Unsupported clip schema type: ${schema.type}`);
    }
  }
  const name = `schema${definitions.length}`;
  definitions.push(`const ${name} = ${result};`);
  names.set(key, name);
  return name;
}

const roots = [
  ["clipLibraryResponseSchema", "ListAvatarClipsResponse"],
  ["clipLibraryUpdateSchema", "PutAvatarClipsResponse"],
].map(([name, contract]) =>
  `export const ${name} = ${expression(spec.components.schemas[contract])} satisfies z.ZodType<Wire["${contract}"]>;\n`
  + `type _${name}AcceptsWire = AssertTrue<Accepts<typeof ${name}, Wire["${contract}"]>>;`);
const output = `import { z } from "zod";
import type { components } from "./openapi.ts";
import { clipBehaviorSchema, clipLibraryDeclarationSchema } from "./character-motion.ts";

type Wire = components["schemas"];

/**
 * A schema in this file IS its contract schema, asserted in both directions it can still be
 * asserted in.
 *
 * OUTPUT is the \`satisfies z.ZodType<Wire[...]>\` on each root: what a parse returns is the wire
 * type and nothing wider. libs/http-client/test/client.test.ts pins it to exact equality.
 *
 * INPUT is \`Accepts\`, and it is one directional deliberately. It used to be the second argument
 * of the same \`satisfies\`, which said the schema accepts the wire type AND nothing else. The
 * vendored character-motion.ts now wraps its two motion records in \`z.preprocess\` with an
 * unannotated callback, so zod infers \`unknown\` for their input and the "nothing else" half has
 * no expression left. That file is taken byte for byte from the platform under the sha256 pin in
 * \`x-clip-contract\`, so it cannot be corrected from here. The half that survives is the half a
 * caller leans on: a value of the wire type is accepted. Every shape the lost half used to
 * reject at compile time is asserted at runtime in client.test.ts instead.
 */
type Accepts<Schema extends z.ZodType, Value> = [Value] extends [z.input<Schema>] ? true : false;
type AssertTrue<Value extends true> = Value;

clipLibraryDeclarationSchema satisfies z.ZodType<Wire["PutAvatarClipsRequest"]>;
type _clipLibraryDeclarationSchemaAcceptsWire =
  AssertTrue<Accepts<typeof clipLibraryDeclarationSchema, Wire["PutAvatarClipsRequest"]>>;
export { clipLibraryDeclarationSchema };

${definitions.join("\n\n")}

${roots.join("\n\n")}
`;
if (check) {
  if (await readFile(target, "utf8") !== output) throw new Error("Clip schemas are stale; run npm run spec:types");
} else {
  // No files change until the executable digest and response generation have succeeded.
  if (pull || sync) {
    await writeFile(vendorTarget, vendorBytes);
    await writeFile(specTarget, specBytes);
  }
  await writeFile(target, output);
}
console.log(`Clip contract SHA-256 ${hash}; response schemas ${check ? "verified" : "generated"}`);
