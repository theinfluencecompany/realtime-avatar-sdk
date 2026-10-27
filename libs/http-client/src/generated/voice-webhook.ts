// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the voice webhook contract.
import { z } from "zod";
import type { components } from "./openapi.ts";

type Wire = components["schemas"];

const schema0 = z.url().max(500);

const schema1 = z.string().min(16).max(200);

const schema2 = z.string().min(1).max(200);

const schema3 = z.string().min(2).max(35);

const schema4 = z.literal([8000,16000,22050,24000,44100,48000]);

const schema5 = z.int().min(1000).max(15000);

const schema6 = z.strictObject({
  "url": schema0,
  "secret": schema1,
  "voice_id": schema2.optional(),
  "language": schema3.optional(),
  "sample_rate": schema4.optional(),
  "timeout_ms": schema5.optional(),
});

const schema7 = z.literal("voice.synthesize");

const schema8 = z.literal(1);

const schema9 = z.string().min(1).max(200);

const schema10 = z.string();

const schema11 = z.string().min(1).max(5000);

const schema12 = z.string();

const schema13 = z.null();

const schema14 = z.union([schema12, schema13]);

const schema15 = z.string();

const schema16 = z.union([schema15, schema13]);

const schema17 = z.literal("pcm_s16le");

const schema18 = z.literal([8000,16000,22050,24000,44100,48000]);

const schema19 = z.object({
  "encoding": schema17,
  "sample_rate": schema18,
  "channels": schema8,
});

const schema20 = z.string().min(1).max(64);

const schema21 = z.string().max(200);

const schema22 = z.record(schema20, schema21).refine((value) => Object.keys(value).length <= 16, { message: "Too many keys: at most 16" });

const schema23 = z.object({
  "type": schema7,
  "version": schema8,
  "request_id": schema9,
  "session_id": schema10,
  "text": schema11,
  "voice_id": schema14,
  "language": schema16,
  "output": schema19,
  "client_metadata": schema22,
});

export const voiceWebhookWireSchema = schema6 satisfies z.ZodType<NonNullable<Wire["LiveKitSessionRequest"]["voice_webhook"]>>;
export const voiceWebhookOptionsSchema = z.strictObject({
  url: voiceWebhookWireSchema.shape.url,
  secret: voiceWebhookWireSchema.shape.secret,
  voiceId: voiceWebhookWireSchema.shape.voice_id,
  language: voiceWebhookWireSchema.shape.language,
  sampleRate: voiceWebhookWireSchema.shape.sample_rate,
  timeoutMs: voiceWebhookWireSchema.shape.timeout_ms,
});

export function voiceWebhookToWire(input: z.input<typeof voiceWebhookOptionsSchema>): NonNullable<Wire["LiveKitSessionRequest"]["voice_webhook"]> {
  const options = voiceWebhookOptionsSchema.parse(input);
  return {
    url: options.url,
    secret: options.secret,
    ...(options.voiceId !== undefined ? { voice_id: options.voiceId } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.sampleRate !== undefined ? { sample_rate: options.sampleRate } : {}),
    ...(options.timeoutMs !== undefined ? { timeout_ms: options.timeoutMs } : {}),
  };
}

export const voiceWebhookRequestSchema = schema23 satisfies z.ZodType<Wire["VoiceWebhookRequest"], Wire["VoiceWebhookRequest"]>;
