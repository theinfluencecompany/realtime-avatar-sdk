import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectionState, useLocalParticipant } from "@livekit/components-react";
import { ConnectionState, Track, createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import { createCameraControl } from "../camera";

export function useAvatarCamera({ allowed, active = true }: { allowed: boolean; active?: boolean }) {
  const { localParticipant, cameraTrack, isCameraEnabled } = useLocalParticipant();
  const connection = useConnectionState();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"permission_denied" | "unavailable" | null>(null);
  const control = useRef<ReturnType<typeof createCameraControl<LocalVideoTrack>> | null>(null);
  const available = allowed && active && connection === ConnectionState.Connected;

  useEffect(() => {
    let alive = true;
    const current = createCameraControl({
      capture: createLocalVideoTrack,
      publish: (track) => localParticipant.publishTrack(track, { source: Track.Source.Camera }),
      unpublish: (track) => localParticipant.unpublishTrack(track, true),
      onPending: (value) => { if (alive) setPending(value); },
    });
    control.current = current;
    return () => {
      alive = false;
      control.current = null;
      void current.close().catch(() => {});
    };
  }, [localParticipant]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    const current = control.current;
    if (!current) return;
    setError(null);
    try {
      await current.setEnabled(enabled && available);
    } catch (failure) {
      if (control.current !== current) return;
      setError(failure instanceof Error && failure.name === "NotAllowedError"
        ? "permission_denied" : "unavailable");
    }
  }, [available]);

  useEffect(() => {
    if (!available) void setEnabled(false);
  }, [available, setEnabled]);

  const toggle = useCallback(() => setEnabled(!isCameraEnabled && !control.current?.pending),
    [isCameraEnabled, setEnabled]);

  return { enabled: isCameraEnabled, pending, error, available, toggle, setEnabled,
    publication: cameraTrack, participant: localParticipant };
}
