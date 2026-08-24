import { RealtimeAvatarApiError, RealtimeAvatarConfigError, RealtimeAvatarValidationError } from "./errors";
import {
  toLiveKitSessionWireRequest,
  type LiveKitCapacitySnapshot,
  type LiveKitSessionGrant,
  type LiveKitSessionRequest,
} from "./livekit-grant";
import {
  capacityBusyResponseSchema,
  liveKitCapacitySnapshotSchema,
  liveKitSessionGrantSchema,
} from "./schemas";
import type {
  CapacityBusyResponse,
  LiveKitSessionReleaseReason,
} from "realtime-avatar-contracts";
import type { LLMProvider } from "realtime-avatar-contracts";
import {
  listConfiguredLLMProviders,
  readLLMProvider,
  type ConfiguredLLMProviders,
  type LLMCredentialsConfig,
} from "./llm";
import type {
  CreateImageAvatarOptions,
  CreateImageAvatarResult,
  CreatePlatformAvatarRequest,
  CreateRemotePlatformAssetRequest,
  CreateVideoAvatarFromUrlOptions,
  CreateVideoAvatarOptions,
  CreateVideoAvatarResult,
  PlatformAsset,
  PlatformAvatar,
  PlatformCreditBalance,
  SyncAvatarClipsResult,
  UpdatePlatformAvatarRequest,
  UploadPlatformAssetOptions,
} from "./platform";
import { REALTIME_AVATAR_MODEL_IDS } from "./platform";
import {
  BROWSER_PROXY_ENDPOINTS,
  DEFAULT_BROWSER_PROXY_URL,
  DEFAULT_PLATFORM_BASE_URL,
  PLATFORM_ENDPOINTS,
  joinPath,
  proxyPathForPlatformPath,
} from "./proxy-contract";

export { DEFAULT_BROWSER_PROXY_URL, DEFAULT_PLATFORM_BASE_URL } from "./proxy-contract";

type MaybePromise<T> = T | Promise<T>;
type ApiKeyFactory = string | (() => MaybePromise<string | null | undefined>);
type HeaderFactory = HeadersInit | (() => MaybePromise<HeadersInit>);
type FetchLike = typeof fetch;

type EndpointName =
  | "assets"
  | "assetsRemote"
  | "avatars"
  | "creditsBalance"
  | "livekitCapacity"
  | "livekitSession"
  | "livekitSessionRelease";

type RealtimeAvatarEndpointMap = Record<EndpointName, string>;

export type RealtimeAvatarBrowserOptions = {
  /** Same-origin proxy that mints LiveKit session grants. */
  proxyUrl?: string;
  fetch?: FetchLike;
  /** Non-secret provider ids this browser may request. */
  llmProviders?: readonly LLMProvider[];
};

export type RealtimeAvatarServerOptions<
  TLlm extends LLMCredentialsConfig | undefined = undefined,
> = {
  apiKey: ApiKeyFactory;
  /** Defaults to the hosted platform origin. */
  baseUrl?: string;
  fetch?: FetchLike;
  headers?: HeaderFactory;
  /** Server-only LLM credentials used to allow per-avatar provider choices. */
  llm?: TLlm;
};

type RealtimeAvatarClientOptions<
  TLlmProvider extends LLMProvider = LLMProvider,
> = {
  baseUrl?: string;
  apiKey?: ApiKeyFactory;
  endpoints: RealtimeAvatarEndpointMap;
  apiPathPrefix?: string;
  fetch?: FetchLike;
  headers?: HeaderFactory;
  llmProviders?: readonly TLlmProvider[];
  llm?: LLMCredentialsConfig;
};

export type RealtimeAvatarRequestOptions = {
  signal?: AbortSignal;
  headers?: HeadersInit;
};

export type LiveKitSessionStartResult =
  | { status: "ready"; grant: LiveKitSessionGrant }
  | { status: "busy"; busy: CapacityBusyResponse };

