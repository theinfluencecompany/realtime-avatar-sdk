import { z } from "zod";

export const motionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine(value => !["__proto__", "constructor", "prototype"].includes(value), "Reserved identifier");

function motionRecord<T extends z.ZodType>(valueSchema: T) {
  const record = z.record(motionIdSchema, valueSchema);
  // Zod records skip __proto__; reject it before validation without erasing the input type.
  // `preprocess` rather than `transform().pipe()`: the pipe has to prove its own input type,
  // which it cannot while the value schema is still generic — zod 4.6 made that a hard error.
  return z.preprocess((value, ctx) => {
    if (value !== null && typeof value === "object" && Object.hasOwn(value, "__proto__")) {
      ctx.addIssue({ code: "custom", path: ["__proto__"], message: "Reserved identifier" });
    }
    return value;
  }, record);
}

export const clipSourceSchema = z.union([
  z.strictObject({ assetId: z.string().trim().min(1).max(160) }),
  z.strictObject({
    motionPrompt: z.string().trim().min(1).max(1200),
    durationSeconds: z.int().min(4).max(8).optional(),
  }),
]);

export const clipDeclarationSchema = z.strictObject({ source: clipSourceSchema });

/** Interchangeable candidates, drawn uniformly. Order carries no meaning. */
export const clipListSchema = z.array(motionIdSchema).min(1).max(32)
  .superRefine((clips, ctx) => {
    const seen = new Set<string>();
    clips.forEach((clip, index) => {
      if (seen.has(clip)) {
        ctx.addIssue({ code: "custom", path: [index], message: `"${clip}" is already a candidate here` });
      }
      seen.add(clip);
    });
  });

/**
 * Backward-compatible authoring input for one weighted idle pool.
 * The stored source is a normal candidate named `primary`; member weights may disable it.
 * Explicit `weights` default each omitted member to 1.
 * `weight` remains the aggregate weight of the authored clips and is divided
 * equally among them with source weight 1 before availability filtering.
 * There is no separate rest coin.
 * Repetition is avoided for every member when another candidate is available;
 * a sole available member may complete another traversal.
 */
export const idleWeightSchema = z.number().min(0).max(100);

export const idleSchema = z.strictObject({
  clips: clipListSchema,
  /** Legacy aggregate weight. Mutually exclusive with member weights. */
  weight: idleWeightSchema.optional(),
  /** Per-member weights, including `primary`; omitted members default to 1. */
  weights: motionRecord(idleWeightSchema).optional(),
}).superRefine((idle, ctx) => {
  if (idle.weights === undefined) return;
  if (idle.weight !== undefined) {
    ctx.addIssue({ code: "custom", path: ["weight"], message: "Use weight or weights, not both" });
  }
  const members = new Set(["primary", ...idle.clips]);
  for (const clip of Object.keys(idle.weights)) {
    if (!members.has(clip)) {
      ctx.addIssue({ code: "custom", path: ["weights", clip], message: "Unknown idle member" });
    }
  }
  if (![...members].some(clip => (idle.weights?.[clip] ?? 1) > 0)) {
    ctx.addIssue({ code: "custom", path: ["weights"], message: "Idle pool needs a positive member" });
  }
});

export const clipActionSchema = z.strictObject({
  description: z.string().trim().min(1).max(512),
  clips: clipListSchema,
});

const clipBehaviorFields = z.strictObject({
  idle: idleSchema.optional(),
  /** AUTOMATIC — one reaction per speech episode, then back to idle. */
  on: z.strictObject({
    userSpeechStarted: z.strictObject({ clips: clipListSchema }).optional(),
  }).optional(),
  /** REQUESTABLE, not automatic: declaring an action does not play it. */
  actions: motionRecord(clipActionSchema).optional(),
});
export const clipBehaviorSchema = clipBehaviorFields;

function* clipReferences(
  behavior: ClipBehavior,
): Generator<{ clips: readonly string[]; path: (string | number)[] }> {
  if (behavior.idle) yield { clips: behavior.idle.clips, path: ["idle", "clips"] };
  const listening = behavior.on?.userSpeechStarted;
  if (listening) yield { clips: listening.clips, path: ["on", "userSpeechStarted", "clips"] };
  for (const [id, action] of Object.entries(behavior.actions ?? {})) {
    yield { clips: action.clips, path: ["actions", id, "clips"] };
  }
}

