import type { VideoCaptureOptions } from "livekit-client";
import type { LiveKitSessionGrant } from "./livekit-grant";

function defaultCameraCaptureOptions(): VideoCaptureOptions {
  return { resolution: { width: 640, height: 360, frameRate: 5 }, facingMode: "user" };
}

export function cameraPublishOptions(
  grant: Pick<LiveKitSessionGrant, "camera"> | null | undefined,
  video: boolean | VideoCaptureOptions,
): boolean | VideoCaptureOptions {
  if (grant?.camera !== true) return false;
  return video === true
    ? defaultCameraCaptureOptions()
    : video;
}

export function createCameraControl<CameraTrack extends { stop(): void }>(driver: {
  capture: (options: VideoCaptureOptions) => Promise<CameraTrack>;
  publish: (track: CameraTrack) => Promise<unknown>;
  unpublish: (track: CameraTrack) => Promise<unknown>;
  onPending: (pending: boolean) => void;
}) {
  let desired = false;
  let disposed = false;
  let generation = 0;
  let current: CameraTrack | null = null;
  let opening: Promise<void> | null = null;
  let closing = Promise.resolve();

  const retire = (track: CameraTrack): Promise<void> => {
    let stopFailure: Error | undefined;
    try { track.stop(); } catch (cause) {
      stopFailure = new Error("Camera capture could not stop", { cause });
    }
    const operation = closing.then(async () => {
      await driver.unpublish(track);
      if (stopFailure) throw stopFailure;
    });
    closing = operation.catch(() => {});
    return operation;
  };

  async function setEnabled(enabled: boolean): Promise<void> {
    desired = enabled && !disposed;
    if (!desired) {
      generation += 1;
      const track = current;
      current = null;
      if (track) await retire(track);
      return;
    }
    if (opening) {
      await opening;
      if (desired && !disposed && !current) await setEnabled(true);
      return;
    }
    if (current) return;
    const attempt = generation;
    driver.onPending(true);
    opening = Promise.resolve().then(async () => {
      await closing;
      if (!desired || disposed || attempt !== generation) return;
      const track = await driver.capture(defaultCameraCaptureOptions());
      if (!desired || disposed || attempt !== generation) {
        track.stop();
        return;
      }
      current = track;
      try {
        await driver.publish(track);
      } catch (error) {
        if (current === track) current = null;
        await retire(track);
        throw error;
      }
      if (!desired || disposed || attempt !== generation) {
        if (current === track) current = null;
        await retire(track);
      }
    }).finally(() => {
      opening = null;
      driver.onPending(false);
    });
    return opening;
  }

  return {
    get pending() { return opening !== null; },
    setEnabled,
    async close() {
      disposed = true;
      await setEnabled(false);
    },
  };
}
