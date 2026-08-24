import {
  BROWSER_PROXY_ENDPOINTS,
  DEFAULT_BROWSER_PROXY_URL,
  DEFAULT_PLATFORM_BASE_URL,
  PLATFORM_ENDPOINTS,
  type RealtimeAvatarProxyOperation,
} from "../proxy-contract";

export type { RealtimeAvatarProxyOperation };

type MaybePromise<T> = T | Promise<T>;
type ApiKeyFactory = string | (() => MaybePromise<string | null | undefined>);
type HeaderFactory = HeadersInit | (() => MaybePromise<HeadersInit>);
type FetchLike = typeof fetch;

export type RealtimeAvatarProxyAuthContext = {
  request: Request;
  operation: RealtimeAvatarProxyOperation;
};

export type RealtimeAvatarRouteHandlerOptions = {
  apiKey: ApiKeyFactory;
  baseUrl?: string;
  fetch?: FetchLike;
  headers?: HeaderFactory;
  pathPrefix?: string;
  allowedOperations?: readonly RealtimeAvatarProxyOperation[];
  requireAuth?: (context: RealtimeAvatarProxyAuthContext) => MaybePromise<Response | void | null>;
};

export type RealtimeAvatarRouteHandler = {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  PATCH(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
};

type ProxyRoute = {
  operation: RealtimeAvatarProxyOperation;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  pattern: RegExp;
  upstreamPath: (match: RegExpExecArray) => string;
};

const PROXY_ROUTES: readonly ProxyRoute[] = [
  route("credits.balance", "GET", pathPattern(BROWSER_PROXY_ENDPOINTS.creditsBalance), PLATFORM_ENDPOINTS.creditsBalance),
  route("assets.upload", "POST", pathPattern(BROWSER_PROXY_ENDPOINTS.assets), PLATFORM_ENDPOINTS.assets),
  route("assets.remote", "POST", pathPattern(BROWSER_PROXY_ENDPOINTS.assetsRemote), PLATFORM_ENDPOINTS.assetsRemote),
  route("avatars.list", "GET", pathPattern(BROWSER_PROXY_ENDPOINTS.avatars), PLATFORM_ENDPOINTS.avatars),
  route("avatars.create", "POST", pathPattern(BROWSER_PROXY_ENDPOINTS.avatars), PLATFORM_ENDPOINTS.avatars),
  route("avatars.get", "GET", /^\/avatars\/([^/]+)$/, (match) => `${PLATFORM_ENDPOINTS.avatars}/${match[1]}`),
  route("avatars.update", "PATCH", /^\/avatars\/([^/]+)$/, (match) => `${PLATFORM_ENDPOINTS.avatars}/${match[1]}`),
  route("avatars.delete", "DELETE", /^\/avatars\/([^/]+)$/, (match) => `${PLATFORM_ENDPOINTS.avatars}/${match[1]}`),
  route(
    "realtime.livekitCapacity",
    "GET",
    pathPattern(BROWSER_PROXY_ENDPOINTS.realtimeLiveKitCapacity),
    PLATFORM_ENDPOINTS.realtimeLiveKitCapacity,
  ),
  route(
    "realtime.livekitSession",
    "POST",
    pathPattern(BROWSER_PROXY_ENDPOINTS.realtimeLiveKitSession),
    PLATFORM_ENDPOINTS.realtimeLiveKitSession,
  ),
  route(
    "realtime.livekitSessionRelease",
    "POST",
    pathPattern(BROWSER_PROXY_ENDPOINTS.realtimeLiveKitSessionRelease),
    PLATFORM_ENDPOINTS.realtimeLiveKitSessionRelease,
  ),
];

const REQUEST_HEADER_ALLOWLIST = ["accept", "content-type", "idempotency-key", "x-request-id"] as const;
const RESPONSE_HEADER_ALLOWLIST = ["cache-control", "content-type", "etag", "location", "x-request-id"] as const;

export function createRouteHandler(options: RealtimeAvatarRouteHandlerOptions): RealtimeAvatarRouteHandler {
  const handle = (request: Request) => handleRealtimeAvatarProxy(request, options);
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle };
}

export async function handleRealtimeAvatarProxy(
  request: Request,
  options: RealtimeAvatarRouteHandlerOptions,
): Promise<Response> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) return jsonError("A fetch implementation is required", 500);

  const matched = matchOperation(request, options.pathPrefix ?? DEFAULT_BROWSER_PROXY_URL);
  if (!matched) return jsonError("Realtime Avatar proxy route not found", 404);
  if (options.allowedOperations && !options.allowedOperations.includes(matched.operation)) {
    return jsonError("Realtime Avatar proxy operation is not allowed", 403);
  }

  const authResponse = await options.requireAuth?.({ request, operation: matched.operation });
  if (authResponse instanceof Response) return authResponse;

  const apiKey = await resolveApiKey(options.apiKey);
  if (!apiKey) return jsonError("Realtime Avatar API key is not configured", 500);

  const upstreamHeaders = await buildUpstreamHeaders(request, options.headers, apiKey);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: upstreamHeaders,
    signal: request.signal,
  };
  if (!isBodylessMethod(request.method)) {
    init.body = request.body;
    init.duplex = "half";
  }

  const upstreamUrl = `${normalizeBaseUrl(options.baseUrl ?? DEFAULT_PLATFORM_BASE_URL)}${matched.upstreamPath}${matched.search}`;
  const upstream = await fetchImpl(upstreamUrl, init);
  return forwardResponse(upstream);
}

function route(
  operation: RealtimeAvatarProxyOperation,
  method: ProxyRoute["method"],
  pattern: RegExp,
  upstreamPath: string | ((match: RegExpExecArray) => string),
): ProxyRoute {
  return {
    operation,
    method,
    pattern,
    upstreamPath: typeof upstreamPath === "function" ? upstreamPath : () => upstreamPath,
  };
}

function matchOperation(
  request: Request,
  pathPrefix: string,
): { operation: RealtimeAvatarProxyOperation; upstreamPath: string; search: string } | null {
  const url = new URL(request.url);
  const suffix = stripPathPrefix(url.pathname, normalizePathPrefix(pathPrefix));
  if (suffix === null) return null;
  const method = request.method.toUpperCase();
  for (const candidate of PROXY_ROUTES) {
    if (candidate.method !== method) continue;
    const match = candidate.pattern.exec(suffix);
    if (!match) continue;
    return { operation: candidate.operation, upstreamPath: candidate.upstreamPath(match), search: url.search };
  }
  return null;
}

async function buildUpstreamHeaders(
  request: Request,
  configuredHeaders: HeaderFactory | undefined,
  apiKey: string,
): Promise<Headers> {
  const headers = new Headers(await resolveHeaders(configuredHeaders));
  headers.set("Authorization", `Bearer ${apiKey}`);
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    if (headers.has(name)) continue;
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function forwardResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function pathPattern(path: string): RegExp {
  return new RegExp(`^${escapeRegExp(path)}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPathPrefix(pathname: string, prefix: string): string | null {
  if (prefix && !pathname.startsWith(prefix)) return null;
  const suffix = prefix ? pathname.slice(prefix.length) : pathname;
  return suffix || "/";
}

function normalizePathPrefix(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).pathname.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function isBodylessMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

async function resolveApiKey(apiKey: ApiKeyFactory): Promise<string | null | undefined> {
  return typeof apiKey === "function" ? apiKey() : apiKey;
}

async function resolveHeaders(headers: HeaderFactory | undefined): Promise<HeadersInit | undefined> {
  return typeof headers === "function" ? headers() : headers;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
