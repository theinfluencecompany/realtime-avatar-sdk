import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionQuality, ConnectionState, Track } from "livekit-client";
import {
  createNetworkEvidenceSession,
  MAX_NETWORK_EVIDENCE_SAMPLES,
  NETWORK_EVIDENCE_DURATION_MS,
  networkEvidenceSchemaVersion,
  summarizeRtcStats,
  summarizeRtcStatsReports,
  toNetworkEvidenceAnalytics,
  type AvatarNetworkEvidenceSample,
} from "../src/react/network-evidence.ts";

function fakeReport(stats: Record<string, unknown>[]): RTCStatsReport {
  return new Map(stats.map((stat) => [String(stat.id), stat]));
}

const transport = {
  id: "transport-1",
  type: "transport",
  iceState: "connected",
  dtlsState: "connected",
  selectedCandidatePairId: "pair-1",
  selectedCandidatePairChanges: 4,
};
const pair = {
  id: "pair-1",
  type: "candidate-pair",
  localCandidateId: "local-1",
  remoteCandidateId: "remote-1",
  currentRoundTripTime: 0.087,
  availableOutgoingBitrate: 1_200_000,
  availableIncomingBitrate: 900_000,
};
const local = {
  id: "local-1",
  type: "local-candidate",
  candidateType: "relay",
  protocol: "tcp",
  networkType: "cellular",
};
const remote = { id: "remote-1", type: "remote-candidate", candidateType: "relay" };

test("the evidence schema is versioned", () => {
  assert.equal(networkEvidenceSchemaVersion, 1);
});

test("receiver frame rates preserve fractional measurements", () => {
  const summary = summarizeRtcStats(fakeReport([
    { id: "video", type: "inbound-rtp", kind: "video", framesPerSecond: 29.97 },
  ]));
  assert.equal(summary.video?.framesPerSecond, 29.97);
});

test("summarizeRtcStats retains useful LiveKit facts and strips candidate identifiers", () => {
  const summary = summarizeRtcStats(
    fakeReport([
      transport,
      pair,
      local,
      remote,
      {
        id: "video-1",
        type: "inbound-rtp",
        kind: "video",
        bytesReceived: 120_000,
        packetsReceived: 1_200,
        packetsLost: 12,
        jitter: 0.012,
        jitterBufferDelay: 2.4,
        jitterBufferEmittedCount: 2_000,
        framesReceived: 600,
        framesDecoded: 590,
        framesDropped: 10,
        framesPerSecond: 24,
        frameWidth: 432,
        frameHeight: 768,
        freezeCount: 2,
        totalFreezesDuration: 0.45,
        codecId: "codec-1",
      },
      { id: "codec-1", type: "codec", mimeType: "video/H264" },
      {
        id: "audio-1",
        type: "inbound-rtp",
        kind: "audio",
        bytesReceived: 15_000,
        packetsReceived: 800,
        packetsLost: 2,
        jitter: 0.004,
        concealedSamples: 48,
        totalSamplesReceived: 48_000,
        codecId: "codec-2",
      },
      { id: "codec-2", type: "codec", mimeType: "audio/opus" },
    ]),
  );

  assert.deepEqual(summary.connection, {
    ice: "connected",
    dtls: "connected",
    route: "relay/tcp -> relay",
    network: "cellular",
    rttMs: 87,
    availableOutgoingBitrate: 1_200_000,
    availableIncomingBitrate: 900_000,
    selectedCandidatePairChanges: 4,
  });
  assert.deepEqual(summary.video, {
    bytesReceived: 120_000,
    packetsReceived: 1_200,
    packetsLost: 12,
    jitterMs: 12,
    jitterBufferDelayMs: 2_400,
    jitterBufferEmittedCount: 2_000,
    framesReceived: 600,
    framesDecoded: 590,
    framesDropped: 10,
    framesPerSecond: 24,
    frameWidth: 432,
    frameHeight: 768,
    freezeCount: 2,
    totalFreezesDurationMs: 450,
    codec: "h264",
  });
  assert.deepEqual(summary.audio, {
    bytesReceived: 15_000,
    packetsReceived: 800,
    packetsLost: 2,
    jitterMs: 4,
    concealedSamples: 48,
    totalSamplesReceived: 48_000,
    codec: "opus",
  });
  const serialized = JSON.stringify(summary);
  for (const forbidden of ["local-1", "remote-1", "pair-1", "candidate:", "192.168.", "10."]) {
    assert.equal(serialized.includes(forbidden), false, `evidence leaked ${forbidden}`);
  }
});

test("selects inbound media by the bound MediaStreamTrack identifier", () => {
  const report = fakeReport([
    { id: "v1", type: "inbound-rtp", kind: "video", trackIdentifier: "other", framesDecoded: 999 },
    { id: "v2", type: "inbound-rtp", kind: "video", trackIdentifier: "avatar", framesDecoded: 12 },
  ]);
  assert.equal(summarizeRtcStatsReports([report], { videoTrackId: "avatar" }).video?.framesDecoded, 12);
  assert.equal(summarizeRtcStatsReports([report], { videoTrackId: "missing" }).video, undefined);
});

test("missing transport stats do not become a clean zero-valued network", () => {
  const summary = summarizeRtcStats(
    fakeReport([
      {
        id: "video-1",
        type: "inbound-rtp",
        kind: "video",
        bytesReceived: 0,
        packetsReceived: 0,
        packetsLost: 0,
      },
    ]),
  );
  assert.equal(summary.connection, undefined);
  assert.deepEqual(summary.video, {
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
  });
});

