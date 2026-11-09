import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  createExternalPerformanceObserver, EXTERNAL_PERFORMANCE_TIMING, KNOWN_EXTERNAL_PERFORMANCE_STATUSES,
  type ExternalPerformanceFrame, type ExternalPerformanceInvalidation,
} from "../src/external-performance.ts";
import { lifecycleServerFrameSchema } from "../src/wire.ts";

const ACCEPTED = {
  kind: "external_performance", version: 1, session_id: "session-1", generation_id: "generation-1",
  status: "accepted", audible_checkpoint: "unavailable", audio_mapping: "unavailable",
} as const satisfies ExternalPerformanceFrame;
const frame = (generation_id: string, status: ExternalPerformanceFrame["status"]): ExternalPerformanceFrame =>
  ({ ...ACCEPTED, generation_id, status });

function setup() {
  const frames: ExternalPerformanceFrame[] = [];
  const invalidations: ExternalPerformanceInvalidation[] = [];
  const observer = createExternalPerformanceObserver("session-1", {
    onFrame: (f) => { frames.push(f); },
    onInvalidated: (reason) => { invalidations.push(reason); },
  });
  const seen = () => frames.map((f) => `${f.generation_id}:${f.status}`);
  return { observer, frames, invalidations, seen };
}

test("the lifecycle decoder drops a newer worker's additions and refuses only an incompatible frame", () => {
  assert.equal(lifecycleServerFrameSchema.safeParse(ACCEPTED).success, true);
  for (const added of [{ epoch: 2 }, { utterance_id: "u" }, { sample_position: 0 }, { emotion: "happy" }]) {
    assert.deepEqual(lifecycleServerFrameSchema.parse({ ...ACCEPTED, ...added }), ACCEPTED, JSON.stringify(added));
  }
  assert.equal(lifecycleServerFrameSchema.parse({ ...ACCEPTED, status: "audio_finished" }).kind, "external_performance");
  for (const invalid of [
    { ...ACCEPTED, version: 2 }, { ...ACCEPTED, status: "" },
    { ...ACCEPTED, audible_checkpoint: 1 }, { ...ACCEPTED, audio_mapping: { sample_rate_hz: 24000 } },
    { ...ACCEPTED, generation_id: "" }, { ...ACCEPTED, session_id: undefined },
  ]) assert.equal(lifecycleServerFrameSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test("a status this SDK predates is skipped without disturbing its generation", () => {
  const { observer, seen } = setup();
  observer.receive(frame("g1", "accepted"));
  observer.receive(frame("g1", "audio_finished"));
  observer.receive(frame("g2", "audio_finished"));
  observer.receive(frame("g1", "audio_released"));
  assert.deepEqual(seen(), ["g1:accepted", "g1:audio_released"]);
  assert.deepEqual(KNOWN_EXTERNAL_PERFORMANCE_STATUSES, ["accepted", "dropped", "cancelled", "audio_released"]);
});

test("each generation follows the producer's own transitions; duplicates and late frames are dropped", () => {
  const { observer, seen } = setup();
  observer.receive(frame("g1", "audio_released")); // its admission was never observed
  observer.receive(frame("g1", "cancelled")); // nothing admitted to cancel
  observer.receive(frame("g1", "accepted"));
  observer.receive(frame("g1", "accepted"));
  observer.receive(frame("g1", "audio_released"));
  observer.receive(frame("g1", "audio_released"));
  observer.receive(frame("g1", "accepted")); // a second speech of the same generation is not a new admission
  observer.receive(frame("g1", "cancelled"));
  observer.receive(frame("g1", "cancelled"));
  observer.receive(frame("g1", "accepted")); // terminal wins over late frames
  observer.receive(frame("g2", "dropped"));
  observer.receive(frame("g2", "accepted")); // a refused draft is never admitted afterwards
  assert.deepEqual(seen(), ["g1:accepted", "g1:audio_released", "g1:cancelled", "g2:dropped"]);
});

test("an earlier generation may still be released after a later one is admitted", () => {
  // Generation ids are UUIDs with no order, and the worker queues speech: the SDK invents no
  // "newest wins" rule the producer does not state.
  const { observer, seen } = setup();
  observer.receive(frame("g1", "accepted"));
  observer.receive(frame("g2", "accepted"));
  observer.receive(frame("g1", "audio_released"));
  assert.deepEqual(seen(), ["g1:accepted", "g2:accepted", "g1:audio_released"]);
});

test("a frame naming another call's session is not this call's", () => {
  const { observer, frames } = setup();
  observer.receive({ ...ACCEPTED, session_id: "session-0" });
  assert.deepEqual(frames, []);
});

test("connection loss invalidates once; after reconnecting only generations first seen since are observed", () => {
  const { observer, invalidations, seen } = setup();
  observer.receive(frame("g1", "accepted"));
  observer.invalidate("connection_lost");
  observer.invalidate("connection_lost");
  observer.receive(frame("g2", "accepted")); // arrived while the connection was down
  observer.resume();
  observer.receive(frame("g1", "audio_released")); // the previous connection's generation
  observer.receive(frame("g1", "cancelled"));
  observer.receive(frame("g2", "audio_released")); // its admission was never observed
  observer.receive(frame("g3", "accepted"));
  observer.receive(frame("g3", "audio_released"));
  assert.deepEqual(seen(), ["g1:accepted", "g3:accepted", "g3:audio_released"]);
  assert.deepEqual(invalidations, ["connection_lost"]);
});

test("ending is final, and still reported to an observer paused by connection loss", () => {
  const paused = setup();
  paused.observer.invalidate("connection_lost");
  paused.observer.invalidate("ended");
  paused.observer.resume();
  paused.observer.receive(frame("g1", "accepted"));
  paused.observer.invalidate("binding_changed");
  assert.deepEqual(paused.invalidations, ["connection_lost", "ended"]);
  assert.deepEqual(paused.frames, []);

  const replaced = setup();
  replaced.observer.invalidate("binding_changed");
  replaced.observer.resume();
  replaced.observer.receive(frame("g1", "accepted"));
  assert.deepEqual(replaced.invalidations, ["binding_changed"]);
  assert.deepEqual(replaced.frames, []);
});

test("a long call keeps observing past thousands of generations", () => {
  // A generation that finishes normally gets no terminal frame, so a cap on remembered
  // generations must forget the oldest rather than stop observing the call.
  const { observer, frames, invalidations } = setup();
  for (let i = 0; i < 5000; i++) {
    observer.receive(frame(`g${i}`, "accepted"));
    observer.receive(frame(`g${i}`, "audio_released"));
  }
  observer.receive(frame("g4999", "cancelled"));
  observer.receive(frame("g4999", "accepted"));
  assert.equal(frames.length, 10_001);
  assert.deepEqual(invalidations, []);
});

test("observer exceptions do not interrupt the call or undo deduplication", () => {
  let count = 0;
  const observer = createExternalPerformanceObserver("session-1", {
    onFrame: () => { count++; throw new Error("app failed"); },
    onInvalidated: () => Promise.reject(new Error("app failed")),
  });
  assert.doesNotThrow(() => { observer.receive(ACCEPTED); observer.receive(ACCEPTED); observer.invalidate("ended"); });
  assert.equal(count, 1);
});

test("receiver playout is reported unsupported, in the producer's own words", () => {
  assert.deepEqual(EXTERNAL_PERFORMANCE_TIMING, {
    receiverPlayout: "unsupported", audibleCheckpoint: "unavailable", audioMapping: "unavailable",
  });
  assert.equal(Object.isFrozen(EXTERNAL_PERFORMANCE_TIMING), true);
});

test("no private LiveKit connection internals and no invented clock", () => {
  for (const file of ["../src/external-performance.ts", "../src/react/session-lifecycle.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.engine\b|pcManager|RTCPeerConnection|livekit-client\/(?:dist|src)/, file);
  }
  const adapter = readFileSync(new URL("../src/external-performance.ts", import.meta.url), "utf8");
  assert.doesNotMatch(adapter, /setInterval|setTimeout|performance\.now|Date\.now|getStats/);
});
