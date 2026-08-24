/**
 * The CONNECT surface (server half) — one function that turns "I have an API key and a
 * character in my database" into a working mint endpoint.
 *
 * WHY THIS EXISTS. `handleRealtimeAvatarProxy` is a faithful courier: it forwards the
 * request body verbatim. That is correct for a proxy and wrong for an integrator, because
 * making the persona/voice/ceiling server-authoritative then requires them to know
 *   (a) which body keys a browser must never be allowed to set,
 *   (b) that the wire is snake_case while their SDK call was camelCase,
 *   (c) that the wire schema is strict, so a mis-cased key is a REJECTED mint, and
 *   (d) the strip -> merge -> rebuild-the-Request dance, including deleting content-length.
 * Every integration re-derived that, and each one is a chance to leave a forgeable field open.
 *
 * So this handler owns all four. The integrator writes ONE typed callback that returns a
 * policy for this caller — persona, memory, voice, ceiling — in ordinary camelCase, and
 * never sees a wire shape, a header, or a Request rebuild. Fields the policy does not set
 * are stripped rather than passed through, so "I forgot to set it" fails closed instead of
 * inheriting whatever the client sent.
 */
import { handleRealtimeAvatarProxy, type RealtimeAvatarProxyOperation } from "../server/proxy";

type MaybePromise<T> = T | Promise<T>;
type ApiKeyFactory = string | (() => MaybePromise<string | null | undefined>);

/** A prior message replayed as conversation history when the call opens. */
export type ConnectContextMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** One looping clip the character can rest in or play. Hosted on YOUR storage. */
export type ConnectClip = {
  id: string;
  url: string;
  /**
   * When she should use this clip, in plain English — e.g. "when she's flustered". Read by
   * the CHARACTER, so it is a sentence and not a predicate. The same field, and the same
   * word, as {@link ConnectVideoState.when}.
   */
  when?: string;
  /**
   * What SELECTS the clip, when it is not the character choosing it by `when`. Defaults to
   * the resting rotation, or to `"cue"` when `when` is set.
   *
   * `"think"` is RETIRED (2026-08-17) and selects nothing. It stays in the union because
   * removing it is a breaking type change for compiling callers, and it is still accepted
   * on the wire so the characters that carry a legacy think clip keep minting — but the
   * worker drops the clip at its parse boundary, so a pose sent this way never plays and
   * nothing tells you. The state it waited on is the ~600ms plan window; the clip authored
   * for it is 3-5s and plays to completion, so it could only ever land late and land wrong.
   * Use `"cue"` with a `when` sentence for a pondering pose.
   *
   * (No `@deprecated` tag on purpose — JSDoc attaches it to the FIELD, which would strike
   * through the live `"idle"` / `"listen"` / `"cue"` values too.)
   */
  on?: "idle" | "listen" | "think" | "cue";
  /** Relative pick-probability inside its pool. A rare one-shot wants ~0.1. */
  weight?: number;
};

/**
 * One named state the character can be in, and the plain-English condition that should put
 * her there. The condition is read by the character herself — she picks the state that fits
 * what is happening, which is why it is a sentence and not a predicate you have to evaluate.
 */
export type ConnectVideoState = {
  /** When she should be in this state, e.g. "when the user is happy". */
  when: string;
  /** A closed-loop clip on public storage. */
  url: string;
  /** Relative likelihood against sibling states. Defaults to 1. */
  weight?: number;
};

/**
 * How this call is rendered.
 *
 * `looping` (default) animates speech onto real video you supply — one loop, or a MAP of
 * named states we compile into a state machine and switch between automatically.
 * `generative` synthesizes the video instead, so it needs no clips at all.
 *
 * A discriminated union rather than optional fields: passing clips to a generative call is
 * a contradiction, and this makes it unrepresentable instead of silently ignored.
 */
