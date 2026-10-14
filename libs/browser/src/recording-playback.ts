import type { RecordingArtifact } from "../../http-client/src/generated/recording.ts";

export function recordingTimeline(recordings: readonly RecordingArtifact[]) {
  if (new Set(recordings.map((recording) => recording.sessionId)).size > 1) throw new Error("Recordings belong to different sessions");
  if (new Set(recordings.map((recording) => recording.recordingId)).size !== recordings.length) throw new Error("Duplicate recording assets");
  const participants = recordings.filter((recording) => recording.participant && recording.status === "ready");
  const entries = participants.map((recording) => {
    if (recording.status !== "ready" || !recording.mediaStartedAt || !recording.mediaEndedAt || recording.durationMs === null) {
      throw new Error("Recording media timing is unavailable");
    }
    const start = Date.parse(recording.mediaStartedAt);
    const end = Math.min(Date.parse(recording.mediaEndedAt), start + recording.durationMs);
    const activeStart = start + (recording.mediaStartOffsetMs ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(activeStart) || end <= activeStart) throw new Error("Recording media timing is invalid");
    return { recording, start, activeStart, end };
  });
  if (!entries.length) return null;
  // Separate audio/video tracks can overlap; two voices (or pictures) for the same
  // participant cannot. Re-published tracks occupy later intervals in the same lane.
  const laneEnds = new Map<string, number>();
  for (const { recording, activeStart, end } of [...entries].sort((a, b) => a.activeStart - b.activeStart)) {
    const kinds = recording.mode === "audio_video" ? ["audio", "video"] : [recording.mode];
    for (const kind of kinds) {
      const lane = `${recording.participant?.role}:${kind}`;
      if (activeStart < (laneEnds.get(lane) ?? -Infinity)) throw new Error(`Duplicate participant ${kind} recordings overlap`);
      laneEnds.set(lane, end);
    }
  }
  const originMs = Math.min(...entries.map((entry) => entry.start));
  return {
    originMs,
    durationMs: Math.max(...entries.map((entry) => entry.end)) - originMs,
    entries: entries.map(({ recording, start, activeStart, end }) => ({ recording, startMs: start - originMs, activeStartMs: activeStart - originMs, endMs: end - originMs })),
  };
}

export function recordingPositions(timeline: NonNullable<ReturnType<typeof recordingTimeline>>, positionMs: number) {
  return timeline.entries.map((entry) => ({
    recordingId: entry.recording.recordingId,
    active: positionMs >= entry.activeStartMs && positionMs < entry.endMs,
    timeSeconds: Math.max(0, Math.min(positionMs, entry.endMs) - entry.startMs) / 1000,
  }));
}

/** Camera masking does not stop a combined file's audio or alter native media time. */
export function recordingVideoVisible(recording: RecordingArtifact, timeSeconds: number): boolean {
  const mediaMs = timeSeconds * 1000;
  return recording.mode !== "audio" && !(recording.mediaMutedIntervalsMs ?? []).some((interval) =>
    mediaMs >= interval.startMs && mediaMs < interval.endMs,
  );
}
