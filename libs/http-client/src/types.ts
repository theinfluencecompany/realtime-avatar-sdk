/**
 * The public shapes. Everything an integrator touches is here, in one file, on purpose:
 * an agent reading this repo should be able to learn the whole surface without following
 * imports.
 *
 * Naming is camelCase throughout. The HTTP wire is snake_case and strict — that translation
 * happens once, inside `client.ts`, and nowhere else.
 *
 * ── WHERE A TYPE COMES FROM ────────────────────────────────────────────────────────────
 *
 *   zod schemas on the platform  (a different repo — the origin, not editable here)
 *     -> https://realtimeavatar.ai/openapi.json          the published contract
 *     -> spec/realtime-avatar.openapi.json               vendored, so a build needs no network
 *     -> src/generated/openapi.ts                        `npm run spec` regenerates; never hand-edit
 *     -> THIS FILE                                       curated, camelCased, derived
 *
 * `npm run spec:check` reports drift between the vendored copy and the live one, and exits 0
 * offline so a fork or an air-gapped runner does not go red for it.
 *
 * THREE types here are NOT derived, and each has a reason rather than an oversight:
 *
 *   ListSessionsOptions   the contract declares NO query parameters on GET /v1/usage/sessions.
 *                         The route reads them; the spec does not describe them. Fixing that
 *                         belongs upstream in the spec export, not here.
 *   TranscriptPayload     the transcript webhook body is not in the published contract at all.
 *                         Same upstream gap, bigger: nothing describes this shape publicly.
 *   VideoPolicy and its   deliberately NOT one-to-one with the wire. `{ loop, states, edits }`
 *   VideoState/VideoEdits is an SDK-designed surface over `clip_library`, `support_edits` and
 *                         `render_backend`. Deriving it would leak three wire concepts into one
 *                         product decision and make the ergonomics hostage to the transport.
 *
 * Everything else indexes into the contract, so `npm run check` is what catches a divergence.
 * Verified by mutation: renaming `participant_token` in the generated file fails the typecheck.
 */

import type { components } from "./generated/openapi.ts";

/**
 * The wire shapes, from the published contract at https://realtimeavatar.ai/openapi.json.
 *
 * The public types below are DERIVED from these rather than declared beside them, so a field
 * whose type changes upstream changes here too, and a field that disappears fails to compile
 * instead of going quietly `undefined` at runtime.
 *
 * What stays hand-written is the CURATION — which fields surface and what they are called.
 * That is a product decision the spec cannot make: the platform's `Avatar` carries a tenant
 * id, a model id and an idle-video status that an integrator has no use for, and `publicUrl`
 * reads better as `url` at the call site. `Pick` keeps that choice explicit and makes it fail
 * loudly if the field it names ever goes away.
 */
type Wire = components["schemas"];

/**
 * Live video and audio (default), or audio only.
 *
 * `mode` picks the RENDERER, not the turn-taking. Both modes run the same full-duplex
 * loop — she listens the entire time she is speaking, and she stops when you cut in.
 * `voice` skips rendering video entirely (cheaper, no video track); `avatar` publishes it.
 *
 * There is deliberately no `duplex` option. An earlier version of this SDK had one, and
 * `{ mode: "avatar", duplex: "full" }` silently rewrote `mode` to `"voice"` — so asking for
 * full duplex cost you the video track. Both modes are full duplex now, so that trade-off
 * is gone. Interruption is not a mode you select — it is how calls work.
 */
export type CallMode = NonNullable<Wire["LiveKitSessionRequest"]["mode"]>;

/**
  * A prior message replayed as memory when the call opens.
  *
  * The contract declares this shape inline inside the request rather than as a named schema, so
  * it is indexed out of the array. At most 32, and `content` is capped at 4,000 characters.
  */
export type ContextMessage = NonNullable<Wire["LiveKitSessionRequest"]["initial_context"]>[number];

/**
 * DERIVATION: hand-written, and deliberately NOT one-to-one with the wire.
 *
 * The contract carries `clip_library`, `support_edits` and `render_backend` as three separate
 * concerns. `video` is one product decision layered over all three, so deriving it would leak
 * the transport's shape into the ergonomics and make this API hostage to how those three
 * happen to be spelled upstream.
 */