/**
 * Rewrite the loop instead of replaying it: her clip, streamed through a diffusion editor
 * under a prose instruction, then lip-synced by the same path as an unedited one.
 *
 * Editing runs UPSTREAM of the lips, on the closed-mouth plate, so it adds no time to the
 * first word — she is on screen and talking from frame one, she simply has not changed
 * clothes yet. The first lap is live and expensive; later laps replay a banked loop, so a
 * STATIC instruction converges on the cost of plain looping. Every change of direction buys
 * a fresh lap and a visible style pop, which is why `live.rules` should be written narrowly.
 *
 * REQUIRES A CLIP TO EDIT — which is why it lives on this arm rather than beside `mode`.
 */
export type ConnectVideoEdits = {
  /** What to make the set look like, as prose — e.g. "a snowy cabin at night". 1–1000 chars. */
  instruction: string;
  /** Reference image for reference-guided editing ("put THIS hat on her"). */
  referenceUrl?: string;
  /** Let the look follow the conversation instead of holding still for the whole call. */
  live?: {
    /**
     * YOUR standing brief for what the conversation is allowed to change, 1–2000 chars.
     * Server-owned on purpose: this is the app's policy about what an end user may do to
     * the picture, so a browser that could set it could redress the character at will.
     */
    rules: string;
    /** Seconds a look must hold before the next edit may run, 5–600. Absent ⇒ the worker default. */
    cooldownSeconds?: number;
  };
};

export type ConnectVideo =
  | {
      mode?: "looping";
      /** The one clip she rests in. Omit to use the avatar's stored source video. */
      loop?: string;
      /** Named states, keyed by id — the map we compile into the state machine. */
      states?: Record<string, ConnectVideoState>;
      /**
       * Rewrite the loop under a prose instruction. On this arm BY CONSTRUCTION: the one
       * pairing the wire refuses — edits on a generative session, which synthesizes its own
       * body and so has no supplied clip to open — is not a shape this type can express.
       */
      edits?: ConnectVideoEdits;
    }
  | { mode: "generative" };

/**
 * What the SERVER decides about this call. Everything here is authoritative: whatever the
 * caller's client sent for these concerns is discarded.
 */
export type ConnectPolicy = {
  /** How this call is rendered — one loop, a state map, or generated. */
  video?: ConnectVideo;
  /** The character's behavior contract (system prompt). */
  instructions?: string;
  /** Prior turns, so the call continues a story instead of starting cold. */
  context?: readonly ConnectContextMessage[];
  /** Hard ceiling in seconds — compute it from the balance you just admitted. */
  maxSeconds?: number;
  /** Looping clips for this call. */
  clips?: readonly ConnectClip[];
  /** Receive the two-sided transcript at teardown, HMAC-signed with `secret`. */
  transcript?: { url: string; secret: string };
  /** Opaque correlation echoed verbatim on the transcript, so you can attribute it. */
  metadata?: Record<string, string>;
  /**
   * Let the character call functions that run in the USER'S BROWSER (`attachAvatarTools`).
   *
   * This is the only way to grant it. `capabilities` is in {@link SERVER_OWNED_KEYS}, so a
   * browser asking for the capability has the field stripped before the request leaves the
   * handler — which is the point, since a page that could grant itself tool execution could
   * run tools on any call the policy forgot to think about.
   *
   * Until this field existed the capability was unreachable through this handler at all: the
   * browser's copy was discarded and the policy had nothing to put back, so the only path was
   * to bypass the proxy and mint with `RealtimeAvatar({ clientTools: true })` server-side.
   */
  clientTools?: boolean;
  /**
   * Voice override for this call. Left alone when omitted (the character's default is
   * used); pass `null` to explicitly clear it. Shape is intentionally passthrough — the
   * voice catalog is the one place the wire vocabulary is the product vocabulary.
   */
  voice?: unknown;
};

export type ConnectSessionContext = {
  request: Request;
  /** Which character the caller is asking for. */
  avatarId: string;
  /** `voice` is the audio-only on-ramp; `avatar` is the full call. */
  mode: "avatar" | "voice";
};

