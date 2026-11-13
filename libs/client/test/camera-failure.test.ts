import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { RoomContext } from "@livekit/components-react";
import { ConnectionState, Room, RoomEvent } from "livekit-client";
import type { useAvatarCamera as UseAvatarCamera } from "../src/react/index.ts";

/**
 * A camera that will not turn on says what was thrown, and at which step.
 *
 * `useAvatarCamera` reported every failure that was not a browser `NotAllowedError` as
 * "unavailable", so a camera that failed on one Android phone, three times in a row, could not be
 * diagnosed: a busy device, a refused capture and a publication the room never confirmed all
 * read the same. `error` keeps its two values; `failure` adds the original name and message, and
 * the step that failed.
 *
 * Renders the shipped `realtime-avatar/react` hook in a real, unconnected LiveKit Room. Capture
 * runs through livekit-client's own `createLocalVideoTrack` to a scripted `getUserMedia`, so these
 * also prove LiveKit hands the device's error through untouched.
 */
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
// LiveKit's room-event observables subscribe only where `window` exists; node has none.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {}, removeEventListener: () => {} },
});
// A LocalTrack wraps its device track in a MediaStream, which node does not have.
Object.defineProperty(globalThis, "MediaStream", {
  configurable: true,
  value: class { constructor(readonly tracks: unknown[]) {} },
});
let getUserMedia: () => Promise<unknown> = async () => { throw new Error("getUserMedia was not scripted"); };
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: { getUserMedia: () => getUserMedia(), addEventListener() {}, removeEventListener() {} },
});

const sdk: { useAvatarCamera: typeof UseAvatarCamera } = await import(
  new URL("../../sdk-server/dist/react.js", import.meta.url).href
);

type Camera = ReturnType<typeof UseAvatarCamera>;

/** A device track that captures fine; `stopped` counts how often the SDK let go of it. */
function deviceTrack() {
  const device = {
    stopped: 0,
    kind: "video", id: "front", enabled: true, muted: false, readyState: "live", contentHint: "",
    getSettings: () => ({ deviceId: "front", width: 640, height: 360 }),
    getConstraints: () => ({}),
    addEventListener() {}, removeEventListener() {},
    stop() { device.stopped += 1; },
  };
  const stream = { getTracks: () => [device], getVideoTracks: () => [device], getAudioTracks: () => [] };
  return { device, stream };
}

async function mountCamera(): Promise<{ room: Room; camera: () => Camera }> {
  const room = new Room();
  let state: Camera | undefined;
  function CameraControl(): null {
    state = sdk.useAvatarCamera({ allowed: true });
    return null;
  }
  await act(async () => { create(createElement(RoomContext.Provider, { value: room }, createElement(CameraControl))); });
  await act(async () => { room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected); });
  const camera = () => {
    assert.ok(state);
    return state;
  };
  assert.equal(camera().available, true);
  return { room, camera };
}

async function enable(camera: () => Camera, enabled = true): Promise<void> {
  await act(async () => { await camera().setEnabled(enabled); });
}

test("a refused permission stays permission_denied and now names what the browser said", async () => {
  const { camera } = await mountCamera();
  getUserMedia = async () => { throw new DOMException("Permission denied", "NotAllowedError"); };
  await enable(camera);
  assert.equal(camera().error, "permission_denied");
  assert.deepEqual(camera().failure, { name: "NotAllowedError", message: "Permission denied", stage: "capture" });
});

test("any other capture failure stays unavailable, with the device's own name and message", async () => {
  const { camera } = await mountCamera();
  getUserMedia = async () => { throw new DOMException("Could not start video source", "NotReadableError"); };
  await enable(camera);
  assert.equal(camera().error, "unavailable");
  assert.deepEqual(camera().failure, {
    name: "NotReadableError", message: "Could not start video source", stage: "capture",
  });
});

test("React Native's rejection is read although it is not an Error", async () => {
  const { camera } = await mountCamera();
  // @livekit/react-native-webrtc rejects getUserMedia with a MediaStreamError: a plain class with
  // name and message. A refused Android permission arrives as this, named SecurityError.
  getUserMedia = async () => Promise.reject({ name: "SecurityError", message: "Permission denied." });
  await enable(camera);
  assert.equal(camera().error, "unavailable");
  assert.deepEqual(camera().failure, { name: "SecurityError", message: "Permission denied.", stage: "capture" });

  getUserMedia = async () => Promise.reject(undefined);
  await enable(camera);
  assert.deepEqual(camera().failure, { name: "Unknown", message: "undefined", stage: "capture" });
});

test("a publish failure is reported as publish, and the captured track is released", async () => {
  const { room, camera } = await mountCamera();
  const { device, stream } = deviceTrack();
  getUserMedia = async () => stream;
  room.localParticipant.publishTrack = async () => {
    throw Object.assign(new Error("publication of local track timed out, no response from server"),
      { name: "ConnectionError" });
  };
  await enable(camera);
  assert.equal(camera().error, "unavailable");
  assert.deepEqual(camera().failure, {
    name: "ConnectionError",
    message: "publication of local track timed out, no response from server",
    stage: "publish",
  });
  assert.equal(device.stopped, 1);
});

test("a retry clears the failure, and so does turning the camera off", async () => {
  const { room, camera } = await mountCamera();
  getUserMedia = async () => { throw new DOMException("Could not start video source", "NotReadableError"); };
  await enable(camera);
  assert.equal(camera().failure?.name, "NotReadableError");

  const published: unknown[] = [];
  room.localParticipant.publishTrack = async (track) => { published.push(track); return undefined as never; };
  room.localParticipant.unpublishTrack = async () => undefined;
  getUserMedia = async () => deviceTrack().stream;
  await enable(camera);
  assert.equal(published.length, 1);
  assert.equal(camera().error, null);
  assert.equal(camera().failure, null);

  await enable(camera, false);
  getUserMedia = async () => { throw new DOMException("Permission denied", "NotAllowedError"); };
  await enable(camera);
  assert.equal(camera().error, "permission_denied");
  await enable(camera, false);
  assert.equal(camera().error, null);
  assert.equal(camera().failure, null);
});
