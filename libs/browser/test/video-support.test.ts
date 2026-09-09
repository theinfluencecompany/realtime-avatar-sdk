import assert from "node:assert/strict";
import { test } from "node:test";
import { checkVideoSupport } from "../src/video-support.ts";

test("unsupported browser and missing codec are distinct failures", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "RTCRtpReceiver");
  try {
    Reflect.deleteProperty(globalThis, "RTCRtpReceiver");
    assert.deepEqual(checkVideoSupport().supported, false);
    Object.defineProperty(globalThis, "RTCRtpReceiver", { configurable: true, value: {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/VP8" }] }),
    } });
    const unsupported = checkVideoSupport();
    assert.equal(unsupported.supported, false);
    if (!unsupported.supported) assert.equal(unsupported.reason, "codec_unavailable");
    assert.equal(checkVideoSupport("vp8").supported, true);
  } finally {
    if (original) Object.defineProperty(globalThis, "RTCRtpReceiver", original);
    else Reflect.deleteProperty(globalThis, "RTCRtpReceiver");
  }
});