export type CreateRealtimeAvatarHandlerOptions = {
  apiKey: ApiKeyFactory;
  /** Where you mounted this handler. Must match the client's `proxyUrl`. */
  pathPrefix?: string;
  /**
   * Gate every operation. Return a Response to refuse (401/402/403); return nothing to
   * allow. Exactly one operation costs money to start — `"connect"` — so that is where a
   * wallet check belongs; the rest are cheap reads.
   */
  authorize?: (context: {
    request: Request;
    operation: "connect" | "release" | "read";
  }) => MaybePromise<Response | void | null>;
  /**
   * Decide the call. Return a policy, or a Response to refuse. Omit it only if you are
   * genuinely happy for the character's stored defaults to govern every call.
   */
  session?: (context: ConnectSessionContext) => MaybePromise<ConnectPolicy | Response>;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export type RealtimeAvatarHandler = {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  PATCH(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
};

/**
 * Body keys the SERVER owns. Stripped from the caller's body on every connect, whether or
 * not the policy replaces them — a field the policy leaves unset must be ABSENT, not
 * inherited from the client. This is the whole security property of the handler.
 */
const SERVER_OWNED_KEYS = [
  "instructions",
  "initial_context",
  "initial_say",
  "clip_library",
  "choreography",
  "behavior",
  "scene_graph",
  "capabilities",
  "transcript_webhook",
  "extend_secret",
  "client_metadata",
  "max_session_seconds",
  "voice",
  "voice_id",
  "render_backend",
  "source_kind",
  "source_video_url",
  // `live_edit.rules` is the app's policy about what an end user may do to the picture, so a
  // browser that could set this could redress the character on any call whose policy omits
  // `edits`. Server-owned like every other key here.
  "support_edits",
  "video_cache_id",
] as const;

/** Map the proxy's fine-grained operations onto the three the integrator actually gates. */
function coarseOperation(operation: RealtimeAvatarProxyOperation): "connect" | "release" | "read" {
  if (operation === "realtime.livekitSession") return "connect";
  if (operation === "realtime.livekitSessionRelease") return "release";
  return "read";
}

/** A connect request is the only body carrying both a character and a mode. */
function readConnectBody(body: unknown): { avatarId: string; mode: "avatar" | "voice" } | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.avatar_id !== "string" || !("mode" in record)) return null;
  return { avatarId: record.avatar_id, mode: record.mode === "voice" ? "voice" : "avatar" };
}

/** camelCase policy -> the strict snake_case wire. The one place that translation lives. */
function policyToWire(policy: ConnectPolicy): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (policy.instructions !== undefined) wire.instructions = policy.instructions;
  if (policy.context !== undefined) {
    wire.initial_context = policy.context.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }
  if (policy.maxSeconds !== undefined) wire.max_session_seconds = Math.floor(policy.maxSeconds);
  if (policy.voice !== undefined) wire.voice = policy.voice;
  if (policy.clips !== undefined) {
    wire.clip_library = policy.clips.map((clip) => {
      const entry: Record<string, unknown> = { clip_id: clip.id, source_video_url: clip.url };
      // `cue` is the product word for a clip that plays only when it is named.
      if (clip.on !== undefined) entry.trigger = clip.on === "cue" ? "directive" : clip.on;
      if (clip.when !== undefined) entry.when = clip.when;
      if (clip.weight !== undefined) entry.weight = clip.weight;
      return entry;
    });
  }
  if (policy.video !== undefined) {
    const video = policy.video;
    if (video.mode === "generative") {
      wire.render_backend = "generative";
    } else {
      // A supplied loop replaces the avatar's stored source video for this call, which the
      // wire models as an explicit source kind — set both or the call is rejected.
      if (video.loop) {
        wire.source_kind = "source_video";
        wire.source_video_url = video.loop;
      }
      // The state MAP is the state machine: each entry becomes a clip the character can move
      // to, and `when` becomes the cue she reads to decide. Ids are the map keys, so they are
      // already unique and already meaningful in her menu.
      //
      // No `trigger` here on purpose. `when` with no explicit trigger already means "she
      // chooses this by its description" on the wire, and that rule belongs to the schema
      // alone — restating it here would be a second copy free to drift.
      if (video.states) {
        wire.clip_library = Object.entries(video.states).map(([id, state]) => {
          const entry: Record<string, unknown> = {
            clip_id: id,
            source_video_url: state.url,
            when: state.when,
          };
          if (state.weight !== undefined) entry.weight = state.weight;
          return entry;
        });
      }
      // VIDEO EDITS. Inside the looping arm BY CONSTRUCTION — no runtime check is needed
      // because the union cannot express edits on a generative session, which is exactly
      // the pairing the wire refuses (a synthesized body has no supplied clip to edit).
      if (video.edits) {
        const edits: Record<string, unknown> = { instruction: video.edits.instruction };
        if (video.edits.referenceUrl !== undefined) edits.reference_url = video.edits.referenceUrl;
        if (video.edits.live !== undefined) {
          const live: Record<string, unknown> = { rules: video.edits.live.rules };
          if (video.edits.live.cooldownSeconds !== undefined) {
            live.cooldown_seconds = Math.floor(video.edits.live.cooldownSeconds);
          }
          edits.live_edit = live;
        }
        wire.support_edits = edits;
      }
    }
  }
  if (policy.transcript !== undefined) {
    wire.transcript_webhook = { url: policy.transcript.url, secret: policy.transcript.secret };
  }
  if (policy.metadata !== undefined) wire.client_metadata = policy.metadata;
  // Only ever ADD the capability. `false` must leave `capabilities` absent rather than
  // sending an empty array, because the two are not the same request upstream and the
  // stripped-then-unset path is what a policy that never mentions tools relies on.
  if (policy.clientTools) wire.capabilities = ["client_tools"];
  return wire;
}