test("missing candidate types are unknown, never silently classified direct", () => {
  const summary = summarizeRtcStats(fakeReport([
    transport,
    pair,
    { ...local, candidateType: "private-10.1.1.2", protocol: "tcp" },
    remote,
  ]));
  assert.equal(summary.connection?.route, undefined);
  const projection = toNetworkEvidenceAnalytics({
    livekit: {
      connectionState: ConnectionState.Connected,
      quality: ConnectionQuality.Unknown,
      videoStreamState: Track.StreamState.Unknown,
      audioStreamState: Track.StreamState.Unknown,
    },
    stats: summary,
  });
  assert.equal(projection.routeClass, "unknown");
  assert.equal(JSON.stringify(summary).includes("10.1.1.2"), false);
});

test("evidence callbacks fail open, keep sequence order, and close cleanly", () => {
  const manifest = {
    schemaVersion: networkEvidenceSchemaVersion,
    correlation: { evidenceId: "580c0052-a0c9-47a7-8e52-2b85788743b3", sessionId: "rts_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", surface: "web" as const, mode: "avatar" as const },
    livekit: { roomSid: "RM_test" },
    createdAtUnixMs: 1_000,
  };
  const samples: AvatarNetworkEvidenceSample[] = [];
  const session = createNetworkEvidenceSession(manifest, (sample) => {
    samples.push(sample);
    if (sample.sampleSeq === 1) throw new Error("upload failed");
  });
  const sample = {
    trigger: "interval" as const,
    livekit: {
      connectionState: ConnectionState.Connected,
      quality: ConnectionQuality.Good,
      videoStreamState: Track.StreamState.Active,
      audioStreamState: Track.StreamState.Active,
    },
    identity: { roomSid: "RM_test" },
    statsStatus: "unavailable" as const,
    stats: { source: "none" as const },
  };
  assert.doesNotThrow(() => session.sample({ ...sample, elapsedMs: 0 }));
  assert.doesNotThrow(() => session.sample({ ...sample, elapsedMs: 100.25 }));
  session.close();
  session.sample({ ...sample, elapsedMs: 200 });
  return new Promise<void>((resolve) => {
    queueMicrotask(() => {
      assert.deepEqual(samples.map((item) => item.sampleSeq), [1, 2]);
      assert.deepEqual(samples.map((item) => item.elapsedMs), [0, 100]);
      resolve();
    });
  });
});

test("the shared sample uses LiveKit's own state vocabulary", () => {
  const sample: AvatarNetworkEvidenceSample = {
    schemaVersion: networkEvidenceSchemaVersion,
    evidenceId: "580c0052-a0c9-47a7-8e52-2b85788743b3",
    sampleSeq: 1,
    elapsedMs: 2_000,
    capturedAtUnixMs: 1_700_000_002_000,
    trigger: "interval",
    statsStatus: "available",
    livekit: {
      connectionState: ConnectionState.Connected,
      quality: ConnectionQuality.Good,
      videoStreamState: Track.StreamState.Active,
      audioStreamState: Track.StreamState.Active,
    },
    identity: { roomSid: "RM_1", avatarParticipantSid: "PA_1", videoTrackSid: "TR_1" },
    stats: { source: "receiver", video: { framesDecoded: 1 } },
  };
  assert.equal(sample.livekit.quality, "good");
  assert.equal(sample.livekit.connectionState, "connected");
  assert.equal(sample.livekit.videoStreamState, "active");
});

test("sample limits reject invalid inputs without consuming sequence slots and retain final disconnect", async () => {
  const samples: AvatarNetworkEvidenceSample[] = [];
  const manifest = {
    schemaVersion: networkEvidenceSchemaVersion,
    correlation: { evidenceId: "580c0052-a0c9-47a7-8e52-2b85788743b3", sessionId: "rts_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", surface: "web" as const, mode: "avatar" as const },
    livekit: {}, createdAtUnixMs: 1_000,
  };
  const sample = {
    trigger: "interval" as const, elapsedMs: 0,
    livekit: { connectionState: ConnectionState.Connected, quality: ConnectionQuality.Good,
      videoStreamState: Track.StreamState.Unknown, audioStreamState: Track.StreamState.Unknown },
    identity: {}, statsStatus: "unavailable" as const, stats: { source: "none" as const },
  };
  const session = createNetworkEvidenceSession(manifest, (item) => { samples.push(item); });
  session.sample({ ...sample, elapsedMs: Number.NaN });
  session.sample({ ...sample, elapsedMs: NETWORK_EVIDENCE_DURATION_MS + 1 });
  session.sample({ ...sample, trigger: "disconnected", elapsedMs: NETWORK_EVIDENCE_DURATION_MS + 1 });
  for (let index = 0; index < MAX_NETWORK_EVIDENCE_SAMPLES + 10; index++) session.sample(sample);
  await Promise.resolve();
  assert.equal(samples.length, MAX_NETWORK_EVIDENCE_SAMPLES);
  assert.equal(samples[0]?.sampleSeq, 1);
  assert.equal(samples[0]?.trigger, "disconnected");
  assert.equal(samples.at(-1)?.sampleSeq, MAX_NETWORK_EVIDENCE_SAMPLES);
});
