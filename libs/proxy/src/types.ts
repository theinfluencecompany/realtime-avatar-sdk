import type { CallPolicy, CallMode } from "realtime-avatar";

/** The three things a caller can ask the proxy to do. Gate on these, not on URLs. */
export type ProxyOperation = "connect" | "end" | "avatars" | "credits";

export interface AuthorizeContext {
  request: Request;
  operation: ProxyOperation;
}

export interface SessionContext {
  request: Request;
  /** Which character the caller asked for. Validate it — it came from the client. */
  avatarId: string;
  mode: CallMode;
}

export interface ProxyConfig {
  /** Server-only. `tic_live_…` / `tic_test_…`. */
  apiKey: string | (() => string | Promise<string>);
  baseUrl?: string;

  /**
   * Who may do this. Return a `Response` to refuse, or nothing to allow.
   *
   * `connect` is the only operation that costs money to start, so that is where a wallet
   * check belongs. Leaving the reads ungated keeps them cheap.
   */
  authorize?: (context: AuthorizeContext) => Promise<Response | void> | Response | void;

  /**
   * Does this request own that session? Answer for `POST …/end`.
   *
   * Without it the handler remembers what it minted IN PROCESS, which is correct for one
   * server and wrong for serverless, where the next request lands somewhere else and every
   * release is silently declined. Back this with whatever already knows which user started
   * which call, and return false for anything else — rule 12 exists because a route that
   * ends an arbitrary id lets any visitor hang up any call on your account.
   */
  ownsSession?: (context: { request: Request; sessionId: string }) => Promise<boolean> | boolean;

  /**
   * What the character knows for THIS call. Return a policy, or a `Response` to refuse.
   *
   * Whatever the browser sent for these concerns is discarded — this is the only source.
   * A field you do not set is absent rather than inherited, so an omission fails closed.
   */
  session?: (context: SessionContext) => Promise<CallPolicy | Response> | CallPolicy | Response;
}
