/**
 * The contract between `createProxyClient` (the page) and `createProxyHandler` (your route).
 *
 * One declaration for both halves: the client builds its bodies from these types and the route
 * validates what arrives against these schemas, once, as `unknown`. Until this existed the route
 * cast `request.json()` to the shape it hoped for, so a body of literal `null` threw a TypeError
 * out of the handler, and a queued release could not be told apart from a session release.
 */
import { z } from "zod";
import { liveKitSessionReleaseReasonSchema } from "./wire.ts";

/**
 * `POST …/connect`. The page chooses WHO to call and whether it wants video. Nothing else: a
 * policy field sent here is dropped rather than refused, because the route's `session` hook is
 * the only source of policy and a stale page should not lose its call over a key it no longer
 * gets to set.
 */
export const proxyConnectRequestSchema = z.object({
  avatarId: z.string().min(1),
  mode: z.enum(["avatar", "voice"]).optional(),
});
export type ProxyConnectRequest = z.infer<typeof proxyConnectRequestSchema>;

/**
 * `POST …/end`. A started call is released by its session id; a call still waiting in line has no
 * session yet and is released by its queue ticket. Exactly one of the two, matching the platform's
 * release contract, which carries them in separate fields.
 */
export const proxyEndRequestSchema = z.union([
  z.object({ session_id: z.string().min(1).max(200), reason: liveKitSessionReleaseReasonSchema.optional() }).strict(),
  z.object({ queue_ticket_id: z.string().min(1).max(200), reason: liveKitSessionReleaseReasonSchema.optional() }).strict(),
]);
export type ProxyEndRequest = z.infer<typeof proxyEndRequestSchema>;
