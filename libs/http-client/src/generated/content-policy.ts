// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the policy vocabulary.
import { z } from "zod";
import type { components } from "./openapi.ts";

const schema0 = z.enum(["minor-sexual-content-v1","safe-content-v1"]);

export const contentPolicySchema = schema0 satisfies z.ZodType<NonNullable<components["schemas"]["LiveKitSessionRequest"]["content_policy"]>>;
