// ---------------------------------------------------------------------------
// network-evidence — LiveKit facts normalized for an app-owned evidence sink.
//
// The JSON payload schemas and every payload type live in ./network-evidence-contract.ts and
// are derived with z.infer. This file only owns the SDK adapter: clocks, callback session, and
// the allowlisted projection from WebRTC's open RTCStatsReport dictionary.
//
// LiveKit remains the network-behavior owner. This module does not downgrade a track,
// reconnect a room, choose voice/video, show a banner, upload anything, or participate in
// billing. Candidate IDs, SSRCs, addresses, ports, foundations, candidate strings, participant
// identities, tokens, audio, transcript, prompt, and pixel data are never copied out.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { Track } from "livekit-client";
import {
  MAX_NETWORK_EVIDENCE_SAMPLES,
  NETWORK_EVIDENCE_DURATION_MS,
  networkEvidenceSampleSchema,
  networkEvidenceSchemaVersion,
  networkCandidateTypeSchema,
  networkCandidateProtocolSchema,
  networkIceStateSchema,
  networkDtlsStateSchema,
  networkTypeSchema,
  networkTransportEvidenceSchema,
  networkInboundRtpEvidenceSchema,
  type AvatarNetworkEvidenceManifest,
  type AvatarNetworkEvidenceSample,
  type InboundRtpEvidence,
  type LiveKitEvidenceIdentity,
  type NetworkEvidenceAnalytics,
  type NetworkEvidenceContext,
  type NetworkEvidenceSampleInput,
  type NetworkEvidenceTrigger,
  type PresentationEvidence,
  type RtcStatsEvidence,
  type TransportEvidence,
} from "./network-evidence-contract.ts";

export {
  MAX_NETWORK_EVIDENCE_SAMPLES,
  NETWORK_EVIDENCE_DURATION_MS,
  networkEvidenceManifestSchema,
  networkEvidenceSampleSchema,
  networkEvidenceSchemaVersion,
  networkEvidenceUploadSchema,
  networkEvidenceAcceptedSchema,
  networkEvidenceAnalyticsSchema,
  networkEvidenceContextSchema,
  networkEvidenceModeSchema,
  networkEvidenceSurfaceSchema,
  networkEvidenceTriggerSchema,
  networkConnectionStateSchema,
  networkQualitySchema,
  networkStreamStateSchema,
  networkLiveKitIdentitySchema,
  networkRtcStatsEvidenceSchema,
  networkTransportEvidenceSchema,
  networkInboundRtpEvidenceSchema,
  networkPresentationEvidenceSchema,
} from "./network-evidence-contract.ts";
export type {
  AvatarNetworkEvidenceManifest,
  AvatarNetworkEvidenceSample,
  AvatarNetworkEvidenceUpload,
  InboundRtpEvidence,
  LiveKitEvidenceIdentity,
  NetworkEvidenceAnalytics,
  NetworkEvidenceContext,
  NetworkEvidenceMode,
  NetworkEvidenceSampleInput,
  NetworkEvidenceSurface,
  NetworkEvidenceTrigger,
  PresentationEvidence,
  RtcStatsEvidence,
  TransportEvidence,
} from "./network-evidence-contract.ts";

/** Monotonic time is for joining a sample to a script/recording; wall time is for ordering. */
export function monotonicNowMs(): number {
  try {
    if (typeof globalThis.performance?.now === "function") return globalThis.performance.now();
  } catch {
    // Some native runtimes expose a partial performance object.
  }
  return Date.now();
}

/** Observer options shared by the web and React Native surfaces. */
export type AvatarNetworkEvidenceObserver = {
  context: NetworkEvidenceContext;
  /** Called once after the room identity is available, best effort. */
  onManifest?: (manifest: AvatarNetworkEvidenceManifest) => void;
  /** Called on a bounded interval and selected LiveKit transitions. The SDK delivers from an
   * async task; a slow sink cannot block LiveKit's event dispatch. */
  onSample: (sample: AvatarNetworkEvidenceSample) => void;
  /** Current app turn, read only when a sample is emitted. */
  getTurnId?: () => string | undefined;
  /** Default 5s; adapter clamps to 2–30s. Event samples may arrive sooner. */
  intervalMs?: number;
};

/** Mutable in-memory evidence session. The app owns persistence. */
export type NetworkEvidenceSession = {
  manifest: AvatarNetworkEvidenceManifest;
  sample: (input: NetworkEvidenceSampleInput) => void;
  close: () => void;
};

