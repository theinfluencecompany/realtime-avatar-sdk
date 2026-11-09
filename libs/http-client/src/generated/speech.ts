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

const schema8 = z.strictObject({
  "text": z.string().trim().pipe(schema0),
  "speed": schema2.optional(),
  "language": schema3.optional(),
});

const schema9 = z.string().max(4096);

const schema10 = z.number().min(0).max(180);

const schema11 = z.strictObject({
  "text": schema9,
  "start": schema10,
  "end": schema10,
});

export const speechAlignedTextSchema = schema11.refine(segment => segment.end >= segment.start);

const schema13 = z.uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"));

const schema14 = z.literal("started");

const schema15 = z.literal("pcm_s16le");

const schema16 = z.literal(24000);

const schema17 = z.literal(1);

const schema18 = z.strictObject({
  "requestId": schema13,
  "type": schema14,
  "encoding": schema15,
  "sampleRate": schema16,
  "channels": schema17,
});

const schema19 = z.literal("audio");

const schema20 = z.int().min(0).max(9007199254740991);

const schema21 = z.int().min(0).max(4320000);

const schema22 = z.base64().regex(new RegExp("^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$")).min(4).max(21848);

const schema23 = z.strictObject({
  "requestId": schema13,
  "type": schema19,
  "sequence": schema20,
  "sampleOffset": schema21,
  "audioBase64": schema22,
});

const schema24 = z.literal("alignment");

const schema25 = z.int().min(0).max(127);

const schema26 = z.array(speechAlignedTextSchema).max(2048);

const schema27 = z.strictObject({
  "requestId": schema13,
  "type": schema24,
  "chunkSeq": schema25,
  "segments": schema26,
});

const schema28 = z.literal("completed");

const schema29 = z.int().max(4320000).gt(0);

const schema30 = z.int().max(9007199254740991).gt(0);

const schema31 = z.strictObject({
  "requestId": schema13,
  "type": schema28,
  "totalSamples": schema29,
  "billedCredits": schema6,
  "billedBytes": schema30,
});

const schema32 = z.literal("failed");

const schema33 = z.string();

const schema34 = z.int().min(-9007199254740991).max(9007199254740991);

const schema35 = z.string();

const schema36 = z.url();

const schema37 = z.boolean();

const schema38 = z.uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"));

const schema39 = z.enum(["*","api_keys:write","credits:read","avatars:read","avatars:write","realtime:write","usage:read","recordings:read","usage:write","speech:write","renders:read","renders:write"]);

const schema40 = z.enum(["*","api_keys:write","credits:read","avatars:read","avatars:write","realtime:write","usage:read","recordings:read","usage:write","speech:write","renders:read","renders:write"]);

const schema41 = z.array(schema40);

const schema42 = z.string();

const schema43 = z.int().max(9007199254740991).gt(0);

const schema44 = z.int().min(0).max(9007199254740991);

const schema45 = z.int().min(0).max(9007199254740991);

const schema46 = z.int().min(0).max(9007199254740991);

const schema47 = z.int().min(0).max(9007199254740991);

const schema48 = z.looseObject({
  "error": schema33,
  "status": schema34,
  "code": schema35,
  "documentation": schema36,
  "retryable": schema37.optional(),
  "requestId": schema38.optional(),
  "requiredScope": schema39.optional(),
  "grantedScopes": schema41.optional(),
  "billingUrl": schema42.optional(),
  "maxConcurrentSessions": schema43.optional(),
  "liveSessions": schema44.optional(),
  "activeSessions": schema45.optional(),
  "connectingSessions": schema46.optional(),
  "pendingSessions": schema47.optional(),
});

const schema49 = z.strictObject({
  "requestId": schema13,
  "type": schema32,
  "error": schema48,
});

const schema50 = z.union([schema18, schema23, schema27, schema31, schema49]);
export const createSpeechRequestSchema = schema4.extend({
  format: schema4.shape.format.unwrap().default("mp3"),
});
export type CreateSpeechInput = z.input<typeof createSpeechRequestSchema>;
export const createSpeechStreamRequestSchema = schema8;
export type CreateSpeechStreamRequest = z.infer<typeof createSpeechStreamRequestSchema>;
export type SpeechAlignedText = z.infer<typeof speechAlignedTextSchema>;
export const speechStreamEventSchema = schema50;
export type SpeechStreamEvent = z.infer<typeof speechStreamEventSchema>;
export const SPEECH_STREAM_CONTRACT = {"maxAudioEventBytes":16384,"maxSamples":4320000,"alignedTextEndNotBeforeStart":true} as const;
type StreamWireRequest = operations["createSpeechStream"]["requestBody"]["content"]["application/json"];
type StreamWireEvent = operations["createSpeechStream"]["responses"][200]["content"]["text/event-stream"];
type _SpeechStreamRequestParity = AssertTrue<[CreateSpeechStreamRequest] extends [StreamWireRequest] ? [StreamWireRequest] extends [CreateSpeechStreamRequest] ? true : false : false>;
type _SpeechStreamEventParity = AssertTrue<[SpeechStreamEvent] extends [StreamWireEvent] ? [StreamWireEvent] extends [SpeechStreamEvent] ? true : false : false>;
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
