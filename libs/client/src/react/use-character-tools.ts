import { useEffect, useMemo, useRef, useState } from "react";
import { useConnectionState, useRoomContext } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import {
  attachAvatarTools,
  ToolRegistrationError,
  type RegisteredTool,
  type ToolContext,
  type ToolRegistration,
} from "../../../tools/src/index.ts";

/**
 * Where her tools stand in this call.
 *
 * - `idle`: the room is not connected, so there is nothing to register with.
 * - `registering`: publishing the manifest; `attempt` counts from 1 and rises on each retry.
 * - `ready`: armed; `registered` is what the agent accepted, `rejected` what it dropped and why.
 * - `error`: registration failed for good while connected; `error` says why. A tool that is not
 *   armed is silently uncallable, which reads exactly like the model ignoring it.
 */
export type CharacterToolsState = {
  status: "idle" | "registering" | "ready" | "error";
  registered: string[];
  rejected: ToolRegistration["rejected"];
  error?: string;
  attempt?: number;
};

/**
 * Pauses before re-registering after a retryable failure, while the room stays connected. Each
 * attempt already waits up to 8s for the agent to arm registration, so three attempts give a slow
 * agent about 25s. Past that, a session minted without `client_tools` is the likelier cause, and
 * retrying forever would only hide it.
 */
export const CHARACTER_TOOLS_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/** What re-registration depends on: the names, descriptions and schemas, not object identity. */
function manifestKey(tools: Record<string, RegisteredTool>): string {
  return JSON.stringify(Object.entries(tools).map(([name, tool]) => [name, tool.description, tool.parameters ?? null]));
}

export function useCharacterTools(tools: Record<string, RegisteredTool>, options: {
  onResult?: (event: { name: string; callId: string; ok: boolean; error?: string }) => void;
} = {}): CharacterToolsState {
  const room = useRoomContext();
  const connection = useConnectionState();
  const callback = useRef(options.onResult);
  callback.current = options.onResult;
  // An inline `tools` object is a new identity on every render. Keyed on identity, the effect
  // below re-registered on every render, and its own `registering` update re-rendered: an app
  // that wrote `useCharacterTools({ lookup: { … } })` looped until React gave up ("Maximum
  // update depth exceeded"). Key on the manifest instead, and reach each tool's CURRENT
  // `execute` through a ref, so a new closure is used without re-registering.
  const latest = useRef(tools);
  latest.current = tools;
  const key = manifestKey(tools);
  const stable = useMemo<Record<string, RegisteredTool>>(() => Object.fromEntries(
    Object.entries(latest.current).map(([name, tool]): [string, RegisteredTool] => [
      name,
      // A tool without a callable `execute` is passed as it is, so the manifest still rejects it.
      typeof tool.execute !== "function" ? tool : {
        description: tool.description,
        parameters: tool.parameters,
        execute: (args: never, context: ToolContext) => latest.current[name]?.execute(args, context),
      },
    ]),
  // `key` IS the dependency: it changes exactly when the manifest does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [key]);
  const [state, setState] = useState<CharacterToolsState>({ status: "idle", registered: [], rejected: [] });
  useEffect(() => {
    if (connection !== ConnectionState.Connected) {
      setState({ status: "idle", registered: [], rejected: [] });
      return;
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const register = (attempt: number): void => {
      setState({ status: "registering", registered: [], rejected: [], attempt });
      void attachAvatarTools(room, stable, {
        signal: abort.signal,
        onResult: (event) => { if (!abort.signal.aborted) callback.current?.(event); },
      }).then((result) => {
        if (abort.signal.aborted) { result.dispose(); return; }
        setState({ status: "ready", registered: result.accepted, rejected: result.rejected, attempt });
      }).catch((error: unknown) => {
        if (abort.signal.aborted) return;
        // Retry only what a later attempt can change. The cleanup below (a disconnect, a new
        // manifest, an unmount) cancels a pending retry.
        const delay = CHARACTER_TOOLS_RETRY_DELAYS_MS[attempt - 1];
        if (error instanceof ToolRegistrationError && error.retryable && delay !== undefined) {
          timer = setTimeout(() => register(attempt + 1), delay);
          return;
        }
        setState({ status: "error", registered: [], rejected: [], attempt,
          error: error instanceof Error ? error.message : "Tool registration failed",
        });
      });
    };
    register(1);
    return () => {
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [room, stable, connection]);
  return state;
}
