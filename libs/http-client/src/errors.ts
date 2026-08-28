/** Base for everything this SDK throws, so `catch (e) { if (e instanceof RealtimeAvatarError) }` works. */
export class RealtimeAvatarError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RealtimeAvatarError";
  }
}

/**
 * A non-2xx from the API.
 *
 * `code` is the machine-readable reason when the body was JSON. An HTML body (no `code`)
 * almost always means the route is not served at all rather than that your request was
 * wrong.
 *
 * The ones worth branching on, and what each one asks you to DO — the distinction that
 * matters is retry-vs-don't, because a code you cannot classify becomes either a retry loop
 * against a permanent refusal or a give-up on a transient one:
 *
 * | `code` | | |
 * | --- | --- | --- |
 * | `insufficient_credits` · `spend_limit_exceeded` | 402 | top up; do not retry |
 * | `clip_library_not_enabled` | 403 | per-tenant rollout, not a bad request. Nothing about the body will help |
 * | `loop_not_generatable` | 422 | a grandfathered video-sourced avatar has no portrait to re-animate. **Terminal** |
 * | `clip_declaration_rejected` · `loop_prompt_rejected` | 422 | the prose was refused; rewrite it |
 * | `loop_pending` · `anchor_pending` | 409 | one is already in flight — wait, then retry |
 * | `revision_conflict` | 409 | someone declared first. Re-read `listClips`, re-decide, re-declare |
 * | `clip_render_limit` | 429 | a true rate limit; nothing was applied. Retry later |
 * | `clip_screen_unavailable` | 503 | the prose screen could not run. Retry |
 *
 * Pose validation does NOT appear here: a rejected upload is not an error response at all.
 * The declaration is accepted, and that clip settles `status: "failed"` with the verdict in
 * `poseCheck`.
 *
 * Fields are declared and assigned rather than written as TypeScript parameter properties:
 * that syntax cannot be type-stripped, and this package is meant to run straight from source
 * under `node --experimental-strip-types` as well as from `dist`.
 */
export class RealtimeAvatarHttpError extends RealtimeAvatarError {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: string;

  constructor(status: number, code: string | undefined, body: string) {
    super(`Realtime Avatar API ${status}${code ? ` (${code})` : ""}: ${body || "no body"}`);
    this.name = "RealtimeAvatarHttpError";
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** Out of credits, or over this key's spend limit. Surface a paywall, not an error. */
  get isBilling(): boolean {
    return this.status === 402;
  }
}
