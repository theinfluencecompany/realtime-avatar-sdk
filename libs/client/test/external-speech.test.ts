import assert from "node:assert/strict";
import { test } from "node:test";
import { observeExternalSpeech } from "../dist/browser/index.js";

type Handler = (
  payload: Uint8Array,
  participant?: { identity?: string } | null,
  kind?: unknown,
  topic?: string,
) => void;

test("observeExternalSpeech accepts worker state, ignores viewers, and unsubscribes", () => {
  let handler: Handler | undefined;
  let removed: Handler | undefined;
  const room = {
    on: (_event: "dataReceived", next: Handler) => { handler = next; },
    off: (_event: "dataReceived", next: Handler) => { removed = next; },
  };
  const states: string[] = [];
  const unsubscribe = observeExternalSpeech(room, (frame) => states.push(frame.state));
  const payload = new TextEncoder().encode(JSON.stringify({
    kind: "external_speech_state", speech_id: "answer-1", state: "playing",
  }));

  handler?.(payload, { identity: "viewer-1" }, undefined, "rta.external_speech.state");
  handler?.(payload, { identity: "agent-avatar-1" }, undefined, "another.topic");
  handler?.(payload, { identity: "agent-avatar-1" }, undefined, "rta.external_speech.state");
  assert.deepEqual(states, ["playing"]);

  unsubscribe();
  assert.equal(removed, handler);
});
