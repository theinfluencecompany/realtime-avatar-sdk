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

const schema8 = z.enum(["normal","balanced","low"]);

const schema9 = z.int().min(100).max(300);

const schema10 = z.strictObject({
  "text": z.string().trim().pipe(schema0),
  "speed": schema2.optional(),
  "language": schema3.optional(),
  "latency": schema8.optional(),
  "chunkLength": schema9.optional(),
});

const schema11 = z.string().max(4096);

const schema12 = z.number().min(0).max(180);

const schema13 = z.strictObject({
  "text": schema11,
  "start": schema12,
  "end": schema12,
});

export const speechAlignedTextSchema = schema13.refine(segment => segment.end >= segment.start);

const schema15 = z.uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"));

const schema16 = z.literal("started");

const schema17 = z.literal("pcm_s16le");

const schema18 = z.literal(24000);

const schema19 = z.literal(1);

const schema20 = z.strictObject({
  "requestId": schema15,
  "type": schema16,
  "encoding": schema17,
  "sampleRate": schema18,
  "channels": schema19,
});

const schema21 = z.literal("audio");

const schema22 = z.int().min(0).max(9007199254740991);

const schema23 = z.int().min(0).max(4320000);

const schema24 = z.base64().regex(new RegExp("^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$")).min(4).max(21848);

const schema25 = z.strictObject({
  "requestId": schema15,
  "type": schema21,
  "sequence": schema22,
  "sampleOffset": schema23,
  "audioBase64": schema24,
});

const schema26 = z.literal("alignment");

const schema27 = z.int().min(0).max(127);

const schema28 = z.array(speechAlignedTextSchema).max(2048);

const schema29 = z.strictObject({
  "requestId": schema15,
  "type": schema26,
  "chunkSeq": schema27,
  "segments": schema28,
});

const schema30 = z.literal("completed");

const schema31 = z.int().max(4320000).gt(0);

const schema32 = z.int().max(9007199254740991).gt(0);

const schema33 = z.strictObject({
  "requestId": schema15,
  "type": schema30,
  "totalSamples": schema31,
  "billedCredits": schema6,
  "billedBytes": schema32,
});

const schema34 = z.literal("failed");

const schema35 = z.string();

const schema36 = z.int().min(-9007199254740991).max(9007199254740991);

const schema37 = z.string();

const schema38 = z.url();

const schema39 = z.boolean();

const schema40 = z.uuid().regex(new RegExp("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"));

const schema41 = z.enum(["*","api_keys:write","credits:read","avatars:read","avatars:write","realtime:write","usage:read","recordings:read","usage:write","speech:write","renders:read","renders:write"]);

const schema42 = z.enum(["*","api_keys:write","credits:read","avatars:read","avatars:write","realtime:write","usage:read","recordings:read","usage:write","speech:write","renders:read","renders:write"]);

const schema43 = z.array(schema42);

const schema44 = z.string();

const schema45 = z.int().max(9007199254740991).gt(0);

const schema46 = z.int().min(0).max(9007199254740991);

const schema47 = z.int().min(0).max(9007199254740991);

const schema48 = z.int().min(0).max(9007199254740991);

const schema49 = z.int().min(0).max(9007199254740991);

const schema50 = z.looseObject({
  "error": schema35,
  "status": schema36,
  "code": schema37,
  "documentation": schema38,
  "retryable": schema39.optional(),
  "requestId": schema40.optional(),
  "requiredScope": schema41.optional(),
  "grantedScopes": schema43.optional(),
  "billingUrl": schema44.optional(),
  "maxConcurrentSessions": schema45.optional(),
  "liveSessions": schema46.optional(),
  "activeSessions": schema47.optional(),
  "connectingSessions": schema48.optional(),
  "pendingSessions": schema49.optional(),
});

const schema51 = z.strictObject({
  "requestId": schema15,
  "type": schema34,
  "error": schema50,
});

const schema52 = z.union([schema20, schema25, schema29, schema33, schema51]);
export const createSpeechRequestSchema = schema4.extend({
  format: schema4.shape.format.unwrap().default("mp3"),
});
export type CreateSpeechInput = z.input<typeof createSpeechRequestSchema>;
export const createSpeechStreamRequestSchema = schema10;
export type CreateSpeechStreamRequest = z.infer<typeof createSpeechStreamRequestSchema>;
export type SpeechAlignedText = z.infer<typeof speechAlignedTextSchema>;
export const speechStreamEventSchema = schema52;
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
