import { z } from "zod";
import type { components } from "./openapi.ts";

const schema0 = z.string().min(2).max(64);

const schema1 = z.array(schema0);

const schema2 = z.string().regex(new RegExp("\\S")).min(1).max(160);

const schema3 = z.array(schema2).max(1000);

const schema4 = z.strictObject({
  "language_codes": schema1.optional(),
  "custom_vocabulary": schema3.optional(),
});

export const transcriptionWireSchema = schema4 satisfies z.ZodType<NonNullable<components["schemas"]["LiveKitSessionRequest"]["transcription"]>>;
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
