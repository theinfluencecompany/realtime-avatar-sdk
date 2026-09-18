import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraPublishOptions, createCameraControl } from "../src/camera.ts";

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {};
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

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

test("closing before permission resolves never publishes the captured track", async () => {
  let stopped = 0;
  let published = 0;
  const capture = deferred<{ stop(): void }>();
  const started = deferred<void>();
  const control = createCameraControl({
    capture: () => { started.resolve(); return capture.promise; },
    publish: async () => { published += 1; }, unpublish: async () => {}, onPending: () => {},
  });
  const opening = control.setEnabled(true);
  await started.promise;
  assert.equal(control.pending, true);
  await control.close();
  capture.resolve({ stop() { stopped += 1; } });
  await opening;
  await control.setEnabled(true);
  assert.equal(published, 0);
  assert.equal(stopped, 1);
});

test("concurrent enables share capture and cancellation wins", async () => {
  const capture = deferred<{ stop(): void }>();
  const started = deferred<void>();
  let captures = 0;
  let publications = 0;
  const control = createCameraControl({
    capture: () => { captures += 1; started.resolve(); return capture.promise; },
    publish: async () => { publications += 1; }, unpublish: async () => {}, onPending: () => {},
  });
  const first = control.setEnabled(true);
  await started.promise;
  const second = control.setEnabled(true);
  await control.setEnabled(false);
  capture.resolve({ stop() {} });
  await Promise.all([first, second]);
  assert.equal(captures, 1);
  assert.equal(publications, 0);
});

test("a new enable waits for the previous asynchronous unpublish", async () => {
  const requests: boolean[] = [];
  const stopped = deferred<void>();
  const stoppingStarted = deferred<void>();
  const control = createCameraControl({
    capture: async () => ({ stop() {} }),
    publish: async () => { requests.push(true); },
    unpublish: async () => { requests.push(false); stoppingStarted.resolve(); await stopped.promise; },
    onPending: () => {},
  });
  await control.setEnabled(true);
  const stopping = control.setEnabled(false);
  await stoppingStarted.promise;
  const restarting = control.setEnabled(true);
  assert.deepEqual(requests, [true, false]);
  stopped.resolve();
  await Promise.all([stopping, restarting]);
  assert.deepEqual(requests, [true, false, true]);
});

test("a synchronous capture failure does not poison pending state", async () => {
  let captures = 0;
  const control = createCameraControl({
    capture: () => {
      if (++captures === 1) throw new Error("device unavailable");
      return Promise.resolve({ stop() {} });
    },
    publish: async () => {}, unpublish: async () => {}, onPending: () => {},
  });
  await assert.rejects(control.setEnabled(true), /device unavailable/);
  assert.equal(control.pending, false);
  await control.setEnabled(true);
  assert.equal(captures, 2);
});

test("signaling cleanup is attempted even when the capture driver cannot stop", async () => {
  let unpublished = false;
  const control = createCameraControl({
    capture: async () => ({ stop() { throw new Error("device stop failed"); } }),
    publish: async () => {}, unpublish: async () => { unpublished = true; }, onPending: () => {},
  });
  await control.setEnabled(true);
  await assert.rejects(control.setEnabled(false));
  assert.equal(unpublished, true);
});

test("one controller can repeatedly enable and disable without closing the session", async () => {
  const published: object[] = [];
  const unpublished: object[] = [];
  const control = createCameraControl({
    capture: async () => ({ stop() {} }),
    publish: async (track) => { published.push(track); },
    unpublish: async (track) => { unpublished.push(track); }, onPending: () => {},
  });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await control.setEnabled(true);
    await control.setEnabled(false);
  }
  assert.equal(new Set(published).size, 3);
  assert.deepEqual(unpublished, published);
});
