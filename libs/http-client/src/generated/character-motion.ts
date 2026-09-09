import { z } from "zod";

export const motionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine(value => !["__proto__", "constructor", "prototype"].includes(value), "Reserved identifier");

function motionRecord<T extends z.ZodType>(valueSchema: T) {
  const record = z.record(motionIdSchema, valueSchema);
  // Zod records skip __proto__; reject it before validation without erasing the input type.
  return z.transform((value: z.input<typeof record>, ctx) => {
    if (value !== null && typeof value === "object" && Object.hasOwn(value, "__proto__")) {
      ctx.addIssue({ code: "custom", path: ["__proto__"], message: "Reserved identifier" });
    }
    return value;
  }).pipe(record);
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
 * VARIATIONS ON RESTING, weighted against resting itself.
 *
 * The avatar's stored source is the rest state — it always exists, it is where cold media
 * degrades to, and it is the one clip that may play twice running. So it is not a candidate
 * an author lists; `weight` says how often a variation happens INSTEAD of resting (absent
 * ⇒ 1 ⇒ half the time, 0 ⇒ declared but currently off).
 *
 * A variation never immediately follows itself, so the same motion cannot stutter. With
 * every variation filtered out — cold, or the one already playing — she simply keeps
 * resting, which needs no fallback branch because resting IS the other side of the draw.
 */
export const idleSchema = z.strictObject({
  clips: clipListSchema,
  weight: z.number().min(0).max(100).optional(),
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

/** `null` ⇒ keep resting. Resting is the other side of the draw, not a fallback branch. */
export function selectIdleClip(
  idle: ClipIdle | undefined,
  options: { available: (clip: string) => boolean; current: string | null; random?: () => number },
): string | null {
  if (!idle) return null;
  const random = options.random ?? Math.random;
  // A variation never immediately follows itself; resting always may.
  const candidates = idle.clips.filter(clip => options.available(clip) && clip !== options.current);
  if (candidates.length === 0) return null;
  const weight = idle.weight ?? 1;
  // Filtered BEFORE the draw, so cold or excluded members shrink the CHOICE, never the
  // odds of doing something at all — that share is authored, not derived from a count.
  if (weight <= 0 || random() * (weight + 1) >= weight) return null;
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
}

/** A listening reaction or an action's variant: uniform, never excluded for repeating. */
export function selectTriggeredClip(
  clips: readonly string[],
  options: { available: (clip: string) => boolean; random?: () => number },
): string | null {
  const random = options.random ?? Math.random;
  const candidates = clips.filter(options.available);
  if (candidates.length === 0) return null;
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
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
