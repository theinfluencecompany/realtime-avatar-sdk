// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the speech request and response metadata.
import { z } from "zod";
import type { operations } from "./openapi.ts";
type AssertTrue<Value extends true> = Value;
const schema0 = z.string().min(1).max(2000);

const schema1 = z.enum(["mp3","wav"]);

const schema2 = z.number().min(0.5).max(2);

const schema3 = z.string().regex(new RegExp("^[A-Za-z0-9-]+$")).min(2).max(16);

const schema4 = z.strictObject({
  "text": z.string().trim().pipe(schema0),
  "format": schema1.optional(),
  "speed": schema2.optional(),
  "language": schema3.optional(),
});

const schema5 = z.string().regex(new RegExp("^(vce|voice)_"));

const schema6 = z.number().min(0);

const schema7 = z.int().min(1);
export const createSpeechRequestSchema = schema4.extend({
  format: schema4.shape.format.unwrap().default("mp3"),
});
export type CreateSpeechInput = z.input<typeof createSpeechRequestSchema>;
type WireRequest = operations["createSpeech"]["requestBody"]["content"]["application/json"];
type SpeechRequest = z.output<typeof createSpeechRequestSchema>;
type _SpeechRequestParity = AssertTrue<[SpeechRequest] extends [WireRequest] ? [WireRequest] extends [SpeechRequest] ? true : false : false>;
export const speechVoiceIdSchema = schema5;
export const speechContentTypeSchema = z.enum(["audio/mpeg","audio/wav"]);
export type SpeechContentType = z.infer<typeof speechContentTypeSchema>;
type _SpeechContentTypeParity = AssertTrue<SpeechContentType extends keyof operations["createSpeech"]["responses"][200]["content"] ? keyof operations["createSpeech"]["responses"][200]["content"] extends SpeechContentType ? true : false : false>;
const speechResponseHeadersSchema = z.strictObject({
  "X-RTA-Billed-Credits": z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).transform(Number).pipe(schema6).nullable(),
  "X-RTA-Billed-Bytes": z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).transform(Number).pipe(schema7).nullable(),
});
export function readSpeechHeaders(headers: Headers) {
  const parsed = speechResponseHeadersSchema.parse({
    "X-RTA-Billed-Credits": headers.get("X-RTA-Billed-Credits"),
    "X-RTA-Billed-Bytes": headers.get("X-RTA-Billed-Bytes"),
  });
  return {
    billedCredits: parsed["X-RTA-Billed-Credits"],
    billedBytes: parsed["X-RTA-Billed-Bytes"],
  };
}
