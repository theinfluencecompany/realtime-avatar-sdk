// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the session response contract.
import { z } from "zod";
import type { components } from "./openapi.ts";

type Wire = components["schemas"];

const schema0 = z.string().min(8).max(80);

const schema1 = z.enum(["eou","llm","tts","decision","hold","e2e"]);

const schema2 = z.literal("interrupt_stop");

const schema3 = z.union([schema1, schema2]);

const schema4 = z.int().max(9007199254740991).gt(0);

const schema5 = z.number().min(0);

const schema6 = z.strictObject({
  "count": schema4,
  "max": schema5,
  "p50": schema5,
  "p90": schema5,
});

const schema7 = z.partialRecord(schema3, schema6);

const schema8 = z.literal("available");

const schema9 = z.literal("dialogue");

const schema10 = z.string().regex(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d))|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"));

const schema11 = z.null();

const schema12 = z.union([schema10, schema11]);

const schema13 = z.int().min(0).max(9007199254740991);

const schema14 = z.strictObject({
  "first_at": schema12,
  "last_at": schema12,
  "lines": schema13,
});

const schema15 = z.strictObject({
  "latency_ms": schema7,
  "status": schema8,
  "sourceRole": schema9,
  "coverage": schema14,
});

const schema16 = z.literal("unavailable");

const schema17 = z.enum(["not_closed","unconfigured","missing","invalid","oversized","unscorable","no_measured_latency","timeout","aborted","storage_unavailable"]);

const schema18 = z.strictObject({
  "status": schema16,
  "reason": schema17,
});

const schema19 = z.union([schema15, schema18]);

const schema20 = z.string().min(1).max(200);

const schema21 = z.union([schema20, schema11]);

const schema22 = z.string().regex(new RegExp("^[0-9a-f]{40}$"));

const schema23 = z.union([schema22, schema11]);

const schema24 = z.literal("cloudflare-worker-version");

const schema25 = z.literal("authenticated-worker-heartbeat");

const schema26 = z.union([schema25, schema11]);

const schema27 = z.string().min(1).max(160);

const schema28 = z.union([schema27, schema11]);

const schema29 = z.union([schema13, schema11]);

const schema30 = z.iso.datetime({ offset: true }).regex(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"));

const schema31 = z.union([schema30, schema11]);

const schema32 = z.strictObject({
  "deploymentSource": schema24,
  "workerSource": schema26,
  "workerId": schema28,
  "podStartedAtMs": schema29,
  "workerObservedAt": schema31,
});

const schema33 = z.strictObject({
  "deploymentId": schema21,
  "workerRevision": schema23,
  "provenance": schema32,
});

const schema34 = z.string();

const schema35 = z.union([schema34, schema11]);

const schema36 = z.enum(["reserved","started","released","failed"]);

const schema37 = z.union([schema5, schema11]);

const schema38 = z.custom<Record<string, unknown>>((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value));

const schema39 = z.strictObject({
  "sessionId": schema0,
  "speechDiagnostics": schema19.optional(),
  "releaseIdentity": schema33.optional(),
  "avatarId": schema35,
  "avatarName": schema35,
  "status": schema36,
  "startedAt": schema35,
  "endedAt": schema35,
  "activeSeconds": schema37,
  "billedCreditMicros": schema29,
  "metadata": schema38,
  "createdAt": schema34,
});

const schema40 = z.array(schema39);

const schema41 = z.iso.datetime({ offset: true }).regex(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"));

const schema42 = z.strictObject({
  "data": schema40,
  "nextCursor": schema35,
  "from": schema41,
  "to": schema41,
});

export const listUsageSessionsResponseSchema = schema42 satisfies z.ZodType<Wire["ListUsageSessionsResponse"], Wire["ListUsageSessionsResponse"]>;
type AssertTrue<Value extends true> = Value;
type _ListUsageSessionsAcceptsWire = AssertTrue<
  [Wire["ListUsageSessionsResponse"]] extends [z.input<typeof listUsageSessionsResponseSchema>] ? true : false
>;

export function toSessionsPage(page: z.infer<typeof listUsageSessionsResponseSchema>) {
  const { data, ...pagination } = page;
  return { ...pagination, sessions: data };
}
