import type { RecordingArtifact } from "../../http-client/src/generated/recording.ts";

export function recordingTimeline(recordings: readonly RecordingArtifact[]) {
  if (new Set(recordings.map((recording) => recording.sessionId)).size > 1) throw new Error("Recordings belong to different sessions");
  if (new Set(recordings.map((recording) => recording.recordingId)).size !== recordings.length) throw new Error("Duplicate recording assets");
  const participants = recordings.filter((recording) => recording.participant && recording.status === "ready");
  if (new Set(participants.map((recording) => recording.participant?.role)).size !== participants.length) throw new Error("Duplicate participant recordings");
  const entries = participants.map((recording) => {
    if (recording.status !== "ready" || !recording.mediaStartedAt || !recording.mediaEndedAt || recording.durationMs === null) {
      throw new Error("Recording media timing is unavailable");
    }
    const start = Date.parse(recording.mediaStartedAt);
    const end = Math.min(Date.parse(recording.mediaEndedAt), start + recording.durationMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Recording media timing is invalid");
    return { recording, start, end };
  });
  if (!entries.length) return null;
  const originMs = Math.min(...entries.map((entry) => entry.start));
  return {
    originMs,
    durationMs: Math.max(...entries.map((entry) => entry.end)) - originMs,
    entries: entries.map(({ recording, start, end }) => ({ recording, startMs: start - originMs, endMs: end - originMs })),
  };
}

export function recordingPositions(timeline: NonNullable<ReturnType<typeof recordingTimeline>>, positionMs: number) {
  return timeline.entries.map((entry) => ({
    recordingId: entry.recording.recordingId,
    active: positionMs >= entry.startMs && positionMs < entry.endMs,
    timeSeconds: Math.max(0, Math.min(positionMs, entry.endMs) - entry.startMs) / 1000,
  }));
}
