// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the Fish model vocabulary and which models carry each delivery.
import { z } from "zod";
import type { components } from "./openapi.ts";

type FishVoice = Extract<NonNullable<components["schemas"]["LiveKitSessionRequest"]["voice"]>, { provider: "fish" }>;

const schema0 = z.enum(["s1","s2-pro","s2.1-pro","drama-3"]);

const schema1 = z.enum(["speech-1.6","speech-1.5","s1-mini"]);

const schema2 = z.union([schema0, schema1]);

const schema3 = z.enum(["whisper"]);

const schema4 = z.null();

const schema5 = z.union([schema3, schema4]);

export const fishTtsModelSchema = schema2 satisfies z.ZodType<FishVoice["model"]>;
export type FishTtsModel = z.infer<typeof fishTtsModelSchema>;
export const DEFAULT_FISH_TTS_MODEL = "s2.1-pro" as const satisfies FishTtsModel;
export const fishDeliverySchema = schema5 satisfies z.ZodType<FishVoice["delivery"]>;
export type FishDelivery = NonNullable<z.infer<typeof fishDeliverySchema>>;
/** The models each delivery can be heard on, from the platform's `x-fish-delivery-models`. */
export const FISH_DELIVERY_MODELS = {"whisper":["drama-3"]} as const satisfies Record<FishDelivery, readonly FishTtsModel[]>;
type AssertTrue<Value extends true> = Value;
type _FishTtsModelCoversWire = AssertTrue<[FishVoice["model"]] extends [FishTtsModel] ? true : false>;
type _EveryDeliveryNamesItsModels = AssertTrue<[FishDelivery] extends [keyof typeof FISH_DELIVERY_MODELS] ? true : false>;
