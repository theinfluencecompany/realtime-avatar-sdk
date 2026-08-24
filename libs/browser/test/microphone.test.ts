import { test } from "node:test";
import assert from "node:assert/strict";

import { enableMicrophone } from "../src/microphone.ts";

/**
 * The point of these is that every branch names a DIFFERENT fix. A test that only asserted
 * `ok === false` would pass while the helper told a macOS user to click the address bar.
 */

/** A DOMException-shaped rejection, which is what getUserMedia actually produces. */
function domError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function roomThatRejects(error: unknown) {
  return { localParticipant: { setMicrophoneEnabled: () => Promise.reject(error) } };
}

/** `navigator.mediaDevices` present, so the pre-flight passes and we reach the call. */
function withSecureContext<T>(run: () => Promise<T>): Promise<T> {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: {} },
    configurable: true,
    writable: true,
  });
  return run().finally(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: previous,
      configurable: true,
      writable: true,
    });
  });
}

test("a granted microphone is ok, and carries nothing else", async () => {
  await withSecureContext(async () => {
    const result = await enableMicrophone({
      localParticipant: { setMicrophoneEnabled: () => Promise.resolve() },
    });
    assert.deepEqual(result, { ok: true });
  });
});

test("the OS denial and the BROWSER denial are told apart — they have different fixes", async () => {
  await withSecureContext(async () => {
    // Chromium emits both of these for a macOS TCC denial. Neither is fixable in the browser,
    // so pointing the user at the address bar is the wrong answer.
    for (const message of [
      "Permission denied by system",
      "System Permissions prevented access to audio capture device",
    ]) {
      const result = await enableMicrophone(roomThatRejects(domError("NotAllowedError", message)));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "denied-by-os");
      assert.match(result.hint, /System Settings/);
      assert.match(result.hint, /RESTART/);
    }

    // The site-level denial IS fixable in the browser, and only this one should say so.
    const inBrowser = await enableMicrophone(
      roomThatRejects(domError("NotAllowedError", "Permission denied")),
    );
    assert.equal(inBrowser.ok, false);
    if (inBrowser.ok) return;
    assert.equal(inBrowser.reason, "denied-by-browser");
    assert.match(inBrowser.hint, /address bar/);
    assert.doesNotMatch(inBrowser.hint, /System Settings/);
  });
});

test("device errors are classified by their DOMException name, legacy aliases included", async () => {
  await withSecureContext(async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["NotFoundError", "no-device"],
      ["DevicesNotFoundError", "no-device"],
      ["OverconstrainedError", "no-device"],
      ["NotReadableError", "device-in-use"],
      ["TrackStartError", "device-in-use"],
      ["AbortError", "device-in-use"],
      ["PermissionDeniedError", "denied-by-browser"],
      ["SecurityError", "insecure-origin"],
      ["WhoKnowsError", "unknown"],
    ];
    for (const [name, expected] of cases) {
      const result = await enableMicrophone(roomThatRejects(domError(name, "x")));
      assert.equal(result.ok, false, name);
      if (result.ok) return;
      assert.equal(result.reason, expected, name);
      assert.ok(result.hint.length > 0, name);
    }
  });
});

test("an insecure origin is reported BEFORE the call, naming the origin and not the property", async () => {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: {},
    configurable: true,
    writable: true,
  });
  try {
    let called = false;
    const result = await enableMicrophone({
      localParticipant: {
        setMicrophoneEnabled: () => {
          called = true;
          return Promise.resolve();
        },
      },
    });
    assert.equal(called, false, "must not attempt capture on an insecure origin");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "insecure-origin");
    assert.match(result.hint, /https/);
    // The trap this exists for: localhost is fine, a LAN address is not.
    assert.match(result.hint, /localhost/);
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      value: previous,
      configurable: true,
      writable: true,
    });
  }
});

test("a prompt that is never answered times out instead of hanging forever", async () => {
  await withSecureContext(async () => {
    // Per spec getUserMedia may neither resolve nor reject if the user ignores the prompt.
    // Without the deadline this await never returns and the page has no state to render.
    const result = await enableMicrophone({ localParticipant: { setMicrophoneEnabled: () => new Promise(() => {}) } }, {
      timeoutMs: 20,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no-answer");
    assert.match(result.hint, /prompt/);
  });
});

test("it never throws — the cause is a value the caller has to handle", async () => {
  await withSecureContext(async () => {
    for (const thrown of [undefined, null, "a string", 42, {}]) {
      const result = await enableMicrophone(roomThatRejects(thrown));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "unknown");
    }
  });
});