/** One named state the character can rest in, and when she should be in it. */
export interface VideoState {
  /**
   * A plain sentence — "when the user is happy". Read by the CHARACTER, not by a rules
   * engine, so write it the way you would brief an actor. `sentiment > 0.7` does nothing.
   */
  when: string;
  /** A closed-loop clip: first frame and last frame on the same rest pose. */
  url: string;
  /** Relative likelihood against sibling states. Default 1. */
  weight?: number;
}

/** DERIVATION: hand-written. Part of the `video` surface — see {@link VideoState}. */
/**
 * Rewrite the clip instead of replaying it as shot: her loop, streamed through a video
 * editing model under a prose instruction, then lip-synced by the same path as an unedited
 * one. An OPTION on `looping`, not a third mode — the character, the voice, the lip-sync
 * and the response latency are all a plain looping call. Only the pixels behind her change.
 */
export interface VideoEdits {
  /**
   * What to make it look like **when the call opens** — "turn the room into a snowy cabin
   * at night", "give her a red wool scarf". Plain prose, read by a video editing model,
   * NOT by the character: it changes the picture, never her behavior. Behavior goes in
   * `instructions`. 1–1000 chars.
   */
  instruction: string;
  /** Reference image for reference-guided editing ("put THIS hat on her"). Accepted; not yet honored. */
  referenceUrl?: string;
  /**
   * Let the clip be **re-edited during the call**, following the conversation. Omit it and
   * `instruction` is the look for the whole session — the object's PRESENCE is the switch;
   * there is no `enabled` flag to drift from it.
   */
  live?: {
    /**
     * What may be re-edited, when, and what must not — plain prose, read by a model.
     * 1–2000 chars.
     *
     * Three things worth being deliberate about:
     *
     * 1. **These are YOUR rules, not your user's.** They are the policy about what an end
     *    user may do to your character's appearance, so they belong on your server next to
     *    `instructions` — never accepted from a request body.
     * 2. **Say what must NOT change.** The negative clause is the one that does the work:
     *    "only the room — never her face, hair or clothes".
     * 3. **Passthrough is a legitimate brief.** "Re-edit the set to whatever the user
     *    describes" is a complete rule — say so explicitly if that is what you want.
     */
    rules: string;
    /**
     * Seconds a look must hold before the next edit may run, 5–600. Absent ⇒ the server
     * default (30). A floor, not a preference: every edit re-processes the clip and lands
     * as a visible cut.
     */
    cooldownSeconds?: number;
    /**
     * Which machinery runs the re-edit. Omit it and the server picks its default
     * (`"editor"`). A deploy that cannot provide the requested renderer serves the editor
     * lane and says so in its logs — the call still connects.
     */
    renderer?: "editor" | "generative";
  };
}

/** DERIVATION: hand-written. The `video` surface itself — see {@link VideoState}. */
/**
 * How the character is rendered.
 *
 * A union rather than optional fields: clips on a generative call is a contradiction, and
 * this makes it unrepresentable instead of silently ignored. `edits` lives on the looping
 * arm BY CONSTRUCTION — edits need a clip to edit, and a generative session has none.
 */
export type VideoPolicy =
  | {
      mode?: "looping";
      /**
       * Named states we compile into a state machine and switch between.
       *
       * The clip she RESTS in is not here, because it is not the call's to choose: a call
       * identifies the character, and the character's stored source video is what she rests
       * in. Upload it to the avatar once instead of supplying a URL per call — a call that
       * carries its own media is rejected outright.
       */
      states?: Record<string, VideoState>;
      /** Rewrite the clip under a prose instruction — one clip, many worlds. */
      edits?: VideoEdits;
    }
  | { mode: "generative" };

/** What YOUR SERVER decides about a call. Never accept any of this from a browser. */
export interface CallPolicy {
  /** Her behavior contract — who she is and how she speaks. Max 8000 chars. */
  instructions?: string;
  /** Up to 32 prior messages, replayed as memory. */
  context?: readonly ContextMessage[];
  /** Hard stop in seconds, max 1800. Compute it from the balance you just admitted. */
  maxSeconds?: number;
  /** Speech recognition. `server` for a spoken conversation, `off` if you drive turns. */
  listen?: boolean;
  /** How she is rendered. */
  video?: VideoPolicy;
  /** Voice override for this call; omit to use the avatar's default. */
  voice?: unknown;
  /**
   * Let the browser register tools the model may call.
   *
   * This is a CAPABILITY, granted at mint time by your server — it is the gate, and the only
   * off switch. Without it the worker never exposes the registration method, so no page code
   * is reachable from the model at all. Never grant it from a request body.
   *
   * Note the manifest does NOT ride this request: it is registered over RPC after the client
   * connects. Putting tools on the mint returns 422 (the request schema is strict).
   */
  clientTools?: boolean;

