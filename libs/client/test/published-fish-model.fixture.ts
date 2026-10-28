import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";

// Read from the committed spec rather than the generated schema, so a hand-kept SDK list that
// lags the contract fails here (it once dropped drama-3 while the spec carried it).
const publishedVoiceSchema = z.object({
  components: z.object({
    schemas: z.object({
      LiveKitSessionRequest: z.object({
        properties: z.object({
          voice: z.object({
            anyOf: z.array(z.object({
              oneOf: z.array(z.object({
                properties: z.object({
                  provider: z.object({ const: z.string() }),
                  model: z.object({
                    default: z.string().optional(),
                    enum: z.array(z.string()).optional(),
                    // Live ids and the deprecated ids the platform still accepts are separate branches.
                    anyOf: z.array(z.object({ enum: z.array(z.string()) })).optional(),
                  }).optional(),
                }),
              })).optional(),
            })),
          }),
        }),
      }),
    }),
  }),
});

export async function publishedFishModel() {
  const spec = publishedVoiceSchema.parse(
    JSON.parse(await readFile(new URL("../../../spec/realtime-avatar.openapi.json", import.meta.url), "utf-8")),
  );
  const [model] = spec.components.schemas.LiveKitSessionRequest.properties.voice.anyOf
    .flatMap((member) => member.oneOf ?? [])
    .filter((arm) => arm.properties.provider.const === "fish")
    .map((arm) => arm.properties.model);
  assert.ok(model, "the published contract has a Fish voice model");
  return { default: model.default, ids: [...(model.enum ?? []), ...(model.anyOf ?? []).flatMap((branch) => branch.enum)] };
}
