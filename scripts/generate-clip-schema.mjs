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
async function readContract(key, ownerPath, targetPath) {
  const reference = spec[key];
  if (!reference || typeof reference.source !== "string" || !/^\/[\w./-]+\.ts$/.test(reference.source)
    || reference.source.startsWith("//") || reference.source.split("/").some(part => part === "." || part === "..")
    || typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
    throw new Error(`Missing or invalid ${key} source/sha256`);
  }
  const sourceUrl = new URL(reference.source, specUrl);
  if (sourceUrl.origin !== specUrl.origin) throw new Error(`${key} must use the trusted spec origin`);

  let bytes;
  if (pull) {
    bytes = await fetchBytes(sourceUrl);
  } else if (sync) {
    const publicRoot = resolve(args[1], "apps/web/public");
    const artifact = resolve(publicRoot, `.${reference.source}`);
    if (relative(publicRoot, artifact).startsWith(`..${sep}`)) throw new Error(`${key} escapes public root`);
    bytes = await readFile(artifact);
    const ownerBytes = await readFile(resolve(args[1], ownerPath));
    if (!bytes.equals(ownerBytes)) throw new Error(`${key} differs from its canonical owner`);
  } else {
    bytes = await readFile(targetPath);
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== reference.sha256) throw new Error(`${key} SHA-256 mismatch: expected ${reference.sha256}, got ${hash}`);
  return { bytes, hash };
}

const { bytes: vendorBytes, hash } = await readContract("x-clip-contract", "packages/realtime-avatar-contracts/src/character-motion.ts", vendorTarget);
const recordingTarget = new URL("../libs/http-client/src/generated/recording.ts", import.meta.url);
const recording = await readContract("x-recording-contract", "packages/realtime-avatar-contracts/src/product/recording.ts", recordingTarget);

const supported = new Set([
  "$schema", "type", "properties", "required", "additionalProperties",
  "anyOf", "oneOf", "enum", "format", "pattern", "minLength", "maxLength", "minimum", "maximum",
  "items", "minItems", "maxItems", "const", "description", "readOnly", "default", "propertyNames", "exclusiveMinimum", "exclusiveMaximum",
  "writeOnly", "maxProperties", "deprecated",
]);
const definitions = [];
const behavior = JSON.stringify(spec.components.schemas.ListAvatarClipsResponse.properties.behavior);
if (behavior !== JSON.stringify(spec.components.schemas.PutAvatarClipsResponse.properties.behavior)) {
  throw new Error("Clip response behavior schemas disagree");
}
const names = new Map([[behavior, "clipBehaviorSchema"]]);

function finiteRecordKeys(schema) {
  return (schema.type === "string" && Array.isArray(schema.enum) && schema.enum.length > 0
    && schema.enum.every(value => typeof value === "string"))
    || (schema.type === "string" && typeof schema.const === "string")
    || (Array.isArray(schema.anyOf) && schema.anyOf.length > 0 && schema.anyOf.every(finiteRecordKeys));
}

