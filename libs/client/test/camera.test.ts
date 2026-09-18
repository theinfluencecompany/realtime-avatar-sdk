import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraPublishOptions, createCameraControl } from "../src/camera.ts";

test("camera capture is opt-in on both sides and uses bounded defaults", () => {
  assert.equal(cameraPublishOptions(undefined, true), false);
  assert.equal(cameraPublishOptions({ camera: false }, true), false);
  assert.equal(cameraPublishOptions({ camera: true }, false), false);
  assert.deepEqual(cameraPublishOptions({ camera: true }, true), {
    resolution: { width: 640, height: 360, frameRate: 5 }, facingMode: "user",
  });
  const options = { facingMode: "environment" as const };
  assert.equal(cameraPublishOptions({ camera: true }, options), options);
});

test("closing fences a camera permission that resolves after disposal", async () => {
  const requests: boolean[] = [];
  let finish = () => {};
  const control = createCameraControl(async (enabled) => {
    requests.push(enabled);
    if (enabled) await new Promise<void>((resolve) => { finish = resolve; });
  }, () => {}, () => {});
  const opening = control.setEnabled(true);
  assert.equal(control.pending, true);
  await control.close();
  finish();
  await opening;
  assert.equal(requests.at(-1), false);
  await control.setEnabled(true);
  assert.equal(requests.filter(Boolean).length, 1);
});

test("concurrent camera enables share one device request and cancellation wins", async () => {
  const requests: boolean[] = [];
  let finish = () => {};
  const control = createCameraControl(async (enabled) => {
    requests.push(enabled);
    if (enabled) await new Promise<void>((resolve) => { finish = resolve; });
  }, () => {}, () => {});
  const first = control.setEnabled(true);
  const second = control.setEnabled(true);
  await control.setEnabled(false);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(requests, [true, false, false]);
});