export const clipLibraryDeclarationSchema = z.strictObject({
  /** CAS against the served revision: two editors cannot silently overwrite each other. */
  expectedRevision: z.int().nonnegative(),
  /** The complete desired media set. Anything omitted is retired. */
  clips: motionRecord(clipDeclarationSchema).nonoptional(),
  ...clipBehaviorFields.shape,
}).superRefine((library, ctx) => {
  // The stored source is the implicit rest state, not authored media: declaring it here
  // would be a second copy of the avatar's own source fact, stale on the next swap.
  if (Object.hasOwn(library.clips, "primary")) {
    ctx.addIssue({
      code: "custom",
      path: ["clips", "primary"],
      message: 'The avatar\'s stored source is the rest state and is not declared — pick another id',
    });
  }
  for (const { clips, path } of clipReferences(library)) {
    clips.forEach((clip, index) => {
      if (Object.hasOwn(library.clips, clip)) return;
      ctx.addIssue({ code: "custom", path: [...path, index], message: `Unknown clip "${clip}"` });
    });
  }
});

export type ClipSource = z.infer<typeof clipSourceSchema>;
export type ClipIdle = z.infer<typeof idleSchema>;
export type ClipAction = z.infer<typeof clipActionSchema>;
export type ClipBehavior = z.infer<typeof clipBehaviorFields>;
export type ClipLibraryDeclaration = z.infer<typeof clipLibraryDeclarationSchema>;

/** Compile legacy input before filtering; the source is an ordinary pool member. */
export function idlePoolWeights(idle: ClipIdle | undefined): ReadonlyMap<string, number> {
  if (idle?.weights !== undefined) {
    return new Map(["primary", ...idle.clips].flatMap(clip => {
      const weight = idle.weights?.[clip] ?? 1;
      return weight > 0 ? [[clip, weight]] : [];
    }));
  }
  const pool = new Map<string, number>([["primary", 1]]);
  const weight = idle?.weight ?? 1;
  const members = [...new Set((idle?.clips ?? []).filter(clip => clip !== "primary"))];
  if (weight > 0 && members.length > 0) {
    for (const clip of members) pool.set(clip, weight / members.length);
  }
  return pool;
}

/** `primary` addresses idleUrl; null means no available candidate, not a rest draw. */
export function selectIdleClip(
  idle: ClipIdle | undefined,
  options: { available: (clip: string) => boolean; current: string | null; random?: () => number },
): string | null {
  const available = [...idlePoolWeights(idle)].filter(([clip]) => options.available(clip));
  const alternatives = available.filter(([clip]) => clip !== options.current);
  const candidates = alternatives.length > 0 ? alternatives : available;
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0][0];
  let draw = (options.random ?? Math.random)() * candidates.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [clip, weight] of candidates) {
    draw -= weight;
    if (draw < 0) return clip;
  }
  return candidates[candidates.length - 1][0];
}

/** A listening reaction or an action's variant: uniform, never excluded for repeating. */
export function selectTriggeredClip(
  clips: readonly string[],
  options: { available: (clip: string) => boolean; random?: () => number },
): string | null {
  const random = options.random ?? Math.random;
  const candidates = clips.filter(options.available);
  if (candidates.length === 0) return null;
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
}

export const companionSessionRequestSchema = z.strictObject({
  avatar_id: z.string().min(1).max(160),
  queue_ticket_id: z.string().min(1).max(160).optional(),
  max_session_seconds: z.int().positive().max(180),
});
export type CompanionSessionRequest = z.infer<typeof companionSessionRequestSchema>;

export const publicMotionAssetsSchema = z.object({
  avatarId: z.string(),
  name: z.string(),
  poster: z.string().url().nullable(),
  idleUrl: z.string().url(),
  revision: z.int().nonnegative(),
  behavior: clipBehaviorSchema,
  clips: z.array(z.strictObject({ id: motionIdSchema, url: z.url() })),
}).strict();
export type PublicMotionAssets = z.infer<typeof publicMotionAssetsSchema>;