// `open` admits an object that declares no `additionalProperties` and emits it as a stripping
// `z.object`. Only a payload this SDK RECEIVES from a newer platform may be open, so a field added
// upstream is dropped instead of failing the receiver; every response root stays closed.
function expression(schema, open = false) {
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
    return expression(schema.type.length === 1 ? spelled : { anyOf: [spelled, { type: "null" }] }, open);
  }
  let result;
  if (Object.keys(schema).length === 0) {
    result = "z.unknown()";
  } else if (schema.const !== undefined) {
    result = `z.literal(${JSON.stringify(schema.const)})`;
  } else if (schema.anyOf || schema.oneOf) {
    result = `z.union([${(schema.anyOf ?? schema.oneOf).map((member) => expression(member, open)).join(", ")}])`;
  } else if (schema.enum) {
    if (schema.type === "number" && schema.enum.every((member) => typeof member === "number")) {
      result = `z.literal(${JSON.stringify(schema.enum)})`;
    } else {
      if (schema.type !== "string") throw new Error("Only string and number enums are supported");
      result = `z.enum(${JSON.stringify(schema.enum)})`;
    }
  } else {
    switch (schema.type) {
      case "object": {
        const finiteKeys = schema.propertyNames && finiteRecordKeys(schema.propertyNames);
        const boundedKeys = schema.propertyNames && !finiteKeys && schema.propertyNames.type === "string"
          && Object.keys(schema.propertyNames).every((keyword) => ["type", "minLength", "maxLength"].includes(keyword))
          && JSON.stringify(schema.propertyNames) !== JSON.stringify({ type: "string" });
        if (schema.propertyNames && !finiteKeys && !boundedKeys
          && JSON.stringify(schema.propertyNames) !== JSON.stringify({ type: "string" })) {
          throw new Error("Unsupported response record key schema");
        }
        if (schema.maxProperties !== undefined && (schema.properties || finiteKeys)) {
          throw new Error("maxProperties is only supported on an open-keyed record");
        }
        if (!schema.properties) {
          if (!schema.additionalProperties || typeof schema.additionalProperties !== "object") {
            throw new Error("Expected an explicit response record value schema");
          }
          result = finiteKeys
            ? `z.partialRecord(${expression(schema.propertyNames, open)}, ${expression(schema.additionalProperties, open)})`
            : Object.keys(schema.additionalProperties).length === 0
              ? `z.custom<Record<string, unknown>>((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value))`
              : `z.record(${boundedKeys ? expression(schema.propertyNames, open) : "z.string()"}, ${expression(schema.additionalProperties, open)})`;
          if (schema.maxProperties !== undefined) {
            result += `.refine((value) => Object.keys(value).length <= ${schema.maxProperties}, { message: "Too many keys: at most ${schema.maxProperties}" })`;
          }
          break;
        }
        if (finiteKeys) throw new Error("Finite record keys cannot accompany explicit properties");
        const stripping = open && schema.additionalProperties === undefined;
        if (schema.additionalProperties !== false && !stripping) throw new Error("Expected a closed response object");
        const required = new Set(schema.required ?? []);
        result = `${stripping ? "z.object" : "z.strictObject"}({\n${Object.entries(schema.properties).map(([field, value]) =>
          `  ${JSON.stringify(field)}: ${expression(value, open)}${required.has(field) ? "" : ".optional()"},`
        ).join("\n")}\n})`;
        break;
      }
      case "array":
        result = `z.array(${expression(schema.items, open)})`;
        if (schema.minItems !== undefined) result += `.min(${schema.minItems})`;
        if (schema.maxItems !== undefined) result += `.max(${schema.maxItems})`;
        break;
      case "string":
        if (schema.format && !["uri", "date-time"].includes(schema.format)) throw new Error(`Unsupported format: ${schema.format}`);
        result = schema.format === "uri" ? "z.url()"
          : schema.format === "date-time" ? "z.iso.datetime({ offset: true })" : "z.string()";
        if (schema.pattern) result += `.regex(new RegExp(${JSON.stringify(schema.pattern)}))`;
        if (schema.minLength !== undefined) result += `.min(${schema.minLength})`;
        if (schema.maxLength !== undefined) result += `.max(${schema.maxLength})`;
        break;
      case "number":
      case "integer":
        result = schema.type === "integer" ? "z.int()" : "z.number()";
        if (schema.minimum !== undefined) result += `.min(${schema.minimum})`;
        if (schema.maximum !== undefined) result += `.max(${schema.maximum})`;
        if (schema.exclusiveMinimum !== undefined) result += `.gt(${schema.exclusiveMinimum})`;
        if (schema.exclusiveMaximum !== undefined) result += `.lt(${schema.exclusiveMaximum})`;
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

definitions.length = 0;
names.clear();
const { description: _transcriptionDescription, ...transcriptionSchema } = spec.components.schemas.LiveKitSessionRequest.properties.transcription;
const transcriptionRoot = expression(transcriptionSchema);
const transcriptionTarget = new URL("../libs/http-client/src/generated/transcription.ts", import.meta.url);
const transcriptionOutput = `import { z } from "zod";
import type { components } from "./openapi.ts";

${definitions.join("\n\n")}

export const transcriptionWireSchema = ${transcriptionRoot} satisfies z.ZodType<NonNullable<components["schemas"]["LiveKitSessionRequest"]["transcription"]>>;
export const transcriptionOptionsSchema = z.object({
  languageCodes: transcriptionWireSchema.shape.language_codes,
  customVocabulary: transcriptionWireSchema.shape.custom_vocabulary,
}).strict();

export function transcriptionToWire(input: z.input<typeof transcriptionOptionsSchema>) {
  const options = transcriptionOptionsSchema.parse(input);
  return {
    ...(options.languageCodes !== undefined ? { language_codes: options.languageCodes } : {}),
    ...(options.customVocabulary !== undefined ? { custom_vocabulary: options.customVocabulary } : {}),
  };
}
`;
definitions.length = 0;
names.clear();
const { description: _contentPolicyDescription, ...contentPolicySchema } = spec.components.schemas.LiveKitSessionRequest.properties.content_policy;
const contentPolicyRoot = expression(contentPolicySchema);
const contentPolicyTarget = new URL("../libs/http-client/src/generated/content-policy.ts", import.meta.url);
const contentPolicyOutput = `// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the policy vocabulary.
import { z } from "zod";
import type { components } from "./openapi.ts";

${definitions.join("\n\n")}

export const contentPolicySchema = ${contentPolicyRoot} satisfies z.ZodType<NonNullable<components["schemas"]["LiveKitSessionRequest"]["content_policy"]>>;
`;
definitions.length = 0;
names.clear();
const usageSessionsRoot = expression(spec.components.schemas.ListUsageSessionsResponse);
const usageSessionsTarget = new URL("../libs/http-client/src/generated/usage-sessions.ts", import.meta.url);
const usageSessionsOutput = `// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the session response contract.
import { z } from "zod";
import type { components } from "./openapi.ts";

type Wire = components["schemas"];

${definitions.join("\n\n")}

export const listUsageSessionsResponseSchema = ${usageSessionsRoot} satisfies z.ZodType<Wire["ListUsageSessionsResponse"], Wire["ListUsageSessionsResponse"]>;
type AssertTrue<Value extends true> = Value;
type _ListUsageSessionsAcceptsWire = AssertTrue<
  [Wire["ListUsageSessionsResponse"]] extends [z.input<typeof listUsageSessionsResponseSchema>] ? true : false
>;

export function toSessionsPage(page: z.infer<typeof listUsageSessionsResponseSchema>) {
  const { data, ...pagination } = page;
  return { ...pagination, sessions: data };
}
`;
definitions.length = 0;
names.clear();
// The mint option is closed like every request; the webhook POST a receiver verifies is generated
// open. The in-call frame gets a file of its own below, so a client bundle never carries these.
const { description: _voiceWebhookDescription, ...voiceWebhookSchema } = spec.components.schemas.LiveKitSessionRequest.properties.voice_webhook;
const voiceWebhookRoot = expression(voiceWebhookSchema);
const voiceWebhookRequestRoot = expression(spec.components.schemas.VoiceWebhookRequest, true);
const camelCase = (field) => field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const voiceWebhookFields = Object.keys(voiceWebhookSchema.properties).map((field) => ({
  field, option: camelCase(field), required: (voiceWebhookSchema.required ?? []).includes(field),
}));
const voiceWebhookTarget = new URL("../libs/http-client/src/generated/voice-webhook.ts", import.meta.url);
const voiceWebhookOutput = `// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the voice webhook contract.
import { z } from "zod";
import type { components } from "./openapi.ts";

type Wire = components["schemas"];

${definitions.join("\n\n")}

export const voiceWebhookWireSchema = ${voiceWebhookRoot} satisfies z.ZodType<NonNullable<Wire["LiveKitSessionRequest"]["voice_webhook"]>>;
export const voiceWebhookOptionsSchema = z.strictObject({
${voiceWebhookFields.map(({ field, option }) => `  ${option}: voiceWebhookWireSchema.shape.${field},`).join("\n")}
});

export function voiceWebhookToWire(input: z.input<typeof voiceWebhookOptionsSchema>): NonNullable<Wire["LiveKitSessionRequest"]["voice_webhook"]> {
  const options = voiceWebhookOptionsSchema.parse(input);
  return {
${voiceWebhookFields.map(({ field, option, required }) => required
  ? `    ${field}: options.${option},`
  : `    ...(options.${option} !== undefined ? { ${field}: options.${option} } : {}),`).join("\n")}
  };
}

export const voiceWebhookRequestSchema = ${voiceWebhookRequestRoot} satisfies z.ZodType<Wire["VoiceWebhookRequest"], Wire["VoiceWebhookRequest"]>;
`;
definitions.length = 0;
names.clear();
const voiceErrorFrameRoot = expression(spec.components.schemas.VoiceErrorFrame, true);
const voiceErrorFrameTarget = new URL("../libs/http-client/src/generated/voice-error-frame.ts", import.meta.url);
const voiceErrorFrameOutput = `// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the in-call voice error frame.
import { z } from "zod";
import type { components } from "./openapi.ts";

type Wire = components["schemas"];

${definitions.join("\n\n")}

export const voiceErrorFrameSchema = ${voiceErrorFrameRoot} satisfies z.ZodType<Wire["VoiceErrorFrame"], Wire["VoiceErrorFrame"]>;
`;
definitions.length = 0;
names.clear();
const voiceArms = (schema) => (schema.anyOf ?? schema.oneOf)?.flatMap(voiceArms) ?? [schema];
const fishArms = voiceArms(spec.components.schemas.LiveKitSessionRequest.properties.voice)
  .filter((arm) => arm.properties?.provider?.const === "fish");
if (fishArms.length !== 1) throw new Error(`Expected one Fish voice arm, found ${fishArms.length}`);
const fishTtsModelDefault = fishArms[0].properties.model.default;
if (typeof fishTtsModelDefault !== "string") throw new Error("Expected the Fish voice model to declare a string default");
const fishTtsModelRoot = expression(fishArms[0].properties.model);
const fishTtsModelTarget = new URL("../libs/http-client/src/generated/fish-tts-model.ts", import.meta.url);
const fishTtsModelOutput = `// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the Fish model vocabulary.
import { z } from "zod";
import type { components } from "./openapi.ts";

type FishVoice = Extract<NonNullable<components["schemas"]["LiveKitSessionRequest"]["voice"]>, { provider: "fish" }>;

${definitions.join("\n\n")}

export const fishTtsModelSchema = ${fishTtsModelRoot} satisfies z.ZodType<FishVoice["model"]>;
export type FishTtsModel = z.infer<typeof fishTtsModelSchema>;
export const DEFAULT_FISH_TTS_MODEL = ${JSON.stringify(fishTtsModelDefault)} as const satisfies FishTtsModel;
type AssertTrue<Value extends true> = Value;
type _FishTtsModelCoversWire = AssertTrue<[FishVoice["model"]] extends [FishTtsModel] ? true : false>;
`;
if (check) {
  if (await readFile(fishTtsModelTarget, "utf8") !== fishTtsModelOutput) throw new Error("Fish model schema is stale; run npm run spec:types");
  if (await readFile(usageSessionsTarget, "utf8") !== usageSessionsOutput) throw new Error("Usage sessions schema is stale; run npm run spec:types");
  if (await readFile(contentPolicyTarget, "utf8") !== contentPolicyOutput) throw new Error("Content policy schema is stale; run npm run spec:types");
  if (await readFile(target, "utf8") !== output) throw new Error("Clip schemas are stale; run npm run spec:types");
  if (await readFile(transcriptionTarget, "utf8") !== transcriptionOutput) throw new Error("Transcription schemas are stale; run npm run spec:types");
  if (await readFile(voiceWebhookTarget, "utf8") !== voiceWebhookOutput) throw new Error("Voice webhook schemas are stale; run npm run spec:types");
  if (await readFile(voiceErrorFrameTarget, "utf8") !== voiceErrorFrameOutput) throw new Error("Voice error frame schema is stale; run npm run spec:types");
} else {
  // No files change until the executable digest and response generation have succeeded.
  if (pull || sync) {
    await writeFile(vendorTarget, vendorBytes);
    await writeFile(recordingTarget, recording.bytes);
    await writeFile(specTarget, specBytes);
  }
  await writeFile(target, output);
  await writeFile(transcriptionTarget, transcriptionOutput);
  await writeFile(contentPolicyTarget, contentPolicyOutput);
  await writeFile(usageSessionsTarget, usageSessionsOutput);
  await writeFile(voiceWebhookTarget, voiceWebhookOutput);
  await writeFile(voiceErrorFrameTarget, voiceErrorFrameOutput);
  await writeFile(fishTtsModelTarget, fishTtsModelOutput);
}
console.log(`Clip contract SHA-256 ${hash}; response schemas ${check ? "verified" : "generated"}`);
