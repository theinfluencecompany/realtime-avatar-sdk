/**
 * The contract between `createProxyClient` (the page) and `createProxyHandler` (your route).
 *
 * One declaration for both halves: the client builds its bodies from these types and the route
 * validates what arrives against these schemas, once, as `unknown`. Until this existed the route
 * cast `request.json()` to the shape it hoped for, so a body of literal `null` threw a TypeError
 * out of the handler, and a queued release could not be told apart from a session release.
 */
import { z } from "zod";
import { liveKitSessionReleaseReasonSchema, sessionModeSchema } from "./wire.ts";

/**
 * `POST …/connect`. The page chooses WHO to call and whether it wants video. Nothing else: a
 * policy field sent here is dropped rather than refused, because the route's `session` hook is
 * the only source of policy and a stale page should not lose its call over a key it no longer
 * gets to set.
 */
export const proxyConnectRequestSchema = z.object({
  avatarId: z.string().min(1),
  mode: sessionModeSchema.optional(),
});
export type ProxyConnectRequest = z.infer<typeof proxyConnectRequestSchema>;

/**
 * `POST …/end`. A started call is released by its session id; a call still waiting in line has no
 * session yet and is released by its queue ticket. At least one, and both are allowed, as the
 * platform's release contract allows them. Lengths are the platform's to judge: the route
 * forwards ids it minted and never stores what it is sent.
 *
 * `reason` is diagnostic. One this SDK does not know is not a reason to keep a slot held, so it
 * reads as absent (released as `manual`) rather than refusing the release.
 */
export const proxyEndRequestSchema = z
  .object({
    session_id: z.string().min(1).optional(),
    queue_ticket_id: z.string().min(1).optional(),
    reason: liveKitSessionReleaseReasonSchema.optional().catch(undefined),
  })
  .strict()
  .refine((body) => body.session_id !== undefined || body.queue_ticket_id !== undefined, {
    message: "session_id or queue_ticket_id is required",
  });
export type ProxyEndRequest = z.infer<typeof proxyEndRequestSchema>;
