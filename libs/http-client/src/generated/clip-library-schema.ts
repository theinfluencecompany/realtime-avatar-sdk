import { z } from "zod";
import type { components } from "./openapi.ts";
import { clipBehaviorSchema, clipLibraryDeclarationSchema } from "./character-motion.ts";

type Wire = components["schemas"];

/**
 * A schema in this file IS its contract schema, asserted in both directions it can still be
 * asserted in.
 *
 * OUTPUT is the `satisfies z.ZodType<Wire[...]>` on each root: what a parse returns is the wire
 * type and nothing wider. libs/http-client/test/client.test.ts pins it to exact equality.
 *
 * INPUT is `Accepts`, and it is one directional deliberately. It used to be the second argument
 * of the same `satisfies`, which said the schema accepts the wire type AND nothing else. The
 * vendored character-motion.ts now wraps its two motion records in `z.preprocess` with an
 * unannotated callback, so zod infers `unknown` for their input and the "nothing else" half has
 * no expression left. That file is taken byte for byte from the platform under the sha256 pin in
 * `x-clip-contract`, so it cannot be corrected from here. The half that survives is the half a
 * caller leans on: a value of the wire type is accepted. Every shape the lost half used to
 * reject at compile time is asserted at runtime in client.test.ts instead.
 */
type Accepts<Schema extends z.ZodType, Value> = [Value] extends [z.input<Schema>] ? true : false;
type AssertTrue<Value extends true> = Value;

clipLibraryDeclarationSchema satisfies z.ZodType<Wire["PutAvatarClipsRequest"]>;
type _clipLibraryDeclarationSchemaAcceptsWire =
  AssertTrue<Accepts<typeof clipLibraryDeclarationSchema, Wire["PutAvatarClipsRequest"]>>;
export { clipLibraryDeclarationSchema };

const schema0 = z.string();

const schema1 = z.enum(["queued","generating","ready","failed"]);

const schema2 = z.url();

const schema3 = z.null();

const schema4 = z.union([schema2, schema3]);

const schema5 = z.enum(["generated","uploaded"]);

const schema6 = z.union([schema0, schema3]);

const schema7 = z.int().min(-9007199254740991).max(9007199254740991);

const schema8 = z.union([schema7, schema3]);

const schema9 = z.enum(["once","loop"]);

const schema10 = z.boolean();

const schema11 = z.number().min(0).max(1);

const schema12 = z.strictObject({
  "sameSubject": schema10,
  "firstFrameMatchesAnchor": schema10,
  "lastFrameMatchesAnchor": schema10,
  "framingComparable": schema10,
  "confidence": schema11,
});

const schema13 = z.array(schema0);

const schema14 = z.strictObject({
  "verdict": schema12,
  "issues": schema13,
  "firstFrameUrl": schema4,
  "lastFrameUrl": schema4,
});

const schema15 = z.union([schema14, schema3]);

const schema16 = z.strictObject({
  "code": schema0,
  "message": schema0,
});

const schema17 = z.union([schema16, schema3]);

const schema18 = z.strictObject({
  "clipId": schema0,
  "status": schema1,
  "url": schema4,
  "source": schema5,
  "uploadAssetId": schema6,
  "motionPrompt": schema6,
  "durationSeconds": schema8,
  "playback": schema9,
  "anchorVersion": schema7,
  "poseCheck": schema15,
  "error": schema17,
  "createdAt": schema0,
  "updatedAt": schema0,
});

const schema19 = z.array(schema18);

const schema20 = z.int().min(0).max(9007199254740991);

const schema21 = z.int().min(1).max(9007199254740991);

const schema22 = z.enum(["portrait","source_frame"]);

const schema23 = z.strictObject({
  "url": schema2,
  "source": schema22,
  "timeMs": schema8,
});

const schema24 = z.union([schema23, schema3]);

const schema25 = z.strictObject({
  "data": schema19,
  "avatarId": schema0,
  "revision": schema20,
  "anchorVersion": schema21,
  "anchor": schema24,
  "clipLibraryEligible": schema10,
  "defaultSourceAssetId": schema6,
  "behavior": clipBehaviorSchema,
});

const schema26 = z.strictObject({
  "kept": schema13,
  "queued": schema13,
  "retired": schema13,
});

const schema27 = z.strictObject({
  "data": schema19,
  "avatarId": schema0,
  "revision": schema20,
  "anchorVersion": schema21,
  "anchor": schema24,
  "clipLibraryEligible": schema10,
  "defaultSourceAssetId": schema6,
  "behavior": clipBehaviorSchema,
  "plan": schema26,
});

export const clipLibraryResponseSchema = schema25 satisfies z.ZodType<Wire["ListAvatarClipsResponse"]>;
type _clipLibraryResponseSchemaAcceptsWire = AssertTrue<Accepts<typeof clipLibraryResponseSchema, Wire["ListAvatarClipsResponse"]>>;

export const clipLibraryUpdateSchema = schema27 satisfies z.ZodType<Wire["PutAvatarClipsResponse"]>;
type _clipLibraryUpdateSchemaAcceptsWire = AssertTrue<Accepts<typeof clipLibraryUpdateSchema, Wire["PutAvatarClipsResponse"]>>;
