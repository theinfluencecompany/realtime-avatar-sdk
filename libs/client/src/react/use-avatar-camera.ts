import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectionState, useLocalParticipant } from "@livekit/components-react";
import { ConnectionState, Track, createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import {
  CameraStageError,
  createCameraControl,
  describeCameraFailure,
  type AvatarCameraFailure,
} from "../camera";

export type { AvatarCameraFailure } from "../camera";

export function useAvatarCamera({ allowed, active = true }: { allowed: boolean; active?: boolean }) {
  const { localParticipant, cameraTrack, isCameraEnabled } = useLocalParticipant();
  const connection = useConnectionState();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AvatarCameraFailure | null>(null);
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
    setFailure(null);
    try {
      await current.setEnabled(enabled && available);
    } catch (thrown) {
      if (control.current !== current) return;
      // The control rejects only with CameraStageError; anything else is a bug, not a camera state.
      if (!(thrown instanceof CameraStageError)) throw thrown;
      setFailure(describeCameraFailure(thrown));
    }
  }, [available]);

  useEffect(() => {
    if (!available) void setEnabled(false);
  }, [available, setEnabled]);

  const toggle = useCallback(() => setEnabled(!isCameraEnabled && !control.current?.pending),
    [isCameraEnabled, setEnabled]);

  // `error` is the coarse state the hook has always returned; `failure` says what was thrown.
  const error: "permission_denied" | "unavailable" | null = failure === null ? null
    : failure.name === "NotAllowedError" ? "permission_denied" : "unavailable";

  return { enabled: isCameraEnabled, pending, error, failure, available, toggle, setEnabled,
    publication: cameraTrack, participant: localParticipant };
}
