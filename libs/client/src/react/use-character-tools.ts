import { useEffect, useRef, useState } from "react";
import { useConnectionState, useRoomContext } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { attachAvatarTools, type RegisteredTool, type ToolRegistration } from "../../../tools/src/index.ts";

export function useCharacterTools(tools: Record<string, RegisteredTool>, options: {
  onResult?: (event: { name: string; callId: string; ok: boolean; error?: string }) => void;
} = {}) {
  const room = useRoomContext();
  const connection = useConnectionState();
  const callback = useRef(options.onResult);
  callback.current = options.onResult;
  const [state, setState] = useState<{
    status: "idle" | "registering" | "ready" | "error";
    registered: string[];
    rejected: ToolRegistration["rejected"];
    error?: string;
  }>({ status: "idle", registered: [], rejected: [] });
  useEffect(() => {
    if (connection !== ConnectionState.Connected) {
      setState({ status: "idle", registered: [], rejected: [] });
      return;
    }
    const abort = new AbortController();
    setState({ status: "registering", registered: [], rejected: [] });
    void attachAvatarTools(room, tools, {
      signal: abort.signal,
      onResult: (event) => { if (!abort.signal.aborted) callback.current?.(event); },
    }).then((result) => {
      if (abort.signal.aborted) { result.dispose(); return; }
      setState({ status: "ready", registered: result.accepted, rejected: result.rejected });
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setState({ status: "error", registered: [], rejected: [],
        error: error instanceof Error ? error.message : "Tool registration failed",
      });
    });
    return () => abort.abort();
  }, [room, tools, connection]);
  return state;
}
