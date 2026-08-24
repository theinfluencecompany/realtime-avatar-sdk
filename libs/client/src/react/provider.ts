import { createContext, createElement, useContext, useMemo } from "react";
import type { ReactElement, ReactNode } from "react";
import { RealtimeAvatarClient } from "../client";
import type { LiveKitSessionRequest } from "../livekit-grant";

export type RealtimeAvatarProviderDefaults = {
  /** Applied by app-level hooks that create LiveKit sessions. */
  session?: Partial<LiveKitSessionRequest>;
};

export type RealtimeAvatarProviderProps = {
  /** Shared SDK client. Browser apps usually pass `RealtimeAvatarClient.browser(...)`. */
  client?: RealtimeAvatarClient;
  /** Defaults shared by LiveKit avatar session hooks below this provider. */
  defaults?: RealtimeAvatarProviderDefaults;
  children?: ReactNode;
};

export type RealtimeAvatarContextValue = {
  client: RealtimeAvatarClient;
  defaults: RealtimeAvatarProviderDefaults;
};

const RealtimeAvatarContext = createContext<RealtimeAvatarContextValue | null>(null);
let defaultBrowserClient: RealtimeAvatarClient | null = null;

/**
 * Optional app-level SDK configuration. Most apps can skip this; use it when
 * self-hosting routes, testing with a mock client, or setting global defaults.
 */
export function RealtimeAvatarProvider(props: RealtimeAvatarProviderProps): ReactElement {
  const { client, defaults, children } = props;
  const fallbackClient = useMemo(() => client ?? RealtimeAvatarClient.browser(), [client]);
  const value = useMemo<RealtimeAvatarContextValue>(
    () => ({ client: fallbackClient, defaults: defaults ?? {} }),
    [fallbackClient, defaults],
  );
  return createElement(RealtimeAvatarContext.Provider, { value }, children);
}

export function useRealtimeAvatarClient(): RealtimeAvatarClient {
  return useRealtimeAvatarContext().client;
}

export function useRealtimeAvatarContext(): RealtimeAvatarContextValue {
  const context = useContext(RealtimeAvatarContext);
  if (context) return context;
  defaultBrowserClient ??= RealtimeAvatarClient.browser();
  return { client: defaultBrowserClient, defaults: {} };
}
