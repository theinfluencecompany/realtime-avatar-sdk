// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the Fish model vocabulary.
import { z } from "zod";
import type { components } from "./openapi.ts";

type FishVoice = Extract<NonNullable<components["schemas"]["LiveKitSessionRequest"]["voice"]>, { provider: "fish" }>;

const schema0 = z.enum(["speech-1.6","s1","s2-pro","s2.1-pro","drama-3","speech-1.5","s1-mini"]);

export const fishTtsModelSchema = schema0 satisfies z.ZodType<FishVoice["model"]>;
type AssertTrue<Value extends true> = Value;
type _FishTtsModelCoversWire = AssertTrue<[FishVoice["model"]] extends [z.infer<typeof fishTtsModelSchema>] ? true : false>;
