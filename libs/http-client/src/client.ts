import {
  MUTATING,
  RETRYABLE_STATUS,
  backoffMs,
  isTransient,
  newIdempotencyKey,
  sleep,
} from "./retry.ts";
import { RealtimeAvatarError, RealtimeAvatarHttpError } from "./errors.ts";
import type {
  Asset,
  ListSessionsOptions,
  UsageSession,
  UsageSessionPage,
  AssetKind,
  Avatar,
  AvatarSourceSwap,
  AvatarUpdate,
  CallMode,
  CallPolicy,
  ClipDeclaration,
  ClipLibrary,
  ClipLibraryUpdate,
  LoopRedirect,
  ClipSyncResult,
  CreditBalance,
  EndCallOptions,
  StartCallResult,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://realtimeavatar.ai/api/v1";

/** Must equal the version in package.json — a test asserts it, so drift fails CI. */
export const SDK_VERSION = "0.5.1";



export interface RealtimeAvatarOptions {
  /** `tic_live_…` or `tic_test_…`. Server-side only — never ship this to a browser. */
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 60s; starting a call does real work upstream. */
  timeoutMs?: number;
  /**
   * Extra attempts after a transient failure. Default 2, so 3 attempts in total.
   *
   * Set 0 to disable. Every retried write carries the SAME `Idempotency-Key` — but read
   * that as a correctly-formed request, not as a guarantee: **`startCall` is not currently
   * de-duplicated on it server-side.** So a 503 that in fact started a call can, on retry,
   * start a second one and bill for both.
   *
   * If that matters more to you than recovering from a blip, pass 0 here and retry in your
   * own code where you can check first. `endCall` is genuinely idempotent and safe to retry.
   */
  maxRetries?: number;
  /** Appended to the SDK's own User-Agent. Name your app; it shows up in our logs. */
  userAgent?: string;
}

export interface StartCallOptions extends CallPolicy {
  avatarId: string;
  mode?: CallMode;
}

/**
 * The server-side client.
 *
 * Deliberately zero-dependency and small enough to read in one sitting. It owns the two
 * things that are easy to get wrong and impossible to discover from a 4xx: the camelCase →
 * snake_case translation, and keeping the connection payload intact for relay.
 *
 * This class must only ever run on a server. A browser holding the key could start unlimited
 * calls on your account; the constructor refuses to build in a browser-like runtime so that
 * mistake fails at the first call rather than in production.
 */
export class RealtimeAvatar {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #userAgent: string;

  constructor(options: RealtimeAvatarOptions) {
    if (typeof document !== "undefined") {
      throw new RealtimeAvatarError(
        "RealtimeAvatar is server-only — it holds your API key. Call it from your backend " +
          "and hand the browser only the connection payload it returns.",
      );
    }
    if (!options.apiKey) throw new RealtimeAvatarError("apiKey is required");
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // workerd's fetch validates its `this`: stored bare and invoked as `this.#fetch(...)`
    // it throws "Illegal invocation" on EVERY request — in exactly the runtime our
    // `workerd` export condition advertises. Wrap rather than bind so a fetch installed
    // after construction (RN registerGlobals, instrumentation) is still honored.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.#userAgent = [`realtime-avatar-sdk/${SDK_VERSION}`, runtimeTag(), options.userAgent]
      .filter(Boolean).join(" ");
  }

  // ── calls ────────────────────────────────────────────────────────────────

  /**
   * Start a call and get back what the client needs to join.
   *
   * Returns `{ queued: true, … }` when every slot is busy — that is a normal state, not a
   * failure. Render the position and retry after `retryAfterMs`.
   *
   * Everything in `options` beyond `avatarId`/`mode` is a POLICY: it is what your server has
   * decided about this call. Never populate it from a request body.
   */
  async startCall(options: StartCallOptions): Promise<StartCallResult> {
    // `mode` selects VIDEO vs render-free — it is not a duplex switch. Both modes run the
    // same full-duplex loop: she listens the whole time she speaks and stops when you cut
    // in. Do not reintroduce a `duplex` option here; see the note on CallMode in types.ts.
    const body: Record<string, unknown> = {
      avatar_id: options.avatarId,
      mode: options.mode ?? "avatar",
      stt_mode: options.listen === false ? "off" : "server",
    };
    if (options.instructions !== undefined) body.instructions = options.instructions;
    if (options.context !== undefined) {
      body.initial_context = options.context.map((m) => ({ role: m.role, content: m.content }));
    }
    if (options.maxSeconds !== undefined) body.max_session_seconds = Math.floor(options.maxSeconds);
    if (options.voice !== undefined) body.voice = options.voice;
    if (options.metadata !== undefined) body.client_metadata = options.metadata;
    // The grant is the gate: the worker only exposes tool registration for a session whose
    // mint carried this capability.
    if (options.clientTools) body.capabilities = ["client_tools"];
    if (options.transcript !== undefined) {
      body.transcript_webhook = { url: options.transcript.url, secret: options.transcript.secret };
    }
    if (options.video !== undefined) Object.assign(body, videoToWire(options.video));

    const response = await this.#request("POST", "/realtime/livekit/session", { json: body });

    if (response.status === 429) {
      const busy = (await response.json()) as Record<string, unknown>;
      return {
        queued: true,
        position: typeof busy.queue_position === "number" ? busy.queue_position : null,
        size: typeof busy.queue_size === "number" ? busy.queue_size : 0,
        retryAfterMs: typeof busy.recommended_retry_ms === "number" ? busy.recommended_retry_ms : 3000,
        queueTicketId: typeof busy.queue_ticket_id === "string" ? busy.queue_ticket_id : null,
      };
    }

    const grant = (await this.#json(response)) as Record<string, unknown>;
    return {
      status: "ready",
      sessionId: String(grant.session_id),
      roomName: String(grant.room_name),
      livekitUrl: String(grant.livekit_url),
      participantToken: String(grant.participant_token),
      participantIdentity: String(grant.participant_identity),
      maxSessionSeconds: Number(grant.max_session_seconds ?? 0),
      idleTimeoutSeconds: Number(grant.idle_timeout_seconds ?? 0),
      reservationExpiresAt: String(grant.reservation_expires_at),
      // The parsed fields above are for YOUR logic. Relay `raw` to the client untouched:
      // the browser SDK validates the grant strictly and rejects an added or renamed key.
      raw: grant,
    };
  }

  /**
   * End a call and free its slot NOW, instead of when a timeout notices.
   *
   * The slot is held from the moment `startCall` returns — **including the window before
   * your user has joined the room**. Someone who closes the tab right there leaves the call
   * running until the join timeout reclaims it. Give the page a same-origin route that calls
   * this, hit it with `navigator.sendBeacon` on `pagehide`, and the abandoned call ends the
   * moment they leave. The demo apps carry the whole pattern.
   *
   * Best-effort, like the hang-up it is: `true` when the platform acknowledged the release,
   * `false` for anything else — never a throw. Ending is idempotent (an unknown or
   * already-ended session still acks), so a pagehide beacon and a disconnect handler may
   * both fire for the same call without error. A release that is lost is a slower release,
   * not a leak — the join timeout is the backstop.
   *
   * This ends whatever the id names, so only pass ids YOUR SERVER minted — remember them at
   * `startCall` time and refuse the rest. A route that relays an arbitrary id from the
   * request body lets any visitor hang up any call on your account.
   */
  async endCall(sessionId: string, options: EndCallOptions = {}): Promise<boolean> {
    if (!sessionId) return false;
    // The wire is strict: exactly these keys, absent rather than null when unset.
    const body: Record<string, unknown> = { session_id: sessionId };
    if (options.reason !== undefined) body.reason = options.reason;
    if (options.capacityPool !== undefined) body.capacity_pool = options.capacityPool;
    try {
      const response = await this.#request("POST", "/realtime/livekit/session/release", { json: body });
      // Only the status matters; discard the body so the socket is not held open.
      await response.body?.cancel().catch(() => {});
      return response.ok;
    } catch {
      return false; // a dropped connection here means the timeout ends it — later, not never
    }
  }

  // ── avatars ──────────────────────────────────────────────────────────────

  /**
   * Register a character from a looping clip you host.
   *
   * @deprecated CLOSED to new callers — this answers `422` unless your tenant was already
   * creating from video, in which case it keeps working and your existing avatars are
   * untouched. Use {@link createAvatarFromImage}: one still, and the platform renders the
   * resting loop and the motion library from it.
   *
   * The reason it closed is not arbitrary. Every clip has to start and end on ONE rest pose
   * or a state switch reads as a jump, and the platform can only guarantee that when it
   * rendered the loop and the clips from the same portrait. A supplied video cannot honour
   * it, so the lane could never be made to look right.
   */
  async createAvatarFromVideo(input: {
    displayName: string;
    videoUrl: string;
    voice?: unknown;
    settings?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<Avatar> {
    const asset = await this.createRemoteAsset({ kind: "video", remoteUrl: input.videoUrl });
    return this.createAvatar({
      displayName: input.displayName,
      sourceKind: "video",
      sourceAssetId: asset.id,
      voice: input.voice,
      settings: input.settings,
      metadata: input.metadata,
    });
  }

  /**
   * Register a character from ONE still image. The platform generates everything moving:
   * the resting loop she idles in, then a starter motion library rendered against her rest
   * pose. No footage, no clip URLs, nothing to shoot.
   *
   * `motionPrompt` directs the RESTING LOOP — the video she plays when nothing else is
   * happening — and it is the only chance to direct it, because there is no API today that
   * re-generates a loop after creation (see {@link updateAvatar} for the one thing that can
   * be re-pointed). Describe a small closed arc that returns to where it started: "settles
   * into frame, breathes gently, a slow blink". Omit it and the house default is used.
   *
   * Creation returns while the avatar is still `preprocessing`; poll {@link getAvatar} until
   * it leaves that state. The loop is load-bearing, so a failure there settles `failed` with
   * a readable error — the motion library is not, and a library failure degrades to
   * loop-only rather than demoting the character.
   */
  async createAvatarFromImage(input: {
    displayName: string;
    imageUrl: string;
    motionPrompt?: string;
    voice?: unknown;
    settings?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<Avatar> {
    const asset = await this.createRemoteAsset({ kind: "image", remoteUrl: input.imageUrl });
    return this.createAvatar({
      displayName: input.displayName,
      sourceKind: "image",
      sourceAssetId: asset.id,
      motionPrompt: input.motionPrompt,
      voice: input.voice,
      settings: input.settings,
      metadata: input.metadata,
    });
  }

  async createAvatar(input: {
    displayName: string;
    sourceKind: "image" | "video";
    sourceAssetId: string;
    /** Art direction for the generated resting loop. Image sources only — a video source
     *  already IS the loop, and the platform ignores it there. */
    motionPrompt?: string;
    voice?: unknown;
    settings?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<Avatar> {
    const body: Record<string, unknown> = {
      displayName: input.displayName,
      sourceKind: input.sourceKind,
      sourceAssetId: input.sourceAssetId,
    };
    if (input.motionPrompt !== undefined) body.motionPrompt = input.motionPrompt;
    if (input.voice !== undefined) body.voice = input.voice;
    if (input.settings !== undefined) body.settings = input.settings;
    if (input.metadata !== undefined) body.metadata = input.metadata;
    return toAvatar(await this.#json(await this.#request("POST", "/avatars", { json: body })));
  }

  async listAvatars(): Promise<Avatar[]> {
    const data = (await this.#json(await this.#request("GET", "/avatars"))) as { data?: unknown[] };
    return (data.data ?? []).map(toAvatar);
  }

  async getAvatar(avatarId: string): Promise<Avatar> {
    return toAvatar(await this.#json(await this.#request("GET", `/avatars/${avatarId}`)));
  }

  /**
   * Re-point what an avatar already is. `defaultVoiceId: null` clears the default voice.
   *
   * Cheap metadata only. The three things that cost a render have their own methods, because
   * putting them in a patch alongside a rename would hide minutes of GPU work behind a field:
   * {@link retimeAnchor} moves the rest frame, {@link swapSource} replaces the footage, and
   * the resting loop is re-directed by description at `PUT /v1/avatars/{id}/loop`.
   */
  async updateAvatar(avatarId: string, patch: AvatarUpdate): Promise<Avatar> {
    return toAvatar(
      await this.#json(await this.#request("PATCH", `/avatars/${avatarId}`, { json: patch })),
    );
  }

  /**
   * Re-shoot the character — swap in new footage as her resting loop.
   *
   * ASYNCHRONOUS, and that is the whole design. This returns as soon as the swap is
   * accepted; the avatar keeps serving its CURRENT loop, cache and clips the entire time,
   * and cuts over to the new generation in one step once the replacement is prepared.
   * A call minted a second after this returns is a normal call on the old footage.
   *
   * Two consequences worth designing for:
   *
   * - **The clip library empties and refills.** Old takes are footage of the old source and
   *   cannot splice against the new loop, so they are dropped and re-rendered. Between the
   *   cutover and the last re-render she rests on the new loop with less variety — never
   *   broken, just plainer. Do not gate your UI on the library being full.
   * - **A failed swap does not fail the avatar.** She keeps serving, `status` stays `ready`,
   *   and the reason lands on `error`. So poll `getAvatar` and read `error` — a non-null
   *   `error` on a `ready` avatar is the swap that did not take, not an unhealthy character.
   *
   * The frame this rests on comes from the new footage: pass `anchorTimeMs` when frame 0 of
   * the take is mid-blink. Video-sourced avatars only — a portrait-anchored one is a 422.
   */
  async swapSource(avatarId: string, input: AvatarSourceSwap): Promise<Avatar> {
    const json: Record<string, unknown> = { sourceAssetId: input.sourceAssetId };
    if (input.anchorTimeMs !== undefined) json.anchorTimeMs = input.anchorTimeMs;
    return toAvatar(await this.#json(await this.#request("PATCH", `/avatars/${avatarId}`, { json })));
  }

  /**
   * Re-point the anchor at a different frame of the loop she ALREADY has — same footage,
   * different rest pose. `swapSource` replaces the footage; this only moves the frame.
   *
   * Re-renders the clip library the same way, with the same degradation window, and is
   * clamped server-side to the loop's last extractable frame (read the avatar back to see
   * what was actually cut). Video-sourced avatars only.
   */
  async retimeAnchor(avatarId: string, anchorTimeMs: number): Promise<Avatar> {
    return toAvatar(
      await this.#json(await this.#request("PATCH", `/avatars/${avatarId}`, { json: { anchorTimeMs } })),
    );
  }

  async deleteAvatar(avatarId: string): Promise<void> {
    await this.#json(await this.#request("DELETE", `/avatars/${avatarId}`));
  }

  // A clip envelope missing `revision` would silently drop `expectedRevision` from the
  // next declare — CAS degrades to unconditional with zero signal — so it throws instead.
  #clipEnvelope<T extends ClipLibrary>(out: T): T {
    if (typeof out.revision !== "number" || !Array.isArray(out.data)) {
      throw new RealtimeAvatarError("clip library response did not match the contract");
    }
    return out;
  }

  /**
   * Declare the avatar's full desired clip library — a declaration, not a delta. The
   * platform reconciles it against what exists: unchanged clips are `kept` (still
   * serving), new or changed ones are `queued` to render, and clips you dropped are
   * `retired`. The 202 is acceptance, not readiness — poll `listClips` until no row is
   * `queued` or `generating`. A rejected upload settles `failed`, which is terminal, so
   * waiting for all-`ready` waits forever. While a re-render is in flight the previous
   * take keeps serving, so a declaration never blanks a live avatar.
   *
   * `expectedRevision` is compare-and-set: pass the `revision` you last read and a
   * concurrent writer surfaces as a 409 instead of a lost update. Omit it to declare
   * unconditionally.
   *
   * At most 12 clips: one `idle`, up to two `listen`, the rest `gesture`. An uploaded
   * clip (`source: { assetId }`) must start AND end on the avatar's rest pose — pose
   * validation rejects it otherwise (`status: "failed"`, the verdict in `poseCheck`),
   * and the rest of the library is untouched.
   */
  async setClipLibrary(
    avatarId: string,
    library: { clips: readonly ClipDeclaration[]; expectedRevision?: number },
  ): Promise<ClipLibraryUpdate> {
    const body: Record<string, unknown> = { clips: library.clips };
    if (library.expectedRevision !== undefined) body.expectedRevision = library.expectedRevision;
    return this.#clipEnvelope(
      (await this.#json(
        await this.#request("PUT", `/avatars/${avatarId}/clips`, { json: body }),
      )) as ClipLibraryUpdate,
    );
  }

  /**
   * Re-direct the RESTING LOOP — the video she plays when nothing else is happening — from
   * a new one-sentence description.
   *
   * Not a clip, and this is the distinction integrations get wrong: a clip with
   * `role: "idle"` is a variant spliced OVER the loop, and declaring one never changes what
   * she rests in. This is the only thing that does.
   *
   * `202`, because the render takes minutes. Three properties, all measured against a real
   * render rather than asserted:
   *
   * - **She never goes dark.** She stays `ready` and keeps serving her previous loop for the
   *   entire render — returned as `servingUrl` — then the swap publishes in one step.
   * - **Your clip library is untouched.** Clips render against the portrait, not against the
   *   loop, so a re-direct re-queues nothing and does not move `revision`.
   * - **It bills once**, at the rendering model's rate, per re-direct.
   *
   * Refusals worth telling apart: `409 loop_pending` (one is already in flight — wait) and
   * `422 loop_not_generatable` (a grandfathered video-sourced avatar has no portrait to
   * re-animate — terminal, do not retry).
   */
  async setLoop(avatarId: string, loop: { motionPrompt: string }): Promise<LoopRedirect> {
    return (await this.#json(
      await this.#request("PUT", `/avatars/${avatarId}/loop`, { json: { motionPrompt: loop.motionPrompt } }),
    )) as LoopRedirect;
  }

  /**
   * Block until a loop re-direct settles, and throw if it did not take.
   *
   * `setLoop` returns on ACCEPTANCE; the render runs for minutes afterwards. Every caller
   * therefore writes the same polling loop, and the obvious version of it never terminates
   * on failure — a failed re-direct leaves her `ready` (she is still serving the old loop)
   * and writes nothing to `error`. `idleVideoStatus` is the only field that moves, which is
   * why this exists rather than a doc line telling you to poll.
   *
   * Race-free without a baseline: the platform commits `queued` before `setLoop` returns, so
   * by the time you can call this the status has already left `ready`.
   *
   * Resolves with the settled avatar — `sourceAssetId` is now the new loop. Throws on a
   * failed render and on timeout; a timeout is not a failure, so re-poll or call again.
   */
  async waitForLoop(
    avatarId: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<Avatar> {
    const timeoutMs = options.timeoutMs ?? 20 * 60_000;
    const pollMs = Math.max(1_000, options.pollMs ?? 10_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const avatar = await this.getAvatar(avatarId);
      if (avatar.idleVideoStatus === "failed") {
        throw new RealtimeAvatarError(
          `Loop re-direct failed for ${avatarId}. She is still serving her previous loop — ` +
            "nothing was lost, and you can send another description.",
        );
      }
      if (avatar.idleVideoStatus === "ready" || avatar.idleVideoStatus === "none") return avatar;
      if (Date.now() >= deadline) {
        throw new RealtimeAvatarError(
          `Loop re-direct for ${avatarId} was still ${avatar.idleVideoStatus} after ${Math.round(timeoutMs / 1000)}s. ` +
            "This is a timeout, not a failure — the render may still land.",
        );
      }
      await sleep(pollMs);
    }
  }

  /**
   * Block until every clip in the library has stopped moving.
   *
   * Settled means no row is `queued` or `generating` — NOT that every row is `ready`.
   * Waiting for all-`ready` is the intuitive version and it hangs forever: a clip rejected
   * by pose validation settles `failed`, which is terminal. So this returns the library
   * with the failures in it and lets you decide; a partial library is a legitimate outcome
   * and the rest of it is already serving.
   *
   * Throws only on timeout.
   */
  async waitForClips(
    avatarId: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<ClipLibrary> {
    const timeoutMs = options.timeoutMs ?? 20 * 60_000;
    const pollMs = Math.max(1_000, options.pollMs ?? 10_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const library = await this.listClips(avatarId);
      const moving = library.data.filter((c) => c.status === "queued" || c.status === "generating");
      if (moving.length === 0) return library;
      if (Date.now() >= deadline) {
        throw new RealtimeAvatarError(
          `${moving.length} clip(s) on ${avatarId} were still rendering after ${Math.round(timeoutMs / 1000)}s: ` +
            `${moving.map((c) => c.clipId).join(", ")}. This is a timeout, not a failure.`,
        );
      }
      await sleep(pollMs);
    }
  }

  /** The avatar's clip library: every non-retired clip, plus revision, anchor and eligibility. */
  async listClips(avatarId: string): Promise<ClipLibrary> {
    return this.#clipEnvelope(
      (await this.#json(
        await this.#request("GET", `/avatars/${avatarId}/clips`),
      )) as ClipLibrary,
    );
  }

  /**
   * Reconcile an avatar's clip set after it changes.
   *
   * Required, not optional: clips are prepared once and cached by URL hash, and the serve
   * path only LOADS that cache. A clip that has never been prepared silently does nothing on
   * the first call after you add it. Idempotent, so calling it on every write is cheap.
   *
   * **At most 32 URLs per call.** This is the whole set for the avatar, not a delta, and the
   * endpoint rejects an oversize list rather than truncating it — so a library that outgrows
   * 32 needs the set trimmed, not split across two calls.
   *
   * @deprecated The externally-hosted clip tier this serves is sunsetting. Declare the
   * library with {@link setClipLibrary} instead — the platform renders and hosts the
   * clips, and pose-validates uploads against the avatar's rest pose.
   */
  async syncClips(avatarId: string, clipUrls: readonly string[]): Promise<ClipSyncResult> {
    const out = (await this.#json(
      await this.#request("POST", `/avatars/${avatarId}/clips`, { json: { clipUrls } }),
    )) as ClipSyncResult;
    return { queued: out.queued ?? [], ready: out.ready ?? [], retired: out.retired ?? [] };
  }

  // ── assets ───────────────────────────────────────────────────────────────

  /** Hand us a URL and we stream it into storage. Prefer this for anything large. */
  async createRemoteAsset(input: { kind: AssetKind; remoteUrl: string }): Promise<Asset> {
    return toAsset(await this.#json(await this.#request("POST", "/assets/remote", { json: input })));
  }

  /** Upload bytes you already hold. */
  async uploadAsset(file: Blob, options: { kind?: AssetKind; filename?: string } = {}): Promise<Asset> {
    const form = new FormData();
    form.append("file", file, options.filename ?? "upload");
    if (options.kind) form.append("kind", options.kind);
    return toAsset(await this.#json(await this.#request("POST", "/assets", { body: form })));
  }

  // ── billing ──────────────────────────────────────────────────────────────

  /**
   * Billable sessions, newest first — the itemised half of the bill that `creditBalance`
   * cannot give you.
   *
   * Works with no setup: every session is listed with its times, duration and cost. To also
   * know WHICH of your users a session belongs to, tag the call when you start it:
   *
   * ```ts
   * await rta.startCall({ avatarId, metadata: { user_id: user.id } });
   * // ...later
   * await rta.listSessions({ endUserId: user.id });
   * ```
   *
   * Tagging is optional and nothing degrades without it — you just cannot attribute a
   * session to one of your users. Requires a key with the `usage:read` scope.
   */
  async listSessions(options: ListSessionsOptions = {}): Promise<UsageSessionPage> {
    const query = new URLSearchParams();
    if (options.from) query.set("from", options.from);
    if (options.to) query.set("to", options.to);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.endUserId) query.set("endUserId", options.endUserId);
    const suffix = query.size > 0 ? `?${query}` : "";
    const page = await this.#json(await this.#request("GET", `/usage/sessions${suffix}`));
    return toUsageSessionPage(page);
  }

  /**
   * Every session in a window, following the cursor for you.
   *
   * An async iterator rather than an array, because a busy month is a lot of rows and a
   * caller writing a monthly report should not have to hold all of them to start writing.
   */
  async *iterateSessions(options: ListSessionsOptions = {}): AsyncGenerator<UsageSession> {
    let cursor = options.cursor;
    do {
      const page = await this.listSessions({ ...options, cursor });
      yield* page.sessions;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  async creditBalance(): Promise<CreditBalance> {
    return (await this.#json(await this.#request("GET", "/credits/balance"))) as CreditBalance;
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #request(
    method: string,
    path: string,
    init: { json?: unknown; body?: BodyInit } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      "user-agent": this.#userAgent,
    };
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    // One key for the whole logical request, REUSED on every retry — that reuse is the entire
    // point. A fresh key per attempt would let a 503 that actually started a call bill you
    // again on the retry.
    if (MUTATING.has(method)) headers["idempotency-key"] = newIdempotencyKey();

    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        // A fresh timeout per attempt: the budget is per try, not shared across the retries.
        const signal = AbortSignal.timeout(this.#timeoutMs);
        const response = await this.#fetch(`${this.#baseUrl}${path}`, { method, headers, body, signal });
        if (attempt >= this.#maxRetries || !RETRYABLE_STATUS.has(response.status)) return response;
        // Discard the body we are not going to read, or the socket can be held open.
        await response.body?.cancel().catch(() => {});
        await sleep(backoffMs(attempt, response.headers.get("retry-after")));
      } catch (cause) {
        lastError = cause;
        // A retry is only safe if the request can be replayed. Streaming bodies cannot be.
        if (attempt >= this.#maxRetries || !isTransient(cause) || isStream(body)) {
          throw new RealtimeAvatarError(
            `${method} ${path} failed after ${attempt + 1} attempt(s): ${(cause as Error).message}`,
            { cause: lastError },
          );
        }
        await sleep(backoffMs(attempt, null));
      }
    }
  }

  /** Throw a useful error rather than letting a 4xx flow on as `undefined`. */
  async #json(response: Response): Promise<unknown> {
    if (response.ok) return response.json();
    const text = await response.text().catch(() => "");
    let code: string | undefined;
    try {
      code = (JSON.parse(text) as { code?: string }).code;
    } catch {
      // Not JSON — an HTML body usually means the route is not served at all.
    }
    throw new RealtimeAvatarHttpError(response.status, code, text.slice(0, 400));
  }
}

/** The wire is camelCase here; read defensively so a missing field cannot become "undefined". */
function toUsageSessionPage(raw: unknown): UsageSessionPage {
  const body = isRecord(raw) ? raw : {};
  const rows = Array.isArray(body.data) ? body.data : [];
  return {
    sessions: rows.filter(isRecord).map((row) => ({
      sessionId: String(row.sessionId ?? ""),
      avatarId: typeof row.avatarId === "string" ? row.avatarId : null,
      status: usageStatus(row.status),
      startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
      endedAt: typeof row.endedAt === "string" ? row.endedAt : null,
      activeSeconds: typeof row.activeSeconds === "number" ? row.activeSeconds : null,
      billedCreditMicros: typeof row.billedCreditMicros === "number" ? row.billedCreditMicros : null,
      metadata: isRecord(row.metadata) ? row.metadata : {},
      createdAt: String(row.createdAt ?? ""),
    })),
    nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
    from: String(body.from ?? ""),
    to: String(body.to ?? ""),
  };
}

const USAGE_STATUSES = ["reserved", "started", "released", "failed"] as const;

function usageStatus(value: unknown): UsageSession["status"] {
  return USAGE_STATUSES.find((s) => s === value) ?? "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** camelCase video policy -> the strict snake_case wire. */
function videoToWire(video: NonNullable<CallPolicy["video"]>): Record<string, unknown> {
  if (video.mode === "generative") return { render_backend: "generative" };
  // Nothing here may carry media for the call itself. A session names an avatar and reads
  // the media stored ON it, so top-level source keys are rejected rather than merged.
  const out: Record<string, unknown> = {};
  // One option in, one sibling block out — the same mapping as the connect lane. NOT an
  // early return: `states` still has to be mapped below, and returning here would drop
  // clip_library for exactly the sessions using the newest feature.
  if (video.edits) {
    const edits: Record<string, unknown> = { instruction: video.edits.instruction };
    if (video.edits.referenceUrl !== undefined) edits.reference_url = video.edits.referenceUrl;
    // `live` is what makes the look follow the conversation; its PRESENCE is the switch,
    // so absence means the key is omitted entirely — an empty object would read as
    // "enabled, permitting nothing".
    if (video.edits.live !== undefined) {
      const live: Record<string, unknown> = { rules: video.edits.live.rules };
      // Floored: the wire is `.int()`, and a caller computing this from a duration should
      // not 422 on an arithmetic detail unrelated to what they asked for.
      if (video.edits.live.cooldownSeconds !== undefined) {
        live.cooldown_seconds = Math.floor(video.edits.live.cooldownSeconds);
      }
      if (video.edits.live.renderer !== undefined) live.renderer = video.edits.live.renderer;
      edits.live_edit = live;
    }
    out.support_edits = edits;
  }
  if (video.states) {
    out.clip_library = Object.entries(video.states).map(([id, state]) => {
      const clip: Record<string, unknown> = {
        clip_id: id,
        source_video_url: state.url,
        trigger: "directive",
        // `when` is the public name for this cue. The wire also still accepts the older
        // `hint`; send one name only, and prefer the one the docs and types use.
        when: state.when,
      };
      if (state.weight !== undefined) clip.weight = state.weight;
      return clip;
    });
  }
  return out;
}

function toAvatar(raw: unknown): Avatar {
  const a = raw as Record<string, unknown>;
  return {
    id: String(a.id),
    displayName: String(a.displayName ?? ""),
    sourceKind: a.sourceKind === "video" ? "video" : "image",
    status: (a.status as Avatar["status"]) ?? "draft",
    defaultVoiceId: a.defaultVoiceId ? String(a.defaultVoiceId) : null,
    sourceAssetId: a.sourceAssetId ? String(a.sourceAssetId) : null,
    // Carried because it is the ONLY channel a failed source swap has: she stays `ready`
    // and serving, and this says why the re-shoot did not take.
    error: a.error ? String(a.error) : null,
    // The loop lane's terminal signal, and the reason it is here: a re-direct that fails
    // leaves `status` on `ready` (she is still serving the old loop, which is the whole
    // design) and writes nothing to `error`. Without this field a caller polling after
    // `setLoop` has NO way to distinguish "still rendering" from "gave up", and waits
    // forever. queued → generating → ready | failed.
    idleVideoStatus: (a.idleVideoStatus as Avatar["idleVideoStatus"]) ?? "none",
  };
}

function toAsset(raw: unknown): Asset {
  const a = raw as Record<string, unknown>;
  // The wire field is `publicUrl`. Reading `url` silently produced "undefined" — a string,
  // so nothing threw and the bad value only surfaced when someone fetched it.
  const url = a.publicUrl ?? a.url;
  if (typeof url !== "string" || !url) {
    throw new RealtimeAvatarError(`asset ${String(a.id)} came back without a public URL`);
  }
  return {
    id: String(a.id),
    kind: (a.kind as AssetKind) ?? "video",
    url,
    status: typeof a.status === "string" ? a.status : "ready",
    contentType: typeof a.contentType === "string" ? a.contentType : null,
    sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : null,
  };
}


/** `node`, `workerd`, `deno`, `bun` — enough to tell where SDK traffic comes from. */
function runtimeTag(): string {
  const g: object = globalThis;
  if ("Deno" in g) return "deno";
  if ("Bun" in g) return "bun";
  if ("navigator" in g && typeof navigator?.userAgent === "string"
      && navigator.userAgent.includes("Cloudflare-Workers")) return "workerd";
  if ("process" in g && typeof process?.versions?.node === "string") return `node/${process.versions.node}`;
  return "unknown";
}





/** A stream can only be sent once, so a request carrying one must not be replayed. */
function isStream(body: BodyInit | undefined): boolean {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}
