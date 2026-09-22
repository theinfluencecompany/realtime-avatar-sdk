import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingArtifactSchema } from "../../http-client/src/generated/recording.ts";
import { recordingTimeline, recordingPositions } from "../src/recording-playback.ts";

function file(id: string, role: "user" | "avatar", start: number, duration: number) {
  return recordingArtifactSchema.parse({
    sessionId: "s", recordingId: id, mode: "audio_video", status: "ready",
    createdAt: "2026-09-22T00:00:00.000Z", retainedUntil: "2026-10-22T00:00:00.000Z",
    mediaStartedAt: new Date(Date.UTC(2026, 8, 22) + start).toISOString(),
    mediaEndedAt: new Date(Date.UTC(2026, 8, 22) + start + duration).toISOString(),
    mediaType: "video/mp4", sizeBytes: 1000, durationMs: duration,
    participant: { role, participantIdentity: role },
  });
}

test("participant files retain their media offsets through play, gaps, and seeking", () => {
  const timeline = recordingTimeline([file("user", "user", 0, 60000), file("avatar", "avatar", 1000, 59000)]);
  assert.ok(timeline);
  assert.equal(timeline.durationMs, 60000);
  assert.deepEqual(recordingPositions(timeline, 500).filter((item) => item.active).map((item) => item.recordingId), ["user"]);
  assert.deepEqual(recordingPositions(timeline, 45000).find((item) => item.recordingId === "avatar"), { recordingId: "avatar", active: true, timeSeconds: 44 });
  assert.equal(recordingPositions(timeline, 60000).some((item) => item.active), false);
});

test("a duplicate participant file cannot double a voice", () => {
  assert.throws(() => recordingTimeline([file("one", "user", 0, 30000), file("two", "user", 10000, 30000)]), /Duplicate participant/);
});

test("missing media timing cannot be replaced with creation time", () => {
  const { mediaStartedAt: _start, ...untimed } = file("user", "user", 0, 10000);
  assert.throws(() => recordingTimeline([untimed]), /timing is unavailable/);
});