  /** Receive the two-sided transcript, signed, after the call ends. */
  transcript?: { url: string; secret: string };
  /** Up to 16 string pairs, echoed verbatim on that transcript. */
  metadata?: Record<string, string>;
}

/**
 * What a client needs to join. Treat it as OPAQUE and relay it byte-for-byte — the browser
 * SDK validates it strictly, and adding or wrapping a key throws.
 */
type Grant = Wire["LiveKitSessionGrant"];

export interface CallConnection {
  status: Grant["status"];
  sessionId: Grant["session_id"];
  roomName: Grant["room_name"];
  /** Hand these two to `livekit-client` if you are not using the browser SDK. */
  livekitUrl: Grant["livekit_url"];
  participantToken: Grant["participant_token"];
  participantIdentity: Grant["participant_identity"];
  maxSessionSeconds: Grant["max_session_seconds"];
  idleTimeoutSeconds: Grant["idle_timeout_seconds"];
  /** Join before this or the slot returns to the pool. */
  reservationExpiresAt: Grant["reservation_expires_at"];
  /**
   * The untouched server payload. Relay THIS, not the parsed object above.
   *
   * Deliberately NOT derived. It is the whole grant including fields this SDK does not surface,
   * and typing it as the contract's grant would invite reading it field-by-field — which is the
   * habit rule 2 exists to stop. It is opaque on purpose.
   */
  raw: Record<string, unknown>;
}

/**
 * Every slot is busy. Not an error — hold and retry.
 *
 * The field NAMES are this SDK's; the types come from the contract, so a widening upstream
 * cannot silently disagree with what a caller branches on.
 */
export interface CallQueued {
  /** Invented here, not on the wire — it is what makes {@link isQueued} a one-word check. */
  queued: true;
  /**
   * `queue_position` is optional in the contract. `client.ts` coerces an absent one to `null`
   * rather than `undefined`, so this widens deliberately: a caller renders "position unknown"
   * instead of crashing on a queue that has not placed them yet.
   */
  position: NonNullable<Wire["CapacityBusyResponse"]["queue_position"]> | null;
  size: Wire["CapacityBusyResponse"]["queue_size"];
  retryAfterMs: Wire["CapacityBusyResponse"]["recommended_retry_ms"];
  /**
   * The queue's own handle on this attempt. A queued call holds no session id yet, so this is
   * the ONLY thing that can release the place in line — without it a user who closes the tab
   * while waiting keeps their slot until it times out. `null` when the platform did not issue
   * one, which is why it is read rather than assumed.
   */
  queueTicketId: NonNullable<Wire["CapacityBusyResponse"]["queue_ticket_id"]> | null;
}

/**
 * DERIVATION: transitive. A union of {@link CallConnection} and {@link CallQueued}, both of
 * which index the contract — so this follows it without naming it.
 */
export type StartCallResult = CallConnection | CallQueued;

export function isQueued(result: StartCallResult): result is CallQueued {
  return "queued" in result;
}

/**
 * Why a call ended. Diagnostic — it shows on the session record, and every reason frees the
 * slot identically. `page_hide` is the one a tab-close beacon sends; `manual` is an explicit
 * server-side decision.
 */
export type EndCallReason = NonNullable<Wire["LiveKitSessionReleaseRequest"]["reason"]>;

export interface EndCallOptions {
  reason?: EndCallReason;
  /**
   * The grant's `capacity_pool` (`call.raw.capacity_pool`), naming where the slot is held so
   * the release cannot miss it. Optional — without it the platform frees against its default
   * placement, which is where calls land today — but if the grant is in hand, pass it.
   */
  capacityPool?: Wire["LiveKitSessionReleaseRequest"]["capacity_pool"];
}

/** The kinds the contract accepts. Derived, so adding one upstream is not a second edit here. */
export type AssetKind = Wire["Asset"]["kind"];

