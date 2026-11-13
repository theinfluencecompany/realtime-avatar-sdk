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

/**
 * The step that failed. Capture asks the device for a track; publish sends it to the room;
 * stop turns it off again (stopping capture and unpublishing), whether on request or because
 * the camera became unavailable.
 */
export type CameraStage = "capture" | "publish" | "stop";

/**
 * A failed camera step, carrying what the device or the room threw as `cause`.
 *
 * Every rejection of `setEnabled` and `close` is one of these. Before it existed, a refused
 * permission, a busy device and a publication that timed out on the server all reached the
 * app as the same "unavailable", so a failure in the field could not be told apart.
 */
export class CameraStageError extends Error {
  readonly stage: CameraStage;

  constructor(stage: CameraStage, cause: unknown) {
    super(`Camera ${stage} failed`, { cause });
    this.name = "CameraStageError";
    this.stage = stage;
  }
}

/**
 * A camera failure as data an app can show or report, read from the original error. Name and
 * message are each cut to 300 characters.
 */
export interface AvatarCameraFailure {
  /** The original error's name, e.g. `NotAllowedError`; `Unknown` when it has none. */
  name: string;
  /** The original error's message. */
  message: string;
  stage: CameraStage;
}

/** Bounds name and message, so a failure can go into analytics as it is. */
export const MAX_CAMERA_FAILURE_TEXT = 300;

/**
 * Read the original error by shape, not by class: React Native's WebRTC rejects getUserMedia
 * with a `MediaStreamError` that has `name` and `message` but is not an `Error`.
 */
export function describeCameraFailure({ stage, cause }: CameraStageError): AvatarCameraFailure {
  let name = "Unknown";
  let message = "";
  if (typeof cause === "object" && cause !== null) {
    if ("name" in cause && typeof cause.name === "string" && cause.name !== "") name = cause.name;
    if ("message" in cause && typeof cause.message === "string") message = cause.message;
  } else {
    message = String(cause);
  }
  return {
    name: name.slice(0, MAX_CAMERA_FAILURE_TEXT),
    message: message.slice(0, MAX_CAMERA_FAILURE_TEXT),
    stage,
  };
}

async function inStage<Value>(stage: CameraStage, run: () => Promise<Value>): Promise<Value> {
  try {
    return await run();
  } catch (cause) {
    throw new CameraStageError(stage, cause);
  }
}

function stopCapture(track: { stop(): void }): CameraStageError | undefined {
  try {
    track.stop();
    return undefined;
  } catch (cause) {
    return new CameraStageError("stop", cause);
  }
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
    const stopFailure = stopCapture(track);
    const operation = closing.then(async () => {
      await inStage("stop", () => driver.unpublish(track));
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
      const track = await inStage("capture", () => driver.capture(defaultCameraCaptureOptions()));
      if (!desired || disposed || attempt !== generation) {
        const stopFailure = stopCapture(track);
        if (stopFailure) throw stopFailure;
        return;
      }
      current = track;
      try {
        await driver.publish(track);
      } catch (cause) {
        if (current === track) current = null;
        // Cleanup still runs, but its own failure must not replace the publish error: that
        // error is the cause, and losing it behind a later one is what this module prevents.
        await retire(track).catch(() => {});
        throw new CameraStageError("publish", cause);
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
