/**
 * What the React bindings actually need from a client: mint a call, and give the slot back.
 *
 * They used to demand `RealtimeAvatarClient` itself, and that is why `AvatarCall` could not be
 * used at all. The component is exported at runtime from `realtime-avatar/react` and required
 * `client: RealtimeAvatarClient` — but that package exports no client constructor, because the
 * class carries an API-key path and keeping it out of the browser is what took `apiKey`/`Bearer`
 * to zero occurrences in the shipped bundles. So the prop named a type no consumer could produce.
 *
 * The fix is nominal, not structural: the bindings depend on this INTERFACE instead of on that
 * class. Anything with these five methods satisfies it — a fake in a test, or a thin fetch wrapper
 * over an app's own proxy routes, which is what an integrator writes anyway.
 *
 * The carried class itself is GONE as of 2026-08-26. Once nothing named it, a module-graph walk
 * (`npm run reachable`) showed it and six files with it were reachable from nothing at all: 1,230
 * lines of a second HTTP client, a second error path and a second key parser, shipping nowhere.
 * So this interface is now the only client contract in the repo, which is the point.
 *
 * The LLM-provider generic is KEPT. It pairs the client with `session: LiveKitSessionRequest<T>`,
 * so a client built for one provider set still cannot be handed a session requesting another —
 * that check was never what made the prop unusable, and giving it up would have bought nothing.
 */
import type { LiveKitSessionRequest } from "./livekit-grant";
import type {
  CapacityBusyResponse,
  LiveKitSessionGrant,
  LiveKitSessionReleaseReason,
  LLMProvider,
} from "./wire";

/** Per-request escape hatches. Lives here, not on the client, so the React half never imports it from there. */
export type RealtimeAvatarRequestOptions = {
  signal?: AbortSignal;
  headers?: HeadersInit;
};

/**
 * Capacity exhaustion is a VALUE here, not a throw — `queued` is not an error, and modelling it
 * as one is the most common bad first impression an integration makes.
 */
export type LiveKitSessionStartResult =
  | { status: "ready"; grant: LiveKitSessionGrant }
  | { status: "busy"; busy: CapacityBusyResponse };

export interface AvatarSessionClient<TLlmProvider extends LLMProvider = LLMProvider> {
  /** Mint a call, or report that every slot is busy. Never throws for capacity. */
  createLiveKitSessionOrBusy(
    input: LiveKitSessionRequest<TLlmProvider>,
    options?: RealtimeAvatarRequestOptions,
  ): Promise<LiveKitSessionStartResult>;
  /**
   * Free a started call's slot. Returns `false` rather than throwing — a release that is lost
   * is a slower release, never a broken page, because the join timeout is the backstop.
   */
  releaseLiveKitSession(
    sessionId: string,
    reason?: LiveKitSessionReleaseReason,
    options?: RealtimeAvatarRequestOptions,
  ): Promise<boolean>;
  /**
   * The `pagehide` path. `sendBeacon` is the one send that outlives a closing page, and it is
   * synchronous-or-nothing — hence a `boolean` return and no promise, so the caller can fall
   * back to {@link releaseLiveKitSession} when the browser has no beacon.
   */
  releaseLiveKitSessionBeacon(sessionId: string, reason?: LiveKitSessionReleaseReason): boolean;
  /**
   * A queued call holds no session id yet, so {@link releaseLiveKitSession} cannot free it.
   * This is the queue's own release.
   */
  releaseLiveKitQueueTicket(
    queueTicketId: string,
    reason?: LiveKitSessionReleaseReason,
    options?: RealtimeAvatarRequestOptions,
  ): Promise<boolean>;
  releaseLiveKitQueueTicketBeacon(queueTicketId: string, reason?: LiveKitSessionReleaseReason): boolean;
}
