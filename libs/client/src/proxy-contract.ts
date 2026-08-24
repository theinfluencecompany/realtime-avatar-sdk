export const DEFAULT_PLATFORM_BASE_URL = "https://realtimeavatar.ai";
export const DEFAULT_BROWSER_PROXY_URL = "/api/realtime-avatar";
export const PLATFORM_API_PREFIX = "/api/v1";

export type RealtimeAvatarProxyOperation =
  | "assets.upload"
  | "assets.remote"
  | "avatars.list"
  | "avatars.create"
  | "avatars.get"
  | "avatars.update"
  | "avatars.delete"
  | "credits.balance"
  | "realtime.livekitCapacity"
  | "realtime.livekitSession"
  | "realtime.livekitSessionRelease";

export const PLATFORM_ENDPOINTS = {
  assets: `${PLATFORM_API_PREFIX}/assets`,
  assetsRemote: `${PLATFORM_API_PREFIX}/assets/remote`,
  avatars: `${PLATFORM_API_PREFIX}/avatars`,
  creditsBalance: `${PLATFORM_API_PREFIX}/credits/balance`,
  realtimeLiveKitCapacity: `${PLATFORM_API_PREFIX}/realtime/livekit/capacity`,
  realtimeLiveKitSession: `${PLATFORM_API_PREFIX}/realtime/livekit/session`,
  realtimeLiveKitSessionRelease: `${PLATFORM_API_PREFIX}/realtime/livekit/session/release`,
} as const;

export const BROWSER_PROXY_ENDPOINTS = {
  assets: "/assets",
  assetsRemote: "/assets/remote",
  avatars: "/avatars",
  creditsBalance: "/credits/balance",
  realtimeLiveKitCapacity: "/realtime/livekit/capacity",
  realtimeLiveKitSession: "/realtime/livekit/session",
  realtimeLiveKitSessionRelease: "/realtime/livekit/session/release",
} as const;

export function proxyPathForPlatformPath(path: string, proxyUrl: string): string {
  if (path === PLATFORM_API_PREFIX) return proxyUrl;
  if (path.startsWith(`${PLATFORM_API_PREFIX}/`)) {
    return joinPath(proxyUrl, path.slice(`${PLATFORM_API_PREFIX}/`.length));
  }
  return path;
}

export function joinPath(prefix: string, path: string): string {
  if (!prefix) return path.startsWith("/") ? path : `/${path}`;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${prefix}${suffix}`;
}