/**
 * Mount one handler and the whole connect path is done: auth, the server-authoritative
 * policy, and the upstream call.
 *
 * ```ts
 * export const { GET, POST } = createRealtimeAvatarHandler({
 *   apiKey: process.env.REALTIME_AVATAR_API_KEY!,
 *   authorize: async ({ operation }) => {
 *     const user = await currentUser();
 *     if (!user) return new Response("Unauthorized", { status: 401 });
 *     if (operation === "connect" && !(await hasCredits(user))) {
 *       return Response.json({ code: "insufficient_credits" }, { status: 402 });
 *     }
 *   },
 *   session: async ({ avatarId }) => {
 *     const character = await db.character(avatarId);
 *     return { instructions: character.prompt, maxSeconds: 900 };
 *   },
 * });
 * ```
 */
export function createRealtimeAvatarHandler(
  options: CreateRealtimeAvatarHandlerOptions,
): RealtimeAvatarHandler {
  const proxyOptions = {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    pathPrefix: options.pathPrefix,
    requireAuth: options.authorize
      ? ({ request, operation }: { request: Request; operation: RealtimeAvatarProxyOperation }) =>
          options.authorize?.({ request, operation: coarseOperation(operation) })
      : undefined,
  };

  const handle = async (request: Request): Promise<Response> => {
    // Non-connect traffic (and the no-policy case) needs no rewriting — forward as-is.
    if (request.method !== "POST" || !options.session) {
      return handleRealtimeAvatarProxy(request, proxyOptions);
    }

    // Clone: the proxy still needs an unread body if this turns out not to be a connect.
    const body = await request
      .clone()
      .json()
      .catch(() => null);
    const connect = readConnectBody(body);
    if (!connect) return handleRealtimeAvatarProxy(request, proxyOptions);

    const decided = await options.session({ request, avatarId: connect.avatarId, mode: connect.mode });
    if (decided instanceof Response) return decided;

    const caller = { ...(body as Record<string, unknown>) };
    for (const key of SERVER_OWNED_KEYS) delete caller[key];

    const headers = new Headers(request.headers);
    headers.delete("content-length"); // the body changed — let the runtime recompute it
    const forwarded = new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...caller, ...policyToWire(decided) }),
    });
    return handleRealtimeAvatarProxy(forwarded, proxyOptions);
  };

  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle };
}
