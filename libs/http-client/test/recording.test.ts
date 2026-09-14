import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatar } from "../src/client.ts";
import type { components } from "../src/generated/openapi.ts";
import type { RecordingArtifact, RecordingAccessResponse, ListRecordingsResponse } from "../src/generated/recording.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const contractParity: [
  Equal<RecordingArtifact, components["schemas"]["Recording"]>,
  Equal<RecordingAccessResponse, components["schemas"]["RecordingAccessResponse"]>,
  Equal<ListRecordingsResponse, components["schemas"]["ListRecordingsResponse"]>,
] = [true, true, true];
void contractParity;

const pending = {
  recordingId: "rec_test", sessionId: "session_test", mode: "audio_video",
  status: "pending", createdAt: "2026-09-14T12:00:00.000Z", retainedUntil: "2026-10-14T12:00:00.000Z",
} as const;
const grant = {
  status: "ready", session_id: pending.sessionId, room_name: "test-room",
  livekit_url: "wss://example.test", participant_token: "test-token",
  participant_identity: "test-user", reservation_expires_at: "2026-09-14T12:02:00.000Z",
  recording: pending,
};

test("startCall sends server recording policy and preserves its correlated artifact", async () => {
  let request: Request | undefined;
  const rta = new RealtimeAvatar({ apiKey: "test-key", fetch: async (input, init) => {
    request = new Request(input, init);
    return Response.json(grant);
  } });
  const call = await rta.startCall({ avatarId: "avatar_test", recording: "audio_video" });
  assert.ok(request);
  const body: unknown = await request.json();
  assert.ok(typeof body === "object" && body !== null && "recording" in body);
  assert.equal(body.recording, "audio_video");
  assert.ok("recording" in call);
  assert.deepEqual(call.recording, pending);
  assert.ok("raw" in call);
  assert.deepEqual(call.raw, grant);
});

test("recordings stay off unless server policy opts in", async () => {
  const { recording: _recording, ...ordinaryGrant } = grant;
  const rta = new RealtimeAvatar({ apiKey: "test-key", fetch: async (input, init) => {
    const body: unknown = await new Request(input, init).json();
    assert.ok(typeof body === "object" && body !== null);
    assert.equal("recording" in body, false);
    return Response.json(ordinaryGrant);
  } });
  await rta.startCall({ avatarId: "avatar_test" });
});

test("recording list uses the session filter and validates returned metadata", async () => {
  const rta = new RealtimeAvatar({ apiKey: "test-key", fetch: async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v1/recordings");
    assert.equal(url.searchParams.get("sessionId"), pending.sessionId);
    assert.equal(url.searchParams.get("cursor"), "next+page=");
    return Response.json({ data: [pending], nextCursor: null });
  } });
  assert.deepEqual(await rta.listRecordings({ sessionId: pending.sessionId, cursor: "next+page=" }), { data: [pending], nextCursor: null });
});

test("metadata and temporary access use separate authenticated requests", async () => {
  const requests: Request[] = [];
  const access = { recordingId: pending.recordingId, url: "https://media.example.test/video.mp4?signature=test", expiresAt: "2026-09-14T13:00:00.000Z" };
  const rta = new RealtimeAvatar({ apiKey: "test-key", fetch: async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    assert.equal(request.headers.get("authorization"), "Bearer test-key");
    return Response.json(request.url.endsWith("/access") ? access : pending);
  } });
  assert.deepEqual(await rta.getRecording(pending.recordingId), pending);
  assert.deepEqual(await rta.getRecordingAccess(pending.recordingId), access);
  assert.equal(new URL(requests[0].url).pathname, "/api/v1/recordings/rec_test");
  assert.equal(new URL(requests[1].url).pathname, "/api/v1/recordings/rec_test/access");
});

test("malformed ready artifacts and temporary access never become typed success", async () => {
  const rta = new RealtimeAvatar({ apiKey: "test-key", fetch: async () => Response.json({ ...pending, status: "ready" }) });
  await assert.rejects(rta.getRecording(pending.recordingId));
  const access = new RealtimeAvatar({ apiKey: "test-key", fetch: async () => Response.json({ recordingId: pending.recordingId, url: "not-a-url" }) });
  await assert.rejects(access.getRecordingAccess(pending.recordingId));
});
