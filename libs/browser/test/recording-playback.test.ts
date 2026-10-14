import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingArtifactSchema } from "../../http-client/src/generated/recording.ts";
import { recordingTimeline, recordingPositions, recordingVideoVisible } from "../src/recording-playback.ts";

function file(id: string, role: "user" | "avatar", start: number, duration: number, mode: "audio" | "video" | "audio_video" = "audio_video") {
  return recordingArtifactSchema.parse({
    sessionId: "s", recordingId: id, mode, status: "ready",
    createdAt: "2026-09-22T00:00:00.000Z", retainedUntil: "2026-10-22T00:00:00.000Z",
    mediaStartedAt: new Date(Date.UTC(2026, 8, 22) + start).toISOString(),
    mediaEndedAt: new Date(Date.UTC(2026, 8, 22) + start + duration).toISOString(),
    mediaType: mode === "audio" ? "audio/mp4" : "video/mp4", sizeBytes: 1000, durationMs: duration,
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

test("separate raw audio and video preserve both voices through camera gaps and seeking", () => {
  const timeline = recordingTimeline([
    file("user-audio", "user", 0, 60000, "audio"),
    file("avatar-audio", "avatar", 1000, 59000, "audio"),
    file("avatar-video", "avatar", 2000, 58000, "video"),
    file("user-video-after", "user", 30000, 30000, "video"),
    file("user-video-before", "user", 0, 10000, "video"),
  ]);
  assert.ok(timeline);
  assert.equal(timeline.durationMs, 60000);
  const active = (at: number) => recordingPositions(timeline, at).filter((entry) => entry.active);
  assert.deepEqual(active(15000).map((entry) => entry.recordingId), ["user-audio", "avatar-audio", "avatar-video"]);
  assert.deepEqual(active(45000), [
    { recordingId: "user-audio", active: true, timeSeconds: 45 },
    { recordingId: "avatar-audio", active: true, timeSeconds: 44 },
    { recordingId: "avatar-video", active: true, timeSeconds: 43 },
    { recordingId: "user-video-after", active: true, timeSeconds: 15 },
  ]);
  assert.deepEqual(active(500).map((entry) => entry.recordingId), ["user-audio", "user-video-before"]);
});

test("republished microphone segments use their actual offsets and touch without doubling", () => {
  const timeline = recordingTimeline([
    file("first", "user", 0, 5000, "audio"),
    file("second", "user", 5000, 5000, "audio"),
    file("reconnected", "user", 12000, 8000, "audio"),
  ]);
  assert.ok(timeline);
  assert.deepEqual(recordingPositions(timeline, 5000).filter((entry) => entry.active), [
    { recordingId: "second", active: true, timeSeconds: 0 },
  ]);
  assert.equal(recordingPositions(timeline, 11000).some((entry) => entry.active), false);
  assert.deepEqual(recordingPositions(timeline, 15000).filter((entry) => entry.active), [
    { recordingId: "reconnected", active: true, timeSeconds: 3 },
  ]);
});

test("raw audio cannot double a voice from another raw or legacy participant file", () => {
  for (const mode of ["audio", "audio_video"] as const) {
    assert.throws(() => recordingTimeline([
      file("first", "user", 0, 10000, mode),
      file("duplicate-audio", "user", 1000, 10000, "audio"),
    ]), /Duplicate participant audio recordings overlap/);
  }
});

test("overlapping camera segments and mixed sessions cannot share playback", () => {
  assert.throws(() => recordingTimeline([
    file("camera-before", "user", 0, 10000, "video"),
    file("camera-after", "user", 9000, 10000, "video"),
  ]), /Duplicate participant video recordings overlap/);
  assert.throws(() => recordingTimeline([
    file("user", "user", 0, 10000, "audio"),
    { ...file("avatar", "avatar", 0, 10000, "audio"), sessionId: "another-session" },
  ]), /different sessions/);
});

test("a nonzero first native PTS delays visibility without resetting the media clock", () => {
  const timeline = recordingTimeline([
    file("audio", "avatar", 0, 11000, "audio"),
    { ...file("video", "avatar", 100, 10589, "video"), mediaStartOffsetMs: 330 },
  ]);
  assert.ok(timeline);
  assert.deepEqual(recordingPositions(timeline, 400).find((entry) => entry.recordingId === "video"),
    { recordingId: "video", active: false, timeSeconds: 0.3 });
  assert.deepEqual(recordingPositions(timeline, 430).find((entry) => entry.recordingId === "video"),
    { recordingId: "video", active: true, timeSeconds: 0.33 });
  assert.deepEqual(recordingPositions(timeline, 10600).find((entry) => entry.recordingId === "video"),
    { recordingId: "video", active: true, timeSeconds: 10.5 });
});

test("an invalid first playable timestamp cannot produce an empty media interval", () => {
  assert.throws(() => recordingTimeline([
    { ...file("video", "avatar", 0, 1000, "video"), mediaStartOffsetMs: 1000 },
  ]), /timing is invalid/);
});

test("muted video intervals preserve audio activity and native clock positions", () => {
  for (const mode of ["video", "audio_video"] as const) {
    const recording = { ...file("camera", "user", 1000, 10000, mode), mediaMutedIntervalsMs: [{ startMs: 2000, endMs: 5000 }] };
    const timeline = recordingTimeline([file("avatar", "avatar", 0, 11000), recording]);
    assert.ok(timeline);
    const state = recordingPositions(timeline, 4000).find((entry) => entry.recordingId === "camera");
    assert.deepEqual(state, { recordingId: "camera", active: true, timeSeconds: 3 });
    assert.equal(recordingVideoVisible(recording, 1.999), true);
    assert.equal(recordingVideoVisible(recording, 2), false);
    assert.equal(recordingVideoVisible(recording, 4.999), false);
    assert.equal(recordingVideoVisible(recording, 5), true);
  }
});