export type Asset = Pick<Wire["Asset"], "id" | "kind"> & {
  /**
   * The contract declares these REQUIRED and non-nullable. This half of the SDK does no
   * runtime validation, and client.ts coerces a missing or wrong-typed value to `null` rather
   * than handing back `undefined` — so the type says `| null` deliberately, widening what the
   * contract promises rather than deriving it unchanged. A proxy that drops a field, or a
   * server a version behind, is the case that coercion exists for.
   */
  contentType: Wire["Asset"]["contentType"] | null;
  sizeBytes: Wire["Asset"]["sizeBytes"] | null;
  /**
   * Public, unguessable, range-capable. Feed straight into a state url.
   *
   * The contract calls this `publicUrl`; it is surfaced as `url` because that is what it is
   * used for. Black-box testing caught the mapper reading the wrong name and handing back
   * `undefined` — hence the regression test. The RENAME is the ergonomics; the type comes
   * from the contract, so the two cannot drift apart.
   */
  url: Wire["Asset"]["publicUrl"];
  /**
   * Open on purpose: this is a response field, and a reader that treats a status it has
   * never heard of as an error breaks the next time one is added. `(string & {})` rather
   * than a bare `string`, which would absorb the literals and lose the autocomplete — so
   * this widens what the contract declares rather than deriving it unchanged.
   */
  status: Wire["Asset"]["status"] | (string & {});
};

export type Avatar = Pick<
  Wire["Avatar"],
  | "id"
  | "displayName"
  | "sourceKind"
  | "status"
  | "defaultVoiceId"
  | "sourceAssetId"
  | "error"
  | "idleVideoStatus"
>;

/**
 * The patch `updateAvatar` sends — the two fields an integrator re-points after creation.
 * The contract's `UpdateAvatarRequest` carries more (llm, persona, art direction…); that is
 * dashboard machinery this surface deliberately does not model.
 *
 * `sourceAssetId` and `anchorTimeMs` are deliberately NOT here: the platform refuses them
 * alongside any other field, so folding them in would let this type spell a request that can
 * only ever 422. They get their own methods — `swapSource` and `retimeAnchor`.
 */
export type AvatarUpdate = Pick<Wire["UpdateAvatarRequest"], "displayName" | "defaultVoiceId">;

/**
 * Re-shoot the character: `sourceAssetId` becomes the avatar's new resting loop, and the
 * whole clip library re-renders against an anchor re-derived from that footage.
 *
 * `anchorTimeMs` picks the anchor frame OF THE NEW SOURCE (default 0) — frame 0 of a real
 * take is sometimes mid-blink. It is the only field that may accompany a source swap.
 */
export type AvatarSourceSwap = Required<Pick<Wire["UpdateAvatarRequest"], "sourceAssetId">> &
  Pick<Wire["UpdateAvatarRequest"], "anchorTimeMs">;

type UsageSessionsResponse = Wire["ListUsageSessionsResponse"];

/**
 * One billable session — when it ran, how long it was billable for, what it cost.
 *
 * `activeSeconds` is billable wall time in SECONDS and is null until the session settles;
 * `metadata` is whatever you passed to `startCall`, `{}` if you passed nothing. The contract
 * declares this shape inline inside the page rather than as a named schema, so it is indexed
 * out of the array rather than picked off a `Wire[...]` key.
 */
export type UsageSession = UsageSessionsResponse["data"][number];

export interface UsageSessionPage {
  /** The contract calls this `data`; it is surfaced under the name of what it holds. */
  sessions: UsageSession[];
  /** Pass as `cursor` for the next page. Null on the last one. */
  nextCursor: UsageSessionsResponse["nextCursor"];
  /** The window actually served — the platform clamps wide or inverted ranges. */
  from: UsageSessionsResponse["from"];
  to: UsageSessionsResponse["to"];
}

/**
 * DERIVATION: hand-written, because the published contract declares no query parameters on
 * `GET /v1/usage/sessions` — the route reads them, the spec does not describe them. This is
 * the one place in this file where a shape is asserted rather than taken from the contract,
 * and the fix belongs upstream in the spec export, not here.
 */
export interface ListSessionsOptions {
  /** ISO timestamps. Defaults to the trailing 30 days; 90 days is the widest served. */
  from?: string;
  to?: string;
  /** Only sessions you tagged with this `metadata.user_id`. */
  endUserId?: string;
  /** Page size, capped at 200. */
  limit?: number;
  cursor?: string;
}

