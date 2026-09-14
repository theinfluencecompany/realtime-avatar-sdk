// Quality-first policy: rendering jitter alone is never evidence of a bad link.
// All durations below require fresh, contiguous receiver samples.
export const NETWORK_QUALITY_POLICY = {
  startupGraceMs: 3000,
  maxSampleGapMs: 1500,
  minimumPackets: 20,
  lossWindowSamples: 3,
  lossRatio: 0.05,
  jitterSeconds: 0.1,
  impairedFps: 12,
  downgradeMs: 2000,
  floorMs: 2000,
  notifyAfterDowngradeMs: 5000,
  recoverMs: 5000,
  clearNoticeMs: 10000,
} as const;

export type NetworkQualityCap = "high" | "reduced" | "floor";
export type NetworkQualityStatus = "unknown" | "healthy" | "poor";

export interface NetworkVideoSample {
  id: string;
  timestamp: number;
  framesDecoded: number;
  packetsReceived: number;
  packetsLost: number;
  jitter: number;
}

/** Only the bound video receiver, never audio or a sum across SSRCs. */
export function readNetworkVideoSample(report: RTCStatsReport | undefined): NetworkVideoSample | null {
  const samples: NetworkVideoSample[] = [];
  report?.forEach((row) => {
    if (row.type !== "inbound-rtp" || (row.kind ?? row.mediaType) !== "video") return;
    const { timestamp, framesDecoded, packetsReceived, packetsLost, jitter } = row;
    if (typeof row.id !== "string" ||
      ![timestamp, framesDecoded, packetsReceived, packetsLost, jitter].every(
        (n) => typeof n === "number" && Number.isFinite(n),
      ) || timestamp < 0 || framesDecoded < 0 || packetsReceived < 0 || jitter < 0) return;
    samples.push({
      id: `${row.id}:${row.ssrc ?? ""}`, timestamp, framesDecoded, packetsReceived, packetsLost, jitter,
    });
  });
  return samples.length === 1 ? samples[0]! : null;
}

export interface NetworkQualityState {
  cap: NetworkQualityCap;
  status: NetworkQualityStatus;
  sample: NetworkVideoSample | null;
  lastPollMs: number | null;
  openedMs: number;
  badMs: number;
  postDowngradeBadMs: number;
  reducedBadMs: number;
  cleanMs: number;
  packetWindow: { received: number; lost: number }[];
}

export function initNetworkQuality(nowMs: number): NetworkQualityState {
  return {
    cap: "high", status: "unknown", sample: null, lastPollMs: null, openedMs: nowMs,
    badMs: 0, postDowngradeBadMs: 0, reducedBadMs: 0, cleanMs: 0, packetWindow: [],
  };
}

export function stepNetworkQuality(
  previous: NetworkQualityState,
  sample: NetworkVideoSample | null,
  nowMs: number,
  options: { paused: boolean; inhibited: boolean },
): NetworkQualityState {
  const p = NETWORK_QUALITY_POLICY;
  const s = { ...previous, sample, lastPollMs: nowMs };
  const before = previous.sample;
  const pollMs = previous.lastPollMs === null ? 0 : nowMs - previous.lastPollMs;
  const elapsedMs = sample && before ? sample.timestamp - before.timestamp : 0;
  const interrupted = options.inhibited || pollMs <= 0 || pollMs > p.maxSampleGapMs;
  const valid = !interrupted && sample !== null && before !== null &&
    sample.id === before.id && elapsedMs > 0 && elapsedMs <= p.maxSampleGapMs &&
    sample.framesDecoded >= before.framesDecoded && sample.packetsReceived >= before.packetsReceived;
  if (!valid || nowMs - s.openedMs < p.startupGraceMs) {
    // A stale poll, new SSRC, hidden tab or unsupported browser is NOT a clean sample.
    // Retain the cap but require new evidence for all dwell/recovery decisions.
    s.badMs = s.postDowngradeBadMs = s.reducedBadMs = s.cleanMs = 0;
    s.packetWindow = [];
    if (options.inhibited) s.sample = null;
    return s;
  }
  const received = sample.packetsReceived - before.packetsReceived;
  // Late arrivals can revise RFC3550's signed loss counter down; never create negative loss.
  const lost = Math.max(0, sample.packetsLost - before.packetsLost);
  s.packetWindow = [...previous.packetWindow, { received, lost }].slice(-p.lossWindowSamples);
  const totals = s.packetWindow.reduce((sum, interval) => ({
    received: sum.received + interval.received, lost: sum.lost + interval.lost,
  }), { received: 0, lost: 0 });
  const packets = totals.received + totals.lost;
  const fps = (sample.framesDecoded - before.framesDecoded) * 1000 / elapsedMs;
  const loss = packets >= p.minimumPackets ? totals.lost / packets : null;
  const impaired = options.paused || fps < p.impairedFps;
  const bad = options.paused || (impaired && (
    (loss !== null && loss >= p.lossRatio) ||
    (received >= p.minimumPackets && sample.jitter >= p.jitterSeconds)
  ));
  const clean = received > 0 && !options.paused && loss !== null && loss < p.lossRatio &&
    sample.jitter < p.jitterSeconds && fps >= p.impairedFps;
  const duration = Math.min(pollMs, elapsedMs);
  s.badMs = bad ? previous.badMs + duration : 0;
  s.postDowngradeBadMs = bad && previous.cap !== "high" ? previous.postDowngradeBadMs + duration : 0;
  s.cleanMs = clean ? previous.cleanMs + duration : 0;
  s.reducedBadMs = bad && fps === 0 && previous.cap !== "high" ? previous.reducedBadMs + duration : 0;

  if (s.badMs >= p.downgradeMs && s.cap === "high") s.cap = "reduced";
  else if (s.reducedBadMs >= p.floorMs && fps === 0 && s.cap === "reduced") s.cap = "floor";
  if (s.postDowngradeBadMs >= p.notifyAfterDowngradeMs) s.status = "poor";
  if (s.cleanMs >= p.recoverMs) s.cap = "high";
  if (s.cleanMs >= p.clearNoticeMs) s.status = "healthy";
  return s;
}