/** Create a bounded callback session; it never stores samples internally. */
export function createNetworkEvidenceSession(
  manifest: AvatarNetworkEvidenceManifest,
  onSample: (sample: AvatarNetworkEvidenceSample) => void,
): NetworkEvidenceSession {
  let sampleSeq = 0;
  let closed = false;
  const startedAtMs = monotonicNowMs();
  return {
    manifest,
    sample(input) {
      if (closed || sampleSeq >= MAX_NETWORK_EVIDENCE_SAMPLES) return;
      const elapsedMs = Math.round(Math.max(0, input.elapsedMs ?? monotonicNowMs() - startedAtMs));
      if (elapsedMs > NETWORK_EVIDENCE_DURATION_MS && input.trigger !== "disconnected") return;
      const parsed = networkEvidenceSampleSchema.safeParse({
        ...input,
        schemaVersion: networkEvidenceSchemaVersion,
        evidenceId: manifest.correlation.evidenceId,
        sampleSeq: sampleSeq + 1,
        elapsedMs,
        capturedAtUnixMs: input.capturedAtUnixMs ?? Date.now(),
      });
      if (!parsed.success) return;
      const sample = parsed.data;
      sampleSeq += 1;
      queueMicrotask(() => {
        try {
          onSample(sample);
        } catch {
          // Evidence is strictly observational. A broken analytics sink cannot break a call.
        }
      });
    },
    close() {
      closed = true;
    },
  };
}

/** Normalize one RTCStatsReport into selected facts. */
export function summarizeRtcStats(report: RTCStatsReport): RtcStatsEvidence {
  return summarizeRtcStatsReports([report]);
}

/** Merge reports from one adapter tick. `selection` prevents a room with multiple inbound
 * tracks from attributing another participant's RTP to the avatar. */
export function summarizeRtcStatsReports(
  reports: Iterable<RTCStatsReport>,
  selection: { videoTrackId?: string; audioTrackId?: string } = {},
): RtcStatsEvidence {
  const entries: Record<string, unknown>[] = [];
  let source: RtcStatsEvidence["source"] = "none";
  for (const report of reports) {
    source = "receiver";
    report.forEach((entry) => {
      if (isStatsEntry(entry)) entries.push(entry);
    });
  }
  if (entries.some((entry) => entry.type === "transport" || entry.type === "candidate-pair")) {
    source = "peer_connection";
  }

  const byId = new Map<string, Record<string, unknown>>();
  const pairs: Record<string, unknown>[] = [];
  let transport: Record<string, unknown> | undefined;
  const inbound: Record<string, unknown>[] = [];
  const codecs = new Map<string, string>();
  for (const stat of entries) {
    const id = stringValue(stat.id);
    if (id) byId.set(id, stat);
    if (stat.type === "transport") transport = stat;
    if (stat.type === "candidate-pair") pairs.push(stat);
    if (stat.type === "inbound-rtp") inbound.push(stat);
    if (stat.type === "codec") {
      const mimeType = stringValue(stat.mimeType);
      if (id && mimeType) codecs.set(id, mimeType);
    }
  }

  const selectedPairId = stringValue(transport?.selectedCandidatePairId);
  const pair =
    (selectedPairId ? byId.get(selectedPairId) : undefined) ??
    pairs.find((candidate) => candidate.selected === true) ??
    pairs.find((candidate) => candidate.nominated === true);
  const localType = candidateType(lookup(byId, pair?.localCandidateId)?.candidateType);
  const remoteType = candidateType(lookup(byId, pair?.remoteCandidateId)?.candidateType);
  const protocol = candidateProtocol(lookup(byId, pair?.localCandidateId)?.protocol);
  const rttSeconds = measurementValue(pair?.currentRoundTripTime);
  const connectionInput: Record<string, unknown> = {
    ice: readField(networkIceStateSchema, transport?.iceState),
    dtls: readField(networkDtlsStateSchema, transport?.dtlsState),
    route: localType && remoteType && protocol ? `${localType}/${protocol} -> ${remoteType}` : undefined,
    network: readField(networkTypeSchema, lookup(byId, pair?.localCandidateId)?.networkType),
    rttMs: rttSeconds === undefined ? undefined : Math.round(rttSeconds * 1000),
    availableOutgoingBitrate: numberValue(pair?.availableOutgoingBitrate),
    availableIncomingBitrate: numberValue(pair?.availableIncomingBitrate),
    selectedCandidatePairChanges: numberValue(transport?.selectedCandidatePairChanges),
  };
  const connection = compactTransport(connectionInput);
  const video = findInbound(inbound, "video", selection.videoTrackId);
  const audio = findInbound(inbound, "audio", selection.audioTrackId);
  return {
    source: video || audio || connection ? source : "none",
    ...(connection ? { connection } : {}),
    ...(video ? { video: compactInbound(video, codecs) } : {}),
    ...(audio ? { audio: compactInbound(audio, codecs) } : {}),
  };
}

function compactTransport(input: Record<string, unknown>): TransportEvidence | undefined {
  const output: Record<string, unknown> = {};
  copyString(output, "ice", input.ice);
  copyString(output, "dtls", input.dtls);
  copyString(output, "route", input.route);
  copyString(output, "network", input.network);
  copyMeasurement(output, "rttMs", input.rttMs, 86_400_000);
  copyNumber(output, "availableOutgoingBitrate", input.availableOutgoingBitrate, 100_000_000);
  copyNumber(output, "availableIncomingBitrate", input.availableIncomingBitrate, 100_000_000);
  copyNumber(output, "selectedCandidatePairChanges", input.selectedCandidatePairChanges, 10_000_000_000);
  return Object.keys(output).length > 0 ? networkTransportEvidenceSchema.parse(output) : undefined;
}

