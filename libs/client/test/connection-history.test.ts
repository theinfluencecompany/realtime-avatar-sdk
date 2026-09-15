import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionQuality, ConnectionState } from "livekit-client";
import { createConnectionHistoryCollector } from "../src/react/connection-history.ts";

const grant = {
  endpoint: "https://rta.example.invalid/v1/connection-history",
  token: "x".repeat(32),
  expiresAt: "2026-09-15T11:00:00.000Z",
} as const;
const details = {
  connectionState: ConnectionState.Connected,
  localQuality: ConnectionQuality.Good,
  audio: null,
  video: { publisherQuality: ConnectionQuality.Excellent, streamState: null },
};

test("collector batches changed native facts and flushes on dispose", async () => {
  const bodies: unknown[] = [];
  let mono = 10;
  const collector = createConnectionHistoryCollector({
    sessionId: "rts_abc",
    grant,
    clock: { wallMs: () => 1_757_918_400_000, monotonicMs: () => mono },
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
  });
  collector.enqueue(details);
  collector.enqueue(details);
  mono = 110;
  collector.enqueue({ ...details, localQuality: ConnectionQuality.Poor });
  await collector.dispose();
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], {
    sessionId: "rts_abc",
    observations: [
      { sequence: 1, elapsedMs: 0, clientObservedAt: "2025-09-15T06:40:00.000Z", connectionState: "connected", localQuality: "good", audioQuality: null, videoQuality: "excellent" },
      { sequence: 2, elapsedMs: 100, clientObservedAt: "2025-09-15T06:40:00.100Z", connectionState: "connected", localQuality: "poor", audioQuality: null, videoQuality: "excellent" },
    ],
  });
});

test("a failed upload is bounded and never retries after the capability is retired", async () => {
  let calls = 0;
  const collector = createConnectionHistoryCollector({
    sessionId: "rts_abc",
    grant,
    maxRetries: 0,
    clock: { wallMs: () => Date.parse(grant.expiresAt) - 60_000 },
    fetch: async () => { calls++; throw new Error("offline"); },
  });
  collector.enqueue(details);
  await collector.dispose();
  collector.enqueue({ ...details, localQuality: ConnectionQuality.Poor });
  assert.equal(calls, 1);
});

test("deduplication survives a completed batch and an empty flush does not wedge future uploads", async () => {
  let calls = 0;
  const collector = createConnectionHistoryCollector({
    sessionId: "rts_abc", grant, maxRetries: 0,
    clock: { wallMs: () => Date.parse(grant.expiresAt) - 60_000 },
    fetch: async () => { calls++; return new Response(null, { status: 204 }); },
  });
  collector.enqueue(details);
  await collector.flush();
  await collector.flush();
  collector.enqueue(details);
  await collector.flush();
  assert.equal(calls, 1);
});
