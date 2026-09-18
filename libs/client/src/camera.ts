import type { VideoCaptureOptions } from "livekit-client";
import type { LiveKitSessionGrant } from "./livekit-grant";

export function cameraPublishOptions(
  grant: Pick<LiveKitSessionGrant, "camera"> | null | undefined,
  video: boolean | VideoCaptureOptions,
): boolean | VideoCaptureOptions {
  if (grant?.camera !== true) return false;
  return video === true
    ? { resolution: { width: 640, height: 360, frameRate: 5 }, facingMode: "user" }
    : video;
}

export function createCameraControl(
  publish: (enabled: boolean, options?: VideoCaptureOptions) => Promise<unknown>,
  stopCapture: () => void,
  onPending: (pending: boolean) => void,
) {
  let desired = false;
  let disposed = false;
  let opening: Promise<void> | null = null;
  const stop = async () => {
    stopCapture();
    await publish(false);
  };
  return {
    get pending() { return opening !== null; },
    async setEnabled(enabled: boolean): Promise<void> {
      desired = enabled && !disposed;
      if (!desired) return stop();
      if (opening) return opening;
      onPending(true);
      const options = cameraPublishOptions({ camera: true }, true);
      opening = (async () => {
        try {
          await publish(true, typeof options === "boolean" ? undefined : options);
          if (!desired || disposed) await stop();
        } finally {
          opening = null;
          onPending(false);
        }
      })();
      return opening;
    },
    async close() {
      disposed = true;
      desired = false;
      await stop();
    },
  };
}
