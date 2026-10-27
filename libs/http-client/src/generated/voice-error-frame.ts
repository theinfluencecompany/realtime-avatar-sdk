// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the in-call voice error frame.
import { z } from "zod";
import type { components } from "./openapi.ts";

type Wire = components["schemas"];

const schema0 = z.literal("voice_error");

const schema1 = z.enum(["voice_webhook_url_not_allowed","voice_webhook_unauthorized","voice_webhook_unreachable","voice_webhook_timeout","voice_webhook_http_error","voice_webhook_unsupported_audio","voice_webhook_empty_audio"]);

const schema2 = z.string();

const schema3 = z.int().min(-9007199254740991).max(9007199254740991);

const schema4 = z.boolean();

const schema5 = z.object({
  "kind": schema0,
  "code": schema1,
  "message": schema2,
  "status": schema3.optional(),
  "fatal": schema4,
  "request_id": schema2.optional(),
});

export const voiceErrorFrameSchema = schema5 satisfies z.ZodType<Wire["VoiceErrorFrame"], Wire["VoiceErrorFrame"]>;