const MAX_MULTIPART_VIDEO_BYTES = 2 * 1024 * 1024;
const SERVER_ENDPOINTS: RealtimeAvatarEndpointMap = {
  assets: PLATFORM_ENDPOINTS.assets,
  assetsRemote: PLATFORM_ENDPOINTS.assetsRemote,
  avatars: PLATFORM_ENDPOINTS.avatars,
  creditsBalance: PLATFORM_ENDPOINTS.creditsBalance,
  livekitCapacity: PLATFORM_ENDPOINTS.realtimeLiveKitCapacity,
  livekitSession: PLATFORM_ENDPOINTS.realtimeLiveKitSession,
  livekitSessionRelease: PLATFORM_ENDPOINTS.realtimeLiveKitSessionRelease,
};

export class RealtimeAvatarClient<
  TLlmProvider extends LLMProvider = LLMProvider,
> {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly apiKey?: ApiKeyFactory;
  private readonly endpoints: RealtimeAvatarEndpointMap;
  private readonly apiPathPrefix?: string;
  private readonly headers?: HeaderFactory;
  private readonly llmProviders: readonly LLMProvider[];
  private readonly llmConfig?: LLMCredentialsConfig;

  private constructor(options: RealtimeAvatarClientOptions<TLlmProvider>) {
    this.fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!this.fetchImpl) throw new RealtimeAvatarConfigError("A fetch implementation is required");
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "");
    this.apiKey = options.apiKey;
    this.headers = options.headers;
    this.endpoints = options.endpoints;
    this.apiPathPrefix = options.apiPathPrefix ? normalizePathPrefix(options.apiPathPrefix) : undefined;
    this.llmProviders = options.llmProviders ?? ["local"];
    this.llmConfig = options.llm;
  }

  /** Browser client: joins LiveKit through your same-origin session-grant route. */
  static browser<const TLlmProviders extends readonly LLMProvider[] = readonly ["local"]>(
    options: RealtimeAvatarBrowserOptions & { llmProviders?: TLlmProviders } = {},
  ): RealtimeAvatarClient<TLlmProviders[number]> {
    const proxyUrl = normalizePathPrefix(options.proxyUrl ?? DEFAULT_BROWSER_PROXY_URL);
    return new RealtimeAvatarClient({
      fetch: options.fetch,
      endpoints: browserEndpoints(proxyUrl),
      apiPathPrefix: proxyUrl,
      llmProviders: options.llmProviders ?? (["local"] as unknown as TLlmProviders),
    });
  }

  /** Trusted server client. Call only from API routes, workers, jobs, or CLIs. */
  static server<const TLlm extends LLMCredentialsConfig | undefined = undefined>(
    options: RealtimeAvatarServerOptions<TLlm>,
  ): RealtimeAvatarClient<ConfiguredLLMProviders<TLlm>> {
    assertServerClientRuntime();
    return new RealtimeAvatarClient({
      ...options,
      baseUrl: options.baseUrl ?? DEFAULT_PLATFORM_BASE_URL,
      endpoints: SERVER_ENDPOINTS,
      llmProviders: listConfiguredLLMProviders(options.llm) as readonly ConfiguredLLMProviders<TLlm>[],
    });
  }

  async createLiveKitSession(
    input: LiveKitSessionRequest<TLlmProvider>,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<LiveKitSessionGrant> {
    this.assertLlmConfigured(input, "LiveKit session LLM");
    await this.assertLlmSecretReady(input);
    const data = await this.postJson(
      this.requireEndpoint("livekitSession"),
      toLiveKitSessionWireRequest(input),
      options,
    );
    return this.parseContract(data, liveKitSessionGrantSchema, "LiveKit session grant");
  }

  async createLiveKitSessionOrBusy(
    input: LiveKitSessionRequest<TLlmProvider>,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<LiveKitSessionStartResult> {
    try {
      return { status: "ready", grant: await this.createLiveKitSession(input, options) };
    } catch (error) {
      if (error instanceof RealtimeAvatarApiError && error.status === 429) {
        const parsed = capacityBusyResponseSchema.safeParse(error.body);
        if (parsed.success) return { status: "busy", busy: parsed.data };
      }
      throw error;
    }
  }

  /**
   * Releases a held LiveKit session so its GPU capacity lease is freed
   * IMMEDIATELY instead of lingering until its server-side TTL. Call this when a
   * grant is superseded by a fresh one, when the room disconnects for good, or
   * when the UI tears down — every abandoned grant that is not released holds a
   * GPU slot (and grows the queue for the next user) until the lease expires.
   *
   * Best-effort: a failed release is swallowed (the TTL + worker reconcile are
   * the backstop), so callers can fire-and-forget without try/catch. Returns
   * `true` when the platform acknowledged the release.
   */
  async releaseLiveKitSession(
    sessionId: string,
    reason?: LiveKitSessionReleaseReason,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<boolean> {
    if (!sessionId) return false;
    try {
      const response = await this.fetchImpl(this.url(this.requireEndpoint("livekitSessionRelease")), {
        method: "POST",
        headers: await this.releaseHeaders(options.headers),
        signal: options.signal,
        // `keepalive` lets the request OUTLIVE the page so a release fired from a
        // visibilitychange/unmount on the way out still reaches the server.
        keepalive: true,
        body: JSON.stringify(reason ? { session_id: sessionId, reason } : { session_id: sessionId }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Releases a held session via `navigator.sendBeacon`, which is the ONLY
   * reliable way to send a request from a `pagehide`/`beforeunload` handler — the
   * browser keeps a queued beacon alive through unload where a normal `fetch`
   * (even with keepalive) and React unmount effects are cancelled. Returns
   * `false` (so the caller can fall back to {@link releaseLiveKitSession}) when
   * sendBeacon is unavailable or refuses the payload. The same-origin proxy
   * injects the internal credential, so the beacon carries only the session id.
   */
  releaseLiveKitSessionBeacon(sessionId: string, reason?: LiveKitSessionReleaseReason): boolean {
    if (!sessionId) return false;
    const beacon = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
    if (!beacon) return false;
    const url = this.url(this.requireEndpoint("livekitSessionRelease"));
    const payload = JSON.stringify(reason ? { session_id: sessionId, reason } : { session_id: sessionId });
    try {
      // text/plain avoids a CORS preflight (sendBeacon cannot set headers, and a
      // JSON content-type would force a preflight the beacon can't complete on
      // unload). The proxy parses the body as JSON regardless of content-type.
      return beacon(url, new Blob([payload], { type: "text/plain" }));
    } catch {
      return false;
    }
  }

  /**
   * Releases a QUEUED ticket (a request still WAITING in line, no session yet) so
   * its place in the queue is dropped IMMEDIATELY instead of lingering until its
   * ~30s TTL. A queued request holds a `queue_ticket_id` but no `session_id`, so
   * {@link releaseLiveKitSession} (release-by-sessionId) cannot free it — without
   * this, a superseded/abandoned queued ticket (tab switch, unmount, pagehide)
   * sat ahead of everyone for its full TTL and the queue grew unboundedly. Posts
   * to the SAME release route as the session release; the platform drops the
   * ticket by id (idempotent — dropping a missing ticket is fine).
   *
   * Best-effort: a failed release is swallowed (the TTL is the backstop), so
   * callers can fire-and-forget. Returns `true` when the platform acked it.
   */
  async releaseLiveKitQueueTicket(
    queueTicketId: string,
    reason?: LiveKitSessionReleaseReason,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<boolean> {
    if (!queueTicketId) return false;
    try {
      const response = await this.fetchImpl(this.url(this.requireEndpoint("livekitSessionRelease")), {
        method: "POST",
        headers: await this.releaseHeaders(options.headers),
        signal: options.signal,
        // `keepalive` lets the request OUTLIVE the page so a release fired from a
        // visibilitychange/unmount on the way out still reaches the server.
        keepalive: true,
        body: JSON.stringify(
          reason ? { queue_ticket_id: queueTicketId, reason } : { queue_ticket_id: queueTicketId },
        ),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Releases a QUEUED ticket via `navigator.sendBeacon`, the beacon variant of
   * {@link releaseLiveKitQueueTicket} for `pagehide`/`beforeunload` — mirrors
   * {@link releaseLiveKitSessionBeacon}. Returns `false` (so the caller can fall
   * back to {@link releaseLiveKitQueueTicket}) when sendBeacon is unavailable or
   * refuses the payload.
   */
  releaseLiveKitQueueTicketBeacon(queueTicketId: string, reason?: LiveKitSessionReleaseReason): boolean {
    if (!queueTicketId) return false;
    const beacon = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
    if (!beacon) return false;
    const url = this.url(this.requireEndpoint("livekitSessionRelease"));
    const payload = JSON.stringify(
      reason ? { queue_ticket_id: queueTicketId, reason } : { queue_ticket_id: queueTicketId },
    );
    try {
      // text/plain avoids a CORS preflight (sendBeacon cannot set headers, and a
      // JSON content-type would force a preflight the beacon can't complete on
      // unload). The proxy parses the body as JSON regardless of content-type.
      return beacon(url, new Blob([payload], { type: "text/plain" }));
    } catch {
      return false;
    }
  }

  private async releaseHeaders(extra?: HeadersInit): Promise<Headers> {
    const headers = await this.buildHeaders(extra);
    headers.set("Content-Type", "application/json");
    return headers;
  }

  async livekitCapacity(options: RealtimeAvatarRequestOptions = {}): Promise<LiveKitCapacitySnapshot> {
    const data = await this.getJson(this.requireEndpoint("livekitCapacity"), options);
    return this.parseContract(data, liveKitCapacitySnapshotSchema, "LiveKit capacity snapshot");
  }

  async creditBalance(options: RealtimeAvatarRequestOptions = {}): Promise<PlatformCreditBalance> {
    return this.getJson(this.requireEndpoint("creditsBalance"), options);
  }

  async listAvatars(options: RealtimeAvatarRequestOptions = {}): Promise<{ data: PlatformAvatar[] }> {
    return this.getJson(this.requireEndpoint("avatars"), options);
  }

  async createAvatar(
    input: CreatePlatformAvatarRequest,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<PlatformAvatar> {
    return this.postJson(this.requireEndpoint("avatars"), input, options);
  }

  async getAvatar(avatarId: string, options: RealtimeAvatarRequestOptions = {}): Promise<PlatformAvatar> {
    return this.getJson(`${this.requireEndpoint("avatars")}/${encodeURIComponent(avatarId)}`, options);
  }

  async updateAvatar(
    avatarId: string,
    patch: UpdatePlatformAvatarRequest,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<PlatformAvatar> {
    return this.requestJson(
      "PATCH",
      `${this.requireEndpoint("avatars")}/${encodeURIComponent(avatarId)}`,
      patch,
      options,
    );
  }

  async deleteAvatar(avatarId: string, options: RealtimeAvatarRequestOptions = {}): Promise<void> {
    const response = await this.fetchImpl(this.url(`${this.requireEndpoint("avatars")}/${encodeURIComponent(avatarId)}`), {
      method: "DELETE",
      headers: await this.buildHeaders(options.headers),
      signal: options.signal,
    });
    if (!response.ok) throw await RealtimeAvatarApiError.fromResponse(response);
  }

  /**
   * Reconcile an avatar's EXTERNAL clip library to the platform's video-cache tier. Pass the
   * CURRENT set of approved clip source URLs (avatar-hosted short motion clips a tenant serves via
   * a per-session `clip_library`): the platform prewarms the .rtav cache for any missing URL
   * offline (the serve path is load-only, so a cold clip would silently no-op on the first call
   * after an edit) and retires caches whose URL has dropped out. Idempotent + content-addressed —
   * safe to call on every clip approve / regenerate / delete. Returns the queued/ready/retired
   * cache ids. Best-effort by design: callers should treat a throw as "sync deferred", never fatal.
   */
  async syncAvatarClips(
    avatarId: string,
    clipUrls: readonly string[],
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<SyncAvatarClipsResult> {
    return this.postJson(
      `${this.requireEndpoint("avatars")}/${encodeURIComponent(avatarId)}/clips`,
      { clipUrls: [...clipUrls] },
      options,
    );
  }

  async uploadAsset(
    file: Blob,
    uploadOptions: UploadPlatformAssetOptions = {},
    requestOptions: RealtimeAvatarRequestOptions = {},
  ): Promise<PlatformAsset> {
    const form = new FormData();
    form.set("file", file, uploadOptions.filename);
    if (uploadOptions.kind) form.set("kind", uploadOptions.kind);
    return this.postForm(this.requireEndpoint("assets"), form, requestOptions);
  }

  async createRemoteAsset(
    input: CreateRemotePlatformAssetRequest,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<PlatformAsset> {
    return this.postJson(this.requireEndpoint("assetsRemote"), input, options);
  }

  async createImageAvatar(
    input: CreateImageAvatarOptions,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<CreateImageAvatarResult> {
    const asset = await this.uploadAsset(input.image, { kind: "image", filename: input.filename }, options);
    const avatar = await this.createAvatar(
      {
        displayName: input.displayName,
        sourceKind: "image",
        modelId: REALTIME_AVATAR_MODEL_IDS.live,
        sourceAssetId: asset.id,
        defaultVoiceId: input.defaultVoiceId,
        voice: input.voice,
        llm: input.llm,
        settings: input.settings,
        metadata: input.metadata,
      },
      options,
    );
    return { asset, avatar };
  }

  async createVideoAvatar(
    input: CreateVideoAvatarOptions,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<CreateVideoAvatarResult> {
    if (input.video.size > MAX_MULTIPART_VIDEO_BYTES) {
      throw new RealtimeAvatarConfigError(
        "Local multipart video uploads are only for tiny smoke tests. Use createVideoAvatarFromUrl() so the platform streams video directly into object storage.",
      );
    }
    const asset = await this.uploadAsset(input.video, { kind: "video", filename: input.filename }, options);
    return this.createVideoAvatarFromAsset(asset, input, options);
  }

  async createVideoAvatarFromUrl(
    input: CreateVideoAvatarFromUrlOptions,
    options: RealtimeAvatarRequestOptions = {},
  ): Promise<CreateVideoAvatarResult> {
    const asset = await this.createRemoteAsset(
      {
        kind: "video",
        remoteUrl: input.videoUrl,
        originalFilename: input.filename,
        metadata: input.assetMetadata,
      },
      options,
    );
    return this.createVideoAvatarFromAsset(asset, input, options);
  }

  private async createVideoAvatarFromAsset(
    asset: PlatformAsset,
    input: Omit<CreateVideoAvatarOptions, "video"> | Omit<CreateVideoAvatarFromUrlOptions, "videoUrl">,
    options: RealtimeAvatarRequestOptions,
  ): Promise<CreateVideoAvatarResult> {
    const avatar = await this.createAvatar(
      {
        displayName: input.displayName,
        sourceKind: "video",
        modelId: REALTIME_AVATAR_MODEL_IDS.video,
        sourceAssetId: asset.id,
        defaultVoiceId: input.defaultVoiceId,
        voice: input.voice,
        llm: input.llm,
        settings: input.settings,
        metadata: input.metadata,
      },
      options,
    );
    return { asset, avatar };
  }

  private requireEndpoint(name: EndpointName): string {
    const path = this.endpoints[name];
    if (!path) throw new RealtimeAvatarConfigError(`The ${name} endpoint is not configured`);
    return path;
  }

  private async getJson<T>(path: string, options: RealtimeAvatarRequestOptions): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
      method: "GET",
      headers: await this.buildHeaders(options.headers),
      signal: options.signal,
    });
    return this.readJsonResponse<T>(response);
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    options: RealtimeAvatarRequestOptions,
  ): Promise<T> {
    return this.requestJson("POST", path, body, options);
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body: unknown,
    options: RealtimeAvatarRequestOptions,
  ): Promise<T> {
    const headers = await this.buildHeaders(options.headers);
    headers.set("Content-Type", "application/json");
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers,
      signal: options.signal,
      body: JSON.stringify(body),
    });
    return this.readJsonResponse<T>(response);
  }

  private async postForm<T>(path: string, body: FormData, options: RealtimeAvatarRequestOptions): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: await this.buildHeaders(options.headers),
      signal: options.signal,
      body,
    });
    return this.readJsonResponse<T>(response);
  }

  private async readJsonResponse<T>(response: Response): Promise<T> {
    if (!response.ok) throw await RealtimeAvatarApiError.fromResponse(response);
    const data = await response.json();
    if (data === null || typeof data !== "object") {
      throw new RealtimeAvatarValidationError(
        `Realtime Avatar response did not contain JSON object data for ${response.url || "this endpoint"}`,
        [],
        data,
      );
    }
    return data as T;
  }

  private parseContract<T>(data: unknown, schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: unknown } }, label: string): T {
    const parsed = schema.safeParse(data);
    if (parsed.success) return parsed.data;
    throw new RealtimeAvatarValidationError(`${label} did not match the SDK contract`, parsed.error, data);
  }

  private url(path: string): string {
    path = this.proxyPath(path);
    if (/^https?:\/\//i.test(path)) return path;
    if (!this.baseUrl) return path;
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private proxyPath(path: string): string {
    if (!this.apiPathPrefix || /^https?:\/\//i.test(path)) return path;
    return proxyPathForPlatformPath(path, this.apiPathPrefix);
  }

  private async buildHeaders(extra?: HeadersInit): Promise<Headers> {
    const headers = new Headers(await resolveHeaders(this.headers));
    const apiKey = await resolveApiKey(this.apiKey);
    if (apiKey && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${apiKey}`);
    if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  }

  private assertLlmConfigured(input: unknown, label: string): void {
    const provider = readLLMProvider(input);
    if (!provider || provider === "local") return;
    if (this.llmProviders.includes(provider)) return;
    throw new RealtimeAvatarConfigError(
      `${label} requested '${provider}', but this client is configured for [${this.llmProviders.join(", ")}]. ` +
        "Configure provider credentials on the server grant route or pass browser({ llmProviders: [...] }).",
    );
  }

  private async assertLlmSecretReady(input: unknown): Promise<void> {
    const provider = readLLMProvider(input);
    if (!provider || provider === "local" || !this.llmConfig) return;
    const credentials = this.llmConfig[provider];
    const apiKey = credentials ? await resolveApiKey(credentials.apiKey) : null;
    if (apiKey) return;
    throw new RealtimeAvatarConfigError(
      `LiveKit session requested '${provider}', but RealtimeAvatarClient.server({ llm.${provider}.apiKey }) resolved to an empty value.`,
    );
  }
}

function browserEndpoints(proxyUrl: string): RealtimeAvatarEndpointMap {
  return {
    assets: joinPath(proxyUrl, BROWSER_PROXY_ENDPOINTS.assets),
    assetsRemote: joinPath(proxyUrl, BROWSER_PROXY_ENDPOINTS.assetsRemote),
    avatars: joinPath(proxyUrl, BROWSER_PROXY_ENDPOINTS.avatars),
    creditsBalance: joinPath(proxyUrl, BROWSER_PROXY_ENDPOINTS.creditsBalance),
    livekitCapacity: joinPath(proxyUrl, BROWSER_PROXY_ENDPOINTS.realtimeLiveKitCapacity),
    livekitSession: joinPath(proxyUrl, BROWSER_PROXY_ENDPOINTS.realtimeLiveKitSession),
    livekitSessionRelease: joinPath(proxyUrl, BROWSER_PROXY_ENDPOINTS.realtimeLiveKitSessionRelease),
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizePathPrefix(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function resolveApiKey(apiKey: ApiKeyFactory | undefined): Promise<string | null | undefined> {
  return typeof apiKey === "function" ? apiKey() : apiKey;
}

async function resolveHeaders(headers: HeaderFactory | undefined): Promise<HeadersInit | undefined> {
  return typeof headers === "function" ? headers() : headers;
}

function assertServerClientRuntime(): void {
  if (typeof window === "undefined" || typeof window.document === "undefined") return;
  throw new RealtimeAvatarConfigError(
    "RealtimeAvatarClient.server() can only run in trusted server code. Use RealtimeAvatarClient.browser() in browsers.",
  );
}
