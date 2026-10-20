// Generated from spec/realtime-avatar.openapi.json by scripts/generate-clip-schema.mjs.
// Do not edit; the platform owns the session response contract.
import { z } from "zod";
import type { components } from "./openapi.ts";

type Wire = components["schemas"];

const schema0 = z.string().min(8).max(80);

const schema1 = z.enum(["eou","llm","tts","decision","hold","e2e"]);

const schema2 = z.literal("interrupt_stop");

const schema3 = z.union([schema1, schema2]);

const schema4 = z.int().min(-9007199254740991).max(9007199254740991);

const schema5 = z.number();

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

const schema13 = z.strictObject({
  "first_at": schema12,
  "last_at": schema12,
  "lines": schema4,
});

const schema14 = z.strictObject({
  "latency_ms": schema7,
  "status": schema8,
  "sourceRole": schema9,
  "coverage": schema13,
});

const schema15 = z.literal("unavailable");

const schema16 = z.enum(["not_closed","unconfigured","missing","invalid","oversized","unscorable","no_measured_latency","timeout","aborted","storage_unavailable"]);

const schema17 = z.strictObject({
  "status": schema15,
  "reason": schema16,
});

const schema18 = z.union([schema14, schema17]);

const schema19 = z.string().min(1).max(200);

const schema20 = z.union([schema19, schema11]);

const schema21 = z.string().regex(new RegExp("^[0-9a-f]{40}$"));

const schema22 = z.union([schema21, schema11]);

const schema23 = z.literal("cloudflare-worker-version");

const schema24 = z.literal("authenticated-worker-heartbeat");

const schema25 = z.union([schema24, schema11]);

const schema26 = z.string().min(1).max(160);

const schema27 = z.union([schema26, schema11]);

const schema28 = z.int().min(0).max(9007199254740991);

const schema29 = z.union([schema28, schema11]);

const schema30 = z.iso.datetime({ offset: true }).regex(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"));

const schema31 = z.union([schema30, schema11]);

const schema32 = z.strictObject({
  "deploymentSource": schema23,
  "workerSource": schema25,
  "workerId": schema27,
  "podStartedAtMs": schema29,
  "workerObservedAt": schema31,
});

const schema33 = z.strictObject({
  "deploymentId": schema20,
  "workerRevision": schema22,
  "provenance": schema32,
});

const schema34 = z.string();

const schema35 = z.union([schema34, schema11]);

const schema36 = z.enum(["reserved","started","released","failed"]);

const schema37 = z.number().min(0);

const schema38 = z.union([schema37, schema11]);

const schema39 = z.custom<Record<string, unknown>>((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value));

const schema40 = z.strictObject({
  "sessionId": schema0,
  "speechDiagnostics": schema18.optional(),
  "releaseIdentity": schema33.optional(),
  "avatarId": schema35,
  "avatarName": schema35,
  "status": schema36,
  "startedAt": schema35,
  "endedAt": schema35,
  "activeSeconds": schema38,
  "billedCreditMicros": schema29,
  "metadata": schema39,
  "createdAt": schema34,
});

const schema41 = z.array(schema40);

const schema42 = z.iso.datetime({ offset: true }).regex(new RegExp("^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"));

const schema43 = z.strictObject({
  "data": schema41,
  "nextCursor": schema35,
  "from": schema42,
  "to": schema42,
});

export const listUsageSessionsResponseSchema = schema43 satisfies z.ZodType<Wire["ListUsageSessionsResponse"], Wire["ListUsageSessionsResponse"]>;
type AssertTrue<Value extends true> = Value;
type _ListUsageSessionsAcceptsWire = AssertTrue<
  [Wire["ListUsageSessionsResponse"]] extends [z.input<typeof listUsageSessionsResponseSchema>] ? true : false
>;

export function toSessionsPage(page: z.infer<typeof listUsageSessionsResponseSchema>) {
  const { data, ...pagination } = page;
  return { ...pagination, sessions: data };
}
