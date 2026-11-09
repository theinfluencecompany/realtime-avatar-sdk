// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns avatar creation and response contracts.
import { z } from "zod";
import type { components } from "./openapi.ts";

type Wire = components["schemas"];
const schema0 = z.string().min(1).max(160);

const schema1 = z.custom<Record<string, unknown>>((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value));

const schema2 = z.enum(["cartesia","fish"]);

const schema3 = z.string().min(1).max(240);

const schema4 = z.string().min(1).max(120);

const schema5 = z.number().min(0.5).max(2);

const schema6 = z.null();

const schema7 = z.union([schema5, schema6]);

const schema8 = z.string().min(1).max(80);

const schema9 = z.union([schema8, schema6]);

const schema10 = z.string().min(2).max(16);

const schema11 = z.union([schema10, schema6]);

const schema12 = z.strictObject({
  "provider": schema2,
  "voice_id": schema3,
  "model": schema4.optional(),
  "speed": schema7.optional(),
  "emotion": schema9.optional(),
  "language": schema11.optional(),
});

const schema13 = z.string().min(8).max(80);

const schema14 = z.string();

const schema15 = z.enum(["video","live2d"]);

const schema16 = z.enum(["image","video"]);

const schema17 = z.enum(["realtime-avatar-live-v1","realtime-avatar-video-v1"]);

const schema18 = z.union([schema13, schema6]);

const schema19 = z.enum(["draft","preprocessing","ready","failed","disabled","deleted"]);

const schema20 = z.union([schema14, schema6]);

const schema21 = z.enum(["none","queued","generating","ready","failed"]);

const schema22 = z.enum(["local","gemini","openai"]);

const schema23 = z.string().max(200);

const schema24 = z.union([schema23, schema6]);

const schema25 = z.strictObject({
  "provider": schema22,
  "model": schema24.optional(),
});

const schema26 = z.union([schema25, schema6]);

const schema27 = z.strictObject({
  "id": schema13,
  "tenantId": schema13,
  "displayName": schema14,
  "renderer": schema15,
  "sourceKind": schema16,
  "modelId": schema17,
  "sourceAssetId": schema18,
  "status": schema19,
  "error": schema20,
  "idleVideoStatus": schema21,
  "defaultVoiceId": schema20,
  "llm": schema26,
  "createdAt": schema14,
  "updatedAt": schema14,
});

// OpenAPI's required-only voice union becomes unknown in openapi-typescript. Derive the
// explicit selector from its generated executable schema, not that lossy union.
export const explicitAvatarVoiceSchema = schema12;
export const createLive2dAvatarInputSchema = z.strictObject({
  displayName: schema0,
  settings: schema1.optional(),
  metadata: schema1.optional(),
  voice: schema12,
});
export const avatarResponseSchema = schema27;