export type CreditBalance = Pick<
  Wire["CreditBalance"],
  "balanceCreditMicros" | "reservedCreditMicros"
>;

/**
 * Result of reconciling an avatar's clip set to the cache tier.
 * @deprecated The externally-hosted clip tier is sunsetting. Declare the library with
 * `setClipLibrary` instead — the platform renders and hosts the clips for you.
 */
export type ClipSyncResult = Wire["SyncAvatarClipsResponse"];

/**
 * One desired clip in a library declaration: a `clipId` you choose, a role, and exactly ONE
 * source — a `motionPrompt` the platform renders from the avatar's rest-pose anchor, or the
 * `assetId` of a video you uploaded. `durationSeconds` (4–8, default 5) applies to generated
 * clips only; `reroll` is a write-only re-render nudge and is never echoed back by a read.
 */
export type ClipDeclaration = Wire["PutAvatarClipsRequest"]["clips"][number];

/** The two ways a declared clip gets its pixels. Exactly one — an object carrying both is rejected. */
export type ClipSource = Wire["PutAvatarClipsRequest"]["clips"][number]["source"];

/**
 * One clip row as the platform reports it. `status` is JOB state, not serveability: `url` is
 * the SERVING asset and may stay non-null while a re-render is `generating` or has `failed` —
 * the previous take keeps serving. An uploaded clip that fails pose validation carries the
 * structured verdict in `poseCheck` and the reason in `error`.
 */
export type AvatarClip = Wire["ListAvatarClipsResponse"]["data"][number];

/**
 * The library as `listClips` reports it: every non-retired clip plus the avatar-level facts —
 * the declaration `revision` (0 = still creation-owned), the anchor generation, and the
 * rest-pose `anchor` the clips splice against (null only while a video-sourced avatar's
 * anchor frame has not been derived yet).
 */
export type ClipLibrary = Wire["ListAvatarClipsResponse"];

/** How a declaration reconciled against the previous library — by `clipId`. */
export type ClipLibraryPlan = Wire["PutAvatarClipsResponse"]["plan"];

/** The accepted declaration's answer: the post-apply library plus how it reconciled. */
export type ClipLibraryUpdate = Wire["PutAvatarClipsResponse"];

/**
 * The accepted re-direct. `servingUrl` is the loop she is playing RIGHT NOW — the previous
 * one, which keeps serving for the whole render. A caller that treated the new description
 * as live on acceptance would be lying to its user for minutes; this is the field that lets
 * it say "being re-directed" while still showing the real thing.
 */
export type LoopRedirect = Wire["PutAvatarLoopResponse"];

/**
 * DERIVATION: hand-written, because the contract does not describe it.
 *
 * The transcript webhook body is absent from the published document entirely — not narrowed,
 * not redacted, absent. So there is nothing to derive from, and this is the only shape here
 * whose source is a GAP rather than a decision. Fixing it means describing the webhook body
 * upstream.
 */
/** The signed payload delivered to `CallPolicy.transcript.url` after a call ends. */
export interface TranscriptPayload {
  type: "session.transcript";
  session_id: string;
  avatar_id: string;
  mode: CallMode;
  started_at: number;
  ended_at: number;
  seconds: number;
  /** True when a very long call exceeded the buffer and the transcript is partial. */
  truncated: boolean;
  segments: Array<{
    role: "user" | "assistant";
    text: string;
    ts: number;
    /** She was cut off — this text is only what she actually said out loud. */
    interrupted?: boolean;
  }>;
  /**
   * The tool calls the model acted on, in order — absent when the session ran none. An
   * entry without `ok` means the call produced nothing the model saw. `arguments` and
   * `result`/`error` are truncated to 2,000 chars each: this is a history, not a replay.
   */
  tool_calls?: Array<{
    name: string;
    call_id: string;
    /** The raw JSON arguments string, exactly as the model sent it. */
    arguments: string;
    ts: number;
    ok?: boolean;
    result?: string;
    error?: string;
    duration_ms?: number;
  }>;
  /** True when the session ran more tool calls than the buffer holds — the tail is missing. */
  tool_calls_truncated?: boolean;
  client_metadata: Record<string, string>;
}