function findInbound(inbound: Record<string, unknown>[], kind: "audio" | "video", trackId?: string) {
  const candidates = inbound.filter((stat) => kindOf(stat) === kind);
  if (!trackId) return candidates.length === 1 ? candidates[0] : undefined;
  return candidates.find((stat) => stringValue(stat.trackIdentifier) === trackId);
}

function compactInbound(stat: Record<string, unknown>, codecs: Map<string, string>): InboundRtpEvidence {
  const output: Record<string, unknown> = {};
  const codecId = stringValue(stat.codecId);
  copyString(output, "codec", codecFamily(codecId ? codecs.get(codecId) : undefined));
  copyNumber(output, "bytesReceived", stat.bytesReceived, 10_000_000_000);
  copyNumber(output, "packetsReceived", stat.packetsReceived, 10_000_000_000);
  copyNumber(output, "packetsLost", stat.packetsLost, 10_000_000_000);
  copyScaledNumber(output, "jitterMs", stat.jitter, 1000, 86_400_000);
  copyScaledNumber(output, "jitterBufferDelayMs", stat.jitterBufferDelay, 1000, 86_400_000);
  copyNumber(output, "jitterBufferEmittedCount", stat.jitterBufferEmittedCount, 10_000_000_000);
  copyNumber(output, "framesReceived", stat.framesReceived, 10_000_000_000);
  copyNumber(output, "framesDecoded", stat.framesDecoded, 10_000_000_000);
  copyNumber(output, "framesDropped", stat.framesDropped, 10_000_000_000);
  copyMeasurement(output, "framesPerSecond", stat.framesPerSecond, 240);
  copyNumber(output, "frameWidth", stat.frameWidth, 10_000);
  copyNumber(output, "frameHeight", stat.frameHeight, 10_000);
  copyNumber(output, "freezeCount", stat.freezeCount, 10_000_000_000);
  copyScaledNumber(output, "totalFreezesDurationMs", stat.totalFreezesDuration, 1000, 86_400_000);
  copyNumber(output, "keyFramesDecoded", stat.keyFramesDecoded, 10_000_000_000);
  copyNumber(output, "concealedSamples", stat.concealedSamples, 10_000_000_000);
  copyNumber(output, "totalSamplesReceived", stat.totalSamplesReceived, 10_000_000_000);
  return networkInboundRtpEvidenceSchema.parse(output);
}

function lookup(byId: Map<string, Record<string, unknown>>, id: unknown): Record<string, unknown> | undefined {
  const key = stringValue(id);
  return key ? byId.get(key) : undefined;
}

function kindOf(stat: Record<string, unknown>): string | undefined {
  return stringValue(stat.kind) ?? stringValue(stat.mediaType);
}

function codecFamily(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "video/h264") return "h264";
  if (normalized === "video/vp8") return "vp8";
  if (normalized === "video/vp9") return "vp9";
  if (normalized === "video/av1") return "av1";
  if (normalized === "audio/opus") return "opus";
  return undefined;
}

function candidateType(value: unknown): z.infer<typeof networkCandidateTypeSchema> | undefined {
  const parsed = networkCandidateTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function candidateProtocol(value: unknown): z.infer<typeof networkCandidateProtocolSchema> | undefined {
  const parsed = networkCandidateProtocolSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readField<S extends z.ZodType>(schema: S, value: unknown): z.output<S> | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 160 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function copyString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string") target[key] = value;
}

function copyNumber(target: Record<string, unknown>, key: string, value: unknown, max: number): void {
  const number = numberValue(value);
  if (number !== undefined && number <= max) target[key] = number;
}

function measurementValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function copyMeasurement(target: Record<string, unknown>, key: string, value: unknown, max: number): void {
  const number = measurementValue(value);
  if (number !== undefined && number <= max) target[key] = number;
}

function copyScaledNumber(target: Record<string, unknown>, key: string, value: unknown, scale: number, max: number): void {
  const number = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value * scale : undefined;
  if (number !== undefined && Number.isSafeInteger(Math.round(number)) && Math.round(number) <= max) target[key] = Math.round(number);
}

/** Coarsen the rich callback payload at the product-analytics storage boundary. */
export function toNetworkEvidenceAnalytics(
  sample: Pick<AvatarNetworkEvidenceSample, "livekit" | "stats" | "presentation">,
): NetworkEvidenceAnalytics {
  const route = sample.stats.connection?.route;
  const network = sample.stats.connection?.network;
  const rttMs = sample.stats.connection?.rttMs;
  return {
    quality: sample.livekit.quality,
    routeClass: route ? (route.includes("relay") ? "relay" : "direct") : "unknown",
    networkClass: network ?? "unknown",
    rttBucket: rttMs === undefined ? "unknown" : rttMs < 100 ? "lt_100" : rttMs < 250 ? "100_250" : rttMs < 500 ? "250_500" : "gte_500",
    videoPaused: sample.livekit.videoStreamState === Track.StreamState.Paused,
    videoFrameFlowing: sample.presentation?.liveFrameFlowing ?? null,
  };
}

function isStatsEntry(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
